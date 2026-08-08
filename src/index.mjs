#!/usr/bin/env node
/**
 * SKGateway — Enterprise AI Inference Proxy
 *
 * "BlueCoat for AI" — sits between any client and any LLM backend.
 * Routes, monitors, audits, and secures all AI inference traffic.
 *
 * Usage:
 *   node src/index.mjs [--port 18780] [--config ./config/skgateway.yaml]
 */

import http from "node:http";
import { loadConfig, getConfig } from "./config.mjs";
import { createProxyServer, handleRequest, buildConfig } from "./proxy/core.mjs";
import { createRouter, routeAndSend } from "./proxy/router.mjs";
import { buildModelCatalog, reconcileModeFromConfig, tagLocalModels, mergeDiscoveredCatalog, isModelAvailable } from "./proxy/advertise.mjs";
import { loadAllowlist, saveAllowlist, applyAllowlist } from "./advertise.mjs";
import { discoverCatalog, loadCache, saveCache, fetchNvidia, fetchOpenRouter, catalogStatus, loadCardOverrides, applyCardOverlays } from "./discovery.mjs";
import { getPool, resetPool } from "./proxy/connection-pool.mjs";
import { loadAgentRegistry, extractIdentity, ANONYMOUS_AGENT_ID } from "./identity/capauth.mjs";
import { createAuthzClient } from "./policy/authz_decide.mjs";
import { classifyRoute } from "./policy/authz_routes.mjs";
import { authzEnforceEnabled, authorizeRequest } from "./policy/authz_gate.mjs";
import { isInternalRemote } from "./policy/net_trust.mjs";
import { classifyRequest, toSiemEvent } from "./classifiers/engine.mjs";
import { handleModuleManifest } from "./operator/manifest.mjs";
import { fromAnthropicRequest, toAnthropicMessage, modelRetrieveObject } from "./proxy/anthropic-frontend.mjs";
import { SSEWriter, jsonToSSE } from "./proxy/stream.mjs";
import { getLifecycle } from "./discovery/model_catalog_store.mjs";
import { isRoutable, LIFECYCLE_STATES } from "./discovery/lifecycle.mjs";
import { rankModels } from "./ranking/rank.mjs";
import { deriveCapabilities } from "./ranking/capabilities.mjs";
import { REGISTRY_PATH } from "./proxy/registry.mjs";
import { readFileSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";

// ─── Parse CLI args ───
const args = process.argv.slice(2);
// Left null so config.mjs resolveConfigPath() can apply its precedence:
//   --config > $SKGATEWAY_CONFIG > ~/.skcapstone/gateway/skgateway.yaml (synced)
//   > in-repo config/skgateway.yaml. Forcing the in-repo path here would pin
//   every host to the hand-edited, drift-prone in-repo file (CR-1.5).
let configPath = null;
let portOverride = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--config" && args[i + 1]) configPath = args[++i];
  if (args[i] === "--port" && args[i + 1]) portOverride = parseInt(args[++i], 10);
}

// ─── Load config ───
const _cfgEmitter = await loadConfig({ configPath });
const config = _cfgEmitter.current();
const port = portOverride || config.server?.port || 18780;
const bind = config.server?.bind || "127.0.0.1";

// ─── Initialize subsystems ───
// Map YAML credentials_path → credentials_file (Backend reads credentials_file)
const _routerBackends = {};
for (const [id, b] of Object.entries(config.backends || {})) {
  _routerBackends[id] = { ...b };
  if (b.credentials_path && !b.credentials_file) {
    _routerBackends[id].credentials_file = b.credentials_path;
  }
}
const router = createRouter({ backends: _routerBackends, quarantine: config.quarantine, routing: config.routing });

// Advertised-vs-working reconciliation mode (card 5c680ee9). The /v1/models
// catalog is reconciled against live backend health so callers are not offered
// models whose only backend(s) are down or quarantined. Default "flag" is
// non-breaking (annotate status, hide nothing). See src/proxy/advertise.mjs.
const advertiseReconcileMode = reconcileModeFromConfig(config);
console.log(`[skgateway] advertised-catalog reconcile mode: ${advertiseReconcileMode}`);

// ─── Dynamic provider-model discovery (Task 5, wiring Tasks 1-4) ───
// Periodically polls the live NVIDIA + OpenRouter free-chat catalogs (see
// src/discovery.mjs) and merges them with the statically-configured local
// backends into one in-memory catalog. GET /v1/models and GET /admin/models
// both read this catalog through getDiscoveredCatalog(); the on-disk
// allowlist (src/advertise.mjs) then filters what actually gets advertised.
// Fail-soft end to end: a provider fetch error falls back to the on-disk
// cache (loadCache/saveCache) and never blocks startup or breaks /v1/models.
let _catalog = [];
const _discoveryCache = loadCache();

/**
 * The static/local backend model lists already declared in config.backends
 * (ornith/beellama/ollama/anthropic/...), tagged like a discovery result.
 * Excludes nvidia/openrouter, whose ids come from the live discovery fetch
 * below instead of the (mostly hand-curated) static list.
 *
 * Each id is tagged with the OWNING backend's name as `provider` (not a
 * blanket "local"), and `free` is set per-backend rather than hardcoded true:
 * a paid cloud backend (anthropic, detected via isAnthropicBackend: oauth
 * auth_type or an api.anthropic.com URL) must NOT be advertised as free+local,
 * since /v1/models feeds the skchat model picker, which groups by provider
 * and marks "free" models for cost-free use. Mislabeling paid Claude models
 * that way is a cost footgun, not just a display nit. Genuinely-local
 * backends (ornith/beellama/ollama/...) keep free:true. This tagging is
 * catalog-display only; routing itself is driven by the reconciled
 * `owned_by` field from buildModelCatalog(), not by this provider/free tag.
 *
 * The per-model free/provider tagging is the pure tagLocalModels() helper in
 * src/proxy/advertise.mjs (unit-tested there); this wrapper just feeds it the
 * live config's backends.
 */
function localModels(cfg) {
  return tagLocalModels(cfg.backends || {});
}

function providerBackend(provider) {
  return provider === "nvidia" ? "nvidia" : provider === "openrouter" ? "openrouter" : null;
}

/**
 * Filter a list of model ids down to the ones whose lifecycle state is
 * routable (active|suspect). Card P1.4: an id already known eol/dead must
 * never be wired into a Backend's candidate list. Pure aside from the
 * injected lookup (defaults to the real on-disk store,
 * model_catalog_store.getLifecycle), so callers stay unit-testable without
 * booting the whole gateway.
 *
 * @param {string[]} ids
 * @param {(id: string) => object} [getLifecycleFn]
 * @returns {string[]}
 */
export function filterRoutableModelIds(ids, getLifecycleFn = getLifecycle) {
  return ids.filter((id) => isRoutable(getLifecycleFn(id)));
}

