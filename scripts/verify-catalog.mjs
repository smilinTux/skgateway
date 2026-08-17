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
 * FIVE checks, all in one run, reported PER PROVIDER not just in aggregate:
 *
 *   1. LIVENESS. Every id GET /v1/models advertises gets one small real chat
 *      completion. 2xx = alive. 429 = alive-but-throttled (a free tier being
 *      rate limited is not the same failure as a dead model, and is never
 *      counted as dead). Any other 4xx/5xx, a timeout, or a network error is
 *      reported with its own distinct reason - they mean different things
 *      (a 404/410 is a retired model; a timeout can be a slow cold start).
 *      A 2xx with EMPTY `content` but non-empty `reasoning_content` is
 *      alive-but-reasoning-only, a fourth distinct outcome alongside plain
 *      alive/throttled/dead (card 8ae6b962/C17): several models in this
 *      fleet (ornith-1.0-9b, qwen3.6-27b-abliterated, qwen3.8-27b, and more
 *      arriving) spend their max_tokens budget on reasoning_content before
 *      producing a visible answer, which is a capability fact about that
 *      probe, never a liveness failure and never dead.
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
 *   5. ROLE FIDELITY. Each chat ROLE gets a completion and the answer must come
 *      from the model that role RESOLVES to, read from x-sk-model-served (card
 *      3351d25b/A6.2), which on a failover names the serving attempt. The other
 *      four are structurally blind to this: roles are not in GET /v1/models at
 *      all, and a substituted role is ALIVE. Measured 2026-08-16, both 200 the
 *      whole time: sk-creative (the ABLITERATED role) answered by
 *      openai/gpt-oss-20b, which inverts the capability rather than degrading
 *      it; and sk-default answered from cloud through a ~4h outage of .100,
 *      which HID the outage behind healthy responses. A role that ERRORS is not
 *      a fidelity failure (failing loudly is correct for a no_failover backend,
 *      and liveness is check 1's job) - only served-but-wrong counts.
 *
 * ALERTING. Exactly three genuine failure conditions page (ALERT_CATALOG_KEY /
 * ALERT_FAILOVER_KEY / ALERT_ROLE_KEY below): a dead/unrepresented advertised
 * model, failover redundancy below 2, and a role answered by a model it does
 * not resolve to. All three go through scripts/lib/sk-alert.mjs, which
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
 * TOKEN FLOOR (card 8ae6b962/C17). DEFAULT_MAX_TOKENS used to be a flat 24,
 * independent of src/discovery/capability-assessment.mjs's
 * MIN_OUTPUT_TOKEN_LADDER ([64, 256, 1024, 2048]), which exists precisely
 * because several models here emit `reasoning_content` with EMPTY `content`
 * below that ceiling. Measured 2026-08-15 through this gateway:
 * ornith-1.0-9b, qwen3.6-27b-abliterated and qwen3.8-27b all returned
 * HTTP 200 with empty `content` and populated `reasoning_content` at
 * max_tokens=24 (finish_reason "length" - they spent the whole budget
 * thinking). ornith-1.0-9b needed 256 before content ever appeared in this
 * run, but reasoning length varies call to call, and the assessment module
 * already documents Ornith needing the full 2048 rung in other runs. Rather
 * than pick a new round number, DEFAULT_MAX_TOKENS now reuses that module's
 * ladder ceiling directly (imported, not copied), so the two floors agree by
 * construction: raise the ladder there and this job's floor rises with it.
 *
 * COST OF THE RAISE. This does not change how many requests the sweep makes
 * (still one liveness probe per advertised id, minus --skip-provider, plus
 * the failover list) so any RPM/RPD-shaped free-tier limit is unaffected.
 * It raises the per-request max_tokens CEILING from 24 to 2048 (85x), but a
 * model that isn't reasoning-heavy stops itself at finish_reason "stop" well
 * under the old 24-token cap regardless (measured: qwen3.8-27b-ud-q5_k_xl
 * answered in 15 completion tokens even offered room), so the raise costs
 * those models nothing. For the reasoning-heavy models this card exists for,
 * measured actual completion_tokens once they produced content ranged 64 to
 * 408 on this fleet's self-hosted ornith/qwen backends (compute time on our
 * own hardware, not third-party quota) - nowhere near the 2048 ceiling in
 * practice, though a model that never converges could still hit it. The
 * free-tier providers (nvidia/openrouter/opencode, 57 of the 63 non-skipped
 * ids as of 2026-08-15) have not individually been characterized as
 * reasoning-heavy or not; if this raise starts producing FreeUsageLimitError
 * on the daily cadence, that is the signal to drop cadence or cap
 * max_tokens per-provider, not a reason to preemptively halve a cadence that
 * has not yet been shown to cost anything extra for most of the catalog.
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
 *       --max-tokens N       max_tokens per probe completion (default: the
 *                            capability-assessment ladder ceiling, see the
 *                            TOKEN FLOOR section above)
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
import { resolveFailoverCandidates, loadRegistry, REGISTRY_PATH } from "../src/proxy/registry.mjs";
import { fireSkAlert } from "./lib/sk-alert.mjs";
import { MIN_OUTPUT_TOKEN_LADDER } from "../src/discovery/capability-assessment.mjs";

