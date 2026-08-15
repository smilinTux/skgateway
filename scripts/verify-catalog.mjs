#!/usr/bin/env node
/**
 * verify-catalog.mjs - proves the served model catalog and the local-failover
 * redundancy list, with real completions, not catalog-membership checks.
 *
 * Coordination card a7f65226 (parent 767adc4e). Built because on 2026-08-14
 * a green-on-paper catalog was 1-of-12 usable: every id in GET /v1/models was
 * POSTed through the gateway and only openai/gpt-oss-20b answered 200. This
 * script is the standing job that catches that class of drift again.
 *
 * FOUR checks, all in one run, reported PER PROVIDER not just in aggregate:
 *
 *   1. LIVENESS. Every id GET /v1/models advertises gets one small real chat
 *      completion. 2xx = alive. 429 = alive-but-throttled (a free tier being
 *      rate limited is not the same failure as a dead model, and is never
 *      counted as dead). Any other 4xx/5xx, a timeout, or a network error is
 *      reported with its own distinct reason - they mean different things
 *      (a 404/410 is a retired model; a timeout can be a slow cold start).
 *
 *   2. REPRESENTATION - the check that would have caught the real outage.
 *      GET /admin/models/status reports each discovery provider's last-fetch
 *      health (`ok`, `count`). On 2026-08-14 openrouter reported
 *      `ok:true, count:17` while GET /v1/models advertised ZERO openrouter
 *      models - total absence, not a bad entry, so a check that only looks
 *      for bad entries in what IS present would have stayed green. This check
 *      flags any provider the gateway calls healthy that is completely
 *      unrepresented in the served catalog.
 *
 *   3. COUNT DIVERGENCE - informational, never pages by itself. Per provider:
 *      what the last live fetch reported (`provider_says`, from
 *      /admin/models/status), what discovery actually collected into the
 *      catalog (`collected`, from GET /admin/models, which is the full
 *      pre-lifecycle-view catalog), and what we serve (`advertised`, from
 *      GET /v1/models). provider-vs-collected drifting apart is expected -
 *      free tiers churn between refresh cycles - so it is only logged, with
 *      ids, for diagnosability. collected shrinking to advertised is ALSO
 *      expected and healthy on its own (that is the lifecycle view hiding
 *      retired ids on purpose) UNLESS it goes all the way to zero for a
 *      provider the status endpoint calls healthy - that exact case is
 *      check 2, and check 2 is what pages, not this one.
 *
 *   4. FAILOVER REDUNDANCY. Every entry in registry.yaml's
 *      failover.local_fallback gets a real completion (via
 *      src/proxy/registry.mjs's resolveFailoverCandidates, the same resolver
 *      the router itself uses - never a catalog-membership check, which is
 *      exactly what lied before: NVIDIA's catalog lists ids that answer 404).
 *      Fewer than 2 live entries pages. Chef's rule: if you need one, get two
 *      - one live entry is a working system with a dead redundancy story, and
 *      a fallback list is only ever read once the primary is already down, so
 *      a rotted entry is invisible until the exact moment it is load-bearing.
 *
 * ALERTING. Exactly two genuine failure conditions page (see ALERT_CATALOG_KEY
 * / ALERT_FAILOVER_KEY below): a dead/unrepresented advertised model, and
 * failover redundancy below 2. Both go through scripts/lib/sk-alert.mjs, which
 * resolves the real ~/.skenv/bin/sk-alert by an ABSOLUTE path and passes the
 * message as an argv element, copying the one proven-working invocation in
 * this fleet rather than inventing a new one (see that module's header for the
 * incident this avoids). Alerts dedupe via sk-alert's own -k/-t so a
 * persisting problem re-pages once per TTL window, not once per run.
 *
 * BUDGET. This makes real completions against real (mostly free-tier)
 * providers. Measured elsewhere in this card's own investigation: probing
 * ~7 free models pushed two into rate-limit errors within minutes. This
 * script paces requests (--delay, default 500ms) and, by default, EXCLUDES
 * the paid `anthropic` backend from the liveness sweep (--skip-provider,
 * repeatable) so a scheduled run costs no real dollars; free/self-hosted ids
 * are exactly where this class of drift lives. Intended cadence is DAILY, not
 * more - see the scheduler registration this ships with.
 *
 * Usage:
 *   node scripts/verify-catalog.mjs [options]
 *
 *   -e, --endpoint URL       gateway base URL (default $SKGATEWAY_VERIFY_ENDPOINT
 *                            or http://localhost:18780)
 *   -r, --registry PATH      skmodels registry path (default $SKMODELS_REGISTRY
 *                            or ~/.skcapstone/models/registry.yaml)
 *       --skip-provider NAME provider to exclude from the liveness sweep,
 *                            repeatable (default: anthropic)
 *       --max-tokens N       max_tokens per probe completion (default 24)
 *       --timeout MS         per-completion timeout (default 45000)
 *       --delay MS           pacing delay between completions (default 500)
 *       --alert              fire sk-alert on a genuine failure
 *                            (or SKGATEWAY_VERIFY_ALERT=1)
 *       --json               emit the structured result as JSON
 *   -q, --quiet               suppress the human report (still sets exit code)
 *   -h, --help
 *
 * Exit codes:
 *   0  clean - every advertised id alive, every provider represented,
 *      failover redundancy >= 2
 *   1  drift - a dead advertised model, a representation gap, and/or
 *      failover redundancy < 2
 *   2  error - GET /v1/models unreachable
 *
 * @module scripts/verify-catalog
 */

