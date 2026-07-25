#!/usr/bin/env node
/**
 * parity-check.mjs - declared-vs-working parity check with drift alerting.
 *
 * SKGateway card 7c99c856.
 *
 * Problem
 * ───────
 * The committed config (`config/skgateway.yaml`) DECLARES backends and the
 * models each backend serves. The LIVE running gateway can drift from that
 * declaration: a backend goes down, a model stops being served, the config
 * was hot-edited on disk but never reloaded (SIGHUP), or the running process
 * advertises a model the committed config no longer declares. This script
 * compares what the config declares against what the live gateway actually
 * serves and ALERTS on drift.
 *
 * Data sources (both already exposed by the gateway)
 * ──────────────────────────────────────────────────
 *   GET /health     → { backends: { <id>: { status, quarantined, ... } } }
 *                     the router's live per-backend health snapshot.
 *   GET /v1/models  → { data: [ { id, owned_by } ] }
 *                     the aggregated model catalog the RUNNING process
 *                     advertises (built from the config it currently has
 *                     loaded, so it reflects post-SIGHUP state, not the file).
 *
 * Because /v1/models is built from the process's live config, comparing it to
 * the committed config file catches "edited on disk but not reloaded" drift.
 *
 * Drift classes computed
 * ──────────────────────
 *   declared_not_working  A model declared in the config file is either not
 *                         advertised by the live gateway, or its owning backend
 *                         is down / quarantined / unreachable. (per-model reason)
 *   working_not_declared  A model the live gateway advertises is not declared
 *                         for any backend in the committed config (nor matched
 *                         by a declared wildcard pattern).
 *   quarantined           Backends the live /health reports as quarantined or
 *                         down - advertised but not currently serving.
 *   unreachable           Declared backends absent from live /health (the
 *                         running process doesn't know about them), plus a
 *                         top-level flag when the gateway itself can't be reached.
 *
 * Any non-empty drift class ⇒ drift, and the process exits non-zero.
 *
 * Alerting is OPT-IN (`--alert` or SKGATEWAY_PARITY_ALERT=1). It reuses the
 * gateway's own sk-alert bridge (src/integration.mjs → shared sk-alert bus when
 * ~/.skcapstone is present, else a structured stderr log). No new alert path,
 * no hardcoded URLs or secrets.
 *
 * Usage
 * ─────
 *   node scripts/parity-check.mjs [--endpoint URL] [--config PATH]
 *                                 [--json] [--alert] [--alert-level LEVEL]
 *                                 [--strict-undeclared] [--timeout MS] [-q]
 *
 *   --endpoint URL   Live gateway base URL. Default: $SKGATEWAY_PARITY_ENDPOINT
 *                    or http://localhost:18780
 *   --config PATH    Config file to treat as the declaration. Default:
 *                    $SKGATEWAY_CONFIG or config/skgateway.yaml (via loadConfig).
 *   --json           Emit the structured result as JSON (machine-readable).
 *   --alert          Emit an sk-alert on drift (also SKGATEWAY_PARITY_ALERT=1).
 *   --alert-level L  info|warn|error|critical for the alert. Default: warn.
 *   --strict-undeclared  Treat working_not_declared as drift (exit non-zero).
 *                    Default: it is REPORTED but does NOT by itself fail the run,
 *                    because advertising an extra model is lower-severity config
 *                    lag than a declared model that stopped working. Override
 *                    with this flag or SKGATEWAY_PARITY_STRICT=1.
 *   --timeout MS     Per-request fetch timeout. Default 5000.
 *   -q, --quiet      Suppress the human report (still sets the exit code).
 *
 * Exit codes
 * ──────────
 *   0  parity - no drift
 *   1  drift detected
 *   2  gateway unreachable, or a usage / config error
 *
 * @module scripts/parity-check
 */

import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";
import { alert as skAlert } from "../src/integration.mjs";

