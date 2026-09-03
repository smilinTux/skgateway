/**
 * router.mjs — Multi-backend router for SKGateway
 *
 * Manages a registry of LLM backends (Anthropic, NVIDIA NIM, Ollama, and
 * any custom endpoint).  For each incoming inference request it selects the
 * best healthy backend, attaches the appropriate auth headers, and—on
 * failure—falls over to the next eligible backend by priority.
 *
 * Public API (returned by `createRouter`):
 *
 *   route(request)    — Resolve a RouteResult for the request
 *   getHealth()       — Snapshot of every backend's health state
 *   addBackend(cfg)   — Register a new backend at runtime
 *   removeBackend(id) — Deregister a backend by id
 *
 * @module router
 */

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { sendUpstream } from "./upstream.mjs";
import { createEvent, EventType } from "../siem/events.mjs";
import { isAnthropicBackend, toAnthropicRequest, toOpenAIResponse } from "./anthropic-adapter.mjs";
import {
  isCodexBackend,
  toCodexRequest,
  fromCodexResponse,
  readCodexAuthHeaders,
} from "./codex-adapter.mjs";
import { isZaiBackend, readZaiAuthHeaders } from "./zai-adapter.mjs";
import { getPool, PoolAdmissionError } from "./connection-pool.mjs";
import { isRegistryRouted, resolve as resolveRegistry, getAutoConfig, getConfigEpoch, loadRegistry } from "./registry.mjs";
import { getFailoverConfig, isLocalUrl, probeLocalHealth, recordLocalOutcome } from "./local-failover.mjs";
import { readMeter } from "./meter-client.mjs";
import { marginalJoules, imputeJoules, resolveBasis, coeffsForModel, backendIsLocal, usageFromSSE, resolveMeterUrl } from "../metrics/energy.mjs";
import { recordModelOutcome, getLifecycle } from "../discovery/model_catalog_store.mjs";
import { isRoutable, isEffectivelyRoutable } from "../discovery/lifecycle.mjs";
import { applyReasoningFloor } from "./core.mjs";
import { enforceResponseContract } from "./response-contract.mjs";
import { createDecisionCache, decisionKey } from "./decision-cache.mjs";
// card P4.2 (@match routing): reuse the existing ranker + capability deriver
// + discovery cache reader + allowlist/availability checks as-is, no
// reimplementation. getConfig() gates the whole branch behind
// routing.match_enabled (config.mjs, unmodified: the DEFAULTS already carry
// a `routing:` block, card P4.4 adds match_enabled to it later).
import { getConfig } from "../config.mjs";
import { buildServingCatalog } from "../discovery.mjs";
import { rankModels } from "../ranking/rank.mjs";
import { buildCapabilityCatalog } from "../ranking/catalog.mjs";
import { loadAllowlist } from "../advertise.mjs";
import { isCatalogDisabledBackend, isModelAvailable, excludedModelIds, withoutExcludedModels } from "./advertise.mjs";
import {
  resolveZoneCeiling,
  isZoneAllowed,
  policyFromRegistry,
  TRUST_ZONES,
} from "../policy/sensitivity.mjs";
import {
  parseBucketId,
  resolveBucket,
  orderMembersByCost,
  validateFamilyPreference,
  applyFamilyPreference,
  selectMember,
  requiresToolUse,
  looksLikeBucketAttempt,
  allBuckets,
} from "../policy/buckets.mjs";
import { codexPurityProblems } from "../policy/codex-purity.mjs";

// sk-auto routing decision cache (TTL+LRU); keyed by request fingerprint + config epoch.
const _autoDecisionCache = createDecisionCache({ ttlMs: 60_000, maxEntries: 500 });
// @match ranked-pick decision cache (card P4.2). Separate from the sk-auto
// cache above so entries never collide; same TTL/LRU discipline.
const _matchDecisionCache = createDecisionCache({ ttlMs: 60_000, maxEntries: 500 });
import { classifyDifficulty } from "../classifiers/difficulty.mjs";
import { adjustWithEmpirical, promptClassFromResult } from "../classifiers/empirical.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Window size for the sliding error-rate calculation (number of requests). */
/**
 * Client-supplied credential headers, stripped before ANY upstream call
 * (card 6e61f798 / C15).
 *
 * These authenticate a caller TO THIS GATEWAY. None of them is ever a valid
 * credential for an upstream provider, and relaying one is a credential
 * disclosure to a third party. `authorization` is the one that was actually
 * observed leaking to opencode.ai; the rest are here because they are the same
 * category and there is no reason to wait for each to be demonstrated.
 */
export const CLIENT_CREDENTIAL_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "x-sk-capability",
];

/**
 * Gateway-internal control headers the caller sends for OUR routing logic.
 * Meaningless to an upstream provider, and several of them (agent id, session
 * id, service name) describe our internal topology, so they are stripped from
 * third-party calls for the same reason `x-sk-card-id` already was.
 */
export const INTERNAL_CONTROL_HEADERS = [
  "x-sk-card-id",
  "x-sk-context",
  "x-sk-prefer",
  "x-sk-require",
  "x-sk-role",
  "x-sk-service",
  "x-agent-id",
  "x-sk-client-id",
  "x-sk-credential-revision",
  "x-sk-operator-id",
  "x-sk-operator-client-id",
  "x-sk-operator-credential-revision",
  "x-session-id",
  "x-model",
  "x-sk-family-preference",
  "x-sklegal-service-authorization",
  "x-sklegal-tenant-id",
  "x-sklegal-matter-id",
  "x-sklegal-material-id",
  "x-sklegal-material-version",
  "x-sklegal-route-id",
  "x-sklegal-purpose",
  "x-sklegal-classification",
  "x-sklegal-privilege",
  "x-sklegal-ethical-wall",
];

const HEALTH_WINDOW = 100;

/** Mark backend degraded once error rate exceeds this threshold (10 %). */
const DEGRADED_ERROR_RATE = 0.10;

/** Mark backend down once error rate exceeds this threshold (50 %). */
const DOWN_ERROR_RATE = 0.50;

/**
 * After a backend is marked down it enters a cooldown.  Any health check
 * issued during the cooldown resolves immediately as "down" without making
 * a real request.  After the cooldown expires the backend is put back into
 * "degraded" and allowed one probe request to determine liveness.
 *
 * Default: 60 seconds.
 */
const DEFAULT_COOLDOWN_MS = 60_000;