import { fileURLToPath } from "node:url";
import { resolveFailoverCandidates, REGISTRY_PATH } from "../src/proxy/registry.mjs";
import { fireSkAlert } from "./lib/sk-alert.mjs";

export const DEFAULT_ENDPOINT = process.env.SKGATEWAY_VERIFY_ENDPOINT || "http://localhost:18780";
export const DEFAULT_REGISTRY_PATH = process.env.SKMODELS_REGISTRY || REGISTRY_PATH;
export const DEFAULT_SKIP_PROVIDERS = ["anthropic"];
export const DEFAULT_MAX_TOKENS = 24;
export const DEFAULT_TIMEOUT_MS = 45000;
export const DEFAULT_DELAY_MS = 500;
export const DEFAULT_ALERT_TTL_SECONDS = 43200; // 12h: re-pages once per calendar day on a daily cadence, not once per run

export const ALERT_CATALOG_KEY = "skgateway-catalog-verify";
export const ALERT_FAILOVER_KEY = "skgateway-failover-redundancy";
export const MIN_FAILOVER_LIVE = 2;

export const EXIT_OK = 0;
export const EXIT_DRIFT = 1;
export const EXIT_ERROR = 2;

const PROBE_PROMPT = "Reply with the single word: ok.";

// ── small helpers ───────────────────────────────────────────────────────────

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Group an array of {id, provider} - style entries into Map<provider, Set<id>>. */
function groupIdsByProvider(items, providerOf, idOf) {
  const map = new Map();
  for (const it of items) {
    const p = providerOf(it) || "unknown";
    const id = idOf(it);
    if (!map.has(p)) map.set(p, new Set());
    map.get(p).add(id);
  }
  return map;
}

// ── probing a single model with a real completion ──────────────────────────

/**
 * Classify a probe outcome. 2xx -> alive. 429 -> alive AND throttled (never a
 * failure). Anything else is dead, with a distinct `reason` so 4xx/5xx/timeout
 * are never lumped into one generic "failed" bucket.
 *
 * @param {{status?:number, timedOut?:boolean, networkError?:string}} outcome
 * @returns {{alive:boolean, throttled:boolean, reason:string}}
 */
export function classifyProbe({ status, timedOut = false, networkError = null } = {}) {
  if (networkError) return { alive: false, throttled: false, reason: `network_error: ${networkError}` };
  if (timedOut) return { alive: false, throttled: false, reason: "timeout" };
  if (typeof status !== "number") return { alive: false, throttled: false, reason: "no_response" };
  if (status === 429) return { alive: true, throttled: true, reason: "http_429" };
  if (status >= 200 && status < 300) return { alive: true, throttled: false, reason: `http_${status}` };
  return { alive: false, throttled: false, reason: `http_${status}` };
}