const DEFAULT_ENDPOINT = "http://localhost:18780";
const DEFAULT_TIMEOUT_MS = 5000;

// ── exit codes ────────────────────────────────────────────────────────────────
export const EXIT_OK = 0;
export const EXIT_DRIFT = 1;
export const EXIT_ERROR = 2;

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the set of concrete (non-wildcard) model ids from declared backends,
 * plus the wildcard patterns, plus a model→backend ownership map.
 *
 * @param {Record<string, {models?: string[]}>} backends
 * @returns {{ models: Set<string>, wildcards: string[], owner: Map<string,string[]> }}
 */
export function declaredModelIndex(backends = {}) {
  const models = new Set();
  const wildcards = [];
  /** @type {Map<string,string[]>} model id → backend ids that declare it */
  const owner = new Map();
  for (const [id, b] of Object.entries(backends || {})) {
    for (const m of (b?.models || [])) {
      if (typeof m !== "string" || m.length === 0) continue;
      if (m.includes("*")) {
        wildcards.push(m);
        continue;
      }
      models.add(m);
      const list = owner.get(m) || [];
      list.push(id);
      owner.set(m, list);
    }
  }
  return { models, wildcards, owner };
}

/**
 * Does a model id match any declared wildcard pattern? Patterns use a single
 * trailing/embedded `*` as in the gateway config (e.g. "dolphin-*").
 *
 * @param {string} modelId
 * @param {string[]} wildcards
 * @returns {boolean}
 */
export function matchesWildcard(modelId, wildcards = []) {
  for (const w of wildcards) {
    // Escape regex metachars except `*`, then turn `*` into `.*`.
    const re = new RegExp(
      "^" + w.replace(/[.+?^${}()|[\]\\]/g, "\\$&").split("*").join(".*") + "$",
    );
    if (re.test(modelId)) return true;
  }
  return false;
}

/**
 * Is a backend health snapshot "serving" right now?
 * A backend is serving iff it is present, not quarantined, and its status is
 * up or degraded (degraded is still selectable per the router). down / missing
 * / quarantined all count as not serving.
 *
 * @param {{status?: string, quarantined?: boolean} | undefined} h
 * @returns {boolean}
 */
export function backendServing(h) {
  if (!h) return false;
  if (h.quarantined) return false;
  return h.status === "up" || h.status === "degraded";
}

/**
 * Compute the parity delta between declared config and live gateway state.
 *
 * Pure function - no I/O. `liveHealth`/`liveModels` are the parsed bodies of
 * GET /health and GET /v1/models respectively. `reachable` is false when the
 * gateway could not be contacted at all.
 *
 * @param {object} args
 * @param {Record<string, {models?: string[]}>} args.declaredBackends
 * @param {{backends?: Record<string, object>} | null} args.liveHealth
 * @param {{data?: Array<{id: string, owned_by?: string}>} | null} args.liveModels
 * @param {boolean} [args.reachable=true]
 * @param {boolean} [args.strictUndeclared=false]
 * @returns {{
 *   drift: boolean,
 *   reachable: boolean,
 *   classes: {
 *     declared_not_working: Array<{model: string, backends: string[], reason: string}>,
 *     working_not_declared: string[],
 *     quarantined: Array<{backend: string, status: string}>,
 *     unreachable: string[],
 *   },
 *   summary: object,
 * }}
 */