/**
 * Wire discovered ids into the actual routing table. The router has no
 * dynamic "registerModel" call (see src/proxy/router.mjs): a Backend decides
 * what it serves purely from its own `models` array (Backend#supportsModel),
 * so we set that array directly on the live Backend instance the router
 * already holds (router.getBackend(name)). Each refresh RECOMPUTES the array
 * as (config-declared static models) union (this cycle's discovered ids) for
 * that provider, instead of appending, so a model that drops out of a
 * provider's catalog also drops out of routing instead of accumulating
 * forever.
 *
 * Card P1.4: before writing that union into Backend.models, it is filtered
 * to only `active|suspect` ids (filterRoutableModelIds above). An id already
 * known eol/dead therefore can never be picked, or failed over to, by the
 * EXISTING candidatesFor()/failover loop in router.mjs, with zero changes to
 * that loop itself.
 *
 * `opts.getBackend`/`opts.getLifecycleFn` default to the real router/store
 * and exist purely so this function stays unit-testable without booting the
 * whole gateway (see tests/advertise-lifecycle.test.mjs).
 *
 * @param {object} cfg
 * @param {Array<{id:string, provider?:string}>} catalog
 * @param {{getBackend?: (name:string)=>object, getLifecycleFn?: (id:string)=>object}} [opts]
 */
export function registerDiscoveredRoutes(cfg, catalog, opts = {}) {
  const getBackend = opts.getBackend || ((name) => router.getBackend(name));
  const getLifecycleFn = opts.getLifecycleFn || getLifecycle;
  const byProvider = new Map();
  for (const m of catalog) {
    const be = providerBackend(m.provider);
    if (!be) continue;
    if (!byProvider.has(be)) byProvider.set(be, new Set());
    byProvider.get(be).add(m.id);
  }
  for (const [name, ids] of byProvider) {
    const backend = getBackend(name);
    if (!backend) continue; // provider not configured as a router backend, nothing to route to
    const staticModels = (cfg.backends?.[name]?.models || []).filter((x) => typeof x === "string");
    const merged = [...new Set([...staticModels, ...ids])];
    backend.models = filterRoutableModelIds(merged, getLifecycleFn);
    // Lifecycle pruning can legitimately empty this list (every known id for
    // this provider is currently eol/dead). Backend#supportsModel() treats an
    // EMPTY models array as "wildcard match everything" UNLESS the backend is
    // flagged `discovery`-managed (router.mjs:398), and this function IS the
    // discovery route registrar for nvidia/openrouter, whether or not the
    // operator also set config.backends.<name>.discovery in YAML. Without
    // this guard an all-eol provider would flip from "serves nothing"
    // (correct) to "serves everything" (exactly what P1.4 exists to prevent).
    if (backend.models.length === 0) backend.discovery = backend.discovery || name;
  }
}

/**
 * Layer the lifecycle view on top of a merged /v1/models-shaped catalog
 * (card P1.4): `eol`/`dead` ids are hidden entirely, `suspect` ids stay
 * present but gain a `lifecycle: "suspect"` flag (mirrors the existing
 * `status: "unavailable"` reconcile convention in src/proxy/advertise.mjs:
 * annotate, don't silently disappear, for a state that can still recover).
 * `active` ids (the overwhelming common case) pass through unchanged, so
 * `/v1/models` stays an additive superset. Composes with (does not replace)
 * the existing allowlist filter (apply after applyAllowlist()), same as the
 * lifecycle filter composing with the reconcile-mode status field. Pure
 * aside from the injected lookup, for the same testability reason as
 * filterRoutableModelIds above.
 *
 * @param {Array<object>} data
 * @param {(id: string) => object} [getLifecycleFn]
 * @returns {Array<object>}
 */
export function applyLifecycleView(data, getLifecycleFn = getLifecycle) {
  const out = [];
  for (const m of data) {
    const lc = getLifecycleFn(m.id);
    if (!isRoutable(lc)) continue; // hide eol/dead
    out.push(lc.state === LIFECYCLE_STATES.SUSPECT ? { ...m, lifecycle: "suspect" } : m);
  }
  return out;
}

/**
 * Lifecycle state counts over a catalog (card P1.4, GET /admin/models/status).
 * Pure aside from the injected lookup, same reason as above.
 *
 * @param {Array<{id:string}>} catalog
 * @param {(id: string) => object} [getLifecycleFn]
 * @returns {{active:number, suspect:number, eol:number, dead:number}}
 */
export function lifecycleCounts(catalog, getLifecycleFn = getLifecycle) {
  const counts = { active: 0, suspect: 0, eol: 0, dead: 0 };
  for (const m of catalog) {
    const state = getLifecycleFn(m.id)?.state;
    if (state && Object.prototype.hasOwnProperty.call(counts, state)) counts[state] += 1;
  }
  return counts;
}

/**
 * Additive picker-badge fields derived from a discovered model's card (card
 * P2.4, design doc 4.1/5.1). `card.context_length` -> `ctx_tokens`,
 * `card.supported_parameters` including `"tools"` -> `tools`,
 * `card.modality` containing `"image"` -> `vision`. Pure; returns `{}` when
 * there is no usable card (a local-backend entry never gets one; a heuristic
 * NVIDIA card still yields `tools`/`vision` booleans since `nvidia.mjs`
 * always declares `supported_parameters`/`modality`, but omits `ctx_tokens`
 * since it never claims a `context_length` it doesn't actually know, per
 * design 6.1 basis honesty). Spreading the result onto an existing
 * `/v1/models` entry can therefore only ADD keys, never null/undefined one
 * out, which is what keeps `/v1/models` a strict superset of its pre-card
 * shape (the skchat picker and any other consumer of the existing fields is
 * unaffected).
 *
 * @param {object|null|undefined} card
 * @returns {{ctx_tokens?: number, tools?: boolean, vision?: boolean}}
 */
export function deriveModelBadges(card) {
  if (!card || typeof card !== "object") return {};
  const badges = {};
  if (typeof card.context_length === "number") badges.ctx_tokens = card.context_length;
  if (Array.isArray(card.supported_parameters)) badges.tools = card.supported_parameters.includes("tools");
  if (typeof card.modality === "string") badges.vision = card.modality.includes("image");
  return badges;
}

/**
 * Layer the additive `/v1/models` picker badges onto a catalog. Pure;
 * intended to run AFTER `applyLifecycleView` (badges never affect which ids
 * are hidden/flagged, only which fields a surviving entry carries), same
 * ordering discipline as the allowlist -> lifecycle pipeline already in the
 * `/v1/models` handler.
 *
 * @param {Array<object>} data
 * @returns {Array<object>}
 */
export function applyPickerBadges(data) {
  return data.map((m) => ({ ...m, ...deriveModelBadges(m.card) }));
}

/**
 * Build the `/admin/models` payload (card P2.4): every discovered catalog
 * entry (carrying `card` already, when the provider adapter attached one -
 * card P2.1) plus the existing `advertised` allowlist flag and a NEW
 * `lifecycle` field: the full lifecycle record from the model catalog store,
 * so the console (card `e7cde8f1`) can render state/last_verified_at/
 * eol_reason/etc without a second round trip. Pure aside from the injected
 * lookup, same testability discipline as `applyLifecycleView`/
 * `lifecycleCounts` above. Deliberately does NOT hide eol/dead ids the way
 * `applyLifecycleView` does for `/v1/models`: the admin/operator view needs
 * to see every known id's lifecycle, including the ones being pruned.
 *
 * @param {Array<object>} full
 * @param {string[]} allow
 * @param {(id: string) => object} [getLifecycleFn]
 * @returns {Array<object>}
 */