/**
 * Send one small real chat completion for `id` through the gateway and
 * classify the result. Never throws - network failures and timeouts are
 * captured into the classification, exactly like a dead HTTP status would be.
 *
 * @param {object} args
 * @param {string} args.endpoint
 * @param {string} args.id
 * @param {number} [args.maxTokens]
 * @param {number} [args.timeoutMs]
 * @param {typeof fetch} [args.fetchImpl]
 * @returns {Promise<{id:string, status:number|null, ms:number, alive:boolean, throttled:boolean, reason:string}>}
 */
export async function probeModel({ endpoint, id, maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }) {
  const base = String(endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const start = Date.now();
  try {
    const resp = await fetchImpl(`${base}/v1/chat/completions`, {
      method: "POST",
      signal: ac.signal,
      // NO authorization header, deliberately.
      //
      // The gateway merges a backend's own auth ON TOP of a copy of the
      // client's headers (router.mjs:2056), and buildAuthHeaders() returns an
      // empty object when a backend declares api_key auth but has no resolvable
      // key. So a client bearer SURVIVES that merge and is relayed upstream.
      // Sending a placeholder here made all 7 OpenCode Zen models report
      // http_401: opencode.ai rejected our dummy token and this job reported
      // seven healthy models as dead. A verification job that cries wolf is
      // worse than no verification job.
      //
      // This probe is loopback-to-loopback against our own gateway, which does
      // not require caller auth on /v1/chat/completions, so no header is
      // needed. If that ever changes, send a REAL token, never a placeholder.
      // The underlying header-relay issue is tracked as card 6e61f798 (C15).
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: id,
        messages: [{ role: "user", content: PROBE_PROMPT }],
        max_tokens: maxTokens,
      }),
    });
    const ms = Date.now() - start;
    const cls = classifyProbe({ status: resp.status });
    return { id, status: resp.status, ms, ...cls };
  } catch (e) {
    const ms = Date.now() - start;
    const timedOut = e.name === "AbortError";
    const cls = classifyProbe(timedOut ? { timedOut: true } : { networkError: e.message });
    return { id, status: null, ms, ...cls };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a list of ids sequentially, pacing requests by `delayMs` so a run
 * never hammers a free-tier provider. Sequential (not parallel) is
 * deliberate: the whole point of pacing is bounding in-flight request rate.
 *
 * @param {object} args
 * @param {string[]} args.ids
 * @param {string} args.endpoint
 * @param {number} [args.maxTokens]
 * @param {number} [args.timeoutMs]
 * @param {number} [args.delayMs]
 * @param {typeof fetch} [args.fetchImpl]
 * @param {(ms:number) => Promise<void>} [args.sleepImpl]
 * @returns {Promise<Array<ReturnType<typeof probeModel> extends Promise<infer T> ? T : never>>}
 */
export async function probeAll({ ids, endpoint, maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = DEFAULT_TIMEOUT_MS, delayMs = DEFAULT_DELAY_MS, fetchImpl = fetch, sleepImpl = defaultSleep }) {
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    out.push(await probeModel({ endpoint, id: ids[i], maxTokens, timeoutMs, fetchImpl }));
    if (delayMs > 0 && i < ids.length - 1) await sleepImpl(delayMs);
  }
  return out;
}

// ── check 1: liveness ────────────────────────────────────────────────────────

/**
 * Build the per-provider liveness summary from probe results plus the id ->
 * provider map taken from the live /v1/models catalog.
 *
 * @param {object} args
 * @param {Array<{id:string, status:number|null, alive:boolean, throttled:boolean, reason:string}>} args.results
 * @param {Map<string,string>} args.providerById
 * @returns {{perProvider: object, deadIds: Array<object>, aliveCount:number, throttledCount:number, deadCount:number}}
 */
