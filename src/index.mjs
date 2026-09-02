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
import { createProxyServer, handleRequest, buildConfig, trimSystemMessages, trimConversationHistory } from "./proxy/core.mjs";
import { createRouter, routeAndSend } from "./proxy/router.mjs";
import { sanitizeResponse } from "./proxy/sanitizer.mjs";
import { buildModelCatalog, reconcileModeFromConfig, tagLocalModels, mergeDiscoveredCatalog, isModelAvailable, excludedModelIds, withoutExcludedModels } from "./proxy/advertise.mjs";
import { loadAllowlist, saveAllowlist, applyAllowlist } from "./advertise.mjs";
import { discoverCatalog, loadCache, saveCache, fetchNvidia, fetchOpenRouter, fetchOpencode, fetchAnthropicWrapper, fetchCodex, fetchZai, catalogStatus, loadCardOverrides, applyCardOverlays, buildServingCatalog } from "./discovery.mjs";
import { getPool, resetPool } from "./proxy/connection-pool.mjs";
import { loadAgentRegistry, extractIdentity, normalizeAgentId, ANONYMOUS_AGENT_ID } from "./identity/capauth.mjs";
import { ClientAuthenticator, classifyAuthenticationRoute, stripCallerCredentials, stripCredentialQuery } from "./identity/client-auth.mjs";
import { createAuthzClient } from "./policy/authz_decide.mjs";
import { createSkLegalAuthzClient } from "./policy/sklegal_authz_decide.mjs";
import { classifyRoute } from "./policy/authz_routes.mjs";
import { runModelEval, isEvalEligible, createLoopbackChatComplete } from "./ranking/eval.mjs";
import {
  authzEnforceEnabled,
  authorizeRequest,
  createSkLegalQualificationResolver,
} from "./policy/authz_gate.mjs";
import { isInternalRemote } from "./policy/net_trust.mjs";
import { classifyRequest, toSiemEvent } from "./classifiers/engine.mjs";
import { handleModuleManifest } from "./operator/manifest.mjs";
import {
  handleHealthz as handleOperatorHealthz,
  handleReadyz as handleOperatorReadyz,
  handleExplain as handleOperatorExplain,
  handleObserve as handleOperatorObserve,
  handleAct as handleOperatorAct,
} from "./operator/http.mjs";
import { fromAnthropicRequest, toAnthropicMessage, modelRetrieveObject } from "./proxy/anthropic-frontend.mjs";
import { readCodexAuthHeaders } from "./proxy/codex-adapter.mjs";
import { readZaiAuthHeaders, ZAI_CREDENTIALS_PATH } from "./proxy/zai-adapter.mjs";
import { SSEWriter, jsonToSSE } from "./proxy/stream.mjs";
import { getLifecycle } from "./discovery/model_catalog_store.mjs";
import { isRoutable, isEffectivelyRoutable, LIFECYCLE_STATES } from "./discovery/lifecycle.mjs";
import { rankModels } from "./ranking/rank.mjs";
import { deriveCapabilities } from "./ranking/capabilities.mjs";
import { buildCapabilityCatalog } from "./ranking/catalog.mjs";
import { REGISTRY_PATH } from "./proxy/registry.mjs";
import { energyRowsFrom, energyHeaders } from "./metrics/energy.mjs";
import { attributionHeaders } from "./metrics/attribution.mjs";
import { sampleTokenRatio } from "./metrics/token-ratio.mjs";
import { allBuckets, resolveBucket } from "./policy/buckets.mjs";
import { loadRegistry, REGISTRY_PATH as _REGISTRY_PATH } from "./proxy/registry.mjs";
import { policyFromRegistry } from "./policy/sensitivity.mjs";
import { readFileSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";
import { createShadowRecorder } from "./proxy/semantic-cache-shadow.mjs";

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
let clientAuthenticator = config.client_auth?.enabled ? new ClientAuthenticator(config.client_auth) : null;
let operatorAuthenticator = config.operator_auth?.enabled ? new ClientAuthenticator(config.operator_auth) : null;

// ─── Capability-aware routing master gate (design 7.2), DEFAULT OFF ───
// Governs BOTH the `@match` role ranking branch (router.mjs, card P4.2) and
// this file's `x-sk-require` header escape hatch (card P4.3). With it off,
// the header below is never attached to routeRequest: the hot path stays
// byte-identical to before this card existed (no rank call, no new
// candidates, no added latency). Exported (read-only) for tests, same
// testability discipline as this file's other pure/config-derived helpers.
export const matchRoutingEnabled = !!(config.routing && config.routing.match_enabled);

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

/**
 * Which router backend serves a discovery provider's models.
 *
 * This used to hardcode `nvidia` and `openrouter` and return null for anything
 * else, which meant a THIRD discovery provider could be fully implemented,
 * fetched, lifecycle-tracked and ADVERTISED on /v1/models while being
 * completely unroutable. That is not hypothetical: enabling OpenCode Zen
 * (card 6cc8aac3 / C8) put 7 models on /v1/models that every one of which
 * answered 404, which is precisely the defect the whole 767adc4e epic exists
 * to eliminate. Advertised is not the same as reachable, and the catalog is
 * the thing that must never claim otherwise.
 *
 * A discovery provider now maps to the CONFIGURED BACKEND OF THE SAME NAME.
 * That is already the convention the two original providers followed by hand,
 * so this generalizes rather than changes them, and it means the next provider
 * needs no edit here at all. Returning null when no such backend is configured
 * is still correct: there is genuinely nowhere to route those ids, and
 * registerDiscoveredRoutes skips them rather than inventing a destination.
 *
 * @param {string} provider discovery provider name
 * @param {object} [cfg] gateway config, for the configured-backends lookup
 * @returns {string|null} backend name, or null when nothing serves it
 */
function providerBackend(provider, cfg) {
  if (!provider || typeof provider !== "string") return null;
  if (cfg?.backends && Object.prototype.hasOwnProperty.call(cfg.backends, provider)) {
    return provider;
  }
  // Preserved for callers that pass no cfg (tests predating this signature).
  return provider === "nvidia" || provider === "openrouter" ? provider : null;
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
export function filterRoutableModelIds(ids, getLifecycleFn = getLifecycle, claimers = []) {
  return ids.filter((id) => {
    const lifecycle = getLifecycleFn(id);
    if (isRoutable(lifecycle)) return true;
    if (lifecycle?.state === LIFECYCLE_STATES.NOT_CHAT || lifecycle?.provider == null) return false;
    return isEffectivelyRoutable(lifecycle, claimers);
  });
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
    const be = providerBackend(m.provider, cfg);
    if (!be) continue;
    if (!byProvider.has(be)) byProvider.set(be, new Set());
    byProvider.get(be).add(m.id);
  }
  for (const [name, backendCfg] of Object.entries(cfg.backends || {})) {
    const source = backendCfg?.discovery;
    if (typeof source !== "string" || !byProvider.has(source) || name === source) continue;
    byProvider.set(name, new Set(byProvider.get(source)));
  }
  for (const [name, ids] of byProvider) {
    const backend = getBackend(name);
    if (!backend) continue; // provider not configured as a router backend, nothing to route to
    // For discovery-managed backends the configured list is a cold-start seed,
    // not a permanent union. The first authoritative cycle replaces it so a
    // retired model can actually leave routing.
    const staticModels = backend.discovery
      ? []
      : (cfg.backends?.[name]?.models || []).filter((x) => typeof x === "string");
    const merged = [...new Set([...staticModels, ...ids])];
    const routable = filterRoutableModelIds(merged, getLifecycleFn, [name]);
    if (typeof backend.replaceDiscoveredModels === "function" && backend.discovery) {
      backend.replaceDiscoveredModels(routable);
    } else {
      backend.models = routable;
      // Lifecycle pruning can legitimately empty this list. Mark it discovery
      // managed so empty never becomes the ordinary wildcard convention.
      if (backend.models.length === 0) backend.discovery = backend.discovery || name;
    }
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
 * Claimer-aware (incident inc-2026-08-18-qwen38-eol): a non-routable verdict
 * does not preempt a backend's explicit declaration of the id unless the
 * verdict is attributed to the claiming side — the SAME rule as the router's
 * gate (isEffectivelyRoutable), so the advertised catalog and the routable
 * set cannot disagree: a model that routes (a local claimer over an
 * unattributed or foreign-provider EOL verdict) is advertised, and a model
 * that does not route is not. `claimersFor` omitted/`null` keeps the original
 * isRoutable behavior exactly (every pre-incident caller and test).
 *
 * @param {Array<object>} data
 * @param {(id: string) => object} [getLifecycleFn]
 * @param {((id: string) => string[])|null} [claimersFor] backend names declaring each id
 * @returns {Array<object>}
 */
export function applyLifecycleView(data, getLifecycleFn = getLifecycle, claimersFor = null) {
  const out = [];
  for (const m of data) {
    const lc = getLifecycleFn(m.id);
    const claimers = claimersFor ? (claimersFor(m.id) || []) : [];
    if (!isEffectivelyRoutable(lc, claimers)) continue; // hide eol/dead not rescued by a live claim
    out.push(lc.state === LIFECYCLE_STATES.SUSPECT ? { ...m, lifecycle: "suspect" } : m);
  }
  return out;
}

/**
 * For each concrete model id in `backends` (config.backends), the list of
 * backend names whose `models` list declares it — the claimer context
 * applyLifecycleView() (and the router's gate, via candidatesFor) uses for
 * the claim-over-verdict rule (incident inc-2026-08-18-qwen38-eol). Wildcard
 * patterns (`dolphin-*`) are patterns, not ids, and are skipped, the same
 * convention buildModelCatalog()/declaredModelsFor() follow. Pure, no I/O.
 *
 * @param {Record<string, {models?: string[]}>} [backends]
 * @returns {(id: string) => string[]}
 */
/**
 * Advertise buckets + roles on /v1/models and /admin/models.
 *
 * Two complementary views, one gated on `routing.buckets_enabled` (buckets
 * only make sense when the feature is on) and one unconditional (registry
 * roles are always routable via skmodels, regardless of any flag).
 *
 * Buckets come from `allBuckets()` (policy/buckets.mjs) — single source of
 * truth, never retyped. The 12 taxonomy entries (S/M/L/XL ×
 * public/internal/secret) become additive catalog entries with
 * `kind: "bucket"`, `free: false` (honest: cost depends on which member
 * serves), and the class/sensitivity fields so a picker can render them.
 *
 * Roles come from the live registry's `roles:` keys via `loadRegistry()`
 * (proxy/registry.mjs), fail-soft to `[]` when the registry is unavailable.
 * Each gets `kind: "role"`. Unconditional because any `sk-*` id is
 * registry-routed today; advertising them needs no flag gate.
 *
 * Injection order: AFTER `applyAllowlist()` (line ≈1126) in both the
 * /v1/models and /admin/models paths, with dedupe by id (concrete models
 * win, same first-seen-wins rule as `mergeDiscoveredCatalog`). When a
 * non-empty allowlist is in effect, alias entries are filtered through it
 * too, so an operator allowlist stays an allowlist.
 *
 * Exported purely so tests can assert the helper's behaviour without booting
 * a live server (see tests/advertise-lifecycle.test.mjs's
 * `registerDiscoveredRoutes` group).
 *
 * @param {object} [cfg] gateway config, for the `routing.buckets_enabled` check
 * @returns {Array<object>} bucket entries (when enabled) + role entries (always)
 */
export function aliasCatalogEntries(cfg = {}) {
  const out = [];
  const seen = new Set();

  // Buckets: gated on routing.buckets_enabled, built from allBuckets().
  if (cfg?.routing?.buckets_enabled === true) {
    for (const b of allBuckets()) {
      const id = b.bucket;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        object: "model",
        created: 0,
        provider: "skgateway",
        free: false,
        owned_by: "skgateway",
        kind: "bucket",
        model_class: b.model_class,
        sensitivity: b.sensitivity,
      });
    }
  }

  // Roles: always advertised (registry routing is unconditional).
  try {
    const reg = loadRegistry();
    if (reg?.roles) {
      for (const role of Object.keys(reg.roles)) {
        if (seen.has(role)) continue;
        seen.add(role);
        out.push({
          id: role,
          object: "model",
          created: 0,
          provider: "skgateway",
          free: false,
          owned_by: "skgateway",
          kind: "role",
        });
      }
    }
  } catch {
    // Registry unavailable: fail-soft, no roles advertised. Buckets
    // already injected above are unaffected.
  }

  return out;
}

function allowAliases(aliases, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return aliases;
  const allowedIds = new Set(allowlist);
  return aliases.filter((entry) => allowedIds.has(entry.id));
}

export function modelClaimersFor(backends = {}) {
  const map = new Map();
  for (const [name, b] of Object.entries(backends || {})) {
    for (const m of (b?.models || [])) {
      if (typeof m !== "string" || m.includes("*")) continue;
      if (!map.has(m)) map.set(m, []);
      map.get(m).push(name);
    }
  }
  return (id) => map.get(id) || [];
}

/** Replace cold-start config seeds with live models on discovery-managed backends. */
export function effectiveAdvertiseBackends(backends = {}, liveRouter = router) {
  const out = {};
  for (const [name, cfg] of Object.entries(backends || {})) {
    const live = cfg?.discovery ? liveRouter?.getBackend?.(name) : null;
    out[name] = live && Array.isArray(live.models)
      ? { ...cfg, models: [...live.models] }
      : cfg;
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
  // Seeded from LIFECYCLE_STATES rather than a hand-written literal. The
  // literal was `{active, suspect, eol, dead}`, so when card f9e8002b added
  // `not_chat` those models were counted by NOBODY: the hasOwnProperty guard
  // below silently skipped them, and an operator reading
  // /admin/models/status would have seen totals that quietly did not add up to
  // the catalog size.
  //
  // A summary that drops a category it does not recognize is the same class of
  // problem as the rest of this epic: it reports health by omitting the part it
  // cannot describe. Deriving the buckets from the enum means the next
  // disposition appears here automatically.
  const counts = Object.fromEntries(Object.values(LIFECYCLE_STATES).map((s) => [s, 0]));
  // `unknown` catches any state the store somehow holds that the enum does not
  // describe, so the totals always reconcile against the catalog length instead
  // of silently losing entries.
  counts.unknown = 0;
  for (const m of catalog) {
    const state = getLifecycleFn(m.id)?.state;
    if (state && Object.prototype.hasOwnProperty.call(counts, state)) counts[state] += 1;
    else counts.unknown += 1;
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
 * Public-safe card projection for `/v1/models` (the funnel-exposed catalog +
 * the model dex). Strips operator-internal card fields (currently `notes`,
 * which carries ops commentary like "costs real money, keep the tier ladder
 * tight") so they stay on the loopback `/admin/models` only. Everything a
 * reader / picker / dex needs (display_name, summary, good_at, tier, ctx,
 * tools, params, quant, speed, ...) is public-safe and kept. Pure; a card-less
 * entry passes through untouched.
 *
 * @param {Array<object>} data
 * @returns {Array<object>}
 */
const _INTERNAL_CARD_FIELDS = ["notes"];
export function stripInternalCardFields(data) {
  return data.map((m) => {
    if (!m.card || typeof m.card !== "object") return m;
    const card = { ...m.card };
    for (const f of _INTERNAL_CARD_FIELDS) delete card[f];
    return { ...m, card };
  });
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

/**
 * Card C3: refreshCatalog() is the only production call site of
 * discoverCatalog(), and until this fix it never passed the EOL probe knobs
 * (card P2.3, src/discovery/probe.mjs) through from cfg.discovery. Since
 * discoverCatalog() defaults probeSeconds to 0 and its whole probe block is
 * gated on `probeSeconds > 0`, no config key existed that could ever turn the
 * sweep on: `discovery.probe_seconds` in the yaml did nothing.
 *
 * probe_seconds / probe_budget / probe_timeout_ms read here, snake_case in
 * yaml matching every other key in this config block (see providers.*.enabled
 * above). probePool is deliberately NOT sourced from cfg.discovery: it is not
 * a serializable config value, it is the live proxy/connection-pool.mjs
 * singleton, and discoverCatalog's own default (`probePool || getPool()`,
 * discovery.mjs) already resolves it lazily and correctly once this function
 * actually reaches the probe step (well after the module-level `pool`
 * singleton further down is constructed). Capturing that module-scope `pool`
 * const here eagerly would hit its temporal-dead-zone on the very first
 * startup call, since this function is invoked eagerly (fire-and-forget, on
 * module load) before `const pool = getPool(poolConfig)` runs.
 *
 * `discoverCatalogFn` is injected (default: the real discoverCatalog) purely
 * for the regression test (tests/refresh-catalog-probe-wiring.test.mjs): it
 * asserts on the opts object a spy receives, instead of on probe.mjs's
 * internals, because a probe.mjs-only test is exactly what let this wiring
 * gap ship silently (see card C3 / 1f65cf45).
 */
export async function refreshCatalog(cfg, discoverCatalogFn = discoverCatalog) {
  const d = cfg.discovery || {};
  const nvEnabled = d.providers?.nvidia?.enabled !== false;
  const orEnabled = d.providers?.openrouter?.enabled !== false;
  // OpenCode Zen (card C8) is the one provider that defaults OFF rather than
  // ON: nvidia and openrouter use `!== false` because they are long-standing
  // and an operator who never mentions them still expects them. A brand-new
  // provider must not start making network calls to a third party the moment
  // this code lands, so it needs `=== true`.
  //
  // But OFF must mean DISABLED, never UNREACHABLE. The knob is read here, at
  // the only production call site, so setting
  // `discovery.providers.opencode.enabled: true` genuinely turns it on. Card
  // C3 was exactly this bug in the other direction: probe.mjs was fully built
  // and `discoverCatalog` supported it, but refreshCatalog never passed the
  // option through, so `discovery.probe_seconds` was config that did nothing
  // and an operator reading the file would reasonably believe otherwise.
  // Built-but-unreachable is the failure mode this fleet keeps rediscovering,
  // so the wiring lands with the feature even when the feature ships off.
  const ocEnabled = d.providers?.opencode?.enabled === true;
  const anthropicEnabled = d.providers?.anthropic?.enabled === true;
  // Codex (OpenAI subscription backend): same opt-in rule as opencode above
  // (=== true, not !== false). The fetch needs the codex backend's Codex CLI
  // credentials (bearer + chatgpt-account-id), built from its credentials_path
  // via readCodexAuthHeaders() (read-only, never refreshed).
  const cxEnabled = d.providers?.codex?.enabled === true;
  const codexCreds = cfg.backends?.codex?.credentials_path || cfg.backends?.codex?.credentials_file;
  const zaiEnabled = d.providers?.zai?.enabled === true && Boolean(cfg.backends?.zai);
  const zaiCreds = cfg.backends?.zai?.credentials_path || cfg.backends?.zai?.credentials_file || ZAI_CREDENTIALS_PATH;
  const nvidiaKey = process.env[cfg.backends?.nvidia?.api_key_env || "NVIDIA_API_KEY"];
  const openrouterKey = process.env[cfg.backends?.openrouter?.api_key_env || "OPENROUTER_API_KEY"];
  const { models } = await discoverCatalogFn({
    localModels: localModels(cfg),
    nvidiaFetch: nvEnabled ? () => fetchNvidia(nvidiaKey) : async () => ({ data: [] }),
    openrouterFetch: orEnabled ? () => fetchOpenRouter(openrouterKey) : async () => ({ data: [] }),
    opencodeFetch: ocEnabled
      ? () => fetchOpencode(process.env[cfg.backends?.opencode?.api_key_env || "OPENCODE_API_KEY"])
      : async () => ({ zen: { data: [] }, modelsDev: null }),
    anthropicFetch: anthropicEnabled
      ? () => fetchAnthropicWrapper(
          cfg.backends?.anthropic?.url,
          process.env[cfg.backends?.anthropic?.api_key_env || "CCAPI_TOKEN"],
        )
      : null,
    codexFetch: cxEnabled
      ? () => fetchCodex(readCodexAuthHeaders(codexCreds))
      : async () => ({ models: [] }),
    zaiFetch: zaiEnabled
      ? () => fetchZai(readZaiAuthHeaders(zaiCreds))
      : async () => ({ data: [] }),
    cache: _discoveryCache,
    probeSeconds: d.probe_seconds || 0,
    probeBudget: d.probe_budget,
    probeTimeoutMs: d.probe_timeout_ms,
  });
  _catalog = models;
  registerDiscoveredRoutes(cfg, models);
  // Providers absent from the returned catalog still completed a discovery
  // attempt. Record that outcome so pending becomes attributable failed/stale
  // instead of remaining ambiguous forever.
  const zaiProvider = _discoveryCache.providers?.zai;
  if (cfg.backends?.zai && !models.some((m) => m.provider === "zai")) {
    router.registerDiscoveredModels?.("zai", [], {
      ok: zaiProvider?.ok !== false,
      stale: zaiProvider?.ok === false,
      at: zaiProvider?.lastAttemptAt || Date.now(),
    });
  }
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
  capacityDomains: config.pooling?.capacity_domains || {},
};
const pool = getPool(poolConfig);

// ─── Operator-plane self-served facet data sources (epic c880017b, Phase 3.4) ───
// The live objects the /operator/v1/* routes (below, near /health) read from.
// Defined once, right after router/pool exist, so it can never observe them
// as undefined. Each source is a zero-arg accessor — operator/http.mjs treats
// a throw from any one of them as that condition's evidence, never a crash
// into a 500 (see buildObservation() there). getConfig() (not the module-load
// `config` local) so a hot-reloaded discovery.enabled flag is honored live,
// same convention getDiscoveredStatus() below already follows.
const operatorHttpDeps = {
  getHealth: () => router.getHealth(),
  getPoolStats: () => pool.getTotalStats(),
  getCatalogStatus: () => getDiscoveredStatus(),
  discoveryEnabled: () => getConfig().discovery?.enabled !== false,
};

// Metrics collector (lazy, and not imported when disabled)
let metrics = null;
if (config.metrics?.enabled === true) {
  try {
    const { createMetricsCollector } = await import("./metrics/collector.mjs");
    metrics = createMetricsCollector(config.metrics);
    console.log("[skgateway] metrics collector initialized");
  } catch (e) {
    // Metrics was explicitly ENABLED in config and still failed to load. That is a
    // degradation, not an option, and it must not be logged as though it were fine.
    // Observed 2026-08-27: an npm ci rebuilt better-sqlite3 against a different
    // Node than the service runs, the collector failed here, and the gateway came
    // up cheerfully with metrics off. Every request_log row stopped being written
    // and nothing noticed, because this line said "(optional)" at info level while
    // the whole fleet's telemetry was gone.
    const abi = /NODE_MODULE_VERSION|was compiled against a different Node\.js version/i.test(
      String(e && e.message),
    );
    console.error(
      "[skgateway] METRICS DEGRADED: collector is enabled in config but failed to load.",
      "\n  request_log, energy and cost telemetry will NOT be written.",
      "\n  cause:", e && e.message,
      abi
        ? "\n  remedy: the native binding was built for a different Node than this process." +
          "\n          run:  npm rebuild better-sqlite3 --build-from-source" +
          "\n          using the SAME node that runs the service (check the unit's ExecStart)."
        : "\n  remedy: check config.metrics and that ./metrics/collector.mjs loads.",
    );
    if (process.env.SKGATEWAY_REQUIRE_METRICS === "1") {
      console.error("[skgateway] SKGATEWAY_REQUIRE_METRICS=1 is set, refusing to start without metrics.");
      process.exit(1);
    }
  }
} else {
  console.log("[skgateway] metrics collector disabled by configuration");
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
// The legacy lane can retain its internal-peer posture. Explicit SKLegal
// qualification routes never use this bypass and always call the strict client.
const authzTrustInternal =
  (process.env.SKGATEWAY_AUTHZ_TRUST_INTERNAL ?? "").trim() === "0"
    ? false
    : authzCfg.trust_internal !== false;
const authzClient = createAuthzClient({
  url: authzCfg.url,
  cacheTtlMs: authzCfg.cache_ttl_ms,
  timeoutMs: authzCfg.timeout_ms,
});
const sklegalAuthzCfg = authzCfg.sklegal_qualification || {};
// Exact governed wire: X-SKLegal-Service-Authorization carries the service
// credential and request_capauth carries the request-local Authorization value.
const sklegalQualification = createSkLegalQualificationResolver(
  authzEnforce ? sklegalAuthzCfg : {},
);
const sklegalAuthzClient = createSkLegalAuthzClient({
  url: sklegalAuthzCfg.url,
  timeoutMs: sklegalAuthzCfg.timeout_ms ?? authzCfg.timeout_ms,
  qualificationEnabled: sklegalQualification.enabled,
  serviceCredentialFile: sklegalAuthzCfg.service_credential_file,
  serviceCredentialMaxAgeMs: sklegalAuthzCfg.service_credential_max_age_ms,
});
if (authzEnforce) {
  console.log(
    `[skgateway] authz ENFORCE ON; generic PDP ` +
    `${authzClient.configured ? "configured" : "not configured"}; ` +
    `SKLegal qualification ${sklegalQualification.enabled
      ? (sklegalAuthzClient.configured ? "configured" : "not configured, governed routes deny")
      : "disabled"}`,
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
  // Resolve trusted SKLegal scope before considering the legacy internal-peer
  // behavior. A governed route always calls the PDP, including from loopback.
  const qualification = sklegalQualification.resolve(req.method, req.url);
  const internal = !qualification
    && authzTrustInternal
    && isInternalRemote(req.socket?.remoteAddress);
  const verdict = await authorizeRequest({
    method: req.method,
    url: req.url,
    identity,
    client: authzClient,
    internal,
    sklegalQualification: qualification,
    requestCapAuth: req.headers.authorization,
    sklegalClient: sklegalAuthzClient,
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
    governed: verdict.governed === true,
    decision_id: verdict.decision_id ?? null,
    policy_revision: verdict.policy_revision ?? null,
    correlation_id: verdict.correlation_id ?? null,
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
if (config.dashboard?.enabled === true) {
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
} else {
  console.log("[skgateway] dashboard server disabled by configuration");
}

// ─── SIEM hook — append gateway decisions to logs/audit.jsonl ───
import fs from "node:fs";
import path from "node:path";
const siemEnabled = config.siem?.enabled === true;
const siemPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  config.siem?.outputs?.[0]?.path || "./logs/audit.jsonl",
);
if (siemEnabled) {
  try { fs.mkdirSync(path.dirname(siemPath), { recursive: true }); } catch {}
}
// Optional skcapstone bridge — shares warn+ SIEM events on the mesh-wide
// sk-alert bus when ~/.skcapstone is present; no-op otherwise.
import * as skcapstone from "./integration.mjs";

// ─── Syslog output (RFC 5424) — disabled by default ───
// Build one adapter per `type: syslog` output in config.siem.outputs. Each is a
// no-op unless `enabled: true` (or SKGATEWAY_SYSLOG_* env is set). Shipping to
// syslog never blocks or breaks the existing file/append + skcapstone path.
let syslogOutputs = [];
if (siemEnabled) {
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
}

// ─── Elasticsearch / OpenSearch output (_bulk) - disabled by default ───
// Build one adapter per `type: elasticsearch` (or `opensearch`) output. Both
// engines speak the identical _bulk protocol, so one adapter serves both. Each
// is a no-op unless `enabled: true` with an endpoint (or SKGATEWAY_ES_* env is
// set). Shipping to ES never blocks or breaks the file/append + syslog path.
let esOutputs = [];
if (siemEnabled) {
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
}

function siemHook(evt) {
  if (!siemEnabled) return;
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

/**
 * One recorder for the process. Built lazily on first eligible request so a
 * disabled cache costs nothing at boot and an unreachable embedder cannot stop
 * the gateway starting. A disabled→enabled config transition (e.g. via a
 * SIGHUP reload that mutates the same config object) takes effect on the next
 * eligible request, since _shadowCache is still null until then; but once
 * built, later changes to threshold/categories/embed settings on an
 * already-enabled cache are NOT picked up until process restart.
 */
let _shadowCache = null;
function shadowCache(config) {
  const cfg = config.semantic_cache;
  if (!cfg?.enabled) return null;
  if (!_shadowCache) _shadowCache = createShadowRecorder(cfg, { emit: siemHook });
  return _shadowCache;
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

// ─── x-sk-require header escape hatch (card P4.3, design 7.1) ───
// A one-off caller can declare ranker requirements per-request without
// editing the registry, alongside the existing x-sk-context/x-sk-service/
// x-sk-role headers: `x-sk-require: tool_use,min_ctx=64000,
// tier=local|free-remote`. Reuses parseRequireSpec()'s exact grammar above
// rather than reimplementing it, so the header and the suggest-only rank
// API's inline `require=` spec (P3.3) agree on syntax by construction.

/**
 * Parse the `x-sk-require` header into the same requirements shape the
 * ranker (and this route's sibling, `/admin/models/rank?require=`) consume:
 * `{require, prefer?, tier?}`. Pure, no I/O.
 *
 * Fail-soft (design 7.1): anything that is not a single non-blank string
 * header value (missing, blank, or a non-string such as an array from a
 * duplicated header) is "malformed" and yields `null`, so the caller falls
 * through to normal resolution (role/context/service headers, or the
 * registry default) instead of a broken requirements object corrupting
 * routing. A present-but-nonsense header never throws (parseRequireSpec()'s
 * own fail-soft grammar handles that): a malformed token is ignored at parse
 * time, never a 500. A well-formed but unrecognized require key (a real
 * word, just not one this ranker implements) is a different case and is NOT
 * a no-op: since card C5, rank.mjs's requireFailureReason() fails closed on
 * it (excludes the candidate with excluded_reason `require:unknown:<key>`)
 * rather than silently admitting every candidate, so a sovereignty
 * requirement like `sensitivity=secret` cannot look enforced while doing
 * nothing.
 *
 * @param {string|string[]|undefined} headerValue raw req.headers["x-sk-require"]
 * @returns {{require:object, prefer?:string[], tier?:string[]}|null}
 */
export function parseSkRequireHeader(headerValue) {
  if (typeof headerValue !== "string" || !headerValue.trim()) return null;
  try {
    return parseRequireSpec(headerValue);
  } catch {
    return null;
  }
}

/**
 * The routing.match_enabled gate composition (design 7.2): resolves what
 * (if anything) routeRequest's `requirements` field should be for one
 * request. Pure aside from the injected `matchEnabled` flag, so the OFF case
 * is asserted directly without needing a second server boot against a
 * different config.
 *
 * With the flag off, ALWAYS returns `undefined`, regardless of the header's
 * validity: routeRequest gains no `requirements` field at all, keeping the
 * flag-off shape byte-identical to before this card existed. With the flag
 * on, returns `parseSkRequireHeader(headerValue)`, normalizing its `null`
 * (malformed/absent) to `undefined` so a caller can rely on a single falsy
 * check either way.
 *
 * @param {string|string[]|undefined} headerValue raw req.headers["x-sk-require"]
 * @param {boolean} matchEnabled the routing.match_enabled config flag
 * @returns {{require:object, prefer?:string[], tier?:string[]}|undefined}
 */
export function resolveRequestRequirements(headerValue, matchEnabled) {
  if (!matchEnabled) return undefined;
  return parseSkRequireHeader(headerValue) || undefined;
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
 * rebuild either.
 *
 * The id-to-capabilities mapping itself lives in `buildCapabilityCatalog()`
 * (./ranking/catalog.mjs, card C7): router.mjs's live `@match` routing path
 * delegates to the exact same function, so this admin explain endpoint and
 * live routing can never again quietly diverge on how a metrics snapshot
 * feeds capability derivation (they were found to diverge in card C7 because
 * router.mjs hardcoded its own separate, uninjectable `{ metrics: {} }`).
 * This wrapper only keeps `buildRankCatalog`'s existing exported name/shape
 * stable for its callers and tests.
 *
 * @param {Array<object>} full
 * @param {{getLifecycleFn?:(id:string)=>object, deriveCapabilitiesFn?:(card:object, opts:object)=>object, metricsFn?:(id:string)=>object}} [opts]
 * @returns {Array<object>}
 */
export function buildRankCatalog(full, opts = {}) {
  return buildCapabilityCatalog(full, {
    getLifecycleFn: opts.getLifecycleFn || getLifecycle,
    deriveCapabilitiesFn: opts.deriveCapabilitiesFn || deriveCapabilities,
    metricsFn: opts.metricsFn,
  });
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
  if (clientAuthenticator || operatorAuthenticator) {
    try {
      req.url = stripCredentialQuery(req.url ?? '/');
    } catch {
      res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { message: 'Invalid request path', code: 'invalid_path', status: 400 } }));
      return;
    }
  }
  if (process.env.SKGW_REQLOG) { console.log("[REQLOG]", req.method, req.url); }

  // Authentication is disabled by default. Once either boundary is enabled,
  // only an explicit public allowlist can run without credentials. Admin uses
  // a separate operator registry, so a forwarding proxy cannot confer trust by
  // making a remote socket appear loopback-local.
  if (clientAuthenticator || operatorAuthenticator) {
    const routeAuth = classifyAuthenticationRoute(req.method, req.url);
    if (routeAuth.kind === 'invalid') {
      res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error: { message: 'Invalid request path', code: 'invalid_path', status: 400 } }));
      return;
    }
    if (routeAuth.kind !== 'public') {
      const isAdmin = routeAuth.kind === 'admin';
      const authenticator = isAdmin ? operatorAuthenticator : clientAuthenticator;
      const authConfig = isAdmin ? config.operator_auth : config.client_auth;
      if (!authenticator) {
        siemHook({ ts: new Date().toISOString(), event: isAdmin ? 'operator_auth.denied' : 'client_auth.denied', reason: 'boundary_unavailable', status: 403, path: routeAuth.path });
        res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: { message: 'Authentication boundary unavailable', code: 'authentication_unavailable', status: 403 } }));
        return;
      }
      const contentLength = Number(req.headers['content-length'] ?? 0);
      const tooLarge = !Number.isFinite(contentLength) || contentLength < 0 || contentLength > authConfig.max_request_body_bytes;
      const checked = tooLarge ? { ok: false, reason: 'request_too_large' } : authenticator.authenticate(req.headers);
      if (!checked.ok) {
        const allowed = authenticator.denialAllowed();
        const status = tooLarge ? 413 : (allowed ? 401 : 429);
        const code = tooLarge ? 'request_too_large' : (allowed ? 'client_auth_denied' : 'client_auth_rate_limited');
        siemHook({ ts: new Date().toISOString(), event: isAdmin ? 'operator_auth.denied' : 'client_auth.denied', reason: checked.reason, status, path: routeAuth.path });
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: { message: tooLarge ? 'Request body exceeds configured limit' : 'Client authentication failed', code, status } }));
        return;
      }
      if (isAdmin) {
        req.operator_identity = checked.identity;
        req.identity = { ...checked.identity, method: 'operator_auth' };
        req.agent_id = checked.identity.agent_id;
      }
      else {
        req.identity = checked.identity;
        req.agent_id = checked.identity.agent_id;
        req.headers['x-agent-id'] = checked.identity.agent_id;
        req.headers['x-sk-client-id'] = checked.identity.client_id;
        req.headers['x-sk-credential-revision'] = checked.identity.credential_revision;
      }
      stripCallerCredentials(req.headers);
      siemHook({ ts: new Date().toISOString(), event: isAdmin ? 'operator_auth.accepted' : 'client_auth.accepted', agent_id: checked.identity.agent_id, client_id: checked.identity.client_id, credential_revision: checked.identity.credential_revision, registry_revision: checked.identity.registry_revision, path: routeAuth.path });
    }
  }

  // ── SKWorld authorization gate (L1.8) — OFF BY DEFAULT ──
  // This ENTIRE block is skipped unless SKGATEWAY_AUTHZ_ENFORCE / config.authz.
  // enforce is on, so with the flag off the handler below runs exactly as it did
  // before this feature existed (byte-identical: no identity double-resolve, no
  // decide call, no new headers, no added latency). When ON: classify the route,
  // resolve the subject from the authenticated identity, delegate allow/deny to
  // the capauth PDP, and 403 a gated-route deny before any handler runs. Public
  // routes (health/status/discovery/model-listing) pass straight through.
  if (authzEnforce) {
    let gateIdentity = req.identity ?? {
      agent_id: req.headers["x-agent-id"] || ANONYMOUS_AGENT_ID,
      method: req.headers["x-agent-id"] ? "header" : "anonymous",
      agent: null,
    };
    if (!req.identity && identityRegistry) {
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

  // ── Operator-plane self-served facet (epic c880017b, Phase 3.4) ──
  // /operator/v1/{healthz,readyz,explain,observe} mirror
  // docs/OPERATOR_PLANE_REMOTE_STANDARD.md's wire contract directly off this
  // daemon's existing port, replacing the dead-cli / advisory-only path ATLAS
  // has had to rely on. Read-only, unauthenticated (see operator/http.mjs's
  // module docstring for why that is safe today) GETs; act is a reserved POST
  // stub that always 501s — see handleOperatorAct. Routing is a flat path
  // switch (no sub-router) to match this file's existing style for every
  // other single-purpose route above/below.
  if (req.url === "/operator/v1/healthz" && req.method === "GET") {
    handleOperatorHealthz(req, res);
    return;
  }
  if (req.url === "/operator/v1/readyz" && req.method === "GET") {
    handleOperatorReadyz(req, res, operatorHttpDeps);
    return;
  }
  if (req.url === "/operator/v1/explain" && req.method === "GET") {
    handleOperatorExplain(req, res);
    return;
  }
  if (req.url === "/operator/v1/observe" && req.method === "GET") {
    await handleOperatorObserve(req, res, operatorHttpDeps);
    return;
  }
  if (req.url === "/operator/v1/act" && req.method === "POST") {
    handleOperatorAct(req, res);
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
    if (config.dashboard?.enabled !== true) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Dashboard is disabled", code: 404 } }));
      return;
    }
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
      const advertiseBackends = effectiveAdvertiseBackends(config.backends || {}, router);
      const excluded = excludedModelIds(config);
      const reconciled = buildModelCatalog(advertiseBackends, router, advertiseReconcileMode, excluded);
      // mergeDiscoveredCatalog() layers the discovered provider/free/stale tags
      // onto the reconciled health/status entries and GUARANTEES every model
      // carries a non-empty provider (see src/proxy/advertise.mjs). The
      // allowlist is applied last, exactly as on /admin/models.
      const merged = withoutExcludedModels(
        mergeDiscoveredCatalog(reconciled, discovered, advertiseBackends), excluded);
      const allowlist = loadAllowlist();
      const allowed = applyAllowlist(merged, allowlist);
      // Aliases (buckets + registry roles): additive, allowlist-aware,
      // dedupe concrete-first. Buckets only when buckets_enabled is true.
      const aliases = allowAliases(aliasCatalogEntries(getConfig()), allowlist);
      const seenIds = new Set(allowed.map((m) => m.id));
      const enriched = [...allowed, ...aliases.filter((e) => !seenIds.has(e.id))];
      // Lifecycle view (card P1.4): hide eol/dead ids, flag suspect ones.
      // Composes with (does not replace) the allowlist filter above.
      // Picker badges (card P2.4): additive ctx_tokens/tools/vision derived
      // from each surviving entry's card, if it has one. Superset-only.
      // Public-safe: strip internal card fields (notes) before the funnel.
      // Claimer-aware lifecycle view (incident inc-2026-08-18-qwen38-eol):
      // the advertised set honors the same claim-over-verdict rule as the
      // router's gate, so /v1/models and routability stay consistent.
      const data = stripInternalCardFields(applyPickerBadges(applyLifecycleView(enriched, getLifecycle, modelClaimersFor(advertiseBackends))));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data }));
    } catch (e) {
      console.warn("[skgateway] /v1/models discovery merge failed, falling back to static catalog:", e.message);
      const advertiseBackends = effectiveAdvertiseBackends(config.backends || {}, router);
      const excluded = excludedModelIds(config);
      const fallback = buildModelCatalog(advertiseBackends, router, advertiseReconcileMode, excluded);
      const allowlist = loadAllowlist();
      const allowed = applyAllowlist(fallback, allowlist);
      const aliases = allowAliases(aliasCatalogEntries(getConfig()), allowlist);
      const seenIds = new Set(allowed.map((m) => m.id));
      let data = [...allowed, ...aliases.filter((e) => !seenIds.has(e.id))];
      try {
        data = stripInternalCardFields(applyPickerBadges(applyLifecycleView(data, getLifecycle, modelClaimersFor(advertiseBackends))));
      } catch (e2) {
        console.warn("[skgateway] /v1/models static catalog fallback also failed, serving empty list:", e2.message);
        data = [];
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
      const excluded = excludedModelIds(config);
      const advertiseBackends = effectiveAdvertiseBackends(config.backends || {}, router);
      const reconciled = buildModelCatalog(advertiseBackends, router, advertiseReconcileMode, excluded);
      const merged = withoutExcludedModels(
        mergeDiscoveredCatalog(reconciled, discovered, advertiseBackends), excluded);
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
      const full = withoutExcludedModels(
        applyCardOverlays(await getDiscoveredCatalog(), loadCardOverrides()),
        excludedModelIds(config),
      );
      const allow = loadAllowlist();
      // Aliases (buckets + registry roles): additive to the admin view.
      // Buckets gated on routing.buckets_enabled; roles always advertised.
      const aliases = allowAliases(aliasCatalogEntries(getConfig()), allow);
      const enriched = [...full, ...aliases];
      // Card P2.4: each entry keeps its `card` (from P2.1 + the overlay above)
      // and gains a `lifecycle` record alongside the existing `advertised`
      // allowlist flag.
      const data = buildAdminModelsView(enriched, allow);
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
    if (getConfig().discovery?.enabled === false) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: { message: "Model discovery is disabled", code: 409 },
      }));
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

  // ── POST /admin/models/eval?model=<id> — card P3.5, the micro-eval harness ──
  // Runs the deterministic battery (capability-assessment.mjs: tool_call,
  // structured_output, instruction_following, min_output_tokens) against ONE
  // model THROUGH this gateway, and persists the result onto that model's
  // lifecycle record, where catalog.mjs threads it back into
  // capabilities.tool_use as `basis:'eval'`.
  //
  // EXPLICITLY OPERATOR-TRIGGERED, never automatic (design 6.3: "Never runs in
  // the hot path or refresh loop"). The battery spends real completions and
  // real latency; attaching that to the refresh loop is how a smoke test
  // quietly becomes a benchmark nobody authorised. Loopback only, same gate as
  // every other /admin route.
  if (req.method === "POST" && req.url.split("?")[0] === "/admin/models/eval") {
    if (!isLoopback(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Admin routes are loopback only", code: 403 } }));
      return;
    }
    let modelId = null;
    try {
      modelId = new URL(req.url, "http://127.0.0.1").searchParams.get("model");
    } catch {
      modelId = null;
    }
    if (!modelId) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "query parameter `model` is required", code: 400 } }));
      return;
    }
    try {
      const catalog = buildCapabilityCatalog(buildServingCatalog(), { getLifecycleFn: getLifecycle });
      const entry = catalog.find((e) => e.id === modelId);
      if (!entry) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `unknown model ${modelId}`, code: 404 } }));
        return;
      }
      if (!isEvalEligible(entry)) {
        // Design 6.3 scopes the harness to free/local. An UNKNOWN tier lands
        // here too: billing someone's paid account to discover a capability is
        // the most expensive possible way to guess.
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({
          error: {
            message: "eval runs against free/local models only",
            code: 409,
            model: modelId,
            sovereignty: entry.capabilities?.sovereignty ?? null,
          },
        }));
        return;
      }
      const out = await runModelEval(modelId, {
        chatComplete: createLoopbackChatComplete({ port }),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...out }));
    } catch (e) {
      console.warn("[skgateway] /admin/models/eval failed:", e.message);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "eval failed", code: 500 } }));
    }
    return;
  }

  // ── GET /admin/buckets — live per-bucket pool membership (Part 1b) ──
  // Loopback only, read-only (pattern: /admin/models/rank).
  if (req.url === "/admin/buckets" && req.method === "GET") {
    if (!isLoopback(req)) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Admin routes are loopback only", code: 403 } }));
      return;
    }
    try {
      // Use the same serving-config + discovery union and capability mapper as
      // the live bucket request path. Raw discovery omits local/Anthropic
      // entries and carries no derived trust_zone, which made this endpoint
      // report every internal and secret pool as empty while routing disagreed.
      const cfg = getConfig();
      const excluded = excludedModelIds(cfg);
      const catalog = buildCapabilityCatalog(withoutExcludedModels(buildServingCatalog(), excluded), {
        getLifecycleFn: getLifecycle,
      });
      const policy = policyFromRegistry(loadRegistry());
      const isRoutableFn = (e) => {
        const claimers = router.getBackends()
          .filter((backend) => backend.supportsModel(e.id))
          .map((backend) => backend.id);
        return isEffectivelyRoutable(getLifecycle(e.id), claimers);
      };
      const bucketsEnabled = cfg?.routing?.buckets_enabled === true;
      const all = allBuckets();
      const out = [];
      for (const b of all) {
        try {
          const { members, rejected, ceiling } = resolveBucket({
            bucket: b,
            catalog,
            sensitivityPolicy: policy,
            isRoutable: isRoutableFn,
          });
          const physicalResources = new Set(members.map((m) => m.physical_resource_id));
          out.push({
            bucket: b.bucket,
            model_class: b.model_class,
            sensitivity: b.sensitivity,
            ceiling,
            members,
            member_alias_count: members.length,
            physical_server_count: physicalResources.size,
            physical_resources: [...physicalResources],
            rejected,
          });
        } catch (e) {
          console.warn("[skgateway] /admin/buckets failed for", b.bucket, ":", e.message);
          out.push({
            bucket: b.bucket,
            model_class: b.model_class,
            sensitivity: b.sensitivity,
            ceiling: 0,
            members: [],
            rejected: [],
            error: e.message,
          });
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ buckets_enabled: bucketsEnabled, buckets: out }));
    } catch (e) {
      console.warn("[skgateway] /admin/buckets failed:", e.message);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "internal error building bucket status", code: 500 } }));
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
      const full = withoutExcludedModels(
        applyCardOverlays(await getDiscoveredCatalog(), loadCardOverrides()),
        excludedModelIds(config),
      );
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
    // normalizeAgentId, not the raw header: extractIdentity() below has always
    // trimmed and lower-cased, and this branch did not, so the SAME caller was
    // attributed as "Lumina" here and "lumina" there purely on the identity
    // flag. Per-agent spend queries are exact matches, so that split one agent
    // into two keys nothing joins back together.
    const headerAgent = normalizeAgentId(req.headers["x-agent-id"]);
    let identity = req.identity ?? {
      agent_id: headerAgent ?? ANONYMOUS_AGENT_ID,
      verified: false,
      method: headerAgent ? "header" : "anonymous",
      session_id: req.headers["x-session-id"] || null,
      fingerprint: null,
    };
    if (!req.identity && identityRegistry) {
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
    let receivedBytes = 0;
    for await (const chunk of req) {
      receivedBytes += chunk.length;
      if (clientAuthenticator && receivedBytes > config.client_auth.max_request_body_bytes) {
        siemHook({ ts: new Date().toISOString(), event: 'client_auth.denied', reason: 'request_too_large', status: 413, agent_id: identity.agent_id, path: req.url });
        res.writeHead(413, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: { message: 'Request body exceeds configured limit', code: 'request_too_large', status: 413 } }));
        return;
      }
      chunks.push(chunk);
    }
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
    let classification = null;
    if (config.classification?.enabled && Array.isArray(parsedMessages)) {
      try {
        classification = classifyRequest(parsedMessages, {
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

    // Open the metrics record before dispatch so the collector can pair it with
    // the response. The previous code called recordRequest once AFTER the
    // response with snake_case keys the collector does not read, and never
    // called recordResponse, so token_usage and cost_log stayed empty.
    // agentId uses the same verified-identity expression as routeRequest below
    // (falls back to X-Agent-Id / anonymous) rather than the raw header alone,
    // so spend cannot be attributed to a spoofable header. Computed once here
    // and reused by recordRequest and closeMetrics below so both always agree.
    //
    // WHAT IS ACTUALLY KNOWABLE HERE, established for card 316dd167 / A8 by
    // reading every caller in the fleet rather than assuming. Three real
    // sources, in the order extractIdentity() resolves them:
    //   1. a verified CapAuth PGP signature  (X-CapAuth-Signature)
    //   2. a bearer token the agent registry maps to a named agent
    //   3. the X-Agent-Id header
    // All three are wired and land in request_log.agent_id, token_usage and
    // cost_log; tests/served-model-and-agent.test.mjs pins that end to end.
    //
    // AND FOR THE CURRENT LIVE CALLERS, NONE OF THEM IS PRESENT. agent_id was
    // NULL on all 8,199 rows of the live database not because the gateway drops
    // an identity but because nothing sends one: skcode/Claude Code sends only
    // `Authorization: Bearer sk-local` plus `user-agent: claude-cli/...` and
    // `x-app: cli`; skos, skcapstone, skchat and the Hermes provider send
    // `Content-Type` and nothing else. That bearer literal is shared verbatim by
    // skcode, the pi adapter and the opencode adapter, so it names a CLASS of
    // caller, not an agent, and the user-agent names client software, not who
    // is asking. Deriving an agent from either would be inventing one, so on
    // those paths no agent is knowable and this stays undefined, which records
    // NULL. Attribution for them is a client-side change (send X-Agent-Id),
    // not something this call site can synthesise.
    //
    // The anonymous sentinel is NOT an agent: normalizeAgentId maps it to null
    // so a caller sending `X-Agent-Id: anonymous` cannot make unattributed
    // traffic aggregate under what looks like a real agent.
    const metricsAgentId = normalizeAgentId(identity.agent_id)
      ?? normalizeAgentId(req.headers["x-agent-id"])
      ?? undefined;

    // Metrics must never be able to fail a real inference. recordRequest runs
    // synchronously, before dispatch, with nothing else guarding it, so a
    // metrics-internal failure (e.g. a synchronous write error inside
    // maybeFlush) would otherwise 502 a request that never even reached
    // routeAndSend. On failure metricsReqId stays null, and every metrics call
    // below is guarded on it, so the request proceeds exactly as if metrics
    // were disabled.
    let metricsReqId = null;
    if (metrics) {
      try {
        metricsReqId = metrics.recordRequest({
          agentId: metricsAgentId,
          model: parsedModel || "unknown",
          backend: undefined,           // not chosen yet; overridden on response
          sessionId: req.headers["x-session-id"] || undefined,
        });
      } catch (err) {
        console.error("[skgateway] metrics recordRequest failed:", err.message);
        metricsReqId = null;
      }
    }

    // Closes the metrics record exactly once, from whichever exit path gets
    // there first: the normal response-writing branches below, or the finally
    // block that also runs when routeAndSend (or a response-writing branch)
    // throws. metricsClosed guards against a double-record if more than one
    // call site ever runs (the normal path always sets it, so the finally's
    // own check below is a no-op on success). Never throws itself: a metrics
    // failure here must not become a second, fabricated error stacked on top
    // of whatever the request path already did.
    let metricsClosed = false;
    function closeMetrics({ statusCode, firstByteMs, generationMs, responseHeaders, responseBody, backend, modelServed, errorMsg, energy, energyAttempts } = {}) {
      if (!metrics || !metricsReqId || metricsClosed) return;
      metricsClosed = true;
      try {
        metrics.recordResponse({
          reqId: metricsReqId,
          statusCode,
          totalMs: Date.now() - startTime,
          firstByteMs,
          generationMs,
          responseHeaders: responseHeaders ?? {},
          responseBody: responseBody ?? null,
          agentId: metricsAgentId,
          model: parsedModel || "unknown",
          // The model the UPSTREAM said it served, which is a DIFFERENT fact
          // from `model` directly above it: that one is what the caller asked
          // for. Passed through untouched, including when it is undefined,
          // because "we did not observe it" has to survive as NULL. Never
          // falls back to parsedModel. See recordResponse() in
          // metrics/collector.mjs for the full ruling.
          modelServed,
          backend,
          errorMsg,
        });
      } catch (err) {
        console.error("[skgateway] metrics recordResponse failed:", err.message);
      }

      // Energy rows for this request (joule-economy P0). ONE ROW PER ATTEMPT
      // that produced an observation, not one per request: an attempt that
      // burned joules locally and then failed over to cloud paid for that
      // energy, and a ledger that drops it is showing a number where a cost
      // actually happened. energy_log permits multiple rows per req_id by
      // design. energyRowsFrom() collapses to the single `energy` field when
      // there is no per-attempt list, so the ordinary one-attempt request is
      // unchanged, and returns [] when neither is set, so the default
      // shadow-mode (disabled) path still writes nothing.
      for (const row of energyRowsFrom({ energy, energyAttempts })) {
        try {
          metrics.recordEnergy({
            reqId: metricsReqId,
            agentId: metricsAgentId,
            model: parsedModel || "unknown",
            // The attempt's own backend, falling back to the request's
            // serving backend for the single-row shape that carries none.
            backend: row.backendId ?? backend,
            cardId: req.headers["x-sk-card-id"] || null,
            joules: row.joules,
            basis: row.basis,
            node: row.node,
            concurrencyN: row.concurrencyN ?? 1,
          });
        } catch (err) {
          // Per row, so one unwritable row cannot swallow the others.
          console.error("[skgateway] metrics recordEnergy failed:", err.message);
        }
      }
    }

    // ── Apply model limits to request body (card 080e032e) ──
    // Fail-closed: reject before any provider dispatch if limits are exceeded.
    // Uses the same model_limits config section as core.mjs, with the same
    // per-model overrides for maxBodyBytes and maxSystemBytes.
    let transformedBody = routeBody;
    let transformedMessages = parsedMessages;
    try {
      if (parsedModel && parsedMessages && Array.isArray(parsedMessages)) {
        // Build a minimal parsed body object for the trim functions
        const parsedBody = { model: parsedModel, messages: [...parsedMessages] };

        // Resolve per-model limits (overrides global defaults)
        const modelLimits = buildModelLimits(config.model_limits || {});
        const perModel = modelLimits[parsedModel] || {};
        const maxBodyBytes = perModel.maxBodyBytes || 120000;
        const maxSystemBytes = perModel.maxSystemBytes || 40000;

        // trimSystemMessages() and trimConversationHistory() both do
        //     const log = cfg.logger.log.bind(cfg.logger);
        // so a cfg without a logger throws on the FIRST line of the trim, the
        // fail-closed catch below turns that into a 500, and every request the
        // gateway serves 500s. A logger is not optional here.
        const cfg = {
          maxBodyBytes,
          maxSystemBytes,
          logger: { log: (msg) => console.log(`[skgateway] ${msg}`) },
        };

        // Trim system messages first (to free budget for history)
        trimSystemMessages(parsedBody, cfg);

        // Trim conversation history
        trimConversationHistory(parsedBody, cfg);

        // Update the transformed messages for dispatch
        transformedMessages = parsedBody.messages;

        // Re-serialize the body with transformed messages
        // This replaces routeBody before it goes to routeAndSend
        if (anthropicWant || (req.headers["content-type"]?.includes("application/json"))) {
          const requestObj = JSON.parse(routeBody.toString("utf-8"));
          requestObj.messages = transformedMessages;
          transformedBody = Buffer.from(JSON.stringify(requestObj), "utf-8");
        }
      }
    } catch (e) {
      // Fail-closed: any error during limit application rejects the request
      // before provider dispatch
      console.error("[skgateway] model limits processing failed (fail-closed):", e.message);
      closeMetrics({ statusCode: 500, errorMsg: "Request processing failed" });
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Request processing failed", code: 500 } }));
      }
      return;
    }

    const routeRequest = {
      model:   parsedModel,
      messages: transformedMessages,
      // Verified CapAuth identity (falls back to X-Agent-Id / anonymous).
      agentId: metricsAgentId,
      // Preserve the resolved request/session identity on every typed router
      // audit event, alongside agent and per-request correlation ids.
      sessionId: identity.session_id || req.headers["x-session-id"] || undefined,
      // skmodels registry role/context routing (single source of truth).
      // Present => routeAndSend resolves via ~/.skcapstone/models/registry.yaml
      // (precedence context > service > role > default) before backend select.
      context: req.headers["x-sk-context"] || undefined,
      service: req.headers["x-sk-service"] || undefined,
      role:    req.headers["x-sk-role"]    || undefined,
      // Internal card id for energy/cost attribution (joule-economy P0).
      // Stripped before forwarding upstream in router.mjs; never leaves the
      // gateway.
      cardId:  req.headers["x-sk-card-id"] || undefined,
      // x-sk-require escape hatch (card P4.3): DEFAULT OFF via
      // matchRoutingEnabled (routing.match_enabled). With the flag off this
      // is always `undefined` (no field added, no parse run): byte-identical
      // to before this card. router.mjs's @match branch (card P4.2) is the
      // only consumer; unconsumed today, this composes inertly with
      // context/service/role above.
      requirements: resolveRequestRequirements(req.headers["x-sk-require"], matchRoutingEnabled),
    };

    // Dispatch-through-response-writing runs in its own try/finally so that
    // ANY throw here (routeAndSend re-throws everything that is not a
    // ModelEolError, most routinely a backend timeout or DNS failure) still
    // closes the metrics record before the exception continues propagating to
    // the outer catch below. Without this, such a request opened a `pending`
    // entry in the collector via recordRequest above and NEVER closed it,
    // leaking one entry per failed request for the life of the process.
    let result;
    let dispatchError = null;
    const upstreamAbort = new AbortController();
    const onClientClose = () => {
      if (!res.writableEnded) {
        upstreamAbort.abort(new Error("downstream client disconnected"));
      }
    };
    res.once("close", onClientClose);
    if (res.destroyed) onClientClose();
    try {
      // Semantic cache, SHADOW ONLY. Records whether a cached answer would have
      // matched and throws that answer away. It cannot change what is served.
      // Guarded on eligible() first so ineligible traffic never spends an embed.
      const _sc = shadowCache(config);
      const _scText = _sc && Array.isArray(parsedMessages)
        ? parsedMessages.filter((m) => m?.role === "user")
            .map((m) => (typeof m.content === "string" ? m.content : "")).join("\n").trim()
        : "";
      const _scCategory = classification?.category;
      const _scEligible = Boolean(_sc && _scText && _sc.eligible(_scCategory));
      if (_scEligible) {
        try {
          await _sc.observe({ text: _scText, agent: metricsAgentId, category: _scCategory });
        } catch { /* the cache is an observer; a failure here must never fail the request */ }
      }

      result = await routeAndSend(
        router, routeRequest, routePath, req.method, req.headers, transformedBody, true, siemHook,
        upstreamAbort.signal,
      );

      // ── Response sanitization (card 080e032e) ──
      // Apply sanitizer.mjs response sanitization before the client receives bytes.
      // This strips leaked markup, handles <think> blocks, and repairs malformed content.
      // Fail-closed: sanitization errors reject before sending to client.
      if (result && result.body && result.status === 200) {
        try {
          let responseBody = result.body;
          let needsReencoding = false;

          // Parse response body for sanitization
          if (!result.headers["content-type"]?.includes("text/event-stream")) {
            // Non-streaming response: parse and sanitize JSON
            try {
              const parsedResponse = JSON.parse(responseBody.toString("utf-8"));
              const sanitized = sanitizeResponse(parsedResponse, {
                label: "skgateway",
                thinkMode: config.sanitizer?.thinkMode || "strip"
              });

              // Check if sanitization changed anything
              if (JSON.stringify(parsedResponse) !== JSON.stringify(sanitized)) {
                result.body = Buffer.from(JSON.stringify(sanitized), "utf-8");
                console.log(`[skgateway] response sanitized for model=${parsedModel}`);
              }
            } catch (parseError) {
              // Not parseable as JSON - pass through unchanged
              console.warn(`[skgateway] response not JSON, skipping sanitization: ${parseError.message}`);
            }
          }
          // Streaming responses are buffered by routeAndSend and arrive here as
          // complete bodies, so the same sanitization applies.
        } catch (e) {
          // Fail-closed: sanitization error rejects before sending to client
          console.error("[skgateway] response sanitization failed (fail-closed):", e.message);
          closeMetrics({ statusCode: 500, errorMsg: "Response sanitization failed" });
          if (!res.headersSent) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Response sanitization failed", code: 500 } }));
          }
          return;
        }

        if (_scEligible && result?.status === 200 && result?.body) {
          try {
            _sc.record({
              text: _scText,
              response: JSON.parse(result.body.toString("utf-8")),
              agent: metricsAgentId,
              category: _scCategory,
            });
          } catch { /* not JSON, nothing to cache; never break the response */ }
        }

        // Measure bytes-per-token against what the backend actually reported, so
        // the context guard's byte budget can eventually stop guessing at ~4.
        // Sampling only: nothing here changes trimming, routing, response bytes,
        // or status codes. Never throws.
        //
        // bodyBytes is transformedBody, NOT routeBody: transformedBody is what
        // was actually sent to the backend after model-limit trimming (see
        // ~line 2165), and the backend's reported prompt_tokens describes
        // exactly that payload. Measuring the pre-trim routeBody against those
        // tokens would overstate bytes-per-token on every trimmed request.
        //
        // model is read from the response body the backend named, NOT
        // result.servedModel and NEVER parsedModel/the requested alias. Same
        // reasoning as the modelServed comment below (~line 2490): the backend
        // can answer a different model than the router dispatched or the
        // caller requested, and a ratio filed under the requested alias would
        // blend every model that alias resolves to. sampleTokenRatio() already
        // returns null when neither name is present, so no fabrication risk.
        //
        // Samples cover NON-STREAMING JSON responses only: an SSE body is a
        // stream of `data: {...}` frames, not a single JSON object, so
        // JSON.parse on it throws and the sample would silently vanish into
        // the catch below. Rather than let that failure mode masquerade as
        // "nothing to measure", detect it up front from the content-type and
        // emit a token_ratio.skipped event instead, so the skipped population
        // is countable and B-Task 3 can report "N measured, M skipped
        // (streaming)" rather than presenting an unrepresentative sample as
        // if it covered all traffic.
        try {
          if (result.headers?.["content-type"]?.includes("text/event-stream")) {
            siemHook({ ts: new Date().toISOString(), event: "token_ratio.skipped", reason: "streaming" });
          } else {
            const _parsed = JSON.parse(result.body.toString("utf-8"));
            const _sample = sampleTokenRatio({
              model: (typeof _parsed?.model === "string" && _parsed.model) ? _parsed.model : result?.servedModel,
              bodyBytes: transformedBody?.length ?? 0,
              usage: _parsed?.usage,
            });
            if (_sample) siemHook({ ts: new Date().toISOString(), event: "token_ratio.sample", ..._sample });
          }
        } catch { /* a backend that reports no usage simply is not measured */ }
      }

      // The socket is already gone. routeAndSend has released the upstream
      // request and pool slot; do not attempt to write a synthetic 499 to a
      // dead response. The finally block still closes request metrics.
      if (result?.cancelled || res.destroyed) return;

      // Return energy to the caller (spec 4.5): x-sk-energy-joules /
      // -basis / -node. Cost was being recorded and never returned, so no
      // client could react to what it spends, which is the gap the spec
      // names. Derived only from what was actually observed on the serving
      // attempt: `{}` when energy metering is off (result.energy unset), and
      // individually absent, never empty, for any field we do not know. That
      // empty object spreads to nothing, so the disabled path emits exactly
      // the headers it emitted before.
      //
      // The SERVING attempt only, deliberately, not a sum over
      // result.energyAttempts. A failover's attempts can carry different
      // bases (measured_gpu locally, imputed_cloud on the retry) and spec 4.2
      // forbids presenting a mix of bases as one blended number. One joules
      // value has to mean one basis and one node, so it means the attempt
      // that produced the response the client is holding. The full
      // per-attempt cost is in energy_log, where each row carries its own
      // basis and can be aggregated honestly.
      const eHeaders = energyHeaders(result?.energy);

      // Attribution headers (card 3351d25b / A6.2): x-sk-req-id /
      // x-sk-backend / x-sk-model-served. request_log already recorded
      // (id, agent_id, model, backend, session_id) for this call and returned
      // none of it, so a caller holding a response had no key to join on.
      // These ride the SAME merge path as the energy headers rather than a
      // parallel one, which is why the streaming branch below needs no extra
      // work: SSEWriter's extraHeaders option already carries them.
      //
      // Computed here, AFTER routeAndSend has resolved, and that is safe: the
      // gateway buffers whole responses including streamed ones, so the
      // serving backend is already known and unambiguous at header-write time
      // and there is no mid-stream window in which the answer could change.
      //
      // Same ruling as the energy headers directly above, deliberately, so the
      // fleet does not carry two answers to "which attempt does this header
      // describe": the SERVING attempt only. On a failover, backendId and
      // servedModel come from the attempt that produced the bytes the client
      // is holding, never a blend. Per-attempt detail lives in the logs.
      //
      // Unknown fields are ABSENT, never empty, exactly as energyHeaders does
      // it. A request that never reached a backend (EOL-gated 404,
      // all-candidates-throttled 429, no result at all) has no serving backend
      // to name and says so by not claiming one. A header that is always
      // present would prove nothing about the call in hand.
      const aHeaders = attributionHeaders(metricsReqId, result);
      const skHeaders = { ...eHeaders, ...aHeaders };

      if (!result) {
        if (!res.headersSent) {
          // No backend produced anything, so aHeaders carries the req id alone
          // (backend and served model are genuinely unknown and stay absent).
          // The row still exists in request_log, written by closeMetrics
          // below, so the id is exactly the join key a caller needs to find
          // out what happened to a request that failed.
          res.writeHead(502, { "content-type": "application/json", ...aHeaders });
          res.end(JSON.stringify({ error: { message: "No backend produced a response", code: 502 } }));
        }
      } else if (anthropicWant) {
        // Translate the buffered OpenAI result back to the Anthropic wire format.
        let oai = null;
        try { oai = JSON.parse((result.body || "").toString("utf-8")); } catch {}
        if (result.status >= 300 || !oai) {
          // Upstream error / unparseable: pass it through so the Anthropic client
          // sees the real status rather than a fabricated success.
          const headers = { ...result.headers, ...skHeaders };
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
            const writer = new SSEWriter(res, { keepAliveMs: 0, extraHeaders: skHeaders });
            writer.start();
            jsonToSSE(writer, amsg);
          } else {
            const outBuf = Buffer.from(JSON.stringify(amsg), "utf-8");
            res.writeHead(200, {
              "content-type": "application/json",
              "content-length": outBuf.length,
              ...skHeaders,
            });
            res.end(outBuf);
          }
        }
      } else {
        const headers = { ...result.headers, ...skHeaders };
        delete headers["content-length"];
        delete headers["transfer-encoding"];
        delete headers["content-encoding"];
        res.writeHead(result.status, headers);
        res.end(result.body);
      }
    } catch (err) {
      // Record which branch we're in for the finally block below, then
      // rethrow unchanged: the outer catch still writes the 502 (or leaves an
      // already-started response alone) exactly as it did before this round,
      // so the client-visible behaviour on this path is unaffected.
      dispatchError = err;
      throw err;
    } finally {
      res.off("close", onClientClose);
      if (dispatchError) {
        // routeAndSend or a response-writing branch threw. res.headersSent
        // tells us whether the outer catch (which runs right after this
        // finally) will still get to write the 502 itself, or whether a
        // partial response already went out; either way, record a real
        // non-2xx status and the error message so this shows up in
        // request_log as a closed, failed request rather than a silently
        // missing row.
        closeMetrics({
          statusCode: res.headersSent ? (res.statusCode || 502) : 502,
          firstByteMs: result?.firstByteMs,
          generationMs: result?.generationMs,
          responseHeaders: {},
          responseBody: null,
          backend: result?.backendId,
          errorMsg: dispatchError.message,
          energy: result?.energy,
          energyAttempts: result?.energyAttempts,
        });
      } else {
        let parsedBody = null;
        try {
          parsedBody = result?.body ? JSON.parse(result.body.toString("utf8")) : null;
        } catch {
          parsedBody = null;           // SSE or non-JSON; usage extraction skipped
        }
        closeMetrics({
          statusCode: result?.status ?? res.statusCode,
          firstByteMs: result?.firstByteMs,
          generationMs: result?.generationMs,
          responseHeaders: result?.headers ?? {},
          responseBody: parsedBody,
          backend: result?.backendId,
          // Card 316dd167 / A8: the one fact that distinguishes a silent
          // substitution from an ordinary call, and it was already sitting in
          // memory here. The gateway relays the upstream body verbatim
          // (rewriteBodyModel is request-side only), so parsedBody.model is
          // what the backend SAID answered, not an echo of what we asked for.
          // Measured live: a call for `sk-default` came back naming
          // `ornith-1.0-9b`, and one for `sk-m-internal` came back naming
          // `claude-sonnet-5`.
          //
          // Note this is deliberately NOT result.servedModel, which is what
          // the ROUTER dispatched and therefore echoes the request whenever no
          // rewrite happened; that value is the one returned as the
          // x-sk-model-served header by card 3351d25b. The two can disagree,
          // and when they do the disagreement IS the finding.
          //
          // parsedBody is already null when the body is SSE or non-JSON, so
          // this is undefined on exactly those paths and the column stays NULL
          // meaning unobserved. That is by construction, not by a special
          // case, and it must never be widened to `|| parsedModel`.
          modelServed: result?.servedModel,
          energy: result?.energy,
          energyAttempts: result?.energyAttempts,
        });
      }
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
    clientAuthenticator = config.client_auth?.enabled ? new ClientAuthenticator(config.client_auth) : null;
    operatorAuthenticator = config.operator_auth?.enabled ? new ClientAuthenticator(config.operator_auth) : null;
    console.log("[skgateway] config reloaded");
  } catch (e) {
    if (clientAuthenticator) clientAuthenticator.available = false;
    if (operatorAuthenticator) operatorAuthenticator.available = false;
    console.error("[skgateway] config reload failed:", e.message);
  }
});

// ─── Start ───
server.listen(port, bind, () => {
    console.log("[skgateway] listening on http://" + bind + ":" + port);
    const backendNames = Object.keys(config.backends || {});
    console.log("[skgateway] backends: " + (backendNames.join(", ") || "default"));
    console.log("[skgateway] metrics: " + (metrics ? "enabled" : "disabled"));
    if (dashboard) {
      const dashPort = config.dashboard?.port || config.server?.dashboard_port || 18781;
      console.log("[skgateway] dashboard: port " + dashPort);
    } else {
      console.log("[skgateway] dashboard: disabled");
    }
    // Advertise to skcapstone service discovery when present (no-op otherwise).
    try {
      if (skcapstone.registerService({ healthUrl: `http://localhost:${port}/health` })) {
        console.log("[skgateway] registered with skcapstone service discovery");
      }
    } catch {}
});