export function buildAdminModelsView(full, allow, getLifecycleFn = getLifecycle) {
  const set = new Set(allow);
  return full.map((m) => ({
    ...m,
    advertised: allow.length === 0 || set.has(m.id),
    lifecycle: getLifecycleFn(m.id),
  }));
}

async function refreshCatalog(cfg) {
  const d = cfg.discovery || {};
  const nvEnabled = d.providers?.nvidia?.enabled !== false;
  const orEnabled = d.providers?.openrouter?.enabled !== false;
  const nvidiaKey = process.env[cfg.backends?.nvidia?.api_key_env || "NVIDIA_API_KEY"];
  const { models } = await discoverCatalog({
    localModels: localModels(cfg),
    nvidiaFetch: nvEnabled ? () => fetchNvidia(nvidiaKey) : async () => ({ data: [] }),
    openrouterFetch: orEnabled ? () => fetchOpenRouter() : async () => ({ data: [] }),
    cache: _discoveryCache,
  });
  _catalog = models;
  registerDiscoveredRoutes(cfg, models);
  saveCache(_discoveryCache);
  return models;
}

/**
 * Freshness summary of the discovered catalog for operator observability
 * (GET /admin/models/status, POST /admin/models/refresh). Reads the live
 * in-memory catalog + the discovery cache's `lastRefreshedAt`; the pure
 * computation lives in discovery.mjs (catalogStatus). Fail-soft: any error
 * degrades to a best-effort summary rather than throwing into the request path.
 */
export async function getDiscoveredStatus() {
  const cfg = getConfig();
  const refreshSeconds = cfg.discovery?.refresh_seconds || 3600;
  let catalog = [];
  try {
    catalog = await getDiscoveredCatalog();
  } catch {
    catalog = _catalog;
  }
  const status = catalogStatus({ catalog, cache: _discoveryCache, refreshSeconds });
  // Lifecycle counts (card P1.4): additive field, does not change any
  // existing key catalogStatus() already returns.
  return { ...status, lifecycle: lifecycleCounts(catalog) };
}

/** Current merged discovery catalog, used by both /v1/models and /admin/models. */
export async function getDiscoveredCatalog() {
  // Honor the discovery.enabled master switch on the lazy path too. Without
  // this check, a cold first request to /v1/models would still call
  // refreshCatalog() (and therefore hit the network) even with discovery
  // disabled, because the eager-startup gate above only skips the initial
  // call and the interval, not this lazy fallback.
  if (getConfig().discovery?.enabled === false) return localModels(getConfig());
  if (_catalog.length === 0) await refreshCatalog(getConfig());
  return _catalog;
}

// Kick off discovery on startup and on an interval thereafter (default
// hourly, config.discovery.refresh_seconds). A failure here is logged and
// swallowed: the gateway keeps serving on whatever catalog it already has
// (empty on a fresh install until the first successful refresh, or stale
// cache thereafter).
if (config.discovery?.enabled !== false) {
  refreshCatalog(getConfig()).catch((e) => {
    console.warn("[skgateway] initial catalog discovery failed (fail-soft, will retry):", e.message);
  });
  setInterval(() => {
    refreshCatalog(getConfig()).catch((e) => {
      console.warn("[skgateway] catalog discovery refresh failed (fail-soft, serving stale):", e.message);
    });
  }, (config.discovery?.refresh_seconds || 3600) * 1000).unref();
}

// Initialize connection pool with per-backend limits from config
const poolConfig = {
  defaultMaxConcurrent: config.pooling?.default_max_concurrent || 20,
  defaultMaxQueue: config.pooling?.default_max_queue || 1000,
  queueTimeoutMs: config.pooling?.queue_timeout_ms || 300000,
  perBackend: config.pooling?.per_backend || {},
};
const pool = getPool(poolConfig);

// Metrics collector (lazy — may not be installed yet)
let metrics = null;
try {
  const { createMetricsCollector } = await import("./metrics/collector.mjs");
  metrics = createMetricsCollector(config.metrics || {});
  console.log("[skgateway] metrics collector initialized");
} catch (e) {
  console.log("[skgateway] metrics collector not available (optional):", e.message);
}

// ─── CapAuth agent-identity registry (P2.1) ───
// Resolves every /v1/* request to a verified agent identity so routing,
// metrics, and SIEM audit all key on the same caller. Building the registry
// never blocks startup — on failure we degrade to identity disabled.
let identityRegistry = null;
const identityCfg = config.identity || {};
const identityEnabled = identityCfg.enabled !== false;
const requireAgentId = identityCfg.require_agent_id === true;
if (identityEnabled) {
  try {
    identityRegistry = loadAgentRegistry(config);
    console.log(
      `[skgateway] identity registry loaded (${identityRegistry.byName.size} agents, ` +
      `anonymous ${identityCfg.allow_anonymous === false ? "denied" : "allowed"}, ` +
      `auth-gate ${requireAgentId ? "ON" : "OFF"})`,
    );
  } catch (e) {
    console.log("[skgateway] identity registry not available (optional):", e.message);
  }
}

// ─── SKWorld authorization PDP delegation (L1.8) — OFF BY DEFAULT ───
// skgateway is the one non-Python PEP: authenticate locally, then delegate the
// allow/deny to the capauth service's POST /v1/authz/decide (never port the PDP).
// The MASTER GATE is SKGATEWAY_AUTHZ_ENFORCE (env) OR config.authz.enforce. When
// OFF (the default) NONE of the enforcement code below runs and the gateway is
// byte-identical to today: no decide call, no added latency, no behavior change.
// The client is still constructed (cheap, no I/O) so it is ready the instant the
// flag flips, but it is only ever consulted inside the `if (authzEnforce)` guard.
const authzCfg = config.authz || {};
const authzEnforce = authzEnforceEnabled(process.env, config);
// "Allow internal, gate external" posture: a request from a trusted internal peer
// (loopback / Tailscale CGNAT / RFC1918) is allowed without a PDP call; only
// external peers are delegated to the PDP. Default ON; set authz.trust_internal
// or $SKGATEWAY_AUTHZ_TRUST_INTERNAL=0 to gate ALL callers (strict mode).
const authzTrustInternal =
  (process.env.SKGATEWAY_AUTHZ_TRUST_INTERNAL ?? "").trim() === "0"
    ? false
    : authzCfg.trust_internal !== false;
const authzClient = createAuthzClient({
  url: authzCfg.url,
  cacheTtlMs: authzCfg.cache_ttl_ms,
  timeoutMs: authzCfg.timeout_ms,
});
if (authzEnforce) {
  console.log(
    `[skgateway] authz ENFORCE ON — delegating to capauth decide endpoint ` +
    `(${authzClient.configured ? "configured" : "NOT configured → all gated routes DENY"})`,
  );
} else {
  console.log("[skgateway] authz enforce OFF (byte-identical passthrough; no decide call)");
}

/**
 * Enforce PDP authorization for one request when the flag is ON. Returns true if
 * the request was DENIED and a 403 was already written (caller must stop). Returns
 * false to let the request proceed normally. NEVER called when authzEnforce is off.
 *
 * Fail-closed everywhere: any transport/HTTP fault from the PDP is a deny (handled
 * inside authzClient.decide). A gated route whose capability is unmapped is a 403
 * by construction (coverage-gap guard, standard §3).
 */