export const DEFAULT_ENDPOINT = process.env.SKGATEWAY_VERIFY_ENDPOINT || "http://localhost:18780";
export const DEFAULT_REGISTRY_PATH = process.env.SKMODELS_REGISTRY || REGISTRY_PATH;
export const DEFAULT_SKIP_PROVIDERS = ["anthropic"];
// Reuses capability-assessment.mjs's own ladder ceiling rather than a
// hand-picked number, so the two modules agree BY CONSTRUCTION (card
// 8ae6b962/C17). See the TOKEN FLOOR section of this module's doc comment
// for what was measured.
export const DEFAULT_MAX_TOKENS = Math.max(...MIN_OUTPUT_TOKEN_LADDER);
export const DEFAULT_TIMEOUT_MS = 45000;
export const DEFAULT_DELAY_MS = 500;
export const DEFAULT_ALERT_TTL_SECONDS = 43200; // 12h: re-pages once per calendar day on a daily cadence, not once per run

export const ALERT_CATALOG_KEY = "skgateway-catalog-verify";
export const ALERT_FAILOVER_KEY = "skgateway-failover-redundancy";
/** Dedupe key for the role-substitution page (card ba782c14). Distinct from the
 *  catalog key so a substituted role and a dead advertised model do not
 *  suppress each other through sk-alert's -k/-t window. */
export const ALERT_ROLE_KEY = "skgateway-role-fidelity";
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
 * A 2xx whose body carries empty `content` alongside non-empty
 * `reasoning_content` is a fourth outcome, alive-but-reasoning-only (card
 * 8ae6b962/C17): the model answered the request, in the sense that it used
 * the whole probe budget thinking about it, which is a capability fact about
 * that max_tokens value, not evidence the model is unreachable or broken.
 * Classifying it as plain dead is exactly the false-DEAD class this card
 * exists to close off; classifying it as plain alive would hide a real (if
 * benign) signal that this probe's token budget was too tight for this
 * model. `content`/`reasoningContent` are optional so callers that never
 * parsed a body (e.g. tests stubbing `{status}` only) fall through to the
 * existing plain alive/dead behavior unchanged.
 *
 * @param {{status?:number, timedOut?:boolean, networkError?:string, content?:string|null, reasoningContent?:string|null}} outcome
 * @returns {{alive:boolean, throttled:boolean, reasoningOnly?:boolean, reason:string}}
 */