export function summarizeLiveness({ results, providerById }) {
  const perProvider = {};
  const deadIds = [];
  let aliveCount = 0;
  let throttledCount = 0;
  let deadCount = 0;
  for (const r of results) {
    const provider = providerById.get(r.id) || "unknown";
    if (!perProvider[provider]) perProvider[provider] = { total: 0, alive: 0, throttled: 0, dead: 0, dead_ids: [] };
    const p = perProvider[provider];
    p.total += 1;
    if (r.alive) {
      aliveCount += 1;
      p.alive += 1;
      if (r.throttled) { throttledCount += 1; p.throttled += 1; }
    } else {
      deadCount += 1;
      p.dead += 1;
      const entry = { id: r.id, provider, reason: r.reason, status: r.status };
      p.dead_ids.push(entry);
      deadIds.push(entry);
    }
  }
  return { perProvider, deadIds, aliveCount, throttledCount, deadCount };
}

// ── check 2: representation ─────────────────────────────────────────────────

/**
 * A provider the gateway itself calls healthy (`ok:true` in
 * GET /admin/models/status) but that is completely absent from GET /v1/models
 * is the exact 2026-08-14 openrouter shape: total absence, not a bad entry.
 * Requires some positive evidence the provider has models (its last reported
 * count, or what discovery collected for it) so a provider that has
 * legitimately never had models is not flagged.
 *
 * @param {object} args
 * @param {object} args.statusProviders   /admin/models/status .providers
 * @param {Map<string,Set<string>>} args.collectedByProvider
 * @param {Map<string,Set<string>>} args.advertisedByProvider
 * @returns {Array<{provider:string, provider_says:number, collected:number}>}
 */
export function computeRepresentationGaps({ statusProviders = {}, collectedByProvider = new Map(), advertisedByProvider = new Map() }) {
  const gaps = [];
  for (const [name, p] of Object.entries(statusProviders)) {
    if (p?.ok !== true) continue;
    const advertised = advertisedByProvider.get(name)?.size ?? 0;
    if (advertised > 0) continue;
    const collected = collectedByProvider.get(name)?.size ?? 0;
    const providerSays = typeof p.count === "number" ? p.count : 0;
    if (collected > 0 || providerSays > 0) {
      gaps.push({ provider: name, provider_says: providerSays, collected });
    }
  }
  return gaps;
}

// ── check 3: count divergence (informational) ──────────────────────────────

/**
 * Per-provider three-way count table for diagnosability. Never itself an
 * alarm condition - see the module doc comment for why.
 *
 * @param {object} args
 * @param {object} args.statusProviders
 * @param {Map<string,Set<string>>} args.collectedByProvider
 * @param {Map<string,Set<string>>} args.advertisedByProvider
 * @returns {Array<{provider:string, provider_says:number|null, collected:number, advertised:number, collected_not_advertised_ids:string[]}>}
 */
export function computeCountDivergence({ statusProviders = {}, collectedByProvider = new Map(), advertisedByProvider = new Map() }) {
  const providers = new Set([
    ...Object.keys(statusProviders),
    ...collectedByProvider.keys(),
    ...advertisedByProvider.keys(),
  ]);
  const rows = [];
  for (const name of [...providers].sort()) {
    const p = statusProviders[name];
    const collectedIds = collectedByProvider.get(name) || new Set();
    const advertisedIds = advertisedByProvider.get(name) || new Set();
    const collected_not_advertised_ids = [...collectedIds].filter((id) => !advertisedIds.has(id)).sort();
    rows.push({
      provider: name,
      provider_says: p && typeof p.count === "number" ? p.count : null,
      collected: collectedIds.size,
      advertised: advertisedIds.size,
      collected_not_advertised_ids,
    });
  }
  return rows;
}

// ── check 4: failover redundancy ────────────────────────────────────────────

/**
 * Validate every registry.yaml failover.local_fallback entry with a REAL
 * completion (never catalog membership - that is exactly what lied before).
 *
 * @param {object} args
 * @param {string} args.registryPath
 * @param {string} args.endpoint
 * @param {number} [args.maxTokens]
 * @param {number} [args.timeoutMs]
 * @param {number} [args.delayMs]
 * @param {typeof fetch} [args.fetchImpl]
 * @param {(ms:number) => Promise<void>} [args.sleepImpl]
 * @param {(path?:string) => Array<{model:string, backend:string|null}>} [args.resolveCandidatesFn]
 * @returns {Promise<{candidates:Array<object>, entries:Array<object>, liveCount:number, alarm:boolean}>}
 */