async function enforceAuthz(req, res, identity) {
  // Allow-internal, gate-external: a trusted internal TCP peer (loopback/tailnet/
  // RFC1918) is authorized without a PDP call. remoteAddress is the real peer (no
  // trusted proxy in front), so this is a network-layer boundary, not a spoofable
  // header. The verdict still flows to the SIEM hook below for the audit trail.
  const internal = authzTrustInternal && isInternalRemote(req.socket?.remoteAddress);
  const verdict = await authorizeRequest({
    method: req.method,
    url: req.url,
    identity,
    client: authzClient,
    internal,
  });
  if (verdict.kind === "public") return false;

  siemHook({
    ts: new Date().toISOString(),
    event: "authz.decide",
    agent_id: identity?.agent_id ?? null,
    subject: verdict.subject,
    capability: verdict.capability,
    decision: verdict.allowed ? "allow" : "deny",
    reason: verdict.reason,
    path: (req.url || "").split("?")[0],
    method: (req.method || "GET").toUpperCase(),
    remote: req.socket?.remoteAddress ?? null,
  });

  if (verdict.allowed) return false;

  if (!res.headersSent) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: { message: "Forbidden by authorization policy", reason: verdict.reason, code: 403 },
    }));
  }
  return true;
}

// Dashboard server
// Exported (like `server` below) purely so tests can close it after a direct
// import of this module (see tests/advertise-lifecycle.test.mjs's
// registerDiscoveredRoutes group); no production code depends on the export.
export let dashboard = null;
try {
  const { createDashboardServer } = await import("./dashboard/server.mjs");
  const dashPort = config.dashboard?.port || config.server?.dashboard_port || 18781;
  dashboard = createDashboardServer({
    port:    dashPort,
    bind:    config.server?.bind || "0.0.0.0",
    metrics,
    router,
    config,
  });
  console.log(`[skgateway] dashboard server started on port ${dashPort}`);
} catch (e) {
  console.log("[skgateway] dashboard server not available (optional):", e.message);
}

// ─── SIEM hook — append gateway decisions to logs/audit.jsonl ───
import fs from "node:fs";
import path from "node:path";
const siemPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  config.siem?.outputs?.[0]?.path || "./logs/audit.jsonl",
);
try { fs.mkdirSync(path.dirname(siemPath), { recursive: true }); } catch {}
// Optional skcapstone bridge — shares warn+ SIEM events on the mesh-wide
// sk-alert bus when ~/.skcapstone is present; no-op otherwise.
import * as skcapstone from "./integration.mjs";

// ─── Syslog output (RFC 5424) — disabled by default ───
// Build one adapter per `type: syslog` output in config.siem.outputs. Each is a
// no-op unless `enabled: true` (or SKGATEWAY_SYSLOG_* env is set). Shipping to
// syslog never blocks or breaks the existing file/append + skcapstone path.
let syslogOutputs = [];
try {
  const { createSyslogOutput } = await import("./siem/syslog.mjs");
  syslogOutputs = (config.siem?.outputs || [])
    .filter((o) => o && o.type === "syslog")
    .map((o) => createSyslogOutput(o))
    .filter((a) => a.enabled);
  if (syslogOutputs.length) {
    console.log(`[skgateway] syslog output(s) enabled: ${syslogOutputs.length}`);
  }
} catch (e) {
  console.log("[skgateway] syslog output not available (optional):", e.message);
}

// ─── Elasticsearch / OpenSearch output (_bulk) - disabled by default ───
// Build one adapter per `type: elasticsearch` (or `opensearch`) output. Both
// engines speak the identical _bulk protocol, so one adapter serves both. Each
// is a no-op unless `enabled: true` with an endpoint (or SKGATEWAY_ES_* env is
// set). Shipping to ES never blocks or breaks the file/append + syslog path.
let esOutputs = [];
try {
  const { createElasticsearchOutput } = await import("./siem/elasticsearch.mjs");
  esOutputs = (config.siem?.outputs || [])
    .filter((o) => o && (o.type === "elasticsearch" || o.type === "opensearch"))
    .map((o) => createElasticsearchOutput(o))
    .filter((a) => a.enabled);
  if (esOutputs.length) {
    console.log(`[skgateway] elasticsearch/opensearch output(s) enabled: ${esOutputs.length}`);
  }
} catch (e) {
  console.log("[skgateway] elasticsearch output not available (optional):", e.message);
}

function siemHook(evt) {
  try {
    fs.appendFile(siemPath, JSON.stringify(evt) + "\n", () => {});
  } catch (e) {
    console.warn("[skgateway] siem append failed:", e.message);
  }
  try { skcapstone.forwardSiemEvent(evt); } catch {}
  for (const out of syslogOutputs) {
    try { out.write(evt); } catch { /* never let syslog break the hot path */ }
  }
  for (const out of esOutputs) {
    try { out.write(evt); } catch { /* never let ES break the hot path */ }
  }
}

// ─── Build per-model limit map from YAML model_limits section ───
// YAML uses snake_case; core.mjs uses camelCase.
// model_limits:
//   moonshotai/kimi-k2.6: { max_body_bytes: 800000, max_system_bytes: 320000 }
function buildModelLimits(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [model, limits] of Object.entries(raw)) {
    out[model] = {
      ...(limits.max_body_bytes   != null ? { maxBodyBytes:   limits.max_body_bytes   } : {}),
      ...(limits.max_system_bytes != null ? { maxSystemBytes: limits.max_system_bytes } : {}),
    };
  }
  return out;
}

// ─── Loopback check for admin routes ───
// The admin allowlist endpoints (GET/PUT /admin/models*) have no dedicated
// privileged-route auth gate in this codebase (the CapAuth identity gate above
// is opt-in and scoped to /v1/*), so bind admin behavior to loopback callers
// only, same posture as the default server bind (127.0.0.1).
export function isLoopback(req) {
  const addr = req.socket?.remoteAddress || "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

// Body size cap for PUT /admin/models/advertise: the payload is just a list of
// model id strings, 64KB is generous headroom and keeps a malformed/hostile
// loopback PUT from buffering unbounded memory.
const ADVERTISE_MAX_BODY_BYTES = 64 * 1024;

// ─── GET /admin/models/rank (card P3.3): suggest-only rank API ───
// Wraps the pure P3.2 ranker (src/ranking/rank.mjs) with the two ways a
// caller declares what it needs (design 7.1): a registry `@match` role name
// (looked up in registry.yaml's `requirements:` block, design 4.3) OR an
// inline `require=` spec using the same comma-separated mini-grammar as the
// future `x-sk-require` header (card P4.3): `tool_use,min_ctx=64000,
// tier=local|free-remote`. This route NEVER routes a completion: it only
// reads the discovered catalog + lifecycle store and calls the pure ranker,
// same read-only posture as GET /admin/models.

/**
 * Parse an inline `require=` query spec into a `requirements` object
 * (design 6.2 shape: `{require, prefer, tier}`). Pure string parsing, no I/O.
 *
 * Grammar (comma-separated tokens):
 *   - a bare word (no `=`)         -> `require.<word> = true`
 *   - `key=value`, key is `tier`   -> `tier = value.split('|')`
 *   - `key=value`, key is `prefer` -> `prefer = value.split('|')`
 *   - `key=value`, otherwise       -> `require.<key> = Number(value)` when
 *     `value` parses as a finite number, else the raw string.
 *
 * Unknown/malformed tokens are ignored rather than throwing (fail-soft, same
 * discipline the future `x-sk-require` header parser (P4.3) is specified to
 * use): a caller typo should degrade the require spec, not 500 the route.
 *
 * @param {string} spec
 * @returns {{require:object, prefer?:string[], tier?:string[]}}
 */
export function parseRequireSpec(spec) {
  const requirements = { require: {} };
  if (typeof spec !== "string" || !spec.trim()) return requirements;
  for (const rawToken of spec.split(",")) {
    const token = rawToken.trim();
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq === -1) {
      requirements.require[token] = true;
      continue;
    }
    const key = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim();
    if (!key) continue;
    if (key === "tier" || key === "prefer") {
      const list = value.split("|").map((s) => s.trim()).filter(Boolean);
      if (list.length) requirements[key] = list;
      continue;
    }
    const num = Number(value);
    requirements.require[key] = value !== "" && Number.isFinite(num) ? num : value;
  }
  return requirements;
}