export function classifyProbe({ status, timedOut = false, networkError = null, content = null, reasoningContent = null } = {}) {
  // A connection-level failure talking to OUR OWN gateway says nothing about
  // the model. It says the gateway was not there.
  //
  // Measured 2026-08-15: a sweep reported 24 NVIDIA models DEAD with
  // `network_error: fetch failed`, in one contiguous block. Every one of them
  // returned 200 when probed individually seconds later, and the same run's
  // failover check found a model ALIVE that its own liveness check had just
  // called dead. The journal showed the gateway took a SIGTERM mid-sweep (it is
  // restarted by skoperator, and by operators) and the failures were simply the
  // restart window.
  //
  // Reporting those as dead models would page daily and be ignored inside a
  // week, which costs more than the check is worth. `unreachable` is a distinct,
  // non-fatal outcome: the caller re-checks gateway health and retries rather
  // than condemning anything.
  if (networkError) {
    return { alive: false, throttled: false, unreachable: true, reason: `gateway_unreachable: ${networkError}` };
  }
  if (timedOut) return { alive: false, throttled: false, reason: "timeout" };
  if (typeof status !== "number") return { alive: false, throttled: false, reason: "no_response" };
  if (status === 429) return { alive: true, throttled: true, reason: "http_429" };
  if (status >= 200 && status < 300) {
    const hasContent = typeof content === "string" && content.trim().length > 0;
    const hasReasoning = typeof reasoningContent === "string" && reasoningContent.trim().length > 0;
    if (!hasContent && hasReasoning) {
      return { alive: true, throttled: false, reasoningOnly: true, reason: "reasoning_only_empty_content" };
    }
    return { alive: true, throttled: false, reason: `http_${status}` };
  }
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
    // Only a 2xx body is worth parsing: it is the only case classifyProbe
    // does anything with content/reasoningContent for. A body that fails to
    // parse (or a stub in a test that returns no .json()) must never crash
    // the probe - it just means we have no content evidence either way, and
    // classifyProbe falls back to its plain status-only behavior.
    let content = null, reasoningContent = null;
    if (resp.status >= 200 && resp.status < 300) {
      try {
        const parsed = await resp.json();
        const message = parsed?.choices?.[0]?.message || {};
        if (typeof message.content === "string") content = message.content;
        if (typeof message.reasoning_content === "string") reasoningContent = message.reasoning_content;
      } catch {
        // no body evidence, see above
      }
    }
    const cls = classifyProbe({ status: resp.status, content, reasoningContent });
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
    let r = await probeModel({ endpoint, id: ids[i], maxTokens, timeoutMs, fetchImpl });

    // The gateway went away. Wait for it to come back and re-probe this id
    // once before recording anything, so a restart window does not turn into a
    // block of false DEADs (see classifyProbe's note). Bounded and best-effort:
    // if it does not return, the id keeps its `unreachable` outcome, which the
    // summary reports separately and never alerts on.
    if (r.unreachable) {
      const back = await waitForGateway({ endpoint, fetchImpl, sleepImpl });
      if (back) r = await probeModel({ endpoint, id: ids[i], maxTokens, timeoutMs, fetchImpl });
    }

    out.push(r);
    if (delayMs > 0 && i < ids.length - 1) await sleepImpl(delayMs);
  }
  return out;
}

/**
 * Poll the gateway's own health endpoint until it answers, or give up.
 * Deliberately short and bounded: this exists to ride out a service restart
 * (measured at roughly 6 to 10 seconds on this fleet), not to wait out an
 * outage. Returns true when the gateway answered.
 *
 * @param {object} args
 * @param {string} args.endpoint
 * @param {typeof fetch} [args.fetchImpl]
 * @param {(ms:number) => Promise<void>} [args.sleepImpl]
 * @param {number} [args.attempts]
 * @param {number} [args.intervalMs]
 * @returns {Promise<boolean>}
 */
export async function waitForGateway({ endpoint, fetchImpl = fetch, sleepImpl = defaultSleep, attempts = 10, intervalMs = 3000 }) {
  for (let i = 0; i < attempts; i++) {
    await sleepImpl(intervalMs);
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 5000);
      try {
        const resp = await fetchImpl(`${endpoint}/v1/models`, { signal: ac.signal, headers: { accept: "application/json" } });
        if (resp && resp.ok) return true;
      } finally {
        clearTimeout(t);
      }
    } catch {
      // still down, keep waiting
    }
  }
  return false;
}

// ── check 1: liveness ────────────────────────────────────────────────────────

/**
 * Build the per-provider liveness summary from probe results plus the id ->
 * provider map taken from the live /v1/models catalog.
 *
 * @param {object} args
 * @param {Array<{id:string, status:number|null, alive:boolean, throttled:boolean, reasoningOnly?:boolean, reason:string}>} args.results
 * @param {Map<string,string>} args.providerById
 * @returns {{perProvider: object, deadIds: Array<object>, reasoningOnlyIds: Array<object>, aliveCount:number, throttledCount:number, reasoningOnlyCount:number, deadCount:number}}
 */