export function computeParity({
  declaredBackends = {},
  liveHealth = null,
  liveModels = null,
  reachable = true,
  strictUndeclared = false,
} = {}) {
  const { models: declaredModels, wildcards, owner } = declaredModelIndex(declaredBackends);
  const liveBackends = (liveHealth && liveHealth.backends) || {};
  const liveBackendIds = new Set(Object.keys(liveBackends));

  const liveModelIds = new Set();
  for (const m of (liveModels && liveModels.data) || []) {
    if (m && typeof m.id === "string") liveModelIds.add(m.id);
  }

  const declared_not_working = [];
  const working_not_declared = [];
  const quarantined = [];
  const unreachable = [];

  if (!reachable) {
    // Gateway itself is down: everything declared is effectively not working.
    unreachable.push("<gateway>");
    return {
      drift: true,
      reachable: false,
      classes: {
        declared_not_working: [...declaredModels].sort().map((model) => ({
          model,
          backends: owner.get(model) || [],
          reason: "gateway_unreachable",
        })),
        working_not_declared: [],
        quarantined: [],
        unreachable,
      },
      summary: {
        declared_backends: Object.keys(declaredBackends).length,
        declared_models: declaredModels.size,
        live_backends: 0,
        live_models: 0,
        reachable: false,
      },
    };
  }

  // ── quarantined / down backends (advertised but not serving) ──
  for (const [id, h] of Object.entries(liveBackends)) {
    if (h && (h.quarantined || h.status === "down")) {
      quarantined.push({ backend: id, status: h.quarantined ? "quarantined" : h.status });
    }
  }

  // ── declared backends the running process doesn't know about ──
  for (const id of Object.keys(declaredBackends)) {
    if (!liveBackendIds.has(id)) unreachable.push(id);
  }

  // ── declared-but-not-working models ──
  for (const model of [...declaredModels].sort()) {
    const owners = owner.get(model) || [];
    const advertised = liveModelIds.has(model);
    // Is at least one owning backend serving right now?
    const servingOwner = owners.some((id) => backendServing(liveBackends[id]));
    if (!advertised) {
      // Live process does not advertise this declared model → config drift
      // (edited on disk but not reloaded, or model pruned in-process).
      declared_not_working.push({ model, backends: owners, reason: "not_advertised" });
    } else if (!servingOwner) {
      // Advertised but every owning backend is down / quarantined / unknown.
      const anyKnown = owners.some((id) => liveBackendIds.has(id));
      declared_not_working.push({
        model,
        backends: owners,
        reason: anyKnown ? "backend_not_serving" : "backend_unreachable",
      });
    }
  }

  // ── working-but-not-declared models ──
  for (const id of [...liveModelIds].sort()) {
    if (declaredModels.has(id)) continue;
    if (matchesWildcard(id, wildcards)) continue;
    working_not_declared.push(id);
  }

  // Drift severity: declared_not_working, quarantined, and unreachable always
  // count as drift. working_not_declared counts only in strict mode.
  const drift =
    declared_not_working.length > 0 ||
    quarantined.length > 0 ||
    unreachable.length > 0 ||
    (strictUndeclared && working_not_declared.length > 0);

  return {
    drift,
    reachable: true,
    classes: { declared_not_working, working_not_declared, quarantined, unreachable },
    summary: {
      declared_backends: Object.keys(declaredBackends).length,
      declared_models: declaredModels.size,
      declared_wildcards: wildcards.length,
      live_backends: liveBackendIds.size,
      live_models: liveModelIds.size,
      reachable: true,
      strict_undeclared: strictUndeclared,
    },
  };
}

/**
 * Fetch /health and /v1/models from the live gateway.
 *
 * @param {string} endpoint  base URL (no trailing path)
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl=fetch]
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{reachable: boolean, health: object|null, models: object|null, error?: string}>}
 */