/**
 * Look up a `@match` role's requirement block from registry.yaml's
 * `requirements:` top-level section (design 4.3). registry.mjs's
 * `loadRegistry()` does not (yet, card P4.1) parse this block, so this reads
 * it directly rather than reimplementing registry.mjs's mtime cache for a
 * loopback-only, low-volume admin route: correctness over micro-caching here.
 * Fail-soft: a missing/malformed registry file yields `null` (unknown role),
 * never a throw.
 *
 * @param {string} role
 * @param {string} [path]
 * @returns {object|null} the role's `{require?, prefer?, tier?}` block, or
 *   `null` when the role has no requirements entry (unknown, or a plain
 *   non-`@match` role).
 */
export function loadRoleRequirements(role, path = REGISTRY_PATH) {
  try {
    const parsed = yamlLoad(readFileSync(path, "utf8")) || {};
    const reqs = parsed.requirements || {};
    return Object.prototype.hasOwnProperty.call(reqs, role) ? reqs[role] : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the ranker `requirements` object for one `/admin/models/rank`
 * request from its `role`/`require` query params (mutually exclusive; design
 * 7.1's two `@match`-role vs inline-spec surfaces). Pure aside from the
 * injected `loadRoleRequirementsFn` (defaults to the real registry read
 * above), same testability discipline as the rest of this file's admin
 * helpers.
 *
 * @param {{role?:string|null, require?:string|null}} query
 * @param {{loadRoleRequirementsFn?:(role:string)=>object|null}} [opts]
 * @returns {{requirements?:object, role?:string, error?:string}}
 */
export function resolveRankRequirements(query = {}, opts = {}) {
  const role = query.role || null;
  const requireSpec = query.require || null;
  const loadRoleRequirementsFn = opts.loadRoleRequirementsFn || loadRoleRequirements;

  if (role && requireSpec) {
    return { error: "pass either role or require, not both" };
  }
  if (role) {
    const requirements = loadRoleRequirementsFn(role);
    if (!requirements) {
      return { error: `unknown @match role or no requirements defined: ${role}` };
    }
    return { requirements, role };
  }
  if (requireSpec) {
    return { requirements: parseRequireSpec(requireSpec) };
  }
  return { error: "query parameter role or require is required" };
}

/**
 * Assemble the ranker's catalog input (design 4.1 shape: `{id, free,
 * lifecycle:{state}, capabilities}`) from the same discovered-catalog
 * entries `/admin/models` and `/v1/models` already read
 * (`getDiscoveredCatalog()`). Reuses `getLifecycle()` (P1.x) and
 * `deriveCapabilities()` (P3.1) exactly as-is: this function does not
 * rebuild either. Pure aside from the injected lookups, same testability
 * discipline as `buildAdminModelsView`/`applyLifecycleView` above.
 *
 * @param {Array<object>} full
 * @param {{getLifecycleFn?:(id:string)=>object, deriveCapabilitiesFn?:(card:object, opts:object)=>object, metricsFn?:(id:string)=>object}} [opts]
 * @returns {Array<object>}
 */
export function buildRankCatalog(full, opts = {}) {
  const getLifecycleFn = opts.getLifecycleFn || getLifecycle;
  const deriveCapabilitiesFn = opts.deriveCapabilitiesFn || deriveCapabilities;
  const metricsFn = opts.metricsFn || (() => ({}));
  return full.map((entry) => ({
    ...entry,
    lifecycle: getLifecycleFn(entry.id),
    capabilities: deriveCapabilitiesFn(entry, { metrics: metricsFn(entry.id) }),
  }));
}

// ─── Build proxy config ───
// Explicitly map YAML snake_case keys → core.mjs camelCase to avoid silent misses.
const s = config.sanitizer || {};
const t = config.tools     || {};
const proxyConfig = buildConfig({
  port,
  targetUrl:          Object.values(config.backends || {})[0]?.url || "https://integrate.api.nvidia.com/v1",
  maxBodyBytes:       s.max_body_bytes,
  maxSystemBytes:     s.max_system_bytes,
  proactiveToolLimit: t.max_budget,
  toolRoundLimit:     t.call_limit,
  modelLimits:        buildModelLimits(config.model_limits),
  ...(config.streaming ? { streaming: config.streaming } : {}),
  siem: siemHook,
});

// ─── Create HTTP server ───
// Exported purely so tests can close it after a direct import of this module
// (see tests/advertise-lifecycle.test.mjs); no production code depends on it.
export const server = http.createServer(async (req, res) => {
  const startTime = Date.now();
  if (process.env.SKGW_REQLOG) { console.log("[REQLOG]", req.method, req.url); }

  // ── SKWorld authorization gate (L1.8) — OFF BY DEFAULT ──
  // This ENTIRE block is skipped unless SKGATEWAY_AUTHZ_ENFORCE / config.authz.
  // enforce is on, so with the flag off the handler below runs exactly as it did
  // before this feature existed (byte-identical: no identity double-resolve, no
  // decide call, no new headers, no added latency). When ON: classify the route,
  // resolve the subject from the authenticated identity, delegate allow/deny to
  // the capauth PDP, and 403 a gated-route deny before any handler runs. Public
  // routes (health/status/discovery/model-listing) pass straight through.
  if (authzEnforce) {
    let gateIdentity = {
      agent_id: req.headers["x-agent-id"] || ANONYMOUS_AGENT_ID,
      method: req.headers["x-agent-id"] ? "header" : "anonymous",
      agent: null,
    };
    if (identityRegistry) {
      try {
        gateIdentity = await extractIdentity(req, identityRegistry);
      } catch {
        gateIdentity = { agent_id: ANONYMOUS_AGENT_ID, method: "anonymous", agent: null };
      }
    }
    try {
      if (await enforceAuthz(req, res, gateIdentity)) return; // denied → 403 already written
    } catch (e) {
      // Fail closed: an unexpected fault in the gate itself denies rather than
      // silently allowing a gated route through.
      console.warn("[skgateway] authz gate error (fail-closed deny):", e.message);
      const route = classifyRoute(req.method, req.url);
      if (route.kind === "gated") {
        if (!res.headersSent) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Forbidden by authorization policy", reason: "gate error", code: 403 } }));
        }
        return;
      }
    }
  }

  // ── SKWorld module manifest (operator-facet discovery) ──
  // Unauthenticated public discovery, like the other subapps: the fleet control
  // plane reads this to learn skgateway is a first-class service and how Atlas's
  // operator adapter watches/steers it. Built from the request origin so the
  // health URL resolves against wherever the caller reached the gateway.
  if (req.url === "/.well-known/skworld-module.json" && req.method === "GET") {
    handleModuleManifest(req, res);
    return;
  }

  // ── Health check endpoint ──
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime: process.uptime(),
      backends: router.getHealth(),
    }));
    return;
  }

  // ── Anthropic client connectivity probe: HEAD/GET /api/hello ──
  // Claude Code (pointed here via ANTHROPIC_BASE_URL) probes /api/hello to
  // verify the endpoint before it will use it. Without a 200 the probe falls
  // through to the proxy, routes to a backend, and 404s, so the client treats
  // the endpoint/model as unavailable. Answer 200 (loopback, unauthenticated,
  // like /health).
  if (req.url.split("?")[0] === "/api/hello") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.method === "HEAD" ? undefined : JSON.stringify({ ok: true }));
    return;
  }

  // ── Status endpoint (includes pool stats) ──
  if (req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      version: "0.1.0",
      uptime: process.uptime(),
      backends: router.getHealth(),
      pool: pool.getTotalStats(),
      metrics: metrics?.getStats() || null,
    }));
    return;
  }

  // ── Queue / connection pool depth endpoint ──
  if (req.url === "/queue") {
    const allStats = pool.getAllStats();
    const total = pool.getTotalStats();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      pool: {
        totalActive: total.totalActive,
        totalQueued: total.totalQueued,
        totalCapacity: total.totalCapacity,
        utilization: total.totalCapacity > 0 ? (total.totalActive / total.totalCapacity) : 0,
      },
      backends: allStats,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // ── Dashboard redirect (future) ──
  if (req.url === "/" || req.url === "/dashboard") {
    const dashboardPort = config.dashboard?.port || config.server?.dashboard_port || 18781;
    const host = req.headers.host?.split(":")[0] || "localhost";
    res.writeHead(302, { location: `http://${host}:${dashboardPort}/` });
    res.end();
    return;
  }

  // ── Aggregated model catalog: discovered + statically-configured backends ──
  // Reconciled against live backend health/quarantine (card 5c680ee9): a model
  // whose only serving backend(s) are down or quarantined is flagged
  // (status: "unavailable") or hidden per config.advertise.reconcile, so callers
  // are not offered dead models. Recovery re-admits automatically.
  //
  // buildModelCatalog() only sees the models literally declared in
  // config.backends[*].models, so it never carries NVIDIA/OpenRouter's live
  // discovered ids (Task 5), but it IS the source of truth for health/status
  // on the ids it does know about, and that must not be lost. The merge below
  // keeps every reconciled field (id/object/created/owned_by/status) for ids
  // known to both, and layers the discovered provider/free/stale tags on top;
  // an id known only to discovery (the common case for dynamic NVIDIA/
  // OpenRouter models) is admitted using its discovered shape. The allowlist
  // (src/advertise.mjs) is applied last, exactly as on /admin/models.
  if (req.url === "/v1/models" && req.method === "GET") {
    // Local fail-soft net: every callee below already traps its own errors,
    // but this handler sits outside the file's proxy-path try/catch (below),
    // so an unforeseen throw here (e.g. a future change to getDiscoveredCatalog
    // or buildModelCatalog) must not become an unhandled rejection that takes
    // the process down. /v1/models must always answer 200 with whatever
    // catalog it can assemble, never 500, never crash.
    try {
      const discovered = await getDiscoveredCatalog();
      const reconciled = buildModelCatalog(config.backends || {}, router, advertiseReconcileMode);
      // mergeDiscoveredCatalog() layers the discovered provider/free/stale tags
      // onto the reconciled health/status entries and GUARANTEES every model
      // carries a non-empty provider (see src/proxy/advertise.mjs). The
      // allowlist is applied last, exactly as on /admin/models.
      const merged = mergeDiscoveredCatalog(reconciled, discovered);
      const allowed = applyAllowlist(merged, loadAllowlist());
      // Lifecycle view (card P1.4): hide eol/dead ids, flag suspect ones.
      // Composes with (does not replace) the allowlist filter above.
      // Picker badges (card P2.4): additive ctx_tokens/tools/vision derived
      // from each surviving entry's card, if it has one. Superset-only.
      const data = applyPickerBadges(applyLifecycleView(allowed));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data }));
    } catch (e) {
      console.warn("[skgateway] /v1/models discovery merge failed, falling back to static catalog:", e.message);
      let data = [];
      try {
        data = applyPickerBadges(applyLifecycleView(buildModelCatalog(config.backends || {}, router, advertiseReconcileMode)));
      } catch (e2) {
        console.warn("[skgateway] /v1/models static catalog fallback also failed, serving empty list:", e2.message);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data }));
    }
    return;
  }

  // ── Per-model retrieve: GET /v1/models/:id ──
  // Claude Code (and other Anthropic clients) PREFLIGHT the selected model here
  // to validate it before sending a completion. Without this handler the request
  // falls through to the proxy catch-all, routes to a backend, 404s, and the
  // client rejects the model as "may not exist" (this is exactly what broke a
  // `claude --model ornith-big` session against the gateway). Answer 200 with a
  // model object when the id is in the catalog OR is an sk-* registry role (a
  // valid route not present as a concrete catalog id); 404 otherwise. Fail-soft:
  // never 500, never crash the process (same discipline as /v1/models).
  if (req.method === "GET" && req.url.startsWith("/v1/models/")) {
    const id = decodeURIComponent(req.url.slice("/v1/models/".length).split("?")[0]);
    const notFound = () => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: `model ${id} not found` } }));
    };
    if (!id) { notFound(); return; }
    try {
      const discovered = await getDiscoveredCatalog();
      const reconciled = buildModelCatalog(config.backends || {}, router, advertiseReconcileMode);
      const merged = mergeDiscoveredCatalog(reconciled, discovered);
      const data = applyAllowlist(merged, loadAllowlist());
      const entry = data.find((m) => m.id === id);
      // Registry role (sk-default/sk-auto/sk-creative/...): a valid routing
      // target resolved by ~/.skcapstone/models/registry.yaml, not a concrete
      // catalog id. Synthesize a 200 so clients accept it; the completion call
      // is the real validation.
      if (entry || /^sk-/.test(id)) {
        // Build the body BEFORE writing headers so a serialisation error cannot
        // half-send a response (this handler is outside the proxy try/catch).
        const bodyStr = JSON.stringify(modelRetrieveObject(id, entry || null));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(bodyStr);
        return;
      }
      notFound();
    } catch (e) {
      console.warn("[skgateway] /v1/models/:id lookup failed:", e.message);
      notFound();
    }
    return;
  }

  // ── Admin: discovered-catalog view + advertise allowlist (Task 4/5) ──
  // Loopback only (no dedicated privileged-route gate exists yet, see
  // isLoopback() above).
  if (req.url === "/admin/models" && req.method === "GET") {
    if (!isLoopback(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Admin routes are loopback only", code: 403 } }));
      return;
    }
    try {
      // Overlay our curated cards so static models (claude/ornith, which
      // discovery never gives a card) show their real capabilities + dex
      // fields here, not just the discovered ones (model-dex work).
      const full = applyCardOverlays(await getDiscoveredCatalog(), loadCardOverrides());
      const allow = loadAllowlist();
      // Card P2.4: each entry keeps its `card` (from P2.1 + the overlay above)
      // and gains a `lifecycle` record alongside the existing `advertised`
      // allowlist flag.
      const data = buildAdminModelsView(full, allow);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data }));
    } catch (e) {
      console.warn("[skgateway] /admin/models failed:", e.message);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "internal error building model catalog", code: 500 } }));
    }
    return;
  }
  if (req.url === "/admin/models/advertise" && req.method === "PUT") {
    if (!isLoopback(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Admin routes are loopback only", code: 403 } }));
      return;
    }
    // Bound the body read: a malformed/hostile loopback PUT should not be able
    // to buffer an unlimited amount of memory before we even get to parsing.
    let bodyBytes = 0;
    const bodyChunks = [];
    let tooLarge = false;
    for await (const chunk of req) {
      bodyBytes += chunk.length;
      if (bodyBytes > ADVERTISE_MAX_BODY_BYTES) {
        tooLarge = true;
        break;
      }
      bodyChunks.push(chunk);
    }
    if (tooLarge) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `body too large (max ${ADVERTISE_MAX_BODY_BYTES} bytes)` }));
      return;
    }
    const body = Buffer.concat(bodyChunks).toString("utf-8");
    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }
    // `enabled` feeds straight into new Set(...) on the GET /admin/models path
    // (and gets persisted to disk), so a non-array (or an array with non-string
    // entries) must be rejected here rather than allowed to corrupt the
    // allowlist and blow up that later `new Set(...)` call.
    const enabled = (parsed && typeof parsed === "object" && "enabled" in parsed) ? parsed.enabled : [];
    if (!Array.isArray(enabled) || !enabled.every((x) => typeof x === "string")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "enabled must be an array of strings" }));
      return;
    }
    try {
      saveAllowlist(enabled);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, enabled }));
    } catch (e) {
      console.warn("[skgateway] /admin/models/advertise failed:", e.message);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "internal error saving allowlist", code: 500 } }));
    }
    return;
  }

  // ── Admin: catalog freshness status (additive observability) ──
  // Shows how current the discovered NVIDIA/OpenRouter free-model listing is
  // (lastRefreshedAt/ageSeconds vs the configured refreshSeconds) plus counts,
  // so an operator (and the app model picker) can gauge freshness at a glance.
  // Loopback only, same posture as the other /admin/models* routes. Never
  // touches the network on its own; reads the in-memory catalog + cache. This
  // is additive: the /v1/models response shape is unchanged.
  if (req.url === "/admin/models/status" && req.method === "GET") {
    if (!isLoopback(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Admin routes are loopback only", code: 403 } }));
      return;
    }
    try {
      const status = await getDiscoveredStatus();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(status));
    } catch (e) {
      console.warn("[skgateway] /admin/models/status failed:", e.message);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "internal error building catalog status", code: 500 } }));
    }
    return;
  }

  // ── Admin: force an immediate re-discovery, bypassing the refresh interval ──
  // Kicks a fresh NVIDIA+OpenRouter fetch now and returns the updated status
  // (lastRefreshedAt advances on success). Fail-soft: refreshCatalog() is built
  // on discoverCatalog(), which traps each provider fetch and falls back to the
  // on-disk cache (flipping `stale`) rather than throwing, so a provider outage
  // yields a stale-but-served catalog, never a crash or a 5xx. Loopback only,
  // mirroring how /admin/models/advertise is gated.
  if (req.url === "/admin/models/refresh" && req.method === "POST") {
    if (!isLoopback(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Admin routes are loopback only", code: 403 } }));
      return;
    }
    try {
      await refreshCatalog(getConfig());
    } catch (e) {
      // refreshCatalog is fail-soft internally, but guard the wiring around it
      // (route registration, cache persistence) so the gateway never crashes on
      // a forced refresh. We still return the best-effort status below.
      console.warn("[skgateway] /admin/models/refresh discovery error (fail-soft):", e.message);
    }
    try {
      const status = await getDiscoveredStatus();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...status }));
    } catch (e) {
      console.warn("[skgateway] /admin/models/refresh status failed:", e.message);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "internal error building catalog status", code: 500 } }));
    }
    return;
  }

  // ── Admin: suggest-only rank API (card P3.3) ──
  // GET /admin/models/rank?role=<name> or ?require=<spec>. Loopback only,
  // same posture as the other /admin/models* routes. Returns the ranked
  // chain + per-model breakdowns from the pure P3.2 ranker; ROUTES NOTHING
  // (no candidate loop, no upstream call, no completion is ever triggered
  // by this route, design 7.1's "suggest-only API").
  if (req.url.split("?")[0] === "/admin/models/rank" && req.method === "GET") {
    if (!isLoopback(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Admin routes are loopback only", code: 403 } }));
      return;
    }
    const queryString = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
    const params = new URLSearchParams(queryString);
    const { requirements, role, error } = resolveRankRequirements({
      role: params.get("role"),
      require: params.get("require"),
    });
    if (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: error, code: 400 } }));
      return;
    }
    try {
      // Overlay curated cards first so static models (claude/ornith) carry the
      // capabilities the ranker needs (tools/ctx), not just discovered models.
      const full = applyCardOverlays(await getDiscoveredCatalog(), loadCardOverrides());
      const catalog = buildRankCatalog(full);
      const allow = loadAllowlist();
      const chain = rankModels(catalog, requirements, {
        allowlist: allow,
        isModelAvailable: (id) => isModelAvailable(id, router),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ role: role || null, requirements, chain }));
    } catch (e) {
      console.warn("[skgateway] /admin/models/rank failed:", e.message);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "internal error building rank chain", code: 500 } }));
    }
    return;
  }

  // Proxy all /v1/* requests — model-aware routing via the router.
  try {
    // ── CapAuth agent-identity resolution (P2.1) ──
    // Resolve the caller BEFORE routing so the verified agent identity drives
    // routing, metrics, and every SIEM event. Fail-safe: any error degrades to
    // anonymous, never crashes the request. Only the opt-in auth gate blocks.
    let identity = {
      agent_id: req.headers["x-agent-id"] || ANONYMOUS_AGENT_ID,
      verified: false,
      method: req.headers["x-agent-id"] ? "header" : "anonymous",
      session_id: req.headers["x-session-id"] || null,
      fingerprint: null,
    };
    if (identityRegistry) {
      try {
        identity = await extractIdentity(req, identityRegistry);
      } catch (e) {
        // degrade to anonymous — never let identity resolution break the request
        identity = { agent_id: ANONYMOUS_AGENT_ID, verified: false, method: "anonymous", session_id: null, fingerprint: null };
      }
    }
    req.identity = identity;
    req.agent_id = identity.agent_id;

    // Emit an audit event carrying the resolved (and verification-flagged) agent.
    siemHook({
      ts: new Date().toISOString(),
      event: "identity.resolved",
      agent_id: identity.agent_id,
      method: identity.method,
      verified: identity.verified,
      session_id: identity.session_id,
      fingerprint: identity.fingerprint,
      path: req.url,
      remote: req.socket?.remoteAddress ?? null,
    });

    // Opt-in auth gate: reject anonymous callers with 403 (OFF by default).
    if (requireAgentId && identity.method === "anonymous") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "Agent identity required. Provide X-Agent-Id, X-CapAuth-Signature, or Authorization: Bearer.",
          code: "identity_required",
          status: 403,
        },
      }));
      return;
    }

    // Buffer the request body so we can read the model for routing.
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    // ── Anthropic Messages FRONTEND (POST /v1/messages) ──
    // Accept the Anthropic wire format and route it through the SAME OpenAI path
    // as /v1/chat/completions, so a `claude` CLI pointed at
    // ANTHROPIC_BASE_URL=http://<gw>:18780 reaches ANY gateway model (local
    // ornith, nvidia-free, openrouter-free, or the claude wrapper). We translate
    // the request here, route it, then translate the buffered OpenAI result back
    // to an Anthropic Messages response below. Internal routing is non-streaming;
    // if the client asked for stream:true we re-serialise via jsonToSSE.
    let anthropicWant = false;
    let anthropicStream = false;
    let routeBody = body;
    let routePath = req.url;
    // Match by PATHNAME: Claude Code posts to /v1/messages?beta=true (query
    // string), so an exact === "/v1/messages" check would miss it and the
    // Anthropic body would fall through to the raw OpenAI proxy untranslated.
    if (req.method === "POST" && req.url.split("?")[0] === "/v1/messages") {
      const conv = fromAnthropicRequest(body);
      if (conv) {
        anthropicWant = true;
        anthropicStream = conv.stream;
        routeBody = conv.body;
        routePath = "/v1/chat/completions";
      }
    }

    let parsedModel = req.headers["x-model"] || undefined;
    let parsedMessages = undefined;
    if (anthropicWant || (req.headers["content-type"]?.includes("application/json") && routeBody.length)) {
      try {
        const parsed = JSON.parse(routeBody.toString("utf-8"));
        parsedModel = parsed.model || parsedModel;
        // Carry messages for sk-auto difficulty classification (registry.mjs).
        if (Array.isArray(parsed.messages)) parsedMessages = parsed.messages;
      } catch {}
    }

    // ── Prompt classification (P3.5) — PASSIVE observability into SIEM ──
    // Label the request's intent/risk/jailbreak/injection and emit it. Pure
    // heuristic (no network, sub-10ms), fail-open, and it NEVER changes routing.
    if (config.classification?.enabled && Array.isArray(parsedMessages)) {
      try {
        const classification = classifyRequest(parsedMessages, {
          classifier: config.classification.classifier,
        });
        siemHook(toSiemEvent(classification, {
          agent_id: identity.agent_id,
          session_id: identity.session_id,
          model: parsedModel,
          path: req.url,
        }));
      } catch { /* never let classification break a request */ }
    }

    const routeRequest = {
      model:   parsedModel,
      messages: parsedMessages,
      // Verified CapAuth identity (falls back to X-Agent-Id / anonymous).
      agentId: identity.agent_id !== ANONYMOUS_AGENT_ID ? identity.agent_id : (req.headers["x-agent-id"] || undefined),
      // skmodels registry role/context routing (single source of truth).
      // Present => routeAndSend resolves via ~/.skcapstone/models/registry.yaml
      // (precedence context > service > role > default) before backend select.
      context: req.headers["x-sk-context"] || undefined,
      service: req.headers["x-sk-service"] || undefined,
      role:    req.headers["x-sk-role"]    || undefined,
    };

    const result = await routeAndSend(
      router, routeRequest, routePath, req.method, req.headers, routeBody, true, siemHook,
    );

    if (!result) {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "No backend produced a response", code: 502 } }));
      }
    } else if (anthropicWant) {
      // Translate the buffered OpenAI result back to the Anthropic wire format.
      let oai = null;
      try { oai = JSON.parse((result.body || "").toString("utf-8")); } catch {}
      if (result.status >= 300 || !oai) {
        // Upstream error / unparseable — pass it through so the Anthropic client
        // sees the real status rather than a fabricated success.
        const headers = { ...result.headers };
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        delete headers["content-encoding"];
        res.writeHead(result.status, headers);
        res.end(result.body);
      } else {
        const amsg = toAnthropicMessage(oai, parsedModel);
        if (anthropicStream) {
          // Serialise the complete Anthropic message as the streaming event
          // sequence (message_start -> content_block_* -> message_delta ->
          // message_stop -> [DONE]); jsonToSSE auto-detects the Anthropic shape.
          const writer = new SSEWriter(res, { keepAliveMs: 0 });
          writer.start();
          jsonToSSE(writer, amsg);
        } else {
          const outBuf = Buffer.from(JSON.stringify(amsg), "utf-8");
          res.writeHead(200, { "content-type": "application/json", "content-length": outBuf.length });
          res.end(outBuf);
        }
      }
    } else {
      const headers = { ...result.headers };
      delete headers["content-length"];
      delete headers["transfer-encoding"];
      delete headers["content-encoding"];
      res.writeHead(result.status, headers);
      res.end(result.body);
    }

    // Record metrics
    if (metrics) {
      const duration = Date.now() - startTime;
      metrics.recordRequest({
        path: req.url,
        method: req.method,
        duration,
        status: result?.status ?? res.statusCode,
        agent_id: req.agent_id || req.headers["x-agent-id"] || "unknown",
        model: parsedModel || "unknown",
        backend: result?.backendId,
      });
    }
  } catch (err) {
    console.error("[skgateway] unhandled error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Gateway error", code: 502 } }));
    }
  }
});