export function summarizeLiveness({ results, providerById }) {
  const perProvider = {};
  const deadIds = [];
  const unreachableIds = [];
  const reasoningOnlyIds = [];
  let aliveCount = 0;
  let throttledCount = 0;
  let reasoningOnlyCount = 0;
  let deadCount = 0;
  let unreachableCount = 0;
  for (const r of results) {
    const provider = providerById.get(r.id) || "unknown";
    if (!perProvider[provider]) {
      perProvider[provider] = { total: 0, alive: 0, throttled: 0, reasoning_only: 0, dead: 0, unreachable: 0, dead_ids: [], reasoning_only_ids: [] };
    }
    const p = perProvider[provider];
    p.total += 1;
    if (r.alive) {
      aliveCount += 1;
      p.alive += 1;
      if (r.throttled) { throttledCount += 1; p.throttled += 1; }
      // Reasoning-only is a sub-fact about an ALIVE result (card 8ae6b962/C17):
      // the model answered the probe, it just spent the whole budget getting
      // there. Counted alongside throttled, never subtracted from aliveCount,
      // and never landing in deadIds - that is what pages.
      if (r.reasoningOnly) {
        reasoningOnlyCount += 1;
        p.reasoning_only += 1;
        const entry = { id: r.id, provider, ms: r.ms };
        p.reasoning_only_ids.push(entry);
        reasoningOnlyIds.push(entry);
      }
    } else if (r.unreachable) {
      // The gateway was not reachable for this probe, so we learned NOTHING
      // about the model. Counted and reported separately, never as dead, and
      // never alerted on: this is our own availability, not catalog drift.
      unreachableCount += 1;
      p.unreachable += 1;
      unreachableIds.push({ id: r.id, provider, reason: r.reason, status: r.status });
    } else {
      deadCount += 1;
      p.dead += 1;
      const entry = { id: r.id, provider, reason: r.reason, status: r.status };
      p.dead_ids.push(entry);
      deadIds.push(entry);
    }
  }
  return { perProvider, deadIds, unreachableIds, reasoningOnlyIds, aliveCount, throttledCount, reasoningOnlyCount, deadCount, unreachableCount };
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

// ── 5. ROLE FIDELITY ────────────────────────────────────────────────────────

/**
 * Ask each chat ROLE for a completion and assert the answer came from the model
 * that role actually resolves to. Card ba782c14.
 *
 * The other four checks cannot see this failure. Roles are not in
 * GET /v1/models at all, so the liveness sweep never touches them, and the
 * failure mode is not "no answer" but "an answer from something else", which
 * every liveness-shaped check reads as healthy.
 *
 * Two measured incidents on 2026-08-16, both HTTP 200 the whole time:
 *   sk-creative, the ABLITERATED role, answered by openai/gpt-oss-20b after its
 *     sovereign backend was refused. A guardrailed model serving an uncensored
 *     role does not degrade it, it inverts it.
 *   sk-default, during a ~4h outage of .100, also answered from cloud, which
 *     HID the outage. Every probe stayed green while the box was gone.
 *
 * Skips what it cannot meaningfully assert: marker roles like sk-auto, which
 * resolve per-request by design, and non-chat backends like embeddings.
 *
 * @returns {Promise<{entries:object[], mismatches:object[], alarm:boolean}>}
 */
export async function checkRoleFidelity({
  registryPath,
  endpoint,
  maxTokens = DEFAULT_MAX_TOKENS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delayMs = DEFAULT_DELAY_MS,
  fetchImpl = fetch,
  sleepImpl = defaultSleep,
} = {}) {
  const reg = loadRegistry(registryPath);
  const backends = reg?.backends || {};
  const roles = reg?.roles || {};
  const base = String(endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");

  const entries = [];
  let first = true;
  for (const [role, target] of Object.entries(roles)) {
    const backend = backends[target];
    // A marker (sk-auto -> "auto") has no backend entry; embeddings are not
    // chat completions. Neither is broken, so neither is reported as such.
    if (!backend || (backend.kind && backend.kind !== "chat")) continue;

    if (!first) await sleepImpl(delayMs);
    first = false;

    const expected = backend.model;
    let served = null;
    let error = null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(`${base}/v1/chat/completions`, {
        method: "POST",
        signal: ac.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: role,
          messages: [{ role: "user", content: PROBE_PROMPT }],
          max_tokens: maxTokens,
        }),
      });
      // Prefer the header the gateway now attaches (card 3351d25b / A6.2): on a
      // failover it names the SERVING attempt specifically. Fall back to the
      // body's model for a gateway that predates it.
      const hdr = resp.headers?.get?.("x-sk-model-served");
      const body = await resp.json().catch(() => null);
      served = hdr || body?.model || null;
      if (!resp.ok) error = `http_${resp.status}`;
    } catch (e) {
      error = e?.name === "AbortError" ? "timeout" : `network:${e?.message || e}`;
    } finally {
      clearTimeout(timer);
    }

    // A role that FAILS is not a fidelity problem. Failing loudly is the correct
    // behaviour for a non-substitutable backend (no_failover), and liveness is
    // check 1's job. Only a served-but-wrong answer is a mismatch here.
    const faithful = error ? null : served === expected;
    entries.push({ role, backend: target, expected, served, error, faithful });
  }

  const mismatches = entries.filter((e) => e.faithful === false);
  return { entries, mismatches, alarm: mismatches.length > 0 };
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

  const roleFidelity = await checkRoleFidelity({
    registryPath,
    endpoint,
    maxTokens,
    timeoutMs,
    delayMs,
    fetchImpl,
    sleepImpl,
  });

  const catalogDrift = liveness.deadCount > 0 || representationGaps.length > 0;
  const failoverDrift = failover.alarm;
  // A substituted role is drift in its own right. It cannot show up in the other
  // three: roles are not in GET /v1/models, and a substituted role is ALIVE.
  const roleDrift = roleFidelity.alarm;
  const drift = catalogDrift || failoverDrift || roleDrift;

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

  // Role fidelity pages too. It shipped in the previous commit setting the exit
  // code but firing NO alert, which is the same defect the check exists to
  // catch, one layer up: detected, then not announced. The scheduled job runs
  // with notify: off and depends entirely on this sk-alert call, so without it
  // a silent substitution would be found daily and told to nobody.
  if (doAlert && roleDrift) {
    const list = roleFidelity.mismatches
      .map((m) => `${m.role}: expected ${m.expected} (${m.backend}), SERVED ${m.served}`)
      .join("; ");
    const message =
      `skgateway ROLE SUBSTITUTION (${endpoint}): ${roleFidelity.mismatches.length} role(s) answered by a model ` +
      `they do not resolve to [${list}]. A 200 from the wrong model is not degraded service, it can invert the ` +
      `capability (a guardrailed model answering an uncensored role) and it hides outages behind healthy responses.`;
    const res = await alertImpl({ message, level: "crit", key: ALERT_ROLE_KEY, ttlSeconds: alertTtlSeconds });
    alertsFired.push({ key: ALERT_ROLE_KEY, ...res });
  }

  return {
    reachable: true,
    exitCode: drift ? EXIT_DRIFT : EXIT_OK,
    liveness,
    representation: { gaps: representationGaps },
    countDivergence,
    failover,
    roleFidelity,
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

  L.push(`  1. LIVENESS: ${liveness.aliveCount} alive (${liveness.throttledCount} throttled, ${liveness.reasoningOnlyCount} reasoning-only), ${liveness.deadCount} dead` +
    (liveness.unreachableCount ? `, ${liveness.unreachableCount} UNREACHABLE (gateway was down, not model evidence)` : "") +
    (liveness.skipped.length ? `, ${liveness.skipped.length} skipped (${liveness.skipped.join(", ")})` : ""));
  for (const [provider, p] of Object.entries(liveness.perProvider)) {
    L.push(`     ${provider}: ${p.alive}/${p.total} alive (${p.throttled} throttled, ${p.reasoning_only} reasoning-only), ${p.dead} dead`);
    for (const d of p.dead_ids) L.push(`       DEAD ${d.id} - ${d.reason}`);
    // Reasoning-only is a capability fact, not a failure - reported for
    // diagnosability alongside dead_ids, but with no ALARM/DEAD label and
    // never counted against liveness.deadCount (card 8ae6b962/C17).
    for (const ro of p.reasoning_only_ids) L.push(`       reasoning-only ${ro.id} - answered, spent the probe budget thinking`);
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

  const rf = result.roleFidelity;
  if (rf) {
    L.push(`  5. ROLE FIDELITY: ${rf.mismatches.length} substituted` + (rf.alarm ? " - ALARM" : ""));
    for (const e of rf.entries) {
      if (e.faithful === false) {
        // Name both sides: "wrong model" is not actionable, "asked for the
        // abliterated model and got a cloud one" is.
        L.push(`     SUBSTITUTED ${e.role} -> expected ${e.expected} (${e.backend}), SERVED ${e.served}`);
      } else if (e.error) {
        L.push(`     unchecked   ${e.role} - ${e.error} (a failing role is check 1's business, not fidelity)`);
      } else {
        L.push(`     ok          ${e.role} -> ${e.served}`);
      }
    }
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