export async function fetchLive(endpoint, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = String(endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const getJson = async (path) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(base + path, {
        signal: ac.signal,
        headers: { accept: "application/json" },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status} on ${path}`);
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    // /health is the reachability probe; /v1/models is the advertised catalog.
    const health = await getJson("/health");
    const models = await getJson("/v1/models");
    return { reachable: true, health, models };
  } catch (err) {
    return { reachable: false, health: null, models: null, error: err.message };
  }
}

/**
 * Render a human-readable parity report.
 *
 * @param {ReturnType<typeof computeParity>} result
 * @param {string} endpoint
 * @returns {string}
 */
export function formatReport(result, endpoint) {
  const L = [];
  const { classes, summary, drift } = result;
  L.push(`SKGateway parity check - ${endpoint}`);
  if (!result.reachable) {
    L.push(`  STATUS: UNREACHABLE - gateway did not respond.`);
    L.push(`  Declared models unverifiable: ${classes.declared_not_working.length}`);
    L.push(`  RESULT: DRIFT (gateway unreachable)`);
    return L.join("\n");
  }
  L.push(
    `  declared: ${summary.declared_backends} backends / ${summary.declared_models} models` +
      (summary.declared_wildcards ? ` (+${summary.declared_wildcards} wildcard patterns)` : "") +
      `   live: ${summary.live_backends} backends / ${summary.live_models} models`,
  );

  const section = (title, items, render) => {
    if (!items.length) return;
    L.push(`  ${title} (${items.length}):`);
    for (const it of items) L.push(`    - ${render(it)}`);
  };

  section("declared-but-not-working", classes.declared_not_working, (d) =>
    `${d.model} [${(d.backends || []).join(",") || "?"}] - ${d.reason}`,
  );
  section("quarantined / down backends", classes.quarantined, (q) =>
    `${q.backend} - ${q.status}`,
  );
  section("declared backends unknown to live gateway", classes.unreachable, (u) => u);
  section(
    `working-but-not-declared${summary.strict_undeclared ? "" : " (informational)"}`,
    classes.working_not_declared,
    (m) => m,
  );

  if (!drift) L.push("  RESULT: PARITY - no drift");
  else L.push("  RESULT: DRIFT");
  return L.join("\n");
}

/**
 * Run one parity check end to end: fetch live state, compute the delta,
 * optionally alert, and return the result + exit code. I/O deps are injectable
 * for testing.
 *
 * @param {object} args
 * @param {Record<string, {models?: string[]}>} args.declaredBackends
 * @param {string} [args.endpoint]
 * @param {boolean} [args.doAlert=false]
 * @param {string} [args.alertLevel="warn"]
 * @param {boolean} [args.strictUndeclared=false]
 * @param {number} [args.timeoutMs]
 * @param {typeof fetch} [args.fetchImpl]
 * @param {(event: string, payload: object, level: string) => any} [args.alertImpl]
 * @returns {Promise<{ result: ReturnType<typeof computeParity>, exitCode: number, alerted: boolean }>}
 */
export async function runParityCheck({
  declaredBackends,
  endpoint = DEFAULT_ENDPOINT,
  doAlert = false,
  alertLevel = "warn",
  strictUndeclared = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
  alertImpl = skAlert,
} = {}) {
  const live = await fetchLive(endpoint, { fetchImpl, timeoutMs });
  const result = computeParity({
    declaredBackends,
    liveHealth: live.health,
    liveModels: live.models,
    reachable: live.reachable,
    strictUndeclared,
  });
  if (!live.reachable && live.error) result.summary.fetch_error = live.error;

  let alerted = false;
  if (doAlert && result.drift) {
    // Reuse the gateway's own sk-alert bridge. Never include secrets - just the
    // drift classes and counts.
    alertImpl(
      "parity.drift",
      {
        endpoint,
        reachable: result.reachable,
        counts: {
          declared_not_working: result.classes.declared_not_working.length,
          working_not_declared: result.classes.working_not_declared.length,
          quarantined: result.classes.quarantined.length,
          unreachable: result.classes.unreachable.length,
        },
        classes: result.classes,
      },
      alertLevel,
    );
    alerted = true;
  }

  const exitCode = !result.reachable ? EXIT_ERROR : result.drift ? EXIT_DRIFT : EXIT_OK;
  return { result, exitCode, alerted };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

/**
 * Parse argv (array after the node + script args). Exposed for testing.
 * @param {string[]} argv
 * @returns {{endpoint?: string, config?: string, json: boolean, alert: boolean,
 *   alertLevel: string, strictUndeclared: boolean, timeoutMs: number,
 *   quiet: boolean, help: boolean}}
 */
export function parseArgs(argv = []) {
  const out = {
    endpoint: process.env.SKGATEWAY_PARITY_ENDPOINT || DEFAULT_ENDPOINT,
    config: process.env.SKGATEWAY_CONFIG || undefined,
    json: false,
    alert: process.env.SKGATEWAY_PARITY_ALERT === "1",
    alertLevel: process.env.SKGATEWAY_PARITY_ALERT_LEVEL || "warn",
    strictUndeclared: process.env.SKGATEWAY_PARITY_STRICT === "1",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--endpoint":
      case "-e":
        out.endpoint = argv[++i];
        break;
      case "--config":
      case "-c":
        out.config = argv[++i];
        break;
      case "--json":
        out.json = true;
        break;
      case "--alert":
        out.alert = true;
        break;
      case "--alert-level":
        out.alertLevel = argv[++i];
        break;
      case "--strict-undeclared":
        out.strictUndeclared = true;
        break;
      case "--timeout":
        out.timeoutMs = Number(argv[++i]) || DEFAULT_TIMEOUT_MS;
        break;
      case "-q":
      case "--quiet":
        out.quiet = true;
        break;
      case "-h":
      case "--help":
        out.help = true;
        break;
      default:
        if (a && a.startsWith("-")) {
          throw new Error(`unknown flag: ${a}`);
        }
    }
  }
  return out;
}

const HELP = `parity-check.mjs - declared-vs-working parity check with drift alerting

Usage: node scripts/parity-check.mjs [options]

  -e, --endpoint URL     live gateway base URL (default $SKGATEWAY_PARITY_ENDPOINT
                         or ${DEFAULT_ENDPOINT})
  -c, --config PATH      config file to treat as the declaration
                         (default $SKGATEWAY_CONFIG or config/skgateway.yaml)
      --json             emit structured JSON
      --alert            emit an sk-alert on drift (or SKGATEWAY_PARITY_ALERT=1)
      --alert-level L    info|warn|error|critical (default warn)
      --strict-undeclared  count working-but-not-declared as drift
      --timeout MS       per-request fetch timeout (default ${DEFAULT_TIMEOUT_MS})
  -q, --quiet            suppress the human report
  -h, --help             this help

Exit: 0 parity, 1 drift, 2 gateway unreachable / error`;

/**
 * CLI main. Injectable deps for testing.
 * @param {string[]} [argv=process.argv.slice(2)]
 * @param {object} [deps]
 * @returns {Promise<number>} exit code
 */
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

  let declaredBackends;
  try {
    const emitter = await (deps.loadConfig || loadConfig)({ configPath: opts.config, silent: true });
    declaredBackends = emitter.current().backends || {};
  } catch (err) {
    errLog(`config error: ${err.message}`);
    return EXIT_ERROR;
  }

  const { result, exitCode, alerted } = await runParityCheck({
    declaredBackends,
    endpoint: opts.endpoint,
    doAlert: opts.alert,
    alertLevel: opts.alertLevel,
    strictUndeclared: opts.strictUndeclared,
    timeoutMs: opts.timeoutMs,
    fetchImpl: deps.fetchImpl || fetch,
    alertImpl: deps.alertImpl || skAlert,
  });

  if (opts.json) {
    if (!opts.quiet) log(JSON.stringify({ ...result, endpoint: opts.endpoint, alerted }, null, 2));
  } else if (!opts.quiet) {
    log(formatReport(result, opts.endpoint));
    if (alerted) log("  (sk-alert emitted)");
  }
  return exitCode;
}

// Run only when invoked directly, never when imported by tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`parity-check fatal: ${err.stack || err.message}\n`);
    process.exit(EXIT_ERROR);
  });
}