export async function checkFailoverRedundancy({
  registryPath,
  endpoint,
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delayMs = DEFAULT_DELAY_MS,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  resolveCandidatesFn = resolveFailoverCandidates,
}) {
  const candidates = resolveCandidatesFn(registryPath) || [];
  const ids = candidates.map((c) => c.model);
  const results = await probeAll({ ids, endpoint, maxTokens, timeoutMs, delayMs, fetchImpl, sleepImpl });
  const entries = results.map((r) => ({ model: r.id, alive: r.alive, throttled: r.throttled, reason: r.reason, status: r.status, ms: r.ms }));
  const liveCount = entries.filter((e) => e.alive).length;
  return { candidates, entries, liveCount, alarm: liveCount < MIN_FAILOVER_LIVE };
}

// ── fetching live gateway state ─────────────────────────────────────────────

/** Fetch and parse JSON from `path` off `endpoint`, or throw with a clear message. */
async function getJson(endpoint, path, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const base = String(endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(base + path, { signal: ac.signal, headers: { accept: "application/json" } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} on ${path}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── orchestration ───────────────────────────────────────────────────────────

/**
 * Run all four checks end to end against a live gateway, optionally alerting
 * on the two genuine failure conditions. I/O deps are injectable for testing.
 *
 * @param {object} [args]
 * @returns {Promise<object>} the full structured result, exit code, and which alerts fired
 */
export async function runVerification({
  endpoint = DEFAULT_ENDPOINT,
  registryPath = DEFAULT_REGISTRY_PATH,
  skipProviders = DEFAULT_SKIP_PROVIDERS,
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delayMs = DEFAULT_DELAY_MS,
  alertTtlSeconds = DEFAULT_ALERT_TTL_SECONDS,
  doAlert = false,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
  resolveCandidatesFn = resolveFailoverCandidates,
  alertImpl = fireSkAlert,
} = {}) {
  let models, adminModels, status;
  try {
    [models, adminModels, status] = await Promise.all([
      getJson(endpoint, "/v1/models", { fetchImpl }),
      getJson(endpoint, "/admin/models", { fetchImpl }),
      getJson(endpoint, "/admin/models/status", { fetchImpl }),
    ]);
  } catch (e) {
    return {
      reachable: false,
      error: e.message,
      exitCode: EXIT_ERROR,
      liveness: null,
      representation: null,
      countDivergence: null,
      failover: null,
      alertsFired: [],
    };
  }

  const advertised = models?.data || [];
  const collected = adminModels?.data || [];
  const statusProviders = status?.providers || {};

  const providerById = new Map(advertised.map((m) => [m.id, m.provider || m.owned_by || "unknown"]));
  const advertisedByProvider = groupIdsByProvider(advertised, (m) => m.provider || m.owned_by, (m) => m.id);
  const collectedByProvider = groupIdsByProvider(collected, (m) => m.provider || m.owned_by, (m) => m.id);

  const probeIds = advertised
    .filter((m) => !skipProviders.includes(m.provider || m.owned_by))
    .map((m) => m.id);
  const liveResults = await probeAll({ ids: probeIds, endpoint, maxTokens, timeoutMs, delayMs, fetchImpl, sleepImpl });
  const liveness = summarizeLiveness({ results: liveResults, providerById });
  liveness.skipped = advertised
    .filter((m) => skipProviders.includes(m.provider || m.owned_by))
    .map((m) => m.id);

  const representationGaps = computeRepresentationGaps({ statusProviders, collectedByProvider, advertisedByProvider });
  const countDivergence = computeCountDivergence({ statusProviders, collectedByProvider, advertisedByProvider });

  const failover = await checkFailoverRedundancy({
    registryPath,
    endpoint,
    maxTokens,
    timeoutMs,
    delayMs,
    fetchImpl,
    sleepImpl,
    resolveCandidatesFn,
  });

  const catalogDrift = liveness.deadCount > 0 || representationGaps.length > 0;
  const failoverDrift = failover.alarm;
  const drift = catalogDrift || failoverDrift;

  const alertsFired = [];
  if (doAlert && catalogDrift) {
    const parts = [];
    if (liveness.deadCount > 0) {
      const list = liveness.deadIds.slice(0, 10).map((d) => `${d.id}(${d.provider}):${d.reason}`).join(", ");
      parts.push(`${liveness.deadCount} dead advertised model(s): ${list}${liveness.deadIds.length > 10 ? ", ..." : ""}`);
    }
    if (representationGaps.length > 0) {
      const list = representationGaps.map((g) => `${g.provider} ok:true says:${g.provider_says} collected:${g.collected} advertised:0`).join("; ");
      parts.push(`${representationGaps.length} provider representation gap(s): ${list}`);
    }
    const message = `skgateway catalog verify FAILED (${endpoint}): ${parts.join(" | ")}`;
    const res = await alertImpl({ message, level: "crit", key: ALERT_CATALOG_KEY, ttlSeconds: alertTtlSeconds });
    alertsFired.push({ key: ALERT_CATALOG_KEY, ...res });
  }
  if (doAlert && failoverDrift) {
    const list = failover.entries.map((e) => `${e.model}:${e.alive ? "alive" : `dead(${e.reason})`}`).join(", ") || "(no entries configured)";
    const message = `skgateway failover redundancy DOWN (${endpoint}): ${failover.liveCount}/${MIN_FAILOVER_LIVE} local_fallback entries live [${list}]. If you need one, get two.`;
    const res = await alertImpl({ message, level: "crit", key: ALERT_FAILOVER_KEY, ttlSeconds: alertTtlSeconds });
    alertsFired.push({ key: ALERT_FAILOVER_KEY, ...res });
  }

  return {
    reachable: true,
    exitCode: drift ? EXIT_DRIFT : EXIT_OK,
    liveness,
    representation: { gaps: representationGaps },
    countDivergence,
    failover,
    drift,
    alertsFired,
  };
}

// ── report formatting ───────────────────────────────────────────────────────

/** @param {Awaited<ReturnType<typeof runVerification>>} result */
export function formatReport(result, endpoint) {
  const L = [];
  L.push(`SKGateway catalog + failover verification - ${endpoint}`);
  if (!result.reachable) {
    L.push(`  STATUS: UNREACHABLE - ${result.error}`);
    L.push(`  RESULT: ERROR`);
    return L.join("\n");
  }
  const { liveness, representation, countDivergence, failover } = result;

  L.push(`  1. LIVENESS: ${liveness.aliveCount} alive (${liveness.throttledCount} throttled), ${liveness.deadCount} dead` +
    (liveness.skipped.length ? `, ${liveness.skipped.length} skipped (${liveness.skipped.join(", ")})` : ""));
  for (const [provider, p] of Object.entries(liveness.perProvider)) {
    L.push(`     ${provider}: ${p.alive}/${p.total} alive (${p.throttled} throttled), ${p.dead} dead`);
    for (const d of p.dead_ids) L.push(`       DEAD ${d.id} - ${d.reason}`);
  }

  L.push(`  2. REPRESENTATION: ${representation.gaps.length} gap(s)`);
  for (const g of representation.gaps) {
    L.push(`     ALARM ${g.provider} reports ok:true (says ${g.provider_says}, collected ${g.collected}) but 0 advertised`);
  }

  L.push(`  3. COUNT DIVERGENCE (informational):`);
  for (const row of countDivergence) {
    L.push(`     ${row.provider}: provider_says=${row.provider_says ?? "n/a"} collected=${row.collected} advertised=${row.advertised}` +
      (row.collected_not_advertised_ids.length ? ` collected_not_advertised=[${row.collected_not_advertised_ids.slice(0, 8).join(", ")}${row.collected_not_advertised_ids.length > 8 ? ", ..." : ""}]` : ""));
  }

  L.push(`  4. FAILOVER REDUNDANCY: ${failover.liveCount}/${MIN_FAILOVER_LIVE} required live` + (failover.alarm ? " - ALARM" : ""));
  for (const e of failover.entries) {
    L.push(`     ${e.alive ? "alive " : "DEAD  "} ${e.model} - ${e.reason}`);
  }

  if (result.alertsFired.length) {
    for (const a of result.alertsFired) L.push(`  sk-alert ${a.key}: ${a.fired ? "fired" : `NOT fired (${a.reason})`}`);
  }

  L.push(result.drift ? "  RESULT: DRIFT" : "  RESULT: CLEAN");
  return L.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv = []) {
  const out = {
    endpoint: DEFAULT_ENDPOINT,
    registry: DEFAULT_REGISTRY_PATH,
    skipProviders: [...DEFAULT_SKIP_PROVIDERS],
    maxTokens: DEFAULT_MAX_TOKENS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    delayMs: DEFAULT_DELAY_MS,
    alert: process.env.SKGATEWAY_VERIFY_ALERT === "1",
    json: false,
    quiet: false,
    help: false,
  };
  let skipProvidersExplicit = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--endpoint": case "-e": out.endpoint = argv[++i]; break;
      case "--registry": case "-r": out.registry = argv[++i]; break;
      case "--skip-provider":
        if (!skipProvidersExplicit) { out.skipProviders = []; skipProvidersExplicit = true; }
        out.skipProviders.push(argv[++i]);
        break;
      case "--max-tokens": out.maxTokens = Number(argv[++i]) || DEFAULT_MAX_TOKENS; break;
      case "--timeout": out.timeoutMs = Number(argv[++i]) || DEFAULT_TIMEOUT_MS; break;
      case "--delay": out.delayMs = Number(argv[++i]); if (Number.isNaN(out.delayMs)) out.delayMs = DEFAULT_DELAY_MS; break;
      case "--alert": out.alert = true; break;
      case "--json": out.json = true; break;
      case "-q": case "--quiet": out.quiet = true; break;
      case "-h": case "--help": out.help = true; break;
      default:
        if (a && a.startsWith("-")) throw new Error(`unknown flag: ${a}`);
    }
  }
  return out;
}

const HELP = `verify-catalog.mjs - prove the served catalog and failover redundancy with real completions

Usage: node scripts/verify-catalog.mjs [options]

  -e, --endpoint URL        gateway base URL (default $SKGATEWAY_VERIFY_ENDPOINT or ${DEFAULT_ENDPOINT})
  -r, --registry PATH       skmodels registry path (default $SKMODELS_REGISTRY or ${DEFAULT_REGISTRY_PATH})
      --skip-provider NAME  provider to exclude from the liveness sweep, repeatable (default: ${DEFAULT_SKIP_PROVIDERS.join(",")})
      --max-tokens N        max_tokens per probe completion (default ${DEFAULT_MAX_TOKENS})
      --timeout MS          per-completion timeout (default ${DEFAULT_TIMEOUT_MS})
      --delay MS            pacing delay between completions (default ${DEFAULT_DELAY_MS})
      --alert               fire sk-alert on a genuine failure (or SKGATEWAY_VERIFY_ALERT=1)
      --json                emit structured JSON
  -q, --quiet                suppress the human report
  -h, --help                 this help

Exit: 0 clean, 1 drift, 2 gateway unreachable`;

export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log || ((s) => process.stdout.write(s + "\n"));
  const errLog = deps.errLog || ((s) => process.stderr.write(s + "\n"));
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    errLog(err.message);
    errLog(HELP);
    return EXIT_ERROR;
  }
  if (opts.help) {
    log(HELP);
    return EXIT_OK;
  }

  const result = await runVerification({
    endpoint: opts.endpoint,
    registryPath: opts.registry,
    skipProviders: opts.skipProviders,
    maxTokens: opts.maxTokens,
    timeoutMs: opts.timeoutMs,
    delayMs: opts.delayMs,
    doAlert: opts.alert,
    fetchImpl: deps.fetchImpl || fetch,
    sleepImpl: deps.sleepImpl,
    resolveCandidatesFn: deps.resolveCandidatesFn,
    alertImpl: deps.alertImpl,
  });

  if (opts.json) {
    if (!opts.quiet) log(JSON.stringify({ ...result, endpoint: opts.endpoint }, null, 2));
  } else if (!opts.quiet) {
    log(formatReport(result, opts.endpoint));
  }
  return result.exitCode;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`verify-catalog fatal: ${err.stack || err.message}\n`);
    process.exit(EXIT_ERROR);
  });
}