/** Timeout (ms) used for liveness probe requests during recovery. */
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Max ranked candidates mapped into the router's candidate array for an
 * `@match` role (card P4.2, design 7.2: "the ranked chain IS the failover
 * chain"). Bounds the number of `router.route()` lookups a single `@match`
 * request performs.
 */
const MATCH_TOP_K = 5;

/**
 * Discovery catalog cache path the `@match` ranker reads (card P4.2). Mirrors
 * discovery.mjs's own (unexported) default path exactly, so production reads
 * the SAME file discovery cycles already write; env-overridable so tests
 * never touch the real per-node cache.
 */
const MATCH_CATALOG_CACHE_PATH =
  process.env.SKGATEWAY_MODEL_CATALOG_CACHE_PATH ||
  path.join(homedir(), ".config", "skgateway", "model_catalog_cache.json");

/**
 * Thrown by `route()` when a request names a concrete model id that the
 * lifecycle store (model_catalog_store.mjs) knows is `eol`/`dead` and no
 * backend explicitly declares it (card P1.6, arch doc 7.3). Lets
 * `routeAndSend()` answer with a clean 404 + `eol_reason` instead of
 * spraying the request across every configured backend. An UNKNOWN id (never
 * recorded, or still `active`/`suspect`) never triggers this: it keeps
 * today's fall-through behavior, backward-compat.
 */
export class ModelEolError extends Error {
  constructor(model, eolReason) {
    super(`model "${model}" is end-of-life (${eolReason || "unknown reason"})`);
    this.name = "ModelEolError";
    this.model = model;
    this.eolReason = eolReason || null;
    this.status = 404;
  }
}

/**
 * Every backend which explicitly declares this model is temporarily
 * quarantined for this exact claim. This is intentionally distinct from a
 * global lifecycle EOL verdict: another backend declaring the same model can
 * remain selectable and advertised.
 */
export class ModelClaimQuarantinedError extends Error {
  constructor(model) {
    super(`all backend claims for model "${model}" are quarantined`);
    this.name = "ModelClaimQuarantinedError";
    this.model = model;
    this.status = 503;
  }
}

export class ModelOwnerDownError extends Error {
  /** Fail closed when a declared model's owning backend is down (purity). */
  constructor(model, declaredBy) {
    super(
      `model "${model}" is declared by [${(declaredBy || []).join(", ")}] ` +
        `but every owner backend is currently unavailable; refusing to route ` +
        `to unrelated backends`,
    );
    this.name = "ModelOwnerDownError";
    this.model = model;
    this.declaredBy = declaredBy || [];
    this.status = 503;
  }
}

/**
 * Dead-alias auto-quarantine (card 2d1f3a2c).
 *
 * The error-rate health machine (DEGRADED/DOWN above) reacts to the fraction of
 * failures across a 100-request window. That is slow to fire for a freshly-dead
 * alias whose prior successes still dilute the window, and a backend can sit in
 * "degraded" (still selectable) while failing every call. The quarantine layer
 * is a complementary, faster CONSECUTIVE-failure trip: N failures in a row take
 * the alias fully OUT of rotation (routing skips it) for a cooldown, after which
 * a single probe is admitted; one success re-admits it. Quarantine and recovery
 * both emit a SIEM/log event. Threshold <= 0 disables the layer.
 */

/** Consecutive upstream failures before an alias is quarantined. 0 = disabled. */
const DEFAULT_QUARANTINE_THRESHOLD = 5;

/** Cooldown (ms) a quarantined alias stays out of rotation before a re-probe. */
const DEFAULT_QUARANTINE_COOLDOWN_MS = 30_000;

/** Repeated fast wrong-answer failures before one backend-model claim is removed. */
const DEFAULT_MODEL_CLAIM_QUARANTINE_THRESHOLD = 3;
const DEFAULT_MODEL_CLAIM_QUARANTINE_COOLDOWN_MS = 30_000;

/**
 * Fast wrong answers are classified synchronously from the completed attempt.
 * 404/410 mean this door rejected the exact model id. 502 includes a refused
 * connection or absent listener as normalized by sendUpstream(). A slow 504
 * completion timeout is deliberately excluded and remains the separate
 * completion-liveness path.
 */
export function isFastModelClaimFailure(status) {
  return status === 404 || status === 410 || status === 502;
}

// ---------------------------------------------------------------------------
// Rate-limit failover (card 9e28de88): 429 (and, deliberately, 402) are
// failover-worthy, MODEL-granular cooldowns, not the backend-granular
// quarantine machine above.
//
// MEASURED: opencode.ai zen's free tier (deepseek-v4-flash-free) returns 429
// FreeUsageLimitError once its budget is spent. The candidate loop used to
// treat `res.status < 500` as success, so a throttled model was returned to
// the caller verbatim instead of failing over, and the whole promise of a
// multi-provider pool ("give me any door that fits") collapsed to "give me
// the first door's error".
//
// WHY NOT THE QUARANTINE MACHINE ABOVE: quarantine is backend-granular (N
// consecutive failures pull the WHOLE backend out of rotation for every
// model it serves). A 429 says nothing about the backend, which is healthy;
// it says one model on it is out of free-tier budget right now. Reusing
// quarantine here would punish every other model on a perfectly healthy
// backend for one model's rate limit, exactly the mistake the eol work
// (card P1.2/P1.6) already made and un-made for lifecycle state: use the
// instrument sized to the evidence.
//
// This cooldown is keyed by (backendId, model) so:
//   - the SAME backend serving a DIFFERENT model is unaffected, and
//   - a DIFFERENT backend (another door) serving the SAME model is
//     unaffected, which is exactly what lets #5 below (prefer another door
//     to the same model) actually pay off on the very next request.
// ---------------------------------------------------------------------------

/** @type {Map<string, {untilMs:number, status:number, retryAfterMs:?number, hits:number, lastAt:number}>} */
const _throttleCooldowns = new Map();

/** Default cooldown (ms) for a 429 with no `Retry-After` header. Free-tier
 * 429s are almost always a seconds-scale window, so this stays short. */
const DEFAULT_429_COOLDOWN_MS = 30_000;

/**
 * Default cooldown (ms) for a 402 with no `Retry-After` header. See the
 * 402/403 decision comment on `isFailoverStatus()` below: a 402 on these
 * providers means "quota exhausted for the billing period", which resets on
 * an hours/day scale, not a seconds scale, so the default is much longer
 * than the 429 default on purpose.
 */
const DEFAULT_402_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

/** Ceiling on any single cooldown, including a Retry-After-derived one, so a
 * provider that sends back an absurd value (or a full daily reset window in
 * seconds) can never take a door out of rotation for longer than this from
 * this process's point of view. */
const MAX_THROTTLE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

function throttleKey(backendId, model) {
  return `${backendId}::${model}`;
}

/**
 * Parse a `Retry-After` header value (delta-seconds or an HTTP-date) into
 * milliseconds. Returns null when absent/unparseable so the caller falls
 * back to a status-specific default.
 *
 * @param {*} value
 * @returns {?number}
 */
function parseRetryAfterMs(value) {
  if (value === undefined || value === null || value === "") return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const dateMs = Date.parse(String(value));
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

/**
 * Which upstream status codes should advance the candidate loop to the next
 * door rather than being handed straight back to the caller (card 9e28de88
 * fix #1). `isThrottleStatus()` is the subset of these that are also a
 * MODEL-granular cooldown signal (#2) rather than a backend-health one.
 *
 *   >= 500  existing behavior, unchanged: backend/server error, retry
 *           elsewhere.
 *   429     rate limited. The model is alive and correct, just throttled on
 *           THIS door right now. Retryable elsewhere immediately, and
 *           retryable on the SAME door again after a short cooldown.
 *   402     DELIBERATE DECISION: also failover-worthy. On these free-tier
 *           providers a 402 means "quota exhausted for the billing period"
 *           for this door/account, not "the model is broken" and not "slow
 *           down for a second". A different door (another provider, or the
 *           same provider's other free models) is not touched by one
 *           model's period quota, so moving to the next candidate is
 *           correct, same as 429, just with a much longer default cooldown
 *           (period-scale, these providers rarely send Retry-After on a
 *           402).
 *   403     DELIBERATE DECISION: left OUT, still terminal (unchanged,
 *           handled by the pre-existing `res.status < 500` path). On these
 *           providers a 403 is overwhelmingly an authorization/policy
 *           verdict (bad or missing API key, this key not entitled to this
 *           model, a content-policy block), not a quota window. Those
 *           reasons are either permanent for this exact request (failing
 *           over would hide a real misconfiguration behind a slower
 *           multi-hop retry instead of surfacing it) or would recur
 *           identically on every other door sharing the same credential
 *           (failing over buys nothing but loses attribution). If a
 *           provider is later measured overloading 403 for quota the way
 *           OpenRouter overloads 402 for it, that is its own follow-up
 *           card with its own measurement, not a guess baked in here.
 *
 * @param {number} status
 * @returns {boolean}
 */
function isFailoverStatus(status) {
  return status >= 500 || status === 429 || status === 402;
}

/**
 * Subset of `isFailoverStatus()` that is a rate/quota throttle rather than a
 * hard backend error, i.e. the statuses that arm the model-granular cooldown
 * and must NOT touch backend health (see `healthy` in the candidate loop,
 * which stays `res.status < 500` unchanged).
 *
 * @param {number} status
 * @returns {boolean}
 */
function isThrottleStatus(status) {
  return status === 429 || status === 402;
}

/**
 * Record a throttle (429/402) observation for a (backend, model) door and
 * arm its cooldown. This doubles as fix #6 ("record observed throttle
 * events per (model, provider)"): every call updates `hits`/`lastAt` on the
 * SAME map the cooldown check reads, rather than a second parallel
 * scoreboard. `_throttleStateForTests()` exposes it for assertions.
 *
 * NOT wired into src/ranking/rank.mjs's `dimValue()` by this card: that
 * ranker scores catalog entries per MODEL id (design 4.1), not per
 * (model, provider) door, so there is nowhere for a provider-granular
 * throttle signal to land without first making the ranker provider-aware,
 * which is its own card. This function is the recording half only; see the
 * router.mjs module comment / PR description for what is deliberately left
 * for that follow-up.
 *
 * @param {string} backendId
 * @param {string} model
 * @param {number} status  429 or 402
 * @param {*} retryAfterHeader  raw `retry-after` header value, if present
 * @returns {{untilMs:number, cooldownMs:number}}
 */
function recordThrottle(backendId, model, status, retryAfterHeader) {
  const key = throttleKey(backendId, model);
  const prior = _throttleCooldowns.get(key);
  const headerMs = parseRetryAfterMs(retryAfterHeader);
  const defaultMs = status === 402 ? DEFAULT_402_COOLDOWN_MS : DEFAULT_429_COOLDOWN_MS;
  const cooldownMs = Math.min(headerMs ?? defaultMs, MAX_THROTTLE_COOLDOWN_MS);
  const untilMs = Date.now() + cooldownMs;
  const hits = (prior?.hits || 0) + 1;
  _throttleCooldowns.set(key, { untilMs, status, retryAfterMs: headerMs, hits, lastAt: Date.now() });
  return { untilMs, cooldownMs };
}

/**
 * Is (backendId, model) currently cooling down from a prior throttle?
 * @param {string} backendId
 * @param {string} model
 * @returns {boolean}
 */
function isThrottled(backendId, model) {
  const entry = _throttleCooldowns.get(throttleKey(backendId, model));
  return !!entry && Date.now() < entry.untilMs;
}

/** Test-only: clear every recorded throttle cooldown between test cases. */
export function _resetThrottleCooldownsForTests() {
  _throttleCooldowns.clear();
}

/**
 * Test-only: introspect a (backendId, model) door's recorded throttle state
 * (`{untilMs, status, retryAfterMs, hits, lastAt}`), or null if it has never
 * throttled. Not used by production code.
 * @param {string} backendId
 * @param {string} model
 */
export function _throttleStateForTests(backendId, model) {
  const entry = _throttleCooldowns.get(throttleKey(backendId, model));
  return entry ? { ...entry } : null;
}

// ---------------------------------------------------------------------------
// Type documentation (JSDoc only — no TypeScript)
// ---------------------------------------------------------------------------

/**
 * @typedef {'api_key'|'oauth'|'bearer'|'none'} AuthType
 *
 * @typedef {Object} BackendConfig
 * @property {string}   id                  Unique identifier (e.g. "anthropic")
 * @property {string}   url                 Base URL including /v1 suffix
 * @property {AuthType} auth_type           Authentication strategy
 * @property {string[]} models              Model IDs or glob patterns served by this backend
 * @property {string}   [discovery]         Set on discovery-driven backends (e.g. "free"/"all" for
 *                                           openrouter) whose catalog is populated at runtime instead
 *                                           of via a hand-written `models` list. See supportsModel().
 * @property {number}   priority            Lower = higher priority (1 beats 2)
 * @property {string}   [api_key]           Literal key (less preferred than env var)
 * @property {string}   [api_key_env]       Env-var name holding the API key
 * @property {string}   [credentials_file]  Path to JSON credentials (oauth flow)
 * @property {number}   [cooldown_ms]       Cooldown after DOWN before re-probe
 * @property {number}   [timeout_ms]        Socket idle timeout (fail fast on a wedged upstream; 0 = off)
 * @property {boolean}  [enabled]           False removes the backend from every route candidate
 * @property {boolean}  [advertise]         False removes the backend from catalog and routing
 *
 * @typedef {Object} HealthSnapshot
 * @property {'up'|'degraded'|'down'|'unknown'} status  `unknown` = never observed
 *   (no request has completed against this backend since start), which is NOT
 *   the same as healthy. Health is derived from observed outcomes, so an
 *   unobserved backend has no evidence either way. See `getHealth()`.
 * @property {boolean}  observed      false = no request has ever completed here.
 *   When false, `errorRate`, `latencyP50` and `totalErrors` are computed over an
 *   empty sample and carry no information; do not render them as good news.
 * @property {number}   errorRate     0-1 float (meaningless when observed=false)
 * @property {number}   latencyP50    ms (median of recent requests)
 * @property {number}   lastCheck     epoch ms of last successful or failed request; 0 = never
 * @property {number}   totalRequests
 * @property {number}   totalErrors
 *
 * @typedef {Object} RouteResult
 * @property {string}   backendId    Which backend was selected
 * @property {string}   backendUrl   Full upstream URL base
 * @property {Record<string, string>} authHeaders  Headers to inject before forwarding
 * @property {Backend}  backend      The Backend instance (for recording outcomes)
 *
 * @typedef {Object} RouteRequest
 * @property {string}  [model]        Model ID from the incoming request body
 * @property {string}  [agentId]      Agent identifier (for restriction checks)
 * @property {string}  [path]         Request path (e.g. "/v1/chat/completions")
 * @property {string}  [sessionId]    Conversation/session identifier for audit correlation
 */

// ---------------------------------------------------------------------------
// Per-agent model routing (card 45509bf5)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Glob matching helper
// ---------------------------------------------------------------------------

/**
 * Test whether a model ID matches a pattern.
 * Patterns may use `*` as a wildcard (e.g. "dolphin-*").
 * An exact match is also accepted.
 *
 * @param {string} pattern
 * @param {string} model
 * @returns {boolean}
 */
function modelMatches(pattern, model) {
  if (!pattern || !model) return false;
  if (pattern === model) return true;
  // Convert glob-style "*" into a regex
  const reStr = "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
  return new RegExp(reStr, "i").test(model);
}

/**
 * Return a copy of the JSON request body with its `model` field rewritten to
 * `newModel`. Used by registry role/context routing to send a concrete model
 * name to the resolved upstream (backends serve name-agnostically, but the
 * right name keeps upstream logs/metrics honest). content-length is recomputed
 * downstream by sendUpstream, so length changes are safe.
 *
 * @param {Buffer} body
 * @param {string} newModel
 * @returns {Buffer} rewritten body (or the original on parse failure / no model)
 */
function rewriteBodyModel(body, newModel) {
  if (!newModel || !body || body.length === 0) return body;
  try {
    const obj = JSON.parse(body.toString("utf-8"));
    if (obj && typeof obj === "object") {
      obj.model = newModel;
      return Buffer.from(JSON.stringify(obj), "utf-8");
    }
  } catch {
    // not JSON — leave untouched
  }
  return body;
}

/**
 * Raise a sub-floor `max_tokens` in the request body for a reasoning model, so
 * <think> tokens do not starve the visible answer to empty content. Parses and
 * reserializes JSON; non-JSON, absent, or higher caps are left untouched. The
 * floor value comes from the model registry (min_output_tokens per backend).
 *
 * @param {Buffer} body
 * @param {string} model  Resolved concrete model id.
 * @param {number} floor  min_output_tokens from the registry (0 = disabled).
 * @returns {Buffer}
 */
function applyBodyFloor(body, model, floor) {
  if (!(floor > 0) || !body || body.length === 0) return body;
  try {
    const obj = JSON.parse(body.toString("utf-8"));
    const cfg = { reasoningFloorMaxTokens: floor, reasoningModels: [model] };
    if (obj && typeof obj === "object" &&
        applyReasoningFloor(obj, cfg, model, (m) => console.log(`[router] ${m}`))) {
      return Buffer.from(JSON.stringify(obj), "utf-8");
    }
  } catch {
    // not JSON — leave untouched
  }
  return body;
}

/**
 * Get the OpenAI `messages` array for difficulty classification. Prefers
 * `request.messages` (populated by the entry point) and falls back to parsing
 * the buffered JSON body so routeAndSend works standalone (e.g. in tests).
 *
 * @param {RouteRequest} request
 * @param {Buffer} body
 * @returns {Array}
 */
function extractMessages(request, body) {
  if (Array.isArray(request?.messages)) return request.messages;
  try {
    const obj = JSON.parse(body.toString("utf-8"));
    if (obj && Array.isArray(obj.messages)) return obj.messages;
  } catch {
    // not JSON — no messages
  }
  return [];
}

/**
 * Best-effort extraction of OpenAI-style token usage from a (non-streamed)
 * response body, for SIEM `response` events. Returns {} when the body is not
 * JSON or carries no `usage` block (e.g. streamed responses).
 *
 * @param {Buffer} body
 * @returns {{ tokens_in?: number, tokens_out?: number }}
 */
function extractUsage(body) {
  try {
    const o = JSON.parse(body.toString("utf-8"));
    if (o && o.usage && typeof o.usage === "object") {
      return {
        ...(o.usage.prompt_tokens     != null ? { tokens_in:  o.usage.prompt_tokens }     : {}),
        ...(o.usage.completion_tokens != null ? { tokens_out: o.usage.completion_tokens } : {}),
      };
    }
  } catch {
    // not JSON / streamed / no usage — nothing to report
  }
  return {};
}

// How many attempts are currently in flight against each meter, so energy
// rows can record whether a measurement was single-tenant. Spec 4.6.
const _inFlight = new Map();
function inFlightOnMeter(url) { return _inFlight.get(url) ?? 1; }
function enterMeter(url) { if (url) _inFlight.set(url, (_inFlight.get(url) ?? 0) + 1); }
function exitMeter(url) {
  if (!url) return;
  const n = (_inFlight.get(url) ?? 1) - 1;
  if (n <= 0) _inFlight.delete(url); else _inFlight.set(url, n);
}

// ---------------------------------------------------------------------------
// Deterministic backend-door balancer for equal-priority same-model replicas
// ---------------------------------------------------------------------------

/**
 * Round-robin counters keyed by (priority, model) tuples.
 * Each counter rotates through backends in that group to ensure balanced
 * selection across equal-priority doors serving the same model.
 *
 * The key format is "<priority>:<model>" so chiap08-qwen38 and chiap01-qwen38
 * (both priority 1, both serving qwen3.8-27b-huihui-abliterated-q4_k_m)
 * share counter "1:qwen3.8-27b-huihui-abliterated-q4_k_m" and alternate.
 *
 * @type {Map<string, number>}
 */
const _replicaBalancers = new Map();

/**
 * Get the next backend index for a (priority, model) group using round-robin.
 * This is deterministic and ensures equal distribution across all backends
 * in the group over time.
 *
 * @param {number} priority
 * @param {string} model
 * @param {number} count  Number of backends in the group
 * @returns {number} Index (0 to count-1) of the backend to select
 */
function nextReplicaIndex(priority, model, count) {
  if (count <= 1) return 0; // No balancing needed for single backend
  const key = `${priority}:${model}`;
  const current = _replicaBalancers.get(key) || 0;
  const next = (current + 1) % count;
  _replicaBalancers.set(key, next);
  return current; // Use current index before incrementing
}

/**
 * Reset all balancer counters. Used only in tests.
 */
export function _resetReplicaBalancers() {
  _replicaBalancers.clear();
}

/**
 * Get the current balancer state. Used only in tests.
 * @returns {Record<string, number>}
 */
export function _replicaBalancerState() {
  return Object.fromEntries(_replicaBalancers);
}

// ---------------------------------------------------------------------------
// Sliding-window latency tracker (P50 via reservoir sampling)
// ---------------------------------------------------------------------------

/**
 * Fixed-size circular buffer that tracks recent latency samples and computes
 * an approximate P50 (median) without sorting the full dataset on every call.
 *
 * @internal
 */
class LatencyTracker {
  /**
   * @param {number} [capacity=200] Maximum samples held in memory
   */
  constructor(capacity = 200) {
    this._capacity = capacity;
    /** @type {number[]} */
    this._samples = [];
    this._head = 0; // next write position (circular)
  }

  /**
   * Record a new latency sample (milliseconds).
   * @param {number} ms
   */
  record(ms) {
    if (this._samples.length < this._capacity) {
      this._samples.push(ms);
    } else {
      this._samples[this._head] = ms;
      this._head = (this._head + 1) % this._capacity;
    }
  }

  /**
   * Compute approximate P50 of recorded samples.
   * Returns 0 when no samples are present.
   * @returns {number}
   */
  p50() {
    if (this._samples.length === 0) return 0;
    const sorted = [...this._samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];
  }
}

// ---------------------------------------------------------------------------
// Backend class
// ---------------------------------------------------------------------------

/**
 * Represents one upstream LLM backend with its configuration, health state,
 * and auth-token cache.
 */
export class Backend {
  /**
   * @param {BackendConfig} config
   */
  constructor(config) {
    this.id = config.id;
    this.url = config.url.replace(/\/$/, ""); // strip trailing slash
    this.auth_type = config.auth_type || "none";
    // Card 6e61f798 / C15: an operator's explicit statement that this provider
    // is meant to be used without a key, rather than the gateway inferring it
    // from an env var that happens to be missing. See buildAuthHeaders().
    this.auth_optional = config.auth_optional === true;
    this.api_key_env = config.api_key_env || null;
    this.models = Array.isArray(config.models) ? config.models : [];
    // Marks a discovery-driven backend (e.g. openrouter, see config.mjs
    // backends.*.discovery). Its `models` array starts empty and is populated
    // at runtime by registerDiscoveredRoutes() once a discovery fetch
    // succeeds. See supportsModel(): an empty list on a discovery backend must
    // NOT wildcard-match, unlike an ordinary statically-configured backend.
    // Discovery-managed backends claim only models registered by an
    // authoritative catalog. Z.ai predates the explicit `discovery:` key, so
    // infer its source rather than treating `models: []` as accept-everything.
    this.discovery = config.discovery || (isZaiBackend(config) ? "zai" : null);
    this.discoveryStatus = this.discovery ? "pending" : "static";
    this.discoveryRevision = 0;
    this.readinessRevision = 0;
    this.discoveryAt = null;
    this.priority = typeof config.priority === "number" ? config.priority : 99;
    this.cooldown_ms = config.cooldown_ms || DEFAULT_COOLDOWN_MS;
    // Optional per-backend idle timeout (ms). 0 = no timeout (default). Used to
    // fail fast on a wedged upstream (e.g. the claude-code-api :18782 wrapper
    // accepting the socket but never replying) so the router can fail over
    // instead of hanging the request. See sendUpstream(timeoutMs).
    this.timeout_ms = typeof config.timeout_ms === "number" ? config.timeout_ms : 0;

    // Dead-alias auto-quarantine tunables (card 2d1f3a2c). Per-backend config
    // overrides the router-level default which overrides the module default.
    // threshold <= 0 disables quarantine for this backend.
    this.quarantine_threshold = Number.isInteger(config.quarantine_threshold)
      ? config.quarantine_threshold
      : DEFAULT_QUARANTINE_THRESHOLD;
    this.quarantine_cooldown_ms = typeof config.quarantine_cooldown_ms === "number"
      ? config.quarantine_cooldown_ms
      : DEFAULT_QUARANTINE_COOLDOWN_MS;
    this.model_claim_quarantine_threshold = Number.isInteger(config.model_claim_quarantine_threshold)
      ? config.model_claim_quarantine_threshold
      : DEFAULT_MODEL_CLAIM_QUARANTINE_THRESHOLD;
    this.model_claim_quarantine_cooldown_ms = typeof config.model_claim_quarantine_cooldown_ms === "number"
      ? config.model_claim_quarantine_cooldown_ms
      : DEFAULT_MODEL_CLAIM_QUARANTINE_COOLDOWN_MS;
    /** @type {Map<string,{failures:number,quarantinedAt:number,lastStatus:number}>} */
    this._modelClaimFailures = new Map();

    // Auth credentials. credentials_path (the key the YAML schema and
    // config/skgateway.yaml.example document, and what the live config uses
    // for anthropic-direct) is accepted here alongside credentials_file.
    // Before this the Backend only read credentials_file, so a backend
    // declared with credentials_path silently behaved like auth_type none
    // with a warning. Found while adding the codex_oauth backend (which uses
    // credentials_path); this also repairs that latent gap for OAuth
    // backends declared with the path form.
    this._api_key = config.api_key || null;
    this._api_key_env = config.api_key_env || null;
    this._credentials_file = config.credentials_file || config.credentials_path || null;
    // Codex auth (auth_type codex_oauth): read-only view of the Codex CLI
    // credentials file, re-read when its mtime changes so a token file
    // synced from the login host takes effect without a restart. NEVER
    // refreshed (single-use refresh token; see codex-adapter.mjs).
    this._codexAuth = null;
    this._codexAuthMtime = -1;
    this._codexAuthPath = this._credentials_file;
    // z.ai ZCode subscription auth follows the same read-only file contract
    // as Codex, but has its own credential shape and provider-owned CLI.
    this._zaiAuth = null;
    this._zaiAuthMtime = -1;
    this._zaiAuthPath = this._credentials_file;
    // Kimi Code subscription auth follows the same read-only file contract:
    // the kimi CLI owns OAuth refresh and writes
    // ~/.kimi-code/credentials/<env>.json. Access tokens are short lived
    // (observed 900s), so a keepalive timer runs the CLI on the gateway
    // host and this gateway re-reads the file on mtime change only.
    this._kimiAuth = null;
    this._kimiAuthMtime = -1;
    this._kimiAuthPath = this._credentials_file;

    // Agent-level restrictions — set of agent IDs allowed to use this backend.
    // Empty set = no restrictions.
    /** @type {Set<string>} */
    this._allowedAgents = new Set(config.allowed_agents || []);

    // ----- Health state -----
    /** @type {'up'|'degraded'|'down'} */
    this._status = "up";
    /** @type {number} epoch ms */
    this._lastCheck = 0;
    /** @type {number} epoch ms — when the backend was last marked down */
    this._downSince = 0;
    /** @type {boolean} — are we currently running a recovery probe? */
    this._probing = false;

    // Sliding window (last HEALTH_WINDOW outcomes: true=success, false=error)
    /** @type {boolean[]} */
    this._window = [];
    this._windowHead = 0;
    this._windowErrors = 0; // count of `false` in window

    // ----- Quarantine state (consecutive-failure trip; independent of window) -----
    /** @type {number} consecutive failures since the last success */
    this._consecutiveFailures = 0;
    /** @type {boolean} true = out of rotation (skipped by selection) */
    this._quarantined = false;
    /** @type {number} epoch ms (when quarantine started / cooldown last re-armed) */
    this._quarantinedSince = 0;

    this._totalRequests = 0;
    this._totalErrors = 0;

    this._latency = new LatencyTracker(200);

    // OAuth token cache
    this._oauthToken = null;
    /** @type {number} epoch ms */
    this._oauthExpiry = 0;
  }

  // -------------------------------------------------------------------------
  // Model matching
  // -------------------------------------------------------------------------

  /**
   * Returns true if this backend can serve the given model ID.
   * An empty models list is treated as "accept everything", EXCEPT for a
   * discovery-driven backend (this.discovery set, e.g. openrouter), whose
   * empty `models` list before the first successful discovery fetch (or
   * after a failed fetch with no cache) means "nothing registered yet", not
   * "accept everything". Wildcard-matching there would make an unknown model
   * id resolve solely to a backend that cannot actually serve it (400/401)
   * instead of falling back to candidatesFor()'s all-available behavior, so a
   * discovery backend only matches ids explicitly registered via discovery.
   *
   * @param {string} model
   * @returns {boolean}
   */
  supportsModel(model) {
    if (!model) return true;
    if (this.models.length === 0) return !this.discovery;
    return this.models.some((pattern) => modelMatches(pattern, model));
  }

  /** Whether this exact declared backend-model claim is currently selectable. */
  isModelClaimAvailable(model) {
    const state = this._modelClaimFailures.get(model);
    if (!state?.quarantinedAt) return true;
    return Date.now() - state.quarantinedAt >= this.model_claim_quarantine_cooldown_ms;
  }

  /**
   * Fold one completed attempt into exact-claim health. Only repeated fast
   * wrong answers quarantine. Success clears the exact claim. 504 and other
   * slow/ambiguous outcomes do not participate.
   */
  recordModelClaimOutcome(model, status) {
    if (!model || !this.supportsModel(model) || this.model_claim_quarantine_threshold <= 0) return null;
    if (status >= 200 && status < 300) {
      const prior = this._modelClaimFailures.get(model);
      this._modelClaimFailures.delete(model);
      return prior?.quarantinedAt ? { transition: "readmitted", model, failures: 0 } : null;
    }
    if (!isFastModelClaimFailure(status)) return null;

    const prior = this._modelClaimFailures.get(model) || { failures: 0, quarantinedAt: 0, lastStatus: 0 };
    const failures = prior.failures + 1;
    const quarantinedAt = failures >= this.model_claim_quarantine_threshold ? Date.now() : prior.quarantinedAt;
    this._modelClaimFailures.set(model, { failures, quarantinedAt, lastStatus: status });
    if (!prior.quarantinedAt && quarantinedAt) {
      return { transition: "quarantined", model, failures, status };
    }
    return null;
  }

  /** Whether an unclaimed id belongs to this provider's discovery namespace. */
  mayDiscoverModel(model) {
    return Boolean(this.discovery && model &&
      (this.discovery === "zai" ? /^glm-/i.test(model) : false));
  }

  /** Replace one provider snapshot and advance observable process revisions. */
  replaceDiscoveredModels(models, { ok = true, stale = false, at = Date.now() } = {}) {
    const next = [...new Set((models || []).filter((id) => typeof id === "string"))];
    const status = ok ? (stale ? "stale" : "ready") : (next.length ? "stale" : "failed");
    this.discoveryRevision += 1;
    if (status !== this.discoveryStatus || JSON.stringify(next) !== JSON.stringify(this.models)) {
      this.readinessRevision += 1;
    }
    this.models = next;
    this.discoveryStatus = status;
    this.discoveryAt = at;
  }

  // -------------------------------------------------------------------------
  // Agent restriction checks
  // -------------------------------------------------------------------------

  /**
   * Returns true if the given agent is allowed to use this backend.
   * When no restriction list is configured every agent is allowed.
   *
   * @param {string|undefined} agentId
   * @returns {boolean}
   */
  allowsAgent(agentId) {
    if (this._allowedAgents.size === 0) return true;
    return agentId != null && this._allowedAgents.has(agentId);
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  /**
   * Returns a point-in-time snapshot of this backend's health.
   *
   * `status` reports `"unknown"` when this backend has never been observed
   * (`_lastCheck === 0`). Health here is DERIVED FROM OBSERVED REQUEST
   * OUTCOMES, never from active probing, so a backend nobody has called yet
   * still carries the optimistic `"up"` this class is constructed with. That
   * made a never-probed backend indistinguishable from a healthy one.
   *
   * Not hypothetical. On 2026-08-16 the machine hosting `local`
   * (192.168.0.100:8082, ornith) and `ollama` (192.168.0.100:11434) was hard
   * down for over an hour. `/health` reported BOTH as `status: "up",
   * errorRate: 0`, because neither had been called since start, while
   * `sk-default` silently failed over to a cloud model and answered
   * perfectly. The failover behaved correctly; the REPORTING is what lied.
   *
   * So this fixes the reporting and deliberately leaves selection alone.
   * `isAvailable()` is unchanged: an unobserved backend stays selectable
   * exactly as before. Treating unknown as down would refuse every backend at
   * startup, trading a silent lie for a loud outage.
   *
   * @returns {HealthSnapshot}
   */
  getHealth() {
    const observed = this._lastCheck !== 0;
    return {
      status: observed ? this._status : "unknown",
      observed,
      errorRate: this._computeErrorRate(),
      latencyP50: this._latency.p50(),
      lastCheck: this._lastCheck,
      totalRequests: this._totalRequests,
      totalErrors: this._totalErrors,
      quarantined: this._quarantined,
      consecutiveFailures: this._consecutiveFailures,
    };
  }

  /**
   * Whether this backend is available to receive a request right now.
   * Backends in cooldown are treated as down until the cooldown expires,
   * at which point they are tentatively allowed one probe request.
   *
   * @returns {boolean}
   */
  isAvailable() {
    // Quarantine takes precedence over the error-rate status: a quarantined
    // alias is fully out of rotation until its cooldown elapses. After the
    // cooldown a single probe is admitted (quarantine stays armed until a
    // success in recordOutcome() clears it, or a failure re-arms the cooldown).
    if (this._quarantined) {
      const elapsed = Date.now() - this._quarantinedSince;
      // In cooldown → skip. Cooldown elapsed → admit exactly this probe,
      // authoritatively (independent of the error-rate status/down cooldown).
      return elapsed >= this.quarantine_cooldown_ms;
    }

    if (this._status === "up" || this._status === "degraded") return true;
    // Down — check if cooldown has elapsed
    if (this._status === "down") {
      const elapsed = Date.now() - this._downSince;
      if (elapsed >= this.cooldown_ms) {
        // Transition to degraded to allow one probe
        this._status = "degraded";
        console.log(`[router] backend=${this.id} cooldown expired — transitioning down→degraded for re-probe`);
        return true;
      }
    }
    return false;
  }

  /**
   * Record the outcome of one upstream request and update health state.
   *
   * @param {boolean} success   true if the request completed without error (non-5xx)
   * @param {number}  latencyMs round-trip time in milliseconds
   * @returns {?{transition: 'quarantined'|'readmitted', consecutiveFailures: number, threshold: number}}
   *   A quarantine transition descriptor when this outcome flipped the alias in
   *   or out of quarantine, else null. The caller (routeAndSend) emits the
   *   corresponding SIEM/log event; the Backend stays free of SIEM coupling.
   */
  recordOutcome(success, latencyMs) {
    this._lastCheck = Date.now();
    this._totalRequests++;
    if (!success) this._totalErrors++;
    this._latency.record(latencyMs);

    // Update sliding window
    if (this._window.length < HEALTH_WINDOW) {
      this._window.push(success);
      if (!success) this._windowErrors++;
    } else {
      const evicted = this._window[this._windowHead];
      this._window[this._windowHead] = success;
      this._windowHead = (this._windowHead + 1) % HEALTH_WINDOW;
      if (!evicted) this._windowErrors--;
      if (!success) this._windowErrors++;
    }

    this._evaluateStatus();
    return this._evaluateQuarantine(success);
  }

  /**
   * Consecutive-failure quarantine transition (card 2d1f3a2c). Independent of
   * the error-rate status machine in _evaluateStatus(). Returns a transition
   * descriptor on a quarantine/re-admit flip, else null.
   *
   * @param {boolean} success
   * @returns {?{transition: 'quarantined'|'readmitted', consecutiveFailures: number, threshold: number}}
   */
  _evaluateQuarantine(success) {
    if (this.quarantine_threshold <= 0) return null; // disabled

    if (success) {
      this._consecutiveFailures = 0;
      if (this._quarantined) {
        // A probe (admitted after cooldown) succeeded, re-admit to rotation.
        // Also clear the error-rate window so a stale burst of failures cannot
        // immediately re-mark the recovered alias as DOWN and undo the re-admit;
        // the successful probe is authoritative proof of liveness.
        this._quarantined = false;
        this._quarantinedSince = 0;
        this._window = [];
        this._windowHead = 0;
        this._windowErrors = 0;
        this._status = "up";
        this._downSince = 0;
        console.log(`[router] backend=${this.id} probe OK, READMITTED from quarantine`);
        return { transition: "readmitted", consecutiveFailures: 0, threshold: this.quarantine_threshold };
      }
      return null;
    }

    // Failure
    this._consecutiveFailures++;

    if (this._quarantined) {
      // Probe (or an in-flight overlap) failed, stay quarantined, re-arm cooldown.
      this._quarantinedSince = Date.now();
      return null;
    }

    if (this._consecutiveFailures >= this.quarantine_threshold) {
      this._quarantined = true;
      this._quarantinedSince = Date.now();
      console.warn(
        `[router] backend=${this.id} consecutive_failures=${this._consecutiveFailures}` +
        ` >= ${this.quarantine_threshold}, QUARANTINED (cooldown=${this.quarantine_cooldown_ms}ms)`
      );
      return {
        transition: "quarantined",
        consecutiveFailures: this._consecutiveFailures,
        threshold: this.quarantine_threshold,
      };
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  /**
   * Build the Authorization / x-api-key headers for this backend.
   * For `oauth` backends the token is loaded (and refreshed) from the
   * credentials file.  Returns an empty object for `none` auth.
   *
   * @returns {Promise<Record<string, string>>}
   */
  async buildAuthHeaders() {
    switch (this.auth_type) {
      case "api_key":
      case "bearer": {
        const key = this._resolveApiKey();
        if (!key) {
          // Card 6e61f798 / C15. A missing key used to degrade silently to an
          // unauthenticated call, and because the caller's headers were copied
          // first, whatever bearer the CLIENT sent went upstream in its place.
          // The header leak is fixed above; this makes the remaining ambiguity
          // explicit instead of inferring intent from an absent env var.
          //
          // `auth_optional: true` says the operator KNOWS this provider serves
          // unauthenticated traffic and wants that. OpenCode Zen genuinely does
          // (measured 2026-08-15: /v1/models and /v1/chat/completions both
          // return 200 with no auth header at all), so this is a real mode, not
          // a workaround.
          //
          // Without that flag a missing key is a misconfiguration. We still do
          // not hard-fail the request, because that would convert a recoverable
          // credential problem into an outage for every model on the backend,
          // but the warning is deliberately loud and names the env var so the
          // operator can act. Deciding to fail closed here is a live behavior
          // change and is left to a separate, explicit call.
          if (this.auth_optional !== true) {
            console.warn(
              `[router] backend=${this.id} declares auth_type=${this.auth_type} but ` +
                `${this.api_key_env || "its api key env"} is unset. Sending UNAUTHENTICATED. ` +
                `Set the key, or declare auth_optional: true if this provider is meant to be used without one.`,
            );
          }
          return {};
        }
        return { authorization: `Bearer ${key}` };
      }

      case "oauth": {
        const token = await this._getOAuthToken();
        if (!token) return {};
        return { authorization: `Bearer ${token}` };
      }

      case "zai_oauth": {
        // ZCode owns OAuth refresh and writes ~/.zcode/v2/credentials.json.
        // The gateway only reads oauth:zai:access_token and never mutates it.
        const headers = this._getZaiAuthHeaders();
        if (!headers) {
          console.warn(
            `[router] backend=${this.id} zai_oauth auth but no usable credentials at ` +
              `${this._zaiAuthPath || "(no credentials_path/file set)"}. ` +
              `Run the official ZCode login on this gateway host.`,
          );
          return {};
        }
        return headers;
      }

      case "codex_oauth": {
        // OpenAI Codex subscription auth (see codex-adapter.mjs): a bearer
        // access token PLUS the chatgpt-account-id header, read from the
        // Codex CLI auth.json. Read-only: the refresh token is single-use and
        // owned by the Codex CLI login on its host, so this gateway never
        // refreshes and never writes the file (a second refresher would
        // invalidate the CLI's next refresh and kill the login). A stale
        // token 401s, the router counts the failure, failover covers it.
        const headers = this._getCodexAuthHeaders();
        if (!headers) {
          console.warn(
            `[router] backend=${this.id} codex_oauth auth but no usable credentials at ` +
              `${this._codexAuthPath || "(no credentials_path/file set)"}. ` +
              `Sending UNAUTHENTICATED (expect 401). Sync a fresh Codex CLI auth.json there.`,
          );
          return {};
        }
        return headers;
      }

      case "kimi_oauth": {
        // Kimi Code subscription auth: bearer access token read read-only
        // from the kimi CLI credentials file. The CLI on the gateway host
        // owns refresh (tokens live ~15 minutes; a keepalive timer drives
        // it), so this gateway never refreshes and never writes the file.
        const headers = this._getKimiAuthHeaders();
        if (!headers) {
          console.warn(
            `[router] backend=${this.id} kimi_oauth auth but no usable credentials at ` +
              `${this._kimiAuthPath || "(no credentials_path/file set)"}. ` +
              `Sending UNAUTHENTICATED (expect 401). Sync kimi CLI credentials there.`,
          );
          return {};
        }
        return headers;
      }

      case "none":
      default:
        return {};
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** @returns {number} 0–1 */
  _computeErrorRate() {
    if (this._window.length === 0) return 0;
    return this._windowErrors / this._window.length;
  }

  /** Re-evaluate and potentially change status based on current error rate. */
  _evaluateStatus() {
    const rate = this._computeErrorRate();

    if (rate >= DOWN_ERROR_RATE) {
      if (this._status !== "down") {
        console.warn(
          `[router] backend=${this.id} error_rate=${(rate * 100).toFixed(1)}% — marking DOWN` +
          ` (cooldown=${this.cooldown_ms}ms)`
        );
        this._status = "down";
        this._downSince = Date.now();
      }
    } else if (rate >= DEGRADED_ERROR_RATE) {
      if (this._status !== "degraded") {
        console.warn(
          `[router] backend=${this.id} error_rate=${(rate * 100).toFixed(1)}% — marking DEGRADED`
        );
        this._status = "degraded";
      }
    } else {
      if (this._status !== "up") {
        console.log(
          `[router] backend=${this.id} error_rate=${(rate * 100).toFixed(1)}% — recovered to UP`
        );
        this._status = "up";
      }
    }
  }

  /**
   * Return the Codex subscription auth headers, re-reading the credentials
   * file when its mtime changed (tokens are refreshed externally by the
   * owning Codex CLI and synced here; see the codex_oauth case in
   * buildAuthHeaders). Cached in memory between requests. Never throws,
   * never writes, never refreshes.
   *
   * @returns {Record<string, string>|null}
   */
  _getCodexAuthHeaders() {
    if (!this._codexAuthPath) return null;
    try {
      const filePath = this._codexAuthPath.replace(/^~/, process.env.HOME || "");
      const mtime = statSync(filePath).mtimeMs;
      if (!this._codexAuth || mtime !== this._codexAuthMtime) {
        const headers = readCodexAuthHeaders(filePath);
        if (!headers) {
          console.warn(
            `[router] backend=${this.id} codex credentials file has no access token: ${filePath}`,
          );
          return null;
        }
        this._codexAuth = headers;
        this._codexAuthMtime = mtime;
      }
      return this._codexAuth;
    } catch (err) {
      console.error(
        `[router] backend=${this.id} failed to load codex credentials ${this._codexAuthPath}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Return the z.ai subscription auth headers, re-reading the ZCode
   * credentials file when its mtime changes. Never writes or refreshes.
   *
   * @returns {Record<string, string>|null}
   */
  _getKimiAuthHeaders() {
    if (!this._kimiAuthPath) return null;
    try {
      const filePath = this._kimiAuthPath.replace(/^~/, process.env.HOME || "");
      const mtime = statSync(filePath).mtimeMs;
      if (!this._kimiAuth || mtime !== this._kimiAuthMtime) {
        const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        const accessToken = raw && (raw.access_token || raw.accessToken);
        if (!accessToken) {
          console.warn(
            `[router] backend=${this.id} kimi credentials file has no access token: ${filePath}`,
          );
          return null;
        }
        this._kimiAuth = { authorization: `Bearer ${accessToken}` };
        this._kimiAuthMtime = mtime;
      }
      return this._kimiAuth;
    } catch (err) {
      console.error(
        `[router] backend=${this.id} failed to load kimi credentials ${this._kimiAuthPath}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Return the z.ai subscription auth headers, re-reading the ZCode
   * credentials file when its mtime changes. Never writes or refreshes.
   *
   * @returns {Record<string, string>|null}
   */
  _getZaiAuthHeaders() {
    if (!this._zaiAuthPath) return null;
    try {
      const filePath = this._zaiAuthPath.replace(/^~/, process.env.HOME || "");
      const mtime = statSync(filePath).mtimeMs;
      if (!this._zaiAuth || mtime !== this._zaiAuthMtime) {
        const headers = readZaiAuthHeaders(filePath);
        if (!headers) return null;
        this._zaiAuth = headers;
        this._zaiAuthMtime = mtime;
      }
      return this._zaiAuth;
    } catch (err) {
      console.error(
        `[router] backend=${this.id} failed to load z.ai credentials ${this._zaiAuthPath}: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Resolve the API key for api_key / bearer auth.
   * Precedence: env var → literal config value.
   *
   * @returns {string|null}
   */
  _resolveApiKey() {
    if (this._api_key_env) {
      const fromEnv = process.env[this._api_key_env];
      if (fromEnv) return fromEnv;
    }
    return this._api_key || null;
  }

  /**
   * Return a valid OAuth access token, refreshing if expired.
   * The token file is expected to be a JSON object with at least:
   *   { access_token: string, expires_at: number /* epoch seconds *\/ }
   *
   * If the file contains `refresh_token` and the token is expired, this
   * method logs a warning (full OAuth refresh requires per-provider logic
   * outside this module's scope).
   *
   * @returns {Promise<string|null>}
   */
  async _getOAuthToken() {
    const now = Date.now();

    // Return cached token if still valid (with 60s buffer)
    if (this._oauthToken && now < this._oauthExpiry - 60_000) {
      return this._oauthToken;
    }

    if (!this._credentials_file) {
      console.warn(`[router] backend=${this.id} oauth auth but no credentials_file configured`);
      return null;
    }

    const filePath = this._credentials_file.replace(/^~/, process.env.HOME || "");
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const credsRaw = JSON.parse(raw);
      // Support both flat tokens and the Claude Code format:
      //   { "claudeAiOauth": { accessToken, expiresAt, refreshToken } }
      const creds = credsRaw.claudeAiOauth || credsRaw;

      const accessToken = creds.access_token || creds.accessToken;
      if (!accessToken) {
        console.warn(`[router] backend=${this.id} credentials file has no access token: ${filePath}`);
        return null;
      }

      // expires_at may be epoch seconds or ms — normalise to ms
      const expRaw = creds.expires_at || creds.expiry || creds.expiresAt || 0;
      const expiryMs = expRaw > 1e12 ? expRaw : expRaw * 1000;
      const refreshToken = creds.refresh_token || creds.refreshToken;

      // Proactively refresh within 5 min of expiry. Claude Code OAuth tokens
      // live ~8h; without this the subscription path dies every 8h unless a
      // `claude` CLI happens to refresh the creds for us.
      if (refreshToken && now >= expiryMs - 300_000) {
        if (now < (this._refreshCooldownUntil || 0)) {
          console.warn(`[router] backend=${this.id} oauth refresh in cooldown; using stale token`);
        } else {
          const refreshed = await this._refreshOAuth(refreshToken, filePath, credsRaw);
          if (refreshed) {
            this._oauthToken = refreshed.accessToken;
            this._oauthExpiry = refreshed.expiryMs;
            this._refreshCooldownUntil = 0;
            return this._oauthToken;
          }
          // Back off 10 min on failure: hammering the token endpoint just
          // perpetuates the rate-limit (429) and never recovers.
          this._refreshCooldownUntil = now + 10 * 60_000;
          console.warn(
            `[router] backend=${this.id} oauth refresh failed; backing off 10m, using stale token`,
          );
        }
      }

      this._oauthToken = accessToken;
      this._oauthExpiry = expiryMs;
      return this._oauthToken;
    } catch (err) {
      console.error(`[router] backend=${this.id} failed to load credentials file ${filePath}: ${err.message}`);
      return null;
    }
  }

  /**
   * Refresh an expired Claude Code OAuth token using the subscription
   * refresh_token, persisting the new tokens back to the credentials file
   * (preserving its shape). Mirrors Claude Code / CLIProxyAPI behaviour.
   *
   * @returns {Promise<{accessToken:string, expiryMs:number}|null>}
   */
  async _refreshOAuth(refreshToken, filePath, credsRaw) {
    const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // Claude Code CLI
    try {
      const resp = await fetch("https://console.anthropic.com/v1/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "anthropic" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }),
      });
      if (!resp.ok) {
        console.error(`[router] backend=${this.id} oauth refresh HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        return null;
      }
      const data = await resp.json();
      const accessToken = data.access_token;
      if (!accessToken) return null;
      const newRefresh = data.refresh_token || refreshToken;
      const expiryMs = Date.now() + (data.expires_in ? data.expires_in * 1000 : 8 * 3600 * 1000);
      try {
        if (credsRaw.claudeAiOauth) {
          credsRaw.claudeAiOauth.accessToken = accessToken;
          credsRaw.claudeAiOauth.refreshToken = newRefresh;
          credsRaw.claudeAiOauth.expiresAt = expiryMs;
        } else {
          credsRaw.access_token = accessToken;
          credsRaw.refresh_token = newRefresh;
          credsRaw.expires_at = expiryMs;
        }
        fs.writeFileSync(filePath, JSON.stringify(credsRaw, null, 2), { mode: 0o600 });
      } catch (werr) {
        console.warn(`[router] backend=${this.id} could not persist refreshed token: ${werr.message}`);
      }
      console.log(`[router] backend=${this.id} oauth token refreshed (expires in ${Math.round((expiryMs - Date.now()) / 3600000)}h)`);
      return { accessToken, expiryMs };
    } catch (err) {
      console.error(`[router] backend=${this.id} oauth refresh error: ${err.message}`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create a multi-backend router.
 *
 * @param {object} config
 * @param {Record<string, Omit<BackendConfig, 'id'>>} [config.backends]
 *   Map of backend ID → backend configuration (from YAML `backends:` block).
 * @param {string} [config.default_backend]
 *   ID of the backend to use when no model matches any backend's list.
 *   Defaults to the backend with the lowest priority number.
 * @param {boolean} [config.failover]
 *   Whether to attempt failover to secondary backends on error.  Default true.
 * @param {boolean} [config.siem_log]
 *   Emit structured SIEM events for failover and health changes.  Default true.
 *
 * @returns {{
 *   route(request: RouteRequest): Promise<RouteResult[]>,
 *   getHealth(): Record<string, HealthSnapshot>,
 *   addBackend(cfg: BackendConfig): void,
 *   removeBackend(id: string): void,
 * }}
 */
export function createRouter(config = {}) {
  const failoverEnabled = config.failover !== false;
  const siemLog = config.siem_log !== false;

  // Router-level quarantine defaults (card 2d1f3a2c). Applied to every backend
  // that does not set its own quarantine_threshold / quarantine_cooldown_ms, so
  // a single config.quarantine block tunes the whole fleet. Per-backend values
  // still win (they are spread AFTER these defaults below).
  const qDefaults = {};
  if (config.quarantine && typeof config.quarantine === "object") {
    if (Number.isInteger(config.quarantine.threshold)) {
      qDefaults.quarantine_threshold = config.quarantine.threshold;
    }
    if (typeof config.quarantine.cooldown_ms === "number") {
      qDefaults.quarantine_cooldown_ms = config.quarantine.cooldown_ms;
    }
  }

  // Per-agent model routing (cards 45509bf5 / 7ec1d18a; folded into the registry
  // by CR-5.1). The per-agent pin is the `agent:<id>` CONTEXT in the skmodels
  // registry (the single source of truth), resolved live per request (see
  // resolveAgentTarget below). An optional registry_path override lets tests
  // point at a fixture; production uses the module default (REGISTRY_PATH).
  const registryPath = config.registry_path || undefined;

  /** @type {Map<string, Backend>} */
  const backends = new Map();

  // Populate initial registry from config
  if (config.backends && typeof config.backends === "object") {
    for (const [id, cfg] of Object.entries(config.backends)) {
      if (isCatalogDisabledBackend(cfg)) continue;
      backends.set(id, new Backend({ id, ...qDefaults, ...cfg }));
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Return backends sorted ascending by priority (lowest number = first).
   * Only includes backends that are currently available (not in hard cooldown).
   *
   * @returns {Backend[]}
   */
  function availableByPriority() {
    return [...backends.values()]
      .filter((b) => b.isAvailable())
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Find backends that claim to support `model`, sorted by priority.
   * Falls back to all available backends if none explicitly match.
   *
   * Equal-priority backends serving the same model are balanced using a
   * deterministic round-robin mechanism to prevent one backend from
   * queuing while another remains idle (card 786d9232).
   *
   * @param {string|undefined} model
   * @param {string|undefined} agentId
   * @returns {Backend[]}
   */
  function candidatesFor(model, agentId, expand = false) {
    const available = availableByPriority().filter((b) => b.allowsAgent(agentId));

    if (!model) return available;

    // Keep declaration separate from current exact-claim availability. A
    // quarantined claim must not turn into an unmatched-model spray, and one
    // bad claimer must not condemn another claimer or the global model id.
    const declared = [...backends.values()].filter((b) => b.supportsModel(model));
    const matched = available.filter(
      (b) => b.supportsModel(model) && b.isModelClaimAvailable(model),
    );

    // Balancing for equal-priority same-model replicas (card 786d9232).
    // Group backends by priority and apply round-robin within each group.
    if (matched.length > 1) {
      // Group by priority
      const byPriority = new Map();
      for (const backend of matched) {
        const p = backend.priority;
        if (!byPriority.has(p)) {
          byPriority.set(p, []);
        }
        byPriority.get(p).push(backend);
      }

      // For each priority group with multiple backends, rotate the order
      // using the deterministic balancer
      const balanced = [];
      for (const [priority, group] of byPriority) {
        if (group.length > 1) {
          // Use round-robin to select the first backend in the group
          const selectedIndex = nextReplicaIndex(priority, model, group.length);
          // Rotate the array so the selected backend is first
          const rotated = [
            ...group.slice(selectedIndex),
            ...group.slice(0, selectedIndex),
          ];
          balanced.push(...rotated);
        } else {
          balanced.push(...group);
        }
      }
      // Preserve overall priority order by sorting the balanced result
      balanced.sort((a, b) => a.priority - b.priority);
      // Replace matched with the balanced ordering
      matched.splice(0, matched.length, ...balanced);
    }

    // The gate has to be checked here too, not only in the fallback branch
    // below. `Backend.models` is a snapshot written by
    // registerDiscoveredRoutes() at startup and refreshed only once per
    // `discovery.refresh_seconds` (live: 3600s) or on a manual
    // POST /admin/models/refresh. There is no reactive re-sync, so a model
    // that flips to eol|dead mid-hour is still listed in `Backend.models`
    // and `supportsModel()` still matches it. Without this check the gate
    // below is unreachable for any id a backend claims, and a dead model
    // keeps routing for up to an hour (card C4). The store read is
    // mtime/TTL cached (2s, model_catalog_store.mjs) so this adds no real
    // per-request cost.
    if (matched.length > 0) {
      const lcMatched = getLifecycle(model);
      // Claimer-aware (incident inc-2026-08-18-qwen38-eol): the gate only
      // preempts a claim when the verdict is attributed to the claiming side
      // (isEffectivelyRoutable). An unattributed verdict (provider tag null —
      // real-traffic 404/410s recorded without a provider, which may have
      // come from NON-claiming backends in a fail-over spray; that is exactly
      // how the qwen38 false positive formed, nvidia 404-ing an alias chiap08
      // serves fine) or a verdict against a DIFFERENT provider does not
      // overrule this backend's declaration. A verdict tagged with the
      // claiming provider (the C4 case: nvidia 410'd the id and nvidia is the
      // only claimer) still gates, so card C4's protection is intact.
      if (!isEffectivelyRoutable(lcMatched, matched.map((b) => b.id))) {
        const gated = [];
        gated.eolGated = true;
        gated.eolReason = lcMatched.eol_reason;
        return gated;
      }
      return matched;
    }

    if (declared.length > 0 && declared.every((b) => !b.isModelClaimAvailable(model))) {
      const claimQuarantined = [];
      claimQuarantined.claimQuarantined = true;
      return claimQuarantined;
    }

    // Provider purity (card f361407c, incident 2026-09-03): a model id that
    // some backend DECLARES must never spray to unrelated backends when the
    // declaring backend is merely DOWN (error cooldown) or agent-restricted.
    // Observed live: during a z.ai cooldown, glm-4.6 and glm-4.7 fell through
    // to primary=codex, which can only answer "model not supported"; and a
    // fresh kimi backend's first empty-content failure marked it DOWN, so k3
    // requests sprayed to codex the same way. Requests for a declared id
    // fail closed here so the client sees the owner backend's real state and
    // the retry loop backs off instead of burning a codex 400 on every
    // attempt. Undeclared ids keep the historic fall-through.
    if (declared.length > 0 && expand !== true) {
      const ownerDown = [];
      ownerDown.ownerDown = true;
      ownerDown.declaredBy = declared.map((b) => b.id);
      return ownerDown;
    }

    // No backend explicitly claims this model. A KNOWN eol|dead id (per the
    // lifecycle store, card P1.6) is gated here instead of falling through:
    // tag an empty result so route() can answer with a clean 404 +
    // eol_reason and make no backend attempt at all. An UNKNOWN id (never
    // recorded, or still active/suspect, including every id the store has
    // never seen, since defaultLifecycle() starts `active`) keeps today's
    // fall-through to all available backends unchanged (the upstream will
    // return 404/400 for unsupported models, which the retry loop will treat
    // as a hard error and move on).
    const lc = getLifecycle(model);
    if (!isRoutable(lc)) {
      const gated = [];
      gated.eolGated = true;
      gated.eolReason = lc.eol_reason;
      return gated;
    }

    return available;
  }

  /**
   * Emit a structured SIEM event to stdout (JSON Lines format).
   * Consumers (siem/file.mjs, siem/elastic.mjs) can parse these.
   *
   * @param {string} event
   * @param {Record<string, unknown>} fields
   */
  function siemEvent(event, fields) {
    if (!siemLog) return;
    const entry = {
      ts: new Date().toISOString(),
      event,
      source: "router",
      ...fields,
    };
    process.stdout.write(JSON.stringify(entry) + "\n");
  }

  // -------------------------------------------------------------------------
  // route()
  // -------------------------------------------------------------------------

  /**
   * Resolve the best backend for the given request.  On failover the function
   * returns a modified RouteResult with the fallback backend.  The caller is
   * expected to call `backend.recordOutcome()` after each upstream attempt so
   * health tracking stays accurate.
   *
   * This function does NOT make any network calls — it only selects the
   * backend.  Use `sendUpstream` (from upstream.mjs) to make the actual
   * request, then call `backend.recordOutcome()` with the result.
   *
   * Failover example:
   * ```js
   * const { route, getHealth } = createRouter(config);
   *
   * const candidates = await route(request);   // returns RouteResult[]
   * for (const result of candidates) {
   *   const start = Date.now();
   *   const res = await sendUpstream(path, method, headers, body, new URL(result.backendUrl));
   *   result.backend.recordOutcome(res.status < 500, Date.now() - start);
   *   break;
   * }
   * ```
   *
   * @param {RouteRequest} request
   * @returns {Promise<RouteResult[]>}
   *   Ordered list of RouteResult objects to try, primary first.
   *   Guaranteed non-empty as long as at least one backend is registered.
   *   Throws if the registry is empty. Throws `ModelEolError` (card P1.6) if
   *   `model` is a concrete id the lifecycle store knows is eol/dead and no
   *   backend explicitly claims it: no backend is attempted in that case.
   */
  async function route(request) {
    const { model, agentId } = request;

    if (backends.size === 0) {
      throw new Error("[router] No backends registered — cannot route request");
    }

    const candidates = candidatesFor(model, agentId, request.expand === true);

    if (candidates.eolGated) {
      siemEvent("model_eol_gated", { model, agentId, eol_reason: candidates.eolReason });
      throw new ModelEolError(model, candidates.eolReason);
    }
    if (candidates.claimQuarantined) {
      siemEvent("model_claims_quarantined", { model, agentId });
      throw new ModelClaimQuarantinedError(model);
    }
    if (candidates.ownerDown) {
      siemEvent("model_owner_backend_down", {
        model, agentId, declared_by: candidates.declaredBy,
      });
      throw new ModelOwnerDownError(model, candidates.declaredBy);
    }

    if (candidates.length === 0) {
      // All backends are down or restricted for this agent — return all backends
      // sorted by priority so the caller can attempt anyway and surface the error.
      const all = [...backends.values()].sort((a, b) => a.priority - b.priority);
      console.warn(
        `[router] All backends unavailable for model=${model} agent=${agentId} — ` +
        `returning full list (caller will get upstream errors)`
      );
      siemEvent("all_backends_unavailable", { model, agentId, backendCount: all.length });
      return await Promise.all(
        all.map(async (b) => ({
          backendId: b.id,
          backendUrl: b.url,
          authHeaders: await b.buildAuthHeaders(),
          backend: b,
        }))
      );
    }

    // Resolve auth headers for each candidate in parallel
    const results = await Promise.all(
      candidates.map(async (b) => ({
        backendId: b.id,
        backendUrl: b.url,
        authHeaders: await b.buildAuthHeaders(),
        backend: b,
      }))
    );

    if (results.length > 1 && failoverEnabled) {
      const primary = results[0].backendId;
      const fallbacks = results.slice(1).map((r) => r.backendId).join(", ");
      console.log(
        `[router] model=${model || "(none)"} → primary=${primary} ` +
        `fallbacks=[${fallbacks}]`
      );
    } else {
      console.log(`[router] model=${model || "(none)"} → backend=${results[0].backendId}`);
    }

    return failoverEnabled ? results : [results[0]];
  }

  // -------------------------------------------------------------------------
  // getHealth()
  // -------------------------------------------------------------------------

  /**
   * Return a snapshot of every backend's health, INCLUDING registry-routed
   * doors (`reg:<name>`, created on demand by `getRegBackend()`).
   *
   * Those live in the module-level `_regBackends` map rather than in this
   * router's configured `backends`, so for as long as this only walked
   * `backends` the health surface could not see the path that serves most
   * traffic. A request through a registry alias like `sk-default` records its
   * outcome against `reg:ornith`, and nothing was reading it.
   *
   * That is why `local` and `ollama` sat at `lastCheck: 0` indefinitely and a
   * hard-down machine could read as healthy on 2026-08-16: not merely an
   * optimistic default, but a health signal that real traffic never updated.
   * The outcomes were being recorded correctly the whole time; they were
   * simply never reported. Same class as the energy meters keyed by backend
   * name instead of host, which missed `reg:ornith` for the same reason.
   *
   * `_regBackends` is module-level and therefore shared across routers in the
   * same process. That is pre-existing and harmless in production (one router)
   * but means a test creating two routers sees the same reg doors in both.
   *
   * Configured backends win on an id collision: a `reg:` door can never
   * shadow a declared backend's health.
   *
   * @returns {Record<string, HealthSnapshot>}
   */
  function getHealth() {
    const out = {};
    for (const [id, backend] of _regBackends) {
      out[id] = backend.getHealth();
    }
    for (const [id, backend] of backends) {
      out[id] = backend.getHealth();
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // addBackend() / removeBackend()
  // -------------------------------------------------------------------------

  /**
   * Register a new backend (or replace an existing one with the same id).
   *
   * @param {BackendConfig} cfg
   */
  function addBackend(cfg) {
    if (!cfg.id) throw new Error("[router] addBackend: cfg.id is required");
    if (isCatalogDisabledBackend(cfg)) {
      backends.delete(cfg.id);
      console.log(`[router] backend=${cfg.id} disabled and removed from routing`);
      return;
    }
    backends.set(cfg.id, new Backend({ ...qDefaults, ...cfg }));
    console.log(
      `[router] registered backend=${cfg.id} url=${cfg.url} ` +
      `priority=${cfg.priority} models=[${cfg.models?.join(", ")}]`
    );
  }

  /**
   * Deregister a backend by id.  In-flight requests to that backend are not
   * interrupted; only future `route()` calls are affected.
   *
   * @param {string} id
   */
  function removeBackend(id) {
    if (!backends.has(id)) {
      console.warn(`[router] removeBackend: unknown backend id=${id}`);
      return;
    }
    backends.delete(id);
    console.log(`[router] deregistered backend=${id}`);
  }

  /**
   * Return the Backend instance registered under `id`, or null.
   * @param {string} id
   * @returns {Backend|null}
   */
  function getBackends() {
    return [...backends.values()];
  }

  function getBackend(id) {
    return backends.get(id) || null;
  }

  /**
   * Resolve the per-agent routing target for an agent id (CR-5.1).
   *
   * Reads the `agent:<id>` CONTEXT from the skmodels registry (the single
   * source of truth), so a `skmodels set agent:<id> <target>` (or a skchat
   * picker change) takes effect live (registry.mjs re-parses on mtime change).
   * Returns the context target string (a role or a concrete model id) when set,
   * else null (routing unchanged). Lookup is lowercased to match the CapAuth
   * identity layer, and registry `agent:*` keys are written lowercased.
   *
   * @param {string|undefined} agentId
   * @returns {string|null}
   */
  function resolveAgentTarget(agentId) {
    if (!agentId) return null;
    const key = "agent:" + String(agentId).trim().toLowerCase();
    const { contexts } = loadRegistry(registryPath);
    const target = contexts && contexts[key];
    return typeof target === "string" && target.trim() ? target.trim() : null;
  }

  // -------------------------------------------------------------------------
  // Return router interface
  // -------------------------------------------------------------------------

  function registerDiscoveredModels(id, models, outcome) {
    const backend = backends.get(id);
    if (!backend?.discovery) return false;
    backend.replaceDiscoveredModels(models, outcome);
    return true;
  }

  return { route, getHealth, addBackend, removeBackend, getBackend, getBackends, registerDiscoveredModels, resolveAgentTarget };
}

// ---------------------------------------------------------------------------
// Default router instance built from environment / well-known config path
// ---------------------------------------------------------------------------

/**
 * Build a router from the standard SKGateway YAML config, if available.
 * Falls back to a sensible single-backend default when no config is found.
 *
 * Supports a minimal config subset (no YAML parser dependency — reads JSON
 * equivalent or a small hand-rolled YAML subset via regex).  The full YAML
 * parser lives in the gateway entry point which can pass a pre-parsed config
 * object to `createRouter()` directly.
 *
 * @param {object} [overrides]   Merged on top of the discovered config
 * @returns {ReturnType<typeof createRouter>}
 */
export function createDefaultRouter(overrides = {}) {
  // The gateway entry point typically calls createRouter(parsedConfig) directly.
  // This factory is a convenience for tests and ad-hoc scripts.
  const defaultConfig = {
    backends: {
      nvidia: {
        url: process.env.SKGATEWAY_TARGET || "https://integrate.api.nvidia.com/v1",
        auth_type: "api_key",
        api_key_env: "NVIDIA_API_KEY",
        models: ["kimi-k2-instruct", "kimi-k2.5", "kimi-think", "minimax-*", "mistral-*", "llama-*"],
        priority: 2,
      },
      ollama: {
        url: process.env.OLLAMA_URL || "http://192.168.0.100:11434/v1",
        auth_type: "none",
        models: ["dolphin-*"],
        priority: 3,
      },
    },
    failover: true,
    siem_log: true,
    ...overrides,
  };

  // Anthropic is conditional on having a credentials file or env token
  const anthropicCredsFile =
    process.env.ANTHROPIC_CREDENTIALS_FILE ||
    path.join(process.env.HOME || "", ".openclaw", "credentials", "anthropic.json");

  if (process.env.ANTHROPIC_API_KEY) {
    defaultConfig.backends.anthropic = {
      url: "https://api.anthropic.com/v1",
      auth_type: "api_key",
      api_key_env: "ANTHROPIC_API_KEY",
      models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-*"],
      priority: 1,
    };
  } else if (fs.existsSync(anthropicCredsFile)) {
    defaultConfig.backends.anthropic = {
      url: "https://api.anthropic.com/v1",
      auth_type: "oauth",
      credentials_file: anthropicCredsFile,
      models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-*"],
      priority: 1,
    };
  }

  return createRouter(defaultConfig);
}

// ---------------------------------------------------------------------------
// Convenience: route + upstream in one call WITH connection pooling
// ---------------------------------------------------------------------------

/**
 * Isolated pool of registry-materialised backends (ornith, qwen-vl, …).
 * These are used ONLY as the sole candidate for registry role/context routing.
 * They are deliberately kept OUT of the router's normal `backends` Map so their
 * wildcard model match can never shadow concrete-model routing (backward-compat).
 * Health + connection-pool tracking still work because each is a real Backend
 * instance keyed by a stable id.
 *
 * @type {Map<string, Backend>}
 */
const _regBackends = new Map();

/**
 * Get (or lazily create) an isolated registry Backend for the given id/url.
 * @param {string} id   e.g. "reg:ornith"
 * @param {string} url  full base url incl. /v1
 * @returns {Backend}
 */
function getRegBackend(id, url) {
  const clean = String(url || "").replace(/\/$/, "");
  const existing = _regBackends.get(id);
  if (existing && existing.url === clean) return existing;
  const b = new Backend({ id, url: clean, auth_type: "none", models: ["*"], priority: 1 });
  _regBackends.set(id, b);
  return b;
}

/**
 * Test-only: create/fetch a registry-routed door the way the live registry
 * path does, so a test can assert that `getHealth()` reports it. Not used by
 * production code.
 *
 * @param {string} id  e.g. `reg:ornith`
 * @param {string} url upstream base
 * @returns {Backend}
 */
export function _getRegBackendForTests(id, url) {
  return getRegBackend(id, url);
}

// ---------------------------------------------------------------------------
// @match routing (card P4.2, design doc 7.2): rank the discovered catalog
// against a role's requirements and map the ranked chain onto the EXISTING
// candidate/failover/quarantine/pool machinery. Gated behind config
// `routing.match_enabled` (default OFF), see routeAndSend()'s call site.
// ---------------------------------------------------------------------------

/**
 * Is `routing.match_enabled` set in the loaded gateway config? Fail-soft to
 * `false` (the required default) when config.mjs's `loadConfig()` has never
 * run (e.g. most router.mjs unit tests) or the key is simply absent: this
 * function must never throw into the request path.
 *
 * @returns {boolean}
 */
function isMatchRoutingEnabled() {
  try {
    return getConfig()?.routing?.match_enabled === true;
  } catch {
    return false;
  }
}

/**
 * Config epoch for `@match` decisions: the later of the registry's own mtime
 * (`getConfigEpoch()`, already used by the sk-auto decision cache) and the
 * discovery catalog store's mtime (`MATCH_CATALOG_CACHE_PATH`, the same file
 * discovery.mjs's `discoverCatalog()` writes every refresh cycle (the epic's
 * own vocabulary for this file: "the discovery cache ... evolves into a
 * machine-owned FACTS store"). A discovery cycle (new/dropped models, a
 * catalog-presence reconcile flipping a model toward `eol`, card P1.3) always
 * rewrites this file, so its mtime is a faithful "the catalog changed" signal
 * (design 7.2's decision-cache composition: "a catalog refresh or EOL flip
 * invalidates cached picks").
 *
 * Deliberately NOT the model_catalog_store.mjs lifecycle file: that file is
 * also rewritten by `recordModelOutcome()` on every completed request (P1.2),
 * so using its mtime here would invalidate the @match cache on every single
 * request (the very last request's own bookkeeping write), defeating the
 * cache entirely rather than reacting to genuine catalog/lifecycle events.
 *
 * Never throws: an as-yet-uncreated catalog cache file contributes 0.
 *
 * @returns {number}
 */
function matchConfigEpoch() {
  let catalogMtime = 0;
  try {
    catalogMtime = fs.statSync(MATCH_CATALOG_CACHE_PATH).mtimeMs;
  } catch {
    // cache not created yet, contributes nothing to the epoch.
  }
  return Math.max(getConfigEpoch(), catalogMtime);
}

/**
 * Assemble the ranker's catalog input (design 4.1 shape: `{id, free,
 * lifecycle:{state}, capabilities}`) off the on-disk discovery cache UNIONED
 * WITH THE CONFIGURED SERVING BACKENDS, so the router never depends on
 * index.mjs's in-memory catalog or triggers a network fetch. The id-to-capabilities mapping itself is NOT reimplemented here
 * (card C7): it delegates to `buildCapabilityCatalog()`
 * (../ranking/catalog.mjs), the same function index.mjs's `buildRankCatalog()`
 * (card P3.3, the /admin/models/rank suggest-only API) delegates to, so this
 * live routing path and the admin explain-tool can never again silently
 * diverge on how a metrics snapshot (or its absence) feeds capability
 * derivation. Before this card, this function hardcoded
 * `deriveCapabilities(entry, { metrics: {} })` inline, a second, uninjectable
 * copy of what buildRankCatalog already did with an injectable
 * `opts.metricsFn`. Never throws: a missing/unreadable cache file yields the
 * serving config alone, and a missing/unreadable serving config yields the
 * cache alone.
 *
 * THE CACHE ALONE WAS NOT THE SERVED SET. discovery.mjs has three provider
 * adapters (nvidia, openrouter, opencode) and no producer for Anthropic or for
 * our own hardware, so the file this function used to read exclusively could
 * never contain a Claude model or an Ornith model no matter how often it was
 * refreshed. Measured on this node 2026-08-16: 66 models served on
 * /v1/models, 96 in the cache, and not one id in common for the two tiers that
 * matter. `secret` (ceiling zone 0) and `internal` (ceiling zone 1) had no
 * eligible member at all while the zone-2 cloud buckets worked, so the
 * sovereignty gate failed exactly where it mattered.
 *
 * The union itself lives in discovery.mjs's `buildServingCatalog()`, NOT here,
 * because it has to happen on the same side of `applyCardOverlays()` as the
 * cached rows it is unioned with. The overlay is applied when the cache is
 * WRITTEN; a model added downstream of it arrives with no curated
 * `size_class`, scores `unknown` in meetsClassFloor(), and clears only floor
 * `S`. It would be in the catalog and still fail sk-l-secret. See that
 * function's doc comment.
 *
 * @returns {Array<object>}
 */
function buildMatchCatalog() {
  let models;
  try {
    models = buildServingCatalog({ cachePath: MATCH_CATALOG_CACHE_PATH });
  } catch {
    models = [];
  }
  // Exclusions are a config-driven NARROWING, so they are applied separately
  // and never gate the catalog itself. Calling getConfig() as the first
  // statement of the try above put the whole build behind a loaded config:
  // getConfig() throws when none is loaded, the catch returned [], and the
  // documented fail-closed behaviour (an unreadable config yields the
  // discovery cache ALONE, never nothing) silently became an empty catalog.
  // buildServingCatalog() already degrades correctly on its own.
  try {
    models = withoutExcludedModels(models, excludedModelIds(getConfig()));
  } catch {
    // No config loaded: there is nothing to exclude. Keep the catalog as-is.
  }
  return buildCapabilityCatalog(models, { getLifecycleFn: getLifecycle });
}

/**
 * Test-only: expose `buildMatchCatalog()` (card C7) so a test can assert the
 * live `@match` path's catalog/capabilities are identical to what
 * index.mjs's `buildRankCatalog()` (the /admin/models/rank explain endpoint)
 * would compute for the same underlying model entries. Not used by
 * production code.
 * @returns {Array<object>}
 */
export function _buildMatchCatalogForTests() {
  return buildMatchCatalog();
}

/**
 * Build the router candidates array for an `@match` role (card P4.2, design
 * 7.2): rank the discovered catalog against the role's requirements (the
 * pure P3.2 ranker), cache the RANKED ID ORDER (not the resolved backends,
 * those must stay fresh: health/auth can change independent of ranking),
 * then resolve each ranked id to its FULL priority-ordered door chain via
 * the router's own model-matching (`router.route()`) and attach the exact
 * `bodyOverride` model-rewrite mechanism the cloud-fallback candidate
 * already uses (router.mjs's local-failover branch). Because every entry
 * lands in the same `{backendId, backendUrl, authHeaders, backend,
 * bodyOverride, model}` shape the existing candidate loop already
 * understands, failover/quarantine/pool/SIEM/throttle-cooldown all apply
 * unchanged.
 *
 * Card 9e28de88 fix #5: every door `router.route()` returns for a ranked id
 * is pushed, not just the top-priority one, before moving on to the NEXT
 * ranked id. Measured: nine free-tier ids are currently served by two or
 * more providers at once (nemotron-3-ultra-550b-a55b on nvidia, openrouter,
 * AND opencode zen, among others). When the top door for a ranked id
 * throttles, reaching the SAME model through its next-priority door
 * preserves the caller's expectations exactly (same model, same behavior);
 * substituting a different ranked model changes behavior and should only
 * be reached once every door for the current one is exhausted. Since
 * `router.route()` already orders each id's doors by backend priority, the
 * happy path (the top door is healthy) is byte-identical to before this
 * card; this only lengthens the chain actually walked on a throttle/error.
 *
 * @param {ReturnType<typeof createRouter>} router
 * @param {{match:true, role:string, requirements:?object}} reg
 * @param {RouteRequest} request
 * @param {Buffer} body
 * @returns {Promise<{candidates:Array<object>, picks:string[]}>}
 */
async function buildMatchCandidates(router, reg, request, body) {
  const requirements = reg.requirements || {};
  const messages = extractMessages(request, body);
  const epoch = matchConfigEpoch();
  const cacheKey = `match:${reg.role}:${decisionKey(messages, epoch)}`;

  let picks = _matchDecisionCache.get(cacheKey);
  if (!picks) {
    const catalog = buildMatchCatalog();
    const allow = loadAllowlist();
    const chain = rankModels(catalog, requirements, {
      allowlist: allow,
      isModelAvailable: (id) => isModelAvailable(id, router),
    });
    picks = chain
      .filter((c) => c.excluded_reason === null)
      .slice(0, MATCH_TOP_K)
      .map((c) => c.id);
    _matchDecisionCache.set(cacheKey, picks);
  }

  const candidates = [];
  for (const id of picks) {
    let results;
    try {
      results = await router.route({ ...request, model: id, agentId: request.agentId });
    } catch {
      // e.g. ModelEolError from a mid-flight lifecycle flip the ranker's
      // own catalog read hadn't seen yet, or a request with no backends at
      // all: skip this ranked pick, the next one (or the caller's own
      // empty-chain fallback) takes over.
      continue;
    }
    if (!results || results.length === 0) continue;
    // Push EVERY door for this ranked id (see fix #5 in the doc comment
    // above), tagged with the concrete `model` so the candidate loop's
    // throttle cooldown (fix #2) keys on the right (backend, model) pair
    // even though every door here shares one bodyOverride rewrite.
    const rewritten = rewriteBodyModel(body, id);
    for (const r of results) {
      candidates.push({ ...r, bodyOverride: rewritten, model: id });
    }
  }

  if (picks.length) {
    console.log(
      `[router] @match role=${reg.role} ranked=[${picks.join(",")}] ` +
      `candidates=[${candidates.map((c) => c.backendId).join(",")}]`
    );
  }

  return { candidates, picks };
}

/**
 * Test-only: `{hits, misses, size}` on the `@match` ranked-pick decision
 * cache (card P4.2). Mirrors `model_catalog_store.mjs`'s `_resetCacheForTests`
 * introspection convention; not used by production code.
 * @returns {{hits:number, misses:number, size:number}}
 */
export function _matchDecisionCacheStats() {
  return { hits: _matchDecisionCache.hits, misses: _matchDecisionCache.misses, size: _matchDecisionCache.size };
}

/** Test-only: clear the `@match` ranked-pick decision cache (card P4.2). */
export function _resetMatchDecisionCacheForTests() {
  _matchDecisionCache.clear();
}

/**
 * Build the clean 404 response `routeAndSend()` returns for a `ModelEolError`
 * (card P1.6), the same `{status, headers, body, backendId, failover}` shape as
 * every other `routeAndSend()` result, so the caller (src/index.mjs) needs no
 * special-casing. No backend was attempted.
 *
 * @param {ModelEolError} err
 */
function eolGatedResponse(err) {
  const payload = JSON.stringify({
    error: { message: err.message, code: 404 },
    eol_reason: err.eolReason,
  });
  return {
    status: 404,
    headers: { "content-type": "application/json" },
    body: Buffer.from(payload, "utf-8"),
    backendId: null,
    failover: false,
  };
}

function claimQuarantinedResponse(err) {
  return {
    status: 503,
    headers: { "content-type": "application/json", "retry-after": "30" },
    body: Buffer.from(JSON.stringify({
      error: {
        message: err.message,
        code: 503,
        type: "model_claim_quarantined",
        model: err.model,
        retryable: true,
      },
    }), "utf-8"),
    backendId: null,
    failover: false,
  };
}

function ownerDownResponse(err) {
  return {
    status: 503,
    headers: { "content-type": "application/json", "retry-after": "30" },
    body: Buffer.from(JSON.stringify({
      error: {
        message: err.message,
        code: 503,
        type: "model_owner_backend_down",
        model: err.model,
        declared_by: err.declaredBy,
        retryable: true,
      },
    }), "utf-8"),
    backendId: null,
    failover: false,
  };
}

/**
 * High-level helper used by the proxy request handler.
 * Tries each candidate backend in order, acquires a pool slot, sends the
 * request, records outcomes, and returns the first successful response.
 * On failover it emits a SIEM log line.
 *
 * NEW: Uses connection pooler to enforce per-backend concurrency limits
 * and queue excess requests.
 *
 * @param {ReturnType<typeof createRouter>} router
 * @param {RouteRequest} request
 * @param {string}  upstreamPath   Request path (e.g. "/v1/chat/completions")
 * @param {string}  method         HTTP method
 * @param {Record<string, string>} clientHeaders  Incoming client headers
 * @param {Buffer}  body           Buffered request body
 * @param {boolean} [usePool=true] Whether to use the connection pool
 * @param {?function(object): (void|Promise<void>)} [siem=null]
 *   Optional SIEM sink. Called with a fully-structured
 *   {@link module:siem/events.GatewayEvent} at each request lifecycle point
 *   (auth decision, route/model selected, upstream error, failover, and
 *   completion with status/latency/tokens). When configured, each call is
 *   awaited and a sink failure rejects the request boundary rather than
 *   allowing a success with no audit record.
 * @returns {Promise<{
 *   status: number,
 *   headers: Record<string, string>,
 *   body: Buffer,
 *   backendId: string,
 *   servedModel?: string,
 *   failover: boolean,
 *   queueWaitMs?: number,
 * }>}
 */

/**
 * Is trust-zone enforcement armed? Card 45d7a30b / N1.
 *
 * Defaults OFF. The gate ships in SHADOW mode so a soak can show exactly what
 * it would have blocked before it starts blocking, because the failure mode of
 * turning it on blind is a 503 for real traffic, and the failure mode of
 * leaving it off is a silent sovereignty crossing. Both are bad; only one is
 * reversible in a hurry.
 */
function isSensitivityEnforced() {
  try {
    return !!getConfig()?.routing?.sensitivity_enforced;
  } catch {
    return false;
  }
}

/**
 * The trust zone a BACKEND runs in, for failover-time gating.
 *
 * ranking/capabilities.mjs derives a per-MODEL zone from provider posture, but
 * failover decisions happen at the backend level and before any ranking, so
 * this resolves the same question from what a candidate actually has: its
 * backend id and url. Deliberately conservative, an unrecognized backend is
 * treated as the LEAST trusted rather than skipped, so "we could not tell"
 * never satisfies a sovereignty requirement.
 *
 * @param {{backendId?:string, backendUrl?:string, backend?:object}} candidate
 * @returns {number}
 */
export function backendTrustZone(candidate) {
  const url = candidate?.backendUrl || candidate?.backend?.url || "";
  const id = String(candidate?.backendId || candidate?.backend?.id || "");
  if (url && isLocalUrl(url)) return TRUST_ZONES.SOVEREIGN_LOCAL;
  // Anthropic is the one provider whose terms prohibit training on our content
  // (verified 2026-08-15, card N2's provider posture block). The local
  // claude-code-api wrapper is loopback and already caught by isLocalUrl above.
  if (/^anthropic/.test(id)) return TRUST_ZONES.PAID_CONTRACTUAL;
  // z.ai is paid subscription traffic, but its current retention posture is
  // intentionally not assumed contractual-zero. Keep it in zone 2 until the
  // provider terms are reviewed and a dated posture is recorded.
  if (isZaiBackend(candidate?.backend) || /api\.z\.ai\//i.test(url) || /^zai/.test(id)) {
    return TRUST_ZONES.FREE_REMOTE;
  }
  return TRUST_ZONES.FREE_REMOTE;
}

/**
 * Resolve the trust-zone ceiling this request must respect, or null when the
 * caller stated no sensitivity at all.
 *
 * Null means UNCONSTRAINED, which is correct: a caller that says nothing about
 * sensitivity gets today's behavior. This gate raises the floor for callers who
 * opt in; it does not retroactively classify traffic that never declared
 * itself. Making silence mean "secret" would fail-close the entire fleet on the
 * day it shipped.
 *
 * @param {object} request
 * @returns {{ceiling:number, sensitivity:string}|null}
 */
export function requestZoneCeiling(request) {
  const sensitivity = request?.requirements?.require?.sensitivity;
  if (sensitivity === undefined) return null;
  let policy;
  try {
    policy = policyFromRegistry(loadRegistry());
  } catch {
    policy = undefined;
  }
  const { ceiling } = resolveZoneCeiling(sensitivity, policy);
  return { ceiling, sensitivity: String(sensitivity) };
}


/** Is bucket-pool addressing armed? Card 2ba73bf9 / C9. Off by default. */
function isBucketsEnabled() {
  try {
    return !!getConfig()?.routing?.buckets_enabled;
  } catch {
    return false;
  }
}

/**
 * A catalog listing is not completion liveness. Bound bucket attempts even
 * when a backend has no general timeout, so a socket-accepting black hole
 * becomes a retryable 504 instead of holding the selected route forever.
 *
 * This is intentionally bucket-only. Named-model and registry-role traffic
 * retain each backend's existing timeout contract. An explicit shorter backend
 * timeout stays shorter. Tests may lower the boundary through the environment;
 * zero and malformed values cannot disable it.
 */
export const DEFAULT_BUCKET_LIVENESS_TIMEOUT_MS = 60_000;

export function bucketLivenessTimeoutMs(
  backendTimeoutMs = 0,
  raw = process.env.SKGATEWAY_BUCKET_LIVENESS_TIMEOUT_MS,
) {
  const configured = Number(raw);
  const boundary = Number.isFinite(configured) && configured > 0
    ? Math.trunc(configured)
    : DEFAULT_BUCKET_LIVENESS_TIMEOUT_MS;
  return Number.isFinite(backendTimeoutMs) && backendTimeoutMs > 0
    ? Math.min(Math.trunc(backendTimeoutMs), boundary)
    : boundary;
}

/** Per-bucket rotation counters. Ranking decides eligibility, this decides who serves. */
const _bucketCounters = new Map();

/**
 * Does the registry explicitly define this id (as a role, a context key, or a
 * backend name)? The escape hatch for the typo gate below.
 *
 * An operator who deliberately names a role `sk-l-fast` has declared it in the
 * registry, and a declared role must keep working no matter what it is called.
 * Only an id nothing defines can be a typo. Fail-soft to "not defined" on an
 * unreadable registry: the typo gate is opt-in behind buckets_enabled, and
 * refusing a bucket-shaped id we cannot vouch for is the fail-closed direction.
 *
 * @param {string} id
 * @returns {boolean}
 */
function registryDefinesId(id) {
  if (typeof id !== "string" || !id) return false;
  try {
    const reg = loadRegistry();
    const has = (m) => !!m && Object.prototype.hasOwnProperty.call(m, id);
    return has(reg?.roles) || has(reg?.contexts) || has(reg?.backends);
  } catch {
    return false;
  }
}

/**
 * A bucket-shaped id that is not a bucket must FAIL, and say why.
 *
 * Measured on this code before the fix: with buckets_enabled ON,
 * `model=sk-xl-secrets` returned HTTP 200. parseBucketId() correctly refused
 * it, the bucket branch was skipped, isRegistryRouted() then matched it purely
 * on the `sk-` prefix, nothing in the registry defined it, and it resolved
 * through defaults.role to sk-auto, the difficulty classifier. A caller asking
 * for XL-capable work on secret data got an arbitrary model with neither the
 * capability floor nor the trust-zone ceiling applied, and a 200 telling them
 * everything was fine.
 *
 * 400, not 503. 503 says "unavailable, retry later" and would earn a retry
 * storm against an id that will never work; the address itself is wrong and
 * nothing about waiting fixes it. The body carries the full valid bucket list
 * so the caller can see the correction rather than guess at it.
 *
 * @param {string} id the model id the caller sent
 * @param {string} reason from looksLikeBucketAttempt()
 */
function invalidBucketIdResponse(id, reason) {
  return {
    status: 400,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({
      error: {
        message:
          `"${id}" is not a valid bucket address (${reason}). A bucket is ` +
          `sk-<class>-<sensitivity>. It was NOT routed: a near-miss bucket id ` +
          `would otherwise be served with no capability floor and no trust-zone ceiling.`,
        code: 400,
        type: "invalid_bucket_id",
        model: id,
        reason,
        valid_buckets: allBuckets().map((b) => b.bucket),
      },
    }), "utf-8"),
  };
}

/**
 * Resolve a bucket address to router candidates, or to a fail-closed 503.
 *
 * Returns `{candidates}` on success, or `{failClosed}` carrying the response to
 * return directly. An empty pool is NOT an error to paper over: it means no
 * model in the fleet satisfies both the capability floor and the sovereignty
 * ceiling this caller asked for, and serving it from something that misses
 * either would be a silent policy violation dressed up as availability.
 *
 * `emitSiem` is a PARAMETER, not a closure reference. It used to be the
 * latter, and since this is a module-level function while `emitSiem` is a
 * `const` declared inside `routeAndSend`'s body, the identifier simply did not
 * resolve: every call reached the `emitSiem("bucket_resolve", ...)` line and
 * threw `ReferenceError: emitSiem is not defined`. No test ever called this
 * function, so nothing caught it, and buckets_enabled has never been on in
 * production, so nothing exercised it there either. It meant a VALID bucket id
 * failed exactly as hard as an invalid one, the fail-closed 503 body below was
 * unreachable, and the bucket layer could not have worked at all on the day
 * somebody flipped the flag.
 *
 * @param {object} router
 * @param {{bucket:string, model_class:string, sensitivity:string}} addr
 * @param {object} request
 * @param {Buffer} body raw request body, rewritten to the chosen concrete model
 * @param {(type:string, details?:object, ctx?:object)=>Promise<object|null>} [emitSiem]
 */
async function resolveBucketCandidates(router, addr, request, body, emitSiem = async () => null) {
  let catalog = [];
  try {
    catalog = buildMatchCatalog();
  } catch {
    catalog = [];
  }

  let policy;
  try {
    policy = policyFromRegistry(loadRegistry());
  } catch {
    policy = undefined;
  }

  // A caller that sent `tools` must not be handed a model that cannot hold a
  // tool call. buckets.mjs gates on size class, and size is a PRIOR: on this
  // fleet `nvidia/ising-calibration-1.5-31b` clears the class floor and still
  // answers in prose with no tool_calls. Parsing is FAIL-SOFT on purpose, an
  // unreadable body simply does not narrow the pool, so a malformed request
  // degrades to today's behaviour instead of 503ing.
  let wantsTools = false;
  try {
    wantsTools = requiresToolUse(JSON.parse(Buffer.from(body).toString("utf-8")));
  } catch {
    wantsTools = false;
  }

  const { members, rejected, ceiling } = resolveBucket({
    bucket: addr,
    catalog,
    sensitivityPolicy: policy,
    requireToolUse: wantsTools,
    isRoutable: (e) => {
      const claimers = typeof router.getBackends === "function"
        ? router.getBackends()
          .filter((backend) => backend.supportsModel(e.id))
          .map((backend) => backend.id)
        : [];
      return isEffectivelyRoutable(getLifecycle(e.id), claimers);
    },
  });

  await emitSiem(EventType.REQUEST, {
    decision: "bucket_resolve",
    phase: "eligibility",
    outcome: members.length > 0 ? "eligible_members" : "no_eligible_member",
    bucket: addr.bucket,
    model_class: addr.model_class,
    sensitivity: addr.sensitivity,
    ceiling,
    eligible: members.length,
    rejected: rejected.length,
    require_tool_use: wantsTools,
  }, {});

  if (members.length === 0) {
    console.warn(
      `[router] bucket ${addr.bucket} FAIL CLOSED: no model meets class floor ` +
        `${addr.model_class} within trust zone <= ${ceiling}. ${rejected.length} excluded.`,
    );
    return {
      failClosed: {
        status: 503,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({
          error: {
            message:
              `No model satisfies bucket ${addr.bucket} (capability floor ${addr.model_class}, ` +
              `max trust zone ${ceiling}).`,
            code: 503,
            type: "bucket_no_eligible_member",
            bucket: addr.bucket,
            model_class: addr.model_class,
            sensitivity: addr.sensitivity,
            ceiling,
            // The rejects are the actionable part. An empty pool with no
            // reasons is an outage report; with reasons it is a decision an
            // operator can do something about.
            excluded: rejected.slice(0, 20),
          },
        }), "utf-8"),
      },
    };
  }

  const n = (_bucketCounters.get(addr.bucket) || 0) + 1;
  _bucketCounters.set(addr.bucket, n);
  
  // Read and validate family preference from x-sk-prefer header (card 1e26943e)
  const prefHeader = request.headers?.['x-sk-prefer'];
  let familyPreference = null;
  let prefError = null;

  if (prefHeader !== undefined) {
    const validation = validateFamilyPreference(prefHeader, addr.sensitivity);
    if (validation.valid) {
      familyPreference = validation.preference;
      if (familyPreference && familyPreference.length > 0) {
        console.log(
          `[router] bucket ${addr.bucket} applying family preference: ${familyPreference.join(',')}`,
        );
      }
    } else {
      prefError = validation.reason;
      console.warn(
        `[router] bucket ${addr.bucket} invalid family preference: ${prefError}`,
      );
      return {
        failClosed: {
          status: 400,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({
            error: {
              message: `Invalid family preference: ${prefError}`,
              code: 400,
              type: "invalid_family_preference",
            },
          }), "utf-8"),
        },
      };
    }
  }

  // Apply family preference within cheapest cost tier
  const picked = selectMember(members, n, familyPreference);
  
  if (!picked) {
    console.warn(`[router] bucket ${addr.bucket} no member selected after preference`);
    return {
      failClosed: {
        status: 503,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({
          error: {
            message: `No model available for bucket ${addr.bucket}`,
            code: 503,
            type: "bucket_no_member",
          },
        }), "utf-8"),
      },
    };
  }

  console.log(
    `[router] bucket ${addr.bucket} -> ${picked.id} ` +
      `(class ${picked.model_class || "?"} via ${picked.class_basis}, zone ${picked.trust_zone ?? "?"}, ` +
      `family ${picked.family || "?"}, ` +
      `${members.length} eligible)` +
      (familyPreference ? ` [preference: ${familyPreference.join(',')}]` : ''),
  );

  // Resolve the chosen id through the router's own model matching, so
  // failover, quarantine, pooling and the throttle cooldowns all apply
  // unchanged. Every alternate door for that id is kept, which is what makes
  // card 9e28de88's same-model-different-provider preference work inside a pool.
  //
  // AWAITED. `router.route()` is async (it resolves each candidate's auth
  // headers via `await b.buildAuthHeaders()`), and this call site used to take
  // its return value directly. The Promise is not an array and is truthy, so
  // the `Array.isArray(...) ? ... : results ? [results] : []` normalization
  // wrapped the Promise itself as the single candidate, spread it into an
  // empty object, and produced a candidate with no backendId, no backendUrl and
  // no authHeaders. routeAndSend then threw `TypeError: Cannot convert
  // undefined or null to object` on `Object.entries(authHeaders)`. The @match
  // path does await the same call; this one was simply missed, and no test ever
  // reached it. The normalization is kept for the resolved value, which really
  // can be a single object or an array.
  // selectMember() returns the ONE best member (cheapest cost tier, preference
  // applied within that tier). The candidate loop below still needs the full
  // member list so failover, quarantine and pooling keep working when the
  // chosen member's backend is down. Rebuild it with the picked member first,
  // then every other member in cost order: the preference decides who serves,
  // it does not remove anyone from the failover chain.
  const orderedMembers = [
    picked,
    ...orderMembersByCost(members, n).filter((m) => m.id !== picked.id),
  ];

  const candidates = [];
  const seen = new Set();
  const skipped = [];
  for (const member of orderedMembers) {
    let results;
    try {
      results = await router.route({ ...request, model: member.id, agentId: request.agentId });
    } catch (err) {
      if (err instanceof ModelEolError) {
        skipped.push(member.id);
        await emitSiem(EventType.ANOMALY, {
          type: "bucket_member_skipped",
          outcome: "skipped",
          bucket: addr.bucket,
          member: member.id,
          eol_reason: err.eolReason || err.message,
        }, {});
        continue;
      }
      // Provider purity in a bucket chain: a member whose declaring backend
      // is down is retried as an expansion route (the bucket tier treats
      // members as fungible across sibling backends, health-aware expansion).
      // If expansion still yields nothing servable, the member is skipped and
      // the next live member serves. Direct (non-bucket) requests never take
      // this path: for them ModelOwnerDownError fails closed at route().
      if (err instanceof ModelOwnerDownError) {
        try {
          results = await router.route({
            ...request, model: member.id, agentId: request.agentId, expand: true,
          });
        } catch (expandErr) {
          skipped.push(member.id);
          await emitSiem(EventType.ANOMALY, {
            type: "bucket_member_skipped",
            outcome: "skipped",
            bucket: addr.bucket,
            member: member.id,
            eol_reason: expandErr instanceof Error ? expandErr.message : String(expandErr),
          }, {});
          continue;
        }
        const list2 = Array.isArray(results) ? results : results ? [results] : [];
        for (const result of list2) {
          const key = `${result.backendId}:${member.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({
            ...result,
            bodyOverride: rewriteBodyModel(body, member.id),
            model: member.id,
            bucket: addr.bucket,
            bucketMember: member.id,
          });
        }
        continue;
      }
      throw err;
    }
    const list = Array.isArray(results) ? results : results ? [results] : [];
    for (const result of list) {
      const key = `${result.backendId}:${member.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        ...result,
        bodyOverride: rewriteBodyModel(body, member.id),
        model: member.id,
        bucket: addr.bucket,
        bucketMember: member.id,
      });
    }
  }

  if (candidates.length === 0) {
    return {
      failClosed: {
        status: 503,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({
          error: {
            message: `No model satisfies bucket ${addr.bucket} after lifecycle gating.`,
            code: 503,
            type: "bucket_no_eligible_member",
            bucket: addr.bucket,
            model_class: addr.model_class,
            sensitivity: addr.sensitivity,
            ceiling,
            excluded: skipped.map((id) => ({ id, reason: "eol-gated" })),
          },
        }), "utf-8"),
      },
    };
  }

  await emitSiem(EventType.REQUEST, {
    decision: "bucket_resolve",
    phase: "candidate_chain",
    outcome: "candidate_chain_built",
    bucket: addr.bucket,
    chain_length: candidates.length,
    skipped,
  }, {});
  return {
    candidates,
    isBucketChain: true,
  };
}

/**
 * Build the typed, fail-closed SIEM boundary used by routeAndSend().
 *
 * Event construction and sink completion are both part of emission: an
 * unknown EventType throws before the sink is called, and a synchronous throw
 * or rejected sink promise rejects the caller. This prevents a policy/routing
 * decision from succeeding without its required record. Absence of a sink is
 * still an explicit no-op because SIEM itself is optional in configuration.
 *
 * @param {Function|null} siem
 * @param {object|(() => object)} requestSource
 * @param {string} [requestId]
 * @returns {(type:string, details?:object, ctx?:object)=>Promise<object|null>}
 */
export function createRouteSiemEmitter(siem, requestSource = {}, requestId = randomUUID()) {
  return async (type, details = {}, ctx = {}) => {
    const request = typeof requestSource === "function" ? requestSource() : requestSource;
    const event = createEvent(type, details, {
      request_id: requestId,
      ...(request?.agentId ? { agent_id: request.agentId } : {}),
      ...(request?.sessionId ? { session_id: request.sessionId } : {}),
      ...(request?.model ? { model: request.model } : {}),
      ...ctx,
    });
    if (typeof siem !== "function") return null;
    await siem(event);
    return event;
  };
}

export async function routeAndSend(router, request, upstreamPath, method, clientHeaders, body, usePool = true, siem = null, abortSignal = null) {
  const pool = usePool ? getPool() : null;
  const requestedModel = request?.model;
  const codexIntent = [requestedModel, request?.role, request?.context, request?.service];

  // Read fresh off getConfig() every request (not cached at module scope) so
  // a SIGHUP config reload picks up a flipped energy.enabled or an updated
  // meters/coefficients map without a restart, mirroring getPricing(). Fail
  // soft to undefined when loadConfig() has never run (most router.mjs unit
  // tests construct routeAndSend directly), matching isMatchRoutingEnabled()
  // above: this must never throw into the request path.
  let energyCfg;
  try {
    energyCfg = getConfig()?.energy;
  } catch {
    energyCfg = undefined;
  }

  // ── SIEM: per-request audit correlation ──
  // Every lifecycle event emitted for this request shares one request_id so a
  // SIEM/SOC can stitch auth → request → (failover) → response|error together.
  // Audit decisions are a fail-closed boundary: createEvent() type errors and
  // synchronous or asynchronous sink failures propagate. A request must not
  // report success after its required evidence was rejected by the contract or
  // sink. No configured sink remains an explicit, backwards-compatible no-op.
  const _siemRequestId = randomUUID();
  const emitSiem = createRouteSiemEmitter(siem, () => request, _siemRequestId);

  // ── Per-agent model routing (CR-5.1: registry agent:<id> context) ──
  // Map the resolved CapAuth agent identity to its pinned target read LIVE from
  // the skmodels registry `agent:<id>` context (the single source of truth),
  // overriding the model the caller asked for. This runs BEFORE registry +
  // backend selection, and only rewrites the target MODEL, so it composes with
  // everything downstream unchanged: an alias target flows through the registry
  // resolver (incl. sk-auto difficulty classification), a concrete-model target
  // flows through normal backend selection, and either way failover + the
  // dead-alias quarantine below still apply. A pinned target whose backend is
  // quarantined/down falls back through the normal candidate machinery.
  //
  // Explicit per-request registry signals (x-sk-context / x-sk-service /
  // x-sk-role) are deliberate caller intent and WIN over the agent rule; only
  // the model field is pinned. No rule for the agent (or none configured) = the
  // request is untouched and routing behaviour is unchanged.
  const agentTarget = typeof router.resolveAgentTarget === "function"
    ? router.resolveAgentTarget(request.agentId)
    : null;
  if (agentTarget && !request.context && !request.service && !request.role) {
    if (request.model !== agentTarget) {
      console.log(
        `[router] per-agent route agent=${request.agentId} ` +
        `model=${request.model || "(none)"}→${agentTarget}`
      );
    }
    request = { ...request, model: agentTarget };
    // Rewrite the outgoing body model so the upstream (and its logs/metrics)
    // sees the pinned target. When the target is an alias/role the registry
    // block below re-rewrites the body to the resolved concrete model.
    body = rewriteBodyModel(body, agentTarget);
  }

  // ── FRONT of backend selection: skmodels registry role/context routing ──
  // If the request opts into logical routing (model="sk-*" or an x-sk-*
  // header), resolve via the single-source-of-truth registry, rewrite the
  // outgoing model to the resolved backend's concrete model name, and pin the
  // upstream to the resolved backend. Otherwise fall through to normal
  // model-name routing (full backward-compat).
  let candidates = null;
  let isBucketChain = false;

  // ── Bucket pools (card 2ba73bf9 / C9) ──
  // `sk-<class>-<sensitivity>` addresses a POOL, not a model. Checked BEFORE
  // registry routing because a bucket id is deliberately shaped like the
  // existing `sk-*` logical ids and would otherwise be swallowed by
  // isRegistryRouted() as an unknown role.
  //
  // Gated behind routing.buckets_enabled, off by default, for the same reason
  // the sensitivity gate is: a pool that resolves to nothing returns 503, and
  // that is the correct answer but not one to discover in production on a
  // Friday. With the flag off a bucket id simply is not special and falls
  // through to today's behavior.
  const bucketsOn = isBucketsEnabled();
  const bucketAddr = bucketsOn ? parseBucketId(request.model) : null;
  if (bucketAddr) {
    const resolved = await resolveBucketCandidates(router, bucketAddr, request, body, emitSiem);
    if (resolved.failClosed) return resolved.failClosed;
    candidates = resolved.candidates;
    isBucketChain = resolved.isBucketChain === true;
  } else if (bucketsOn) {
    // A near miss is the dangerous case, not an unknown id. See
    // invalidBucketIdResponse() above for the measured 200 this prevents. An
    // id the registry actually defines is never a typo, so it is exempt and
    // routes exactly as it did before.
    const attempt = looksLikeBucketAttempt(request.model);
    if (attempt.attempted && !registryDefinesId(request.model)) {
      console.warn(
        `[router] REFUSED bucket-shaped id "${request.model}": ${attempt.reason}. ` +
          `Not falling through to registry defaults, which would apply no ` +
          `capability floor and no trust-zone ceiling.`,
      );
      await emitSiem(EventType.ERROR, {
        type: "invalid_bucket_id",
        status_code: 400,
        outcome: "rejected",
        model: request.model,
        reason: attempt.reason,
      }, {});
      return invalidBucketIdResponse(request.model, attempt.reason);
    }
  }

  if (!candidates && isRegistryRouted(request)) {
    let reg = resolveRegistry({
      model: request.model,
      context: request.context,
      service: request.service,
      role: request.role,
    });

    // ── sk-auto: pick the concrete role per-request by DIFFICULTY ──
    // resolve() returns an { auto:true } marker for the sk-auto role/context.
    // Run the (fast, no-LLM) classifier over the request messages to choose a
    // real role, then re-resolve THAT role to a concrete backend and route it.
    if (reg && reg.auto) {
      const messages = extractMessages(request, body);
      const autoCfg = getAutoConfig();
      // Decision cache: identical prompts under the same config epoch skip
      // re-classification + the empirical lookup. A registry `auto:` edit bumps
      // the epoch → transparent invalidation. (Scaffolds the S2 small-LLM tier.)
      const _ckey = decisionKey(messages, getConfigEpoch());
      let d = _autoDecisionCache.get(_ckey);
      const _cached = !!d;
      if (!d) {
        // Pure heuristic BASELINE, then a bounded empirical nudge from the shared
        // Telegram ratings store (skchat telegram_ratings ↔ ratings.jsonl).
        const base = classifyDifficulty(messages, autoCfg);
        const promptClass = promptClassFromResult(base);
        const adj = adjustWithEmpirical(base, {
          promptClass,
          config: autoCfg,
          // Map a logical role to its concrete model name so empirical stats
          // (keyed by concrete model) can be looked up.
          resolveModel: (role) => {
            const r = resolveRegistry({ role });
            return r && r.model ? r.model : null;
          },
        });
        d = { role: adj.role, reason: adj.reason, signals: adj.signals, promptClass };
        _autoDecisionCache.set(_ckey, d, autoCfg.cache_ttl_ms);
      }
      const picked = resolveRegistry({ role: d.role });
      console.log(
        `[router] auto-route difficulty=${d.role} class=${d.promptClass} reason=${d.reason} ` +
        `signals=[${d.signals.join(",")}]${_cached ? " (cached)" : ""} -> backend=${picked ? picked.backend : "(unresolved)"}`
      );
      reg = picked;
    }

    // ── @match: capability-aware ranked routing (card P4.2, design 7.2) ──
    // resolve() returns a { match:true, role, requirements } marker (card
    // P4.1) for a role whose target is "@match", exactly parallel to the
    // sk-auto marker above. GATED behind routing.match_enabled (default OFF,
    // ships dark, card P4.4 flips it on per-role later). With the flag off
    // this whole branch is a no-op: `reg` is nulled out and the request falls
    // through to today's default resolution EXACTLY as if the role's target
    // had never resolved at all (no rank call, no new candidates, no added
    // latency: byte-identical to today).
    if (reg && reg.match) {
      if (isMatchRoutingEnabled()) {
        const built = await buildMatchCandidates(router, reg, request, body);
        candidates = built.candidates;
        if (!candidates.length) {
          console.warn(
            `[router] @match role=${reg.role} produced no live ranked candidates, falling back to default routing`
          );
          candidates = await router.route(request);
        } else {
          // Route the top-ranked pick through the normal metrics/health path
          // (mirrors the plain-role `request.model = reg.model` assignment
          // below, which this branch skips since reg is nulled out next).
          request = { ...request, model: built.picks[0] };
        }
      }
      reg = null; // either routed above, or inert, nothing left for the legacy reg block below.
    }

    if (reg) {
      // Rewrite the outgoing model so the upstream receives a real name.
      body = rewriteBodyModel(body, reg.model);
      body = applyBodyFloor(body, reg.model, reg.minOutputTokens);
      if (reg.anthropic) {
        // Route via the gateway's configured anthropic backends. Resolve the
        // FULL priority-ordered chain for the concrete claude model (the
        // claude-code-api :18782 wrapper primary + any lower-priority direct
        // fallback) so a wrapper outage fails over instead of hard-failing —
        // registry routing must not re-introduce the wrapper SPOF. router.route
        // only returns configured backends, never the gateway's own url.
        try {
          candidates = await router.route({ ...request, model: reg.model, agentId: request.agentId });
        } catch (err) {
          if (err instanceof ModelEolError) return eolGatedResponse(err);
          if (err instanceof ModelClaimQuarantinedError) return claimQuarantinedResponse(err);
          if (err instanceof ModelOwnerDownError) return ownerDownResponse(err);
          throw err;
        }
        if (!candidates || candidates.length === 0) {
          console.warn("[router] registry resolved to anthropic but no anthropic backend configured");
        }
      } else {
        // External backend (ornith .100:8082 / qwen38 chiap08:11439 / a
        // remote provider). Kept in an ISOLATED pool so it never joins normal
        // model-name routing (would otherwise shadow concrete-model backends
        // via wildcard match).
        //
        // AUTH (codex support): this path used to hardcode `authHeaders: {}`
        // because every registry target was a local unauthenticated llama.cpp
        // box. A role can now point at an AUTHENTICATED remote backend (the
        // codex subscription backend, auth_type codex_oauth): when the
        // registry url matches a CONFIGURED backend, route through that
        // backend so its buildAuthHeaders() applies and health/pooling state
        // is shared (a reg: synthetic pool with empty auth would send the
        // request unauthenticated and 401, measured live on chiap01). The
        // synthetic isolated pool remains for urls the config does not
        // declare, byte-identical to the old behavior.
        const regUrl = String(reg.url || "").replace(/\/$/, "");
        const configured = (typeof router.getBackends === "function"
          ? [...router.getBackends().values()]
          : []
        ).find((b) => b && b.url === regUrl);
        let localCandidate;
        let regBackendInstance = null; // the attempt backend, for the failover timeout below
        if (configured) {
          regBackendInstance = configured;
          localCandidate = {
            backendId: configured.id,
            backendUrl: configured.url,
            authHeaders: await configured.buildAuthHeaders(),
            backend: configured,
            model: reg.model,
            // Feed the local-health verdict map exactly like the synthetic
            // branch below, but only when the target really is local (a
            // remote configured backend must not poison the liveness map).
            ...(isLocalUrl(reg.url) ? { localUrl: reg.url } : {}),
          };
        } else {
          const b = getRegBackend("reg:" + reg.backend, reg.url);
          regBackendInstance = b;
          localCandidate = {
            backendId: b.id,
            backendUrl: b.url,
            authHeaders: {},
            backend: b,
            localUrl: reg.url, // tag: record the health outcome of this attempt
            model: reg.model, // tag: model-granular throttle cooldown keying (card 9e28de88)
          };
        }
        candidates = [localCandidate];

        // ── Health-aware, sovereign-first local failover ──
        // A local sovereign backend is a single point of failure: when the GPU
        // wedges (broken driver, llama-server hung, /chat/completions never
        // replies) this single-candidate route stalls every caller to a
        // multi-minute timeout. Gate the local route on a fast, cached liveness
        // probe AND a bounded completion timeout, transparently failing over to a
        // known-good cloud FREE model when the local backend is unreachable or
        // hangs. Defaults ON; env-tunable (see local-failover.mjs). Sovereign
        // first: cloud is only used while the local backend is unhealthy, and
        // traffic routes back automatically once the probe verdict recovers.
        // ── Card ba782c14: a backend may declare itself NON-SUBSTITUTABLE ──
        //
        // The N1 gate below honours a sensitivity the CALLER declared. That
        // leaves a hole: when the caller declares nothing, requestZoneCeiling()
        // returns null and the cloud fallback is allowed. Some roles are defined
        // by a property no substitute can satisfy, and the BACKEND knows this
        // even when the caller does not.
        //
        // Measured 2026-08-16, before this flag: with qwen-vl's backend refused,
        // `model=sk-creative` returned 200 with response.model =
        // openai/gpt-oss-20b, while the router log for that same request said
        // `backend=qwen-vl model -> Qwen3.6-27b-abliterated-Q4_K_M`. The
        // abliterated role was answered by a guardrailed cloud model. That does
        // not degrade the role, it inverts it, and private prompts left the
        // fleet to do it.
        //
        // Declaring `no_failover: true` on the backend makes the request FAIL
        // with the real upstream error instead. For a capability that cannot be
        // substituted, failing loudly is the correct answer and answering
        // quietly is the harmful one. Opt-in: absent means failover is unchanged.
        const fc = getFailoverConfig();
        if (reg.noFailover) {
          console.warn(
            `[router] backend=${reg.backend} declares no_failover — NOT substituting ` +
              `with ${fc.fallbackBackend}; request will fail with the upstream error`,
          );
        }
        const fb =
          fc.enabled && !reg.noFailover && isLocalUrl(reg.url)
            ? router.getBackend(fc.fallbackBackend)
            : null;
        if (fb) {
          // Bound the local completion so a wedged upstream (accepts the socket,
          // never replies) 504s and the candidate loop fails over, instead of
          // hanging. Idempotent on the shared backend instance (configured or
          // synthetic reg: pool member).
          regBackendInstance.timeout_ms = fc.completionTimeoutMs;
          const fallbackCandidate = {
            backendId: fb.id,
            backendUrl: fb.url,
            authHeaders: await fb.buildAuthHeaders(),
            backend: fb,
            // Rewrite the outgoing model to the cloud fallback so the cloud
            // backend receives a model it actually serves (the body currently
            // carries the local concrete model, which cloud would 400 on).
            bodyOverride: rewriteBodyModel(body, fc.fallbackModel),
            isCloudFallback: true,
            model: fc.fallbackModel, // tag: model-granular throttle cooldown keying (card 9e28de88)
          };
          // ── Card 45d7a30b / N1: sovereignty gate on the cloud fallback ──
          //
          // THIS is the crossing the card exists to stop. A sovereign local
          // route (zone 0) transparently failing over to a free cloud model
          // (zone 2) is exactly what happened when sk-default's backend went
          // unreachable: the fleet kept answering, looked healthy, and had
          // quietly started sending work to a provider that trains on it.
          //
          // A caller that declared a sensitivity gets that honored here, not
          // just at rank time, because failover happens BELOW ranking and would
          // otherwise be a hole straight through the gate.
          const zc = requestZoneCeiling(request);
          const fbZone = backendTrustZone(fallbackCandidate);
          const fallbackAllowed = !zc || isZoneAllowed(fbZone, zc.ceiling);
          if (zc && !fallbackAllowed) {
            const msg =
              `[router] sensitivity=${zc.sensitivity} (ceiling zone ${zc.ceiling}) ` +
              `${isSensitivityEnforced() ? "BLOCKS" : "would block (shadow)"} ` +
              `cloud failover to ${fb.id} (zone ${fbZone})`;
            console.warn(msg);
            await emitSiem(EventType.POLICY_VIOLATION, {
              rule: "sensitivity_ceiling",
              severity: "warning",
              enforced: isSensitivityEnforced(),
              sensitivity: zc.sensitivity,
              ceiling: zc.ceiling,
              candidate_zone: fbZone,
              action: isSensitivityEnforced() ? "blocked" : "shadow",
              outcome: isSensitivityEnforced() ? "blocked" : "shadow",
            }, { backend: fb.id });
          }
          // Shadow mode logs and does nothing else, so a soak can show what
          // enforcement would change before it changes anything.
          const useFallback = fallbackAllowed || !isSensitivityEnforced();

          const healthy = await probeLocalHealth(reg.url, fc);
          if (!useFallback && !healthy) {
            // Local is down and the only alternative would cross a zone the
            // caller forbade. FAIL CLOSED. A 503 is the correct answer: the
            // request cannot be served within its own sovereignty constraint,
            // and answering it from a disallowed provider would be a silent
            // policy violation dressed up as availability.
            console.warn(
              `[router] FAIL CLOSED: local backend ${reg.backend} unhealthy and cloud ` +
                `failover forbidden by sensitivity=${zc.sensitivity}`,
            );
            return {
              status: 503,
              headers: { "content-type": "application/json" },
              body: Buffer.from(JSON.stringify({
                error: {
                  message:
                    `No model satisfies sensitivity=${zc.sensitivity} (max trust zone ${zc.ceiling}). ` +
                    `The sovereign backend is unavailable and failover would cross into zone ${fbZone}.`,
                  code: 503,
                  type: "sensitivity_no_eligible_candidate",
                  sensitivity: zc.sensitivity,
                  ceiling: zc.ceiling,
                  rejected_zone: fbZone,
                },
              }), "utf-8"),
            };
          }
          if (!useFallback) {
            // Local is healthy and cloud is forbidden: serve locally with no
            // safety net rather than a net that violates the constraint.
            candidates = [localCandidate];
          } else if (healthy) {
            // Local looks alive: try it first, cloud as a bounded safety net for
            // a mid-request hang.
            candidates = [localCandidate, fallbackCandidate];
          } else {
            // Local is unreachable/wedged: skip it entirely this window and serve
            // from cloud. Logged + audited as a failover.
            console.warn(
              `[router] local backend ${reg.backend} (${reg.url}) UNHEALTHY — ` +
              `failing over to ${fc.fallbackBackend}/${fc.fallbackModel} ` +
              `(sovereign-first, cloud-fallback)`
            );
            await emitSiem("failover", {
              from_backend: "reg:" + reg.backend,
              to_backend: fb.id,
              reason: "local_backend_unhealthy",
              fallback_model: fc.fallbackModel,
            }, { backend: fb.id });
            candidates = [fallbackCandidate];
          }
        }
      }
      // Route the resolved model through the normal metrics/health path.
      request = { ...request, model: reg.model };
      console.log(
        `[router] registry-route via=${reg.via} role=${reg.role || "-"} ` +
        `backend=${reg.backend} model→${reg.model}` +
        (reg.url ? ` url=${reg.url}` : reg.anthropic ? " (anthropic)" : "")
      );
    }
  }

  if (!candidates) {
    const configured = typeof router.getBackends === "function"
      ? [...router.getBackends().values()]
      : [];
    const claimsRequested = configured.some((backend) => backend.supportsModel?.(request.model));
    if (request.model && configured.length > 0 && !claimsRequested) {
      const awaiting = configured.find((backend) =>
        backend.mayDiscoverModel?.(request.model) &&
        (backend.discoveryStatus === "pending" || backend.discoveryStatus === "failed")
      );
      if (awaiting) {
        const result = {
          status: 503,
          headers: { "content-type": "application/json", "retry-after": "1" },
          body: Buffer.from(JSON.stringify({
            error: {
              message: `Model capability discovery is not ready: ${awaiting.id}/${request.model}`,
              code: "model_discovery_not_ready",
              type: "service_unavailable",
            },
            requested_model: requestedModel,
            backend: awaiting.id,
            readiness_revision: awaiting.readinessRevision,
            discovery_revision: awaiting.discoveryRevision,
            discovery_status: awaiting.discoveryStatus,
          }), "utf8"),
          backendId: null,
          requestedModel,
          readinessRevision: awaiting.readinessRevision,
          discoveryRevision: awaiting.discoveryRevision,
        };
        emitSiem("error", {
          status: 503,
          code: "model_discovery_not_ready",
          requested_model: requestedModel,
          candidate_backend: awaiting.id,
          readiness_revision: awaiting.readinessRevision,
          discovery_revision: awaiting.discoveryRevision,
          discovery_status: awaiting.discoveryStatus,
        }, {});
        return result;
      }
      const lifecycle = getLifecycle(request.model);
      if (!isRoutable(lifecycle)) {
        try {
          await router.route(request);
        } catch (err) {
          if (err instanceof ModelEolError) return eolGatedResponse(err);
          if (err instanceof ModelClaimQuarantinedError) return claimQuarantinedResponse(err);
          if (err instanceof ModelOwnerDownError) return ownerDownResponse(err);
          throw err;
        }
      }
      const result = {
        status: 404,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({
          error: { message: `Unknown model: ${request.model}`, code: "unknown_model", type: "invalid_request_error" },
          requested_model: requestedModel,
        }), "utf8"),
        requestedModel,
      };
      await emitSiem("response", { status: 404, code: "unknown_model", requested_model: requestedModel }, {});
      return result;
    }
    try {
      candidates = await router.route(request);
    } catch (err) {
      if (err instanceof ModelEolError) return eolGatedResponse(err);
      if (err instanceof ModelClaimQuarantinedError) return claimQuarantinedResponse(err);
      if (err instanceof ModelOwnerDownError) return ownerDownResponse(err);
      throw err;
    }
  }

  // Re-evaluate the complete candidate chain immediately before dispatch.
  // This covers registry reloads, health recovery, buckets and failover lists.
  // A single foreign-provider candidate poisons the chain rather than becoming
  // an outage fallback for a Codex-labelled request.
  codexIntent.push(request?.model, ...(candidates || []).map((candidate) => candidate?.model));
  const purityProblems = codexPurityProblems(
    codexIntent,
    (candidates || []).map((candidate) => ({ ...candidate, model: candidate?.model || request?.model })),
  );
  if (purityProblems.length) {
    const result = {
      status: 503,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({
        error: { message: 'Codex provider route unavailable', code: 'codex_provider_unavailable', type: 'service_unavailable' },
        requested_model: requestedModel,
      }), 'utf8'),
      requestedModel,
    };
    await emitSiem('error', { status: 503, code: 'codex_provider_unavailable', requested_model: requestedModel }, {});
    return result;
  }

  // ── SIEM: auth decision + route/model selected (live request path) ──
  // Emitted once, on the primary candidate, before any upstream call.
  {
    const primary = candidates[0] || {};
    const authType = primary.backend?.auth_type || "none";
    const authOk = authType === "none" ||
      (primary.authHeaders && Object.keys(primary.authHeaders).length > 0);
    await emitSiem("auth", { success: !!authOk, method: authType }, { backend: primary.backendId });
    await emitSiem("request", {
      path: upstreamPath,
      method,
      candidate_count: candidates.length,
      body_bytes: body?.length ?? 0,
    }, { backend: primary.backendId });
  }

  let lastResult = null;
  let didFailover = false;
  // Every attempt that produced an energy observation, in attempt order.
  // Reads are per attempt (spec 4.5), so writes must be too: a local metered
  // attempt that burned real joules and then failed over to cloud gets its own
  // row rather than being overwritten by the attempt that happened to win.
  // Stays empty on the disabled path, where it is never attached to a result.
  const energyAttempts = [];
  // Every candidate that ended in a throttle (429/402), whether an actual
  // upstream response or a still-cooling-down door skipped without a
  // network call (card 9e28de88 fix #3/#6). Drives the attributable-429
  // synthesis at the bottom of the loop, and is the attribution payload
  // itself: {backendId, model, status, cooldownMs, skipped?}.
  const throttledAttempts = [];

  for (let i = 0; i < candidates.length; i++) {
    const { backendId, backendUrl, authHeaders, backend } = candidates[i];
    // A candidate may carry a per-attempt body (e.g. the cloud-fallback
    // candidate rewrites the model to a cloud-served id). Default to the shared
    // body when no override is present.
    const attemptBody = candidates[i].bodyOverride || body;
    // The model THIS door actually serves. Only differs from request.model
    // for candidates that carry an explicit tag (the @match chain, card
    // 9e28de88 fix #5, and the cloud-fallback/local-registry candidates);
    // every other candidate serves the same model as every other candidate
    // in the list (candidatesFor() only ever matches on model id), so
    // request.model is the correct default.
    const candidateModel = candidates[i].model || request.model;
    const attemptTimeoutMs = isBucketChain
      ? bucketLivenessTimeoutMs(backend.timeout_ms)
      : backend.timeout_ms;

    if (i > 0) {
      didFailover = true;
      // SIEM failover event written to stdout as a JSON line
      process.stdout.write(JSON.stringify({
        ts: new Date().toISOString(),
        event: "failover",
        source: "router",
        from: candidates[i - 1].backendId,
        to: backendId,
        model: request.model,
        agentId: request.agentId,
        previousStatus: lastResult?.status,
      }) + "\n");
      console.warn(
        `[router] FAILOVER: ${candidates[i - 1].backendId} → ${backendId}` +
        ` (prev_status=${lastResult?.status})`
      );
      await emitSiem("failover", {
        from_backend: candidates[i - 1].backendId,
        to_backend: backendId,
        reason: `previous_status_${lastResult?.status ?? "error"}`,
      }, { backend: backendId });
    }

    // Model-granular throttle cooldown (card 9e28de88 fix #2): this exact
    // door threw a 429/402 for this exact model recently enough that it is
    // still cooling down. Skip it with NO network call rather than paying
    // for a near-certain repeat 429, and record the skip as an attempt for
    // the attributable-429 synthesis below.
    if (isThrottled(backendId, candidateModel)) {
      const state = _throttleCooldowns.get(throttleKey(backendId, candidateModel));
      const remainingMs = Math.max(0, (state?.untilMs ?? 0) - Date.now());
      console.warn(
        `[router] SKIP backend=${backendId} model=${candidateModel} ` +
        `still cooling down from ${state?.status} (${remainingMs}ms remaining)`
      );
      throttledAttempts.push({
        backendId, model: candidateModel, status: state?.status ?? 429,
        cooldownMs: remainingMs, skipped: true,
      });
      continue;
    }

    // Merge auth headers into a sanitized copy of client headers.
    //
    // CARD 6e61f798 / C15. The client's credential headers are stripped BEFORE
    // the backend's own auth is merged in, not after, and not by relying on the
    // merge to overwrite them.
    //
    // The old order was `{...clientHeaders}` then merge, which looks equivalent
    // and is not: `buildAuthHeaders()` returns an EMPTY object whenever a
    // backend declares `auth_type: api_key` but its `api_key_env` is unset (it
    // logs a warning and gives up). With nothing to overwrite it, the caller's
    // `authorization` header survived and was relayed verbatim to a third-party
    // provider. Reproduced live against opencode.ai: a request carrying
    // `authorization: Bearer test` came back 401 with OpenCode's own
    // `AuthError: Invalid API key`, proving OUR gateway forwarded the caller's
    // bearer. The identical request with no header returned 200.
    //
    // A caller's token authenticates them to US. It is never an upstream
    // credential, and the failure was config-triggered (an absent env var)
    // rather than request-triggered, so nothing in a request review would have
    // caught it. As capauth moves richer per-request tokens onto this path
    // (cards a150c9c0, 373a33ca), the blast radius only grows.
    //
    // Stripping first also makes the downstream Anthropic branch correct by
    // construction: it reads `forwardHeaders.authorization` to authenticate the
    // Messages API call, and that now resolves to the BACKEND's credential (the
    // oauth token for anthropic-direct) or to nothing for the local
    // claude-code-api wrapper, which is `auth_type: none` and needs none.
    const forwardHeaders = { ...clientHeaders };
    for (const h of CLIENT_CREDENTIAL_HEADERS) delete forwardHeaders[h];
    for (const [k, v] of Object.entries(authHeaders)) {
      forwardHeaders[k] = v;
    }
    // Strip headers that must not be forwarded as-is
    delete forwardHeaders.host;
    delete forwardHeaders.connection;
    delete forwardHeaders["keep-alive"];
    // Don't let the client's Accept-Encoding reach the backend: the response
    // relay strips content-encoding but forwards the (still-compressed) body, so
    // a gzip'd upstream reply reaches the client as undecodable bytes ("HTTP 400:
    // <garbage>"). Force identity so backends return uncompressed bodies.
    delete forwardHeaders["accept-encoding"];
    // Internal control headers (energy/cost attribution, agent + session
    // identity, routing hints) must never reach a third-party provider. The
    // card id was already stripped here for exactly this reason; the rest of
    // the family carries the same problem and now goes with it.
    for (const h of INTERNAL_CONTROL_HEADERS) delete forwardHeaders[h];

    const targetUrl = new URL(backendUrl);
    const queueStart = Date.now();

    // Acquire a connection pool slot (waits if at capacity)
    let slot = null;
    if (pool) {
      try {
        slot = await pool.acquire(backendId, { signal: abortSignal });
      } catch (err) {
        // A client which leaves while queued is the same neutral 499 as one
        // which leaves after dispatch: no failover and no backend-health write.
        if (err instanceof PoolAdmissionError && err.code === "client_closed") {
          const queueWaitMs = err.queueWaitMs;
          await emitSiem("response", {
            status: 499,
            latency_ms: queueWaitMs,
            queue_wait_ms: queueWaitMs,
            inflight_concurrency: err.inflightConcurrency,
            admission_outcome: err.admissionOutcome,
            backoff_classification: "cancellation",
            failover: false,
            cancelled: true,
          }, { backend: backendId });
          return {
            status: 499,
            headers: {},
            body: Buffer.from(JSON.stringify({
              error: {
                message: "downstream client disconnected",
                code: "client_closed",
              },
            })),
            backendId,
            capacityDomain: err.capacityDomain,
            queueWaitMs,
            inflightConcurrency: err.inflightConcurrency,
            admissionOutcome: err.admissionOutcome,
            backoffClassification: "cancellation",
            failover: false,
            cancelled: true,
          };
        }

        // Queue-full and queue-timeout are distinct retryable admission
        // outcomes. Neither is evidence that the model/backend is unhealthy.
        const code = err instanceof PoolAdmissionError
          ? err.code
          : "capacity_exceeded";
        const capacityDomain = err instanceof PoolAdmissionError
          ? err.capacityDomain
          : backendId;
        const retryAfterSeconds = err instanceof PoolAdmissionError
          ? err.retryAfterSeconds
          : 1;
        console.error(`[routeAndSend] pool rejected backend=${backendId}: ${err.message}`);
        await emitSiem("error", {
          type: code === "queue_timeout" ? "pool_queue_timeout" : "pool_capacity_exceeded",
          status_code: 503,
          backend: backendId,
          capacity_domain: capacityDomain,
          retry_after_seconds: retryAfterSeconds,
          message: err.message,
        }, { backend: backendId });
        const queueWaitMs = err instanceof PoolAdmissionError
          ? err.queueWaitMs
          : Math.max(0, Date.now() - queueStart);
        const inflightConcurrency = err instanceof PoolAdmissionError
          ? err.inflightConcurrency
          : 0;
        const admissionOutcome = err instanceof PoolAdmissionError
          ? err.admissionOutcome
          : "denied";
        const backoffClassification = code === "queue_timeout"
          ? "timeout"
          : "local_admission_denial";
        await emitSiem("response", {
          status: 503,
          latency_ms: queueWaitMs,
          queue_wait_ms: queueWaitMs,
          inflight_concurrency: inflightConcurrency,
          admission_outcome: admissionOutcome,
          backoff_classification: backoffClassification,
          retry_after_seconds: retryAfterSeconds,
          failover: false,
          admission_rejected: true,
          code,
          capacity_domain: capacityDomain,
        }, { backend: backendId });
        return {
          status: 503,
          headers: {
            "content-type": "application/json",
            "retry-after": String(retryAfterSeconds),
          },
          body: Buffer.from(JSON.stringify({
            error: {
              message: code === "queue_timeout"
                ? `Capacity domain ${capacityDomain} queue wait timed out.`
                : `Capacity domain ${capacityDomain} queue is full.`,
              code,
              backend: backendId,
              capacity_domain: capacityDomain,
              retryable: true,
              retry_after_seconds: retryAfterSeconds,
            }
          })),
          backendId,
          capacityDomain,
          queueWaitMs,
          inflightConcurrency,
          admissionOutcome,
          backoffClassification,
          retryAfterSeconds,
          failover: didFailover,
        };
      }
    }

    // Pool tickets carry the admission snapshot. This avoids sampling after a
    // concurrent release or promotion and bounds queue wait to the configured
    // queue SLA. The no-pool path remains an admitted, zero-wait attempt.
    const queueWaitMs = slot?.queueWaitMs ?? 0;
    const inflightConcurrency = slot?.inflightConcurrency ?? 1;
    const admissionOutcome = slot?.admissionOutcome ?? "admitted";

    // Meter read is per attempt, not per request: a failover attempt must be
    // attributed to the backend that actually served it. Fail-open, so a slow
    // or dead meter costs a null reading and nothing else. When energy
    // metering is disabled (default) meterUrl stays null and readMeter is
    // never called: no network call, no extra latency on the disabled path.
    // resolveMeterUrl, not a bare meters[backendId] lookup: registry routing
    // (the main path, sk-default included) hands out synthetic "reg:*" ids,
    // and spec 4.5 promises a URL-host fallback for backends that carry no
    // node identity of their own. An exact-id-only lookup silently imputes
    // the exact traffic this component was built to measure.
    const meterUrl = energyCfg?.enabled
      ? resolveMeterUrl(energyCfg.meters, backendId, backendUrl)
      : null;
    const meterBeforeStart = meterUrl ? Date.now() : 0;
    const meterBefore = meterUrl
      ? await readMeter(meterUrl, energyCfg.read_timeout_ms ?? 250)
      : null;
    // Wall-clock time this attempt's pre-read consumed. Subtracted out of
    // latencyMs below so up to read_timeout_ms of meter round-trip never
    // bleeds into backend.recordOutcome()/the dashboard's latencyP50: the
    // instrument added to make energy telemetry trustworthy must not corrupt
    // the latency telemetry sitting right next to it. Zero (no-op) whenever
    // metering is disabled or this backend has no configured meter, so
    // latencyMs stays exactly Date.now() - queueStart as before, byte for
    // byte, on the disabled path. queueWaitMs (pool wait) is untouched, it
    // was already snapshotted above before this read ran, and stays folded
    // into latencyMs exactly as it always was.
    const meterBeforeMs = meterUrl ? (Date.now() - meterBeforeStart) : 0;

    let res;
    // Captured inside try/catch, after sendUpstream resolves (or throws) and
    // before finally runs exitMeter. Ruling R19: reading the in-flight count
    // after exitMeter has already removed this attempt from the set means
    // two genuinely overlapping attempts would both read back 1, which is
    // worse than not recording the field at all (a false "clean" reading).
    // Capturing it here, while this attempt is still counted, is what lets
    // the field actually show 2+ when there is real overlap.
    let attemptConcurrency = null;
    // Track in-flight attempts against this meter so the energy row can
    // record whether the measurement window was single-tenant (spec 4.6).
    // No-op when meterUrl is null (energy metering disabled or no meter
    // configured for this backend): the disabled path stays byte-identical.
    enterMeter(meterUrl);
    try {
      if (isAnthropicBackend(backend)) {
        // Translate OpenAI chat-completions → Anthropic Messages API.
        const tr = toAnthropicRequest(attemptBody, {
          authorization: forwardHeaders.authorization,
        });
        if (tr) {
          const aHeaders = { ...forwardHeaders, ...tr.headers };
          delete aHeaders["content-length"];
          const raw = await sendUpstream(tr.path, method, aHeaders, tr.body, targetUrl, attemptTimeoutMs, abortSignal);
          if (raw?.cancelled) {
            res = raw;
          } else {
            if (raw && raw.status >= 400) {
              let d = "";
              try { d = raw.body?.toString("utf-8").slice(0, 600); } catch { /* ignore */ }
              const reqTokens = (() => { try { return JSON.parse(tr.body.toString("utf-8")).max_tokens; } catch { return "?"; } })();
              console.warn(`[router] anthropic ${raw.status} err (sent max_tokens=${reqTokens}): ${d}`);
            }
            res = toOpenAIResponse(raw, request.model);
          }
        } else {
          res = await sendUpstream(upstreamPath, method, forwardHeaders, attemptBody, targetUrl, attemptTimeoutMs, abortSignal);
        }
      } else if (isCodexBackend(backend)) {
        // Translate OpenAI chat-completions -> Codex Responses API (OpenAI
        // *subscription* inference; see codex-adapter.mjs). Same contract as
        // the Anthropic branch above: a translatable body is converted and the
        // buffered upstream SSE answer converted back (to SSE for the client
        // when the client asked stream:true); anything else passes through.
        const tr = toCodexRequest(attemptBody);
        if (tr) {
          if (tr.dropped.length) {
            console.warn(
              `[router] codex ${backendId}: dropped unsupported params [${tr.dropped.join(",")}] ` +
                `for model=${candidateModel}`,
            );
          }
          const cHeaders = { ...forwardHeaders, ...tr.headers };
          delete cHeaders["content-length"];
          const raw = await sendUpstream(tr.path, method, cHeaders, tr.body, targetUrl, attemptTimeoutMs, abortSignal);
          res = raw?.cancelled ? raw : fromCodexResponse(raw, candidateModel, tr.clientStream);
        } else {
          res = await sendUpstream(upstreamPath, method, forwardHeaders, attemptBody, targetUrl, attemptTimeoutMs, abortSignal);
        }
      } else if (isCodexBackend(backend)) {
        // Translate OpenAI chat-completions -> Codex Responses API (OpenAI
        // *subscription* inference; see codex-adapter.mjs). Same contract as
        // the Anthropic branch above: a translatable body is converted and the
        // buffered upstream SSE answer converted back (to SSE for the client
        // when the client asked stream:true); anything else passes through.
        const tr = toCodexRequest(attemptBody);
        if (tr) {
          if (tr.dropped.length) {
            console.warn(
              `[router] codex ${backendId}: dropped unsupported params [${tr.dropped.join(",")}] ` +
                `for model=${candidateModel}`,
            );
          }
          const cHeaders = { ...forwardHeaders, ...tr.headers };
          delete cHeaders["content-length"];
          const raw = await sendUpstream(tr.path, method, cHeaders, tr.body, targetUrl, backend.timeout_ms, abortSignal);
          res = raw?.cancelled ? raw : fromCodexResponse(raw, candidateModel, tr.clientStream);
        } else {
          res = await sendUpstream(upstreamPath, method, forwardHeaders, attemptBody, targetUrl, backend.timeout_ms, abortSignal);
        }
      } else {
        res = await sendUpstream(upstreamPath, method, forwardHeaders, attemptBody, targetUrl, attemptTimeoutMs, abortSignal);
      }
      attemptConcurrency = meterUrl ? inFlightOnMeter(meterUrl) : 1;
    } catch (err) {
      // sendUpstream resolves with 502 on network error, but be defensive
      res = {
        status: 502,
        headers: {},
        body: Buffer.from(JSON.stringify({ error: { message: err.message } })),
      };
      attemptConcurrency = meterUrl ? inFlightOnMeter(meterUrl) : 1;
    } finally {
      // Always release the slot, even on error
      if (pool && slot) {
        pool.release(slot);
      }
      // Pair every enterMeter with an exit here, even on a thrown upstream,
      // so the in-flight count can never leak and drift upward. This runs
      // after attemptConcurrency has already been captured above, so the
      // leak-proofing and the read no longer share a moment in time.
      exitMeter(meterUrl);
    }

    res = enforceResponseContract(res, requestedModel);
    const latencyMs = (Date.now() - queueStart) - meterBeforeMs;

    // A downstream disconnect is not evidence about the backend or model.
    // Return immediately after releasing the pool/meter slot in `finally`,
    // before energy reads, health/lifecycle writes, or failover can run.
    if (res?.cancelled || res?.status === 499) {
      lastResult = {
        ...res,
        backendId,
        servedModel: candidateModel,
        failover: didFailover,
        queueWaitMs,
        inflightConcurrency,
        admissionOutcome: "cancelled",
        backoffClassification: "cancellation",
        firstByteMs: Number.isFinite(res?.firstByteMs) ? queueWaitMs + res.firstByteMs : null,
        cancelled: true,
      };
      if (isBucketChain) {
        lastResult.bucket = bucketAddr.bucket;
        lastResult.bucketMember = candidateModel;
      }
      await emitSiem("response", {
        status: 499,
        latency_ms: latencyMs,
        queue_wait_ms: queueWaitMs,
        inflight_concurrency: inflightConcurrency,
        admission_outcome: "cancelled",
        backoff_classification: "cancellation",
        failover: false,
        cancelled: true,
      }, { backend: backendId });
      return lastResult;
    }

    // Second meter read + energy accounting for this attempt, gated the same
    // way as the pre-read above: when energy metering is disabled the whole
    // block is skipped (attemptEnergy stays null), so lastResult.energy below
    // is never set and index.mjs never calls recordEnergy. Zero behavior
    // change on the disabled path.
    let attemptEnergy = null;
    if (energyCfg?.enabled) {
      const meterAfter = meterUrl
        ? await readMeter(meterUrl, energyCfg.read_timeout_ms ?? 250)
        : null;

      const measured = marginalJoules(meterBefore, meterAfter);
      let joules = measured;
      const basis = resolveBasis({
        metered: measured !== null,
        backendIsLocal: backendIsLocal(backendId, backendUrl, energyCfg?.locality, isLocalUrl),
      });
      if (measured === null) {
        // extractUsage() JSON.parses the body and returns {} for a streamed
        // (SSE) body, so tokens_out is always absent there. Fall back to the
        // SSE scanner in that case rather than imputing on undefined tokens.
        const usage = extractUsage(res.body);
        const sse = (usage.tokens_out === undefined) ? usageFromSSE(res.body) : null;
        joules = imputeJoules(
          sse ?? { input_tokens: usage.tokens_in, output_tokens: usage.tokens_out },
          coeffsForModel(request.model ?? "", energyCfg?.coefficients ?? {}),
        );
      }
      attemptEnergy = {
        joules,
        basis,
        node: meterAfter?.node ?? null,
        concurrencyN: attemptConcurrency ?? 1,
        // Which backend burned it. lastResult.backendId only ever names the
        // final attempt, so without this an earlier attempt's row would be
        // filed under the backend that served the retry.
        backendId,
      };
      energyAttempts.push(attemptEnergy);
    }

    // `healthy` drives every BACKEND-health side effect below (quarantine,
    // local-health, the error-rate window inside recordOutcome itself) and
    // is deliberately unchanged from the original `success = res.status <
    // 500`: a 429/402 is not evidence the backend is broken (card 9e28de88
    // fix #4). `retryElsewhere`/`throttled` (below, after these health
    // writes) is the SEPARATE routing decision of whether to keep this
    // response or try the next door; splitting the two is the whole point
    // of this card, so a throttled model can fail over WITHOUT damaging
    // backend health or lifecycle state.
    const healthy = res.status < 500;
    const qTransition = backend.recordOutcome(healthy, latencyMs);
    const claimTransition = backend.recordModelClaimOutcome(candidateModel, res.status);
    if (claimTransition) {
      const quarantined = claimTransition.transition === "quarantined";
      process.stdout.write(JSON.stringify({
        ts: new Date().toISOString(),
        event: quarantined ? "model_claim_quarantined" : "model_claim_readmitted",
        source: "router",
        backend: backendId,
        model: candidateModel,
        status: res.status,
        consecutive_failures: claimTransition.failures,
      }) + "\n");
    }

    // Model-granular lifecycle bookkeeping (card P1.2, section 4.2 of the
    // model-ranking design doc): record this concrete model's completion
    // status as the passive signal for the EOL state machine (a 404/410
    // counts toward eol, a 2xx resets toward active). This is purely a
    // bookkeeping side effect on a fail-soft store, it does NOT change the
    // `healthy` failover decision above (the shipped 410->backend_error
    // stopgap already makes 410 fail over). applyCompletionOutcome()
    // (src/discovery/lifecycle.mjs) already ignores any status that is not
    // 2xx/404/410, so a 429 or 402 here is a verified no-op for eol
    // bookkeeping (card C12 covers this; card 9e28de88 fix #4 re-verifies
    // it rather than duplicating the gate here).
    // Claimer-aware EOL bookkeeping (incident inc-2026-08-18-qwen38-eol / 
    // problem prob-2026-08-18-model-discovery-validation): a 404/410 from a
    // backend that does NOT claim this model is evidence about that backend's
    // catalog, not about the model — the model may be served fine by a backend
    // that does claim it (the qwen38 false positive: nvidia 404'd
    // `qwen38-abliterated` while chiap08's llama.cpp served it name-
    // agnostically, and the 404s still accumulated to an EOL record). 
    // recordModelOutcome() skips such permanent errors when `claiming` is 
    // false; a 2xx always counts (a success is a success from any door). When
    // NO backend claims the id, every door's 404 is the best evidence 
    // available and counts, exactly as before (card P1.6's spray-avoidance 
    // for unclaimed ids is preserved).
    const claimsHere = candidateModel && typeof backend.supportsModel === "function"
      ? backend.supportsModel(candidateModel)
      : false;
    const anyClaimer = typeof router.getBackends === "function" && candidateModel
      ? router.getBackends().some(
          (b) => typeof b.supportsModel === "function" && b.supportsModel(candidateModel)
        )
      : false;
    recordModelOutcome(candidateModel, { status: res.status, now: Date.now(), claiming: claimsHere || !anyClaimer });

    // Feed the real completion outcome back into the local-health verdict so a
    // wedged local backend that got past the probe but then hung/errored is
    // marked unhealthy immediately (subsequent requests skip it), and a healthy
    // completion keeps it live — faster convergence than the probe TTL alone.
    if (candidates[i].localUrl) recordLocalOutcome(candidates[i].localUrl, healthy);

    // Dead-alias auto-quarantine transitions (card 2d1f3a2c). Mirror the
    // failover pattern: a stdout JSON line (always) plus a structured SIEM
    // event via the shared fail-closed emitter. Quarantine removes the alias
    // from rotation; re-admit returns it once a probe succeeds.
    if (qTransition) {
      const isQ = qTransition.transition === "quarantined";
      process.stdout.write(JSON.stringify({
        ts: new Date().toISOString(),
        event: isQ ? "backend_quarantined" : "backend_readmitted",
        source: "router",
        backend: backendId,
        model: request.model,
        consecutive_failures: qTransition.consecutiveFailures,
        threshold: qTransition.threshold,
      }) + "\n");
      await emitSiem("anomaly", {
        type: isQ ? "backend_quarantine" : "backend_recovery",
        backend: backendId,
        consecutive_failures: qTransition.consecutiveFailures,
        threshold: qTransition.threshold,
      }, {
        backend: backendId,
        severity: isQ ? "warning" : "info",
      });
    }

    // servedModel: the model THIS door actually served, which is not always
    // request.model (the @match chain, the cloud-fallback candidate and the
    // registry candidates all rewrite it). Card 3351d25b / A6.2 returns it to
    // the caller as x-sk-model-served, and a caller that asked for "sk-default"
    // and was served "qwen3-38b" needs the served id, not the alias it typed.
    // Set from the attempt that is about to be returned, so on a failover it
    // names the SERVING attempt and never a blend across attempts, which is
    // the same ruling the energy headers already follow.
    lastResult = {
      ...res,
      backendId,
      readinessRevision: backend.readinessRevision,
      discoveryRevision: backend.discoveryRevision,
      failover: didFailover,
      queueWaitMs,
      inflightConcurrency,
      admissionOutcome,
      backoffClassification: "nonterminal",
      firstByteMs: Number.isFinite(res?.firstByteMs) ? queueWaitMs + res.firstByteMs : null,
    };
    if (isBucketChain) {
      lastResult.bucket = bucketAddr.bucket;
      lastResult.bucketMember = candidateModel;
    }
    if (attemptEnergy) lastResult.energy = attemptEnergy;
    // Only attached when something was actually observed, so the disabled
    // path returns a result whose shape is unchanged, field for field.
    if (energyAttempts.length > 0) lastResult.energyAttempts = energyAttempts;

    // Card 9e28de88 fix #1: 429/402 join >=500 as failover-worthy, so a
    // throttled door advances the loop instead of being handed back to the
    // caller. `healthy` above already kept backend health/lifecycle out of
    // this decision entirely.
    const retryElsewhere = isFailoverStatus(res.status) ||
      (isBucketChain && (res.status === 404 || res.status === 410));
    const throttled = isThrottleStatus(res.status);

    if (!retryElsewhere) {
      console.log(
        `[router] ${res.status} OK backend=${backendId} latency=${latencyMs}ms` +
        (didFailover ? " (failover)" : "") +
        (queueWaitMs > 0 ? ` queued=${queueWaitMs}ms` : "" )
      );
      // 4xx are "success" for failover purposes (no retry) but are client/payload
      // errors the operator needs to see — surface the upstream body so
      // "check gateway logs" is actually actionable.
      if (res.status >= 400) {
        let detail = "";
        try { detail = res.body?.toString("utf-8").slice(0, 500); } catch { /* ignore */ }
        console.warn(`[router] ${res.status} upstream_error backend=${backendId} body=${detail}`);
        // 4xx are non-retryable but are client/payload errors the SOC needs.
        await emitSiem("error", {
          type: "upstream_client_error",
          status_code: res.status,
          backend: backendId,
        }, { backend: backendId });
      }
      // Completion — status + latency + best-effort token usage.
      await emitSiem("response", {
        status: res.status,
        latency_ms: latencyMs,
        queue_wait_ms: queueWaitMs,
        inflight_concurrency: inflightConcurrency,
        admission_outcome: admissionOutcome,
        backoff_classification: "nonterminal",
        failover: didFailover,
        requested_model: lastResult.requestedModel,
        chosen_backend: backendId,
        served_model: lastResult.servedModel,
        readiness_revision: lastResult.readinessRevision,
        discovery_revision: lastResult.discoveryRevision,
        ...extractUsage(res.body),
      }, { backend: backendId });
      return lastResult;
    }

    if (throttled) {
      // Card 9e28de88 fix #2/#6: arm the model-granular cooldown (Retry-After
      // when the upstream sent one, else a status-specific default) and
      // record the observation for attribution/future ranking use, on the
      // SAME map, not a parallel scoreboard.
      const retryAfterHeader = res.headers?.["retry-after"] ?? res.headers?.["Retry-After"];
      const { cooldownMs } = recordThrottle(backendId, candidateModel, res.status, retryAfterHeader);
      throttledAttempts.push({ backendId, model: candidateModel, status: res.status, cooldownMs });
      console.warn(
        `[router] ${res.status} THROTTLED backend=${backendId} model=${candidateModel} ` +
        `cooldown=${cooldownMs}ms` +
        (i < candidates.length - 1 ? " (trying next door)" : " (no more candidates)")
      );
      lastResult.backoffClassification = res.status === 429
        ? "provider_429"
        : "provider_backoff";
      lastResult.retryAfterMs = cooldownMs;
      await emitSiem("anomaly", {
        type: "rate_limited",
        backend: backendId,
        status_code: res.status,
        queue_wait_ms: queueWaitMs,
        inflight_concurrency: inflightConcurrency,
        admission_outcome: admissionOutcome,
        backoff_classification: lastResult.backoffClassification,
        cooldown_ms: cooldownMs,
      }, { backend: backendId, severity: "info" });
      continue;
    }

    console.warn(
      `[router] ${res.status} ERROR backend=${backendId} latency=${latencyMs}ms` +
      (i < candidates.length - 1 ? " — trying next backend" : " — no more backends")
    );
    // Retryable upstream failure (>=500) — one error event per failed attempt.
    await emitSiem("error", {
      type: "upstream_error",
      status_code: res.status,
      backend: backendId,
      retry_count: i,
    }, { backend: backendId });
  }

  // Card 9e28de88 fix #3: every candidate ended in a throttle, whether a
  // real upstream 429/402 or a still-cooling-down door skipped without a
  // network call. Relaying `lastResult` here would either hand back one
  // arbitrary door's raw, unattributed 429 body, or (if EVERY door was
  // skipped via cooldown, so no upstream call ever happened) return null.
  // Neither tells the caller or the SOC which models/providers were tried.
  // Build one attributable 429 instead.
  if (candidates.length > 0 && throttledAttempts.length === candidates.length) {
    const waitsMs = throttledAttempts.map((t) => t.cooldownMs ?? DEFAULT_429_COOLDOWN_MS);
    const retryAfterSec = Math.max(1, Math.ceil(Math.min(...waitsMs) / 1000));

    // Card e7c2b4a9 repair #1: derive final backoff classification from attempts.
    // If ALL throttled attempts are 402, preserve provider_backoff. Only if
    // ANY attempt was a 429 should we classify as provider_429.
    const all402 = throttledAttempts.every((t) => t.status === 402);
    const backoffClassification = all402 ? "provider_backoff" : "provider_429";

    // Card e7c2b4a9 repair #2: detect cooldown-only rejections (no admission occurred).
    // When ALL doors were skipped via cooldown, lastResult is null and no pool
    // admission ever happened. Report a truthful no-admission outcome rather
    // than defaulting to "admitted" with zero inflight concurrency.
    const allSkipped = throttledAttempts.every((t) => t.skipped);
    const admissionOutcome = allSkipped ? "denied" : (lastResult?.admissionOutcome ?? "admitted");
    const inflightConcurrency = allSkipped ? 0 : (lastResult?.inflightConcurrency ?? 0);
    const queueWaitMs = lastResult?.queueWaitMs ?? 0;
    const backendId = lastResult?.backendId ?? null;

    const payload = JSON.stringify({
      error: {
        message: "All candidate models are currently rate limited",
        code: 429,
        type: "rate_limited_all_candidates",
      },
      attempted: throttledAttempts,
    });
    console.warn(
      `[router] 429 ALL CANDIDATES THROTTLED model=${request.model} ` +
      `tried=[${throttledAttempts.map((t) => `${t.backendId}/${t.model}`).join(", ")}]` +
      (allSkipped ? " (all doors cooling, no admission)" : "")
    );
    await emitSiem("response", {
      status: 429,
      queue_wait_ms: queueWaitMs,
      inflight_concurrency: inflightConcurrency,
      admission_outcome: admissionOutcome,
      backoff_classification: backoffClassification,
      retry_after_seconds: retryAfterSec,
      failover: didFailover,
      all_backends_failed: true,
      all_throttled: true,
    }, { backend: backendId });
    return {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(retryAfterSec) },
      body: Buffer.from(payload, "utf-8"),
      backendId,
      queueWaitMs,
      inflightConcurrency,
      admissionOutcome,
      backoffClassification,
      retryAfterSeconds: retryAfterSec,
      failover: didFailover,
    };
  }

  // All backends failed for some other (non-throttle) reason: return the
  // last response so the caller can relay the error.
  await emitSiem("response", {
    status: lastResult?.status ?? 502,
    failover: didFailover,
    all_backends_failed: true,
  }, { backend: lastResult?.backendId });
  return lastResult;
}