// ─── Graceful shutdown ───
function shutdown(signal) {
  console.log(`[skgateway] ${signal} received, shutting down`);
  server.close(() => {
    if (metrics)   metrics.close?.();
    if (dashboard) dashboard.close?.();
    for (const out of syslogOutputs) { try { out.close?.(); } catch {} }
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Hot reload config on SIGHUP ───
// config.mjs registers its own SIGHUP handler that re-reads + validates the
// file and emits "config-changed"; we just refresh our local snapshot from it.
_cfgEmitter.on("config-changed", () => {
  try {
    Object.assign(config, _cfgEmitter.current());
    console.log("[skgateway] config reloaded");
  } catch (e) {
    console.error("[skgateway] config reload failed:", e.message);
  }
});

// ─── Start ───
server.listen(port, bind, () => {
    console.log("[skgateway] listening on http://" + bind + ":" + port);
    const backendNames = Object.keys(config.backends || {});
    console.log("[skgateway] backends: " + (backendNames.join(", ") || "default"));
    console.log("[skgateway] metrics: " + (metrics ? "enabled" : "disabled"));
    const dashPort = config.server?.dashboard_port || 18781;
    console.log("[skgateway] dashboard: port " + dashPort + " (coming soon)");
    // Advertise to skcapstone service discovery when present (no-op otherwise).
    try {
      if (skcapstone.registerService({ healthUrl: `http://localhost:${port}/health` })) {
        console.log("[skgateway] registered with skcapstone service discovery");
      }
    } catch {}
});
