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
import { sendUpstream } from "./upstream.mjs";
import { createEvent } from "../siem/events.mjs";
import { isAnthropicBackend, toAnthropicRequest, toOpenAIResponse } from "./anthropic-adapter.mjs";
import { getPool } from "./connection-pool.mjs";
import { isRegistryRouted, resolve as resolveRegistry, getAutoConfig, getConfigEpoch, loadRegistry } from "./registry.mjs";
import { getFailoverConfig, isLocalUrl, probeLocalHealth, recordLocalOutcome } from "./local-failover.mjs";
import { readMeter } from "./meter-client.mjs";
import { marginalJoules, imputeJoules, resolveBasis, coeffsForModel, usageFromSSE, resolveMeterUrl } from "../metrics/energy.mjs";
import { recordModelOutcome, getLifecycle } from "../discovery/model_catalog_store.mjs";
import { isRoutable } from "../discovery/lifecycle.mjs";
import { applyReasoningFloor } from "./core.mjs";
import { createDecisionCache, decisionKey } from "./decision-cache.mjs";
// card P4.2 (@match routing): reuse the existing ranker + capability deriver
// + discovery cache reader + allowlist/availability checks as-is, no
// reimplementation. getConfig() gates the whole branch behind
// routing.match_enabled (config.mjs, unmodified: the DEFAULTS already carry
// a `routing:` block, card P4.4 adds match_enabled to it later).
import { getConfig } from "../config.mjs";
import { loadCache as loadDiscoveryCache } from "../discovery.mjs";
import { rankModels } from "../ranking/rank.mjs";
import { buildCapabilityCatalog } from "../ranking/catalog.mjs";
import { loadAllowlist } from "../advertise.mjs";
import { isModelAvailable } from "./advertise.mjs";

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
 *
 * @typedef {Object} HealthSnapshot
 * @property {'up'|'degraded'|'down'} status
 * @property {number}   errorRate     0–1 float
 * @property {number}   latencyP50    ms (median of recent requests)
 * @property {number}   lastCheck     epoch ms of last successful or failed request
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
    this.models = Array.isArray(config.models) ? config.models : [];
    // Marks a discovery-driven backend (e.g. openrouter, see config.mjs
    // backends.*.discovery). Its `models` array starts empty and is populated
    // at runtime by registerDiscoveredRoutes() once a discovery fetch
    // succeeds. See supportsModel(): an empty list on a discovery backend must
    // NOT wildcard-match, unlike an ordinary statically-configured backend.
    this.discovery = config.discovery || null;
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

    // Auth credentials
    this._api_key = config.api_key || null;
    this._api_key_env = config.api_key_env || null;
    this._credentials_file = config.credentials_file || null;

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
   * @returns {HealthSnapshot}
   */
  getHealth() {
    return {
      status: this._status,
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
          console.warn(`[router] backend=${this.id} auth_type=${this.auth_type} but no key found`);
          return {};
        }
        return { authorization: `Bearer ${key}` };
      }

      case "oauth": {
        const token = await this._getOAuthToken();
        if (!token) return {};
        return { authorization: `Bearer ${token}` };
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
   * @param {string|undefined} model
   * @param {string|undefined} agentId
   * @returns {Backend[]}
   */
  function candidatesFor(model, agentId) {
    const available = availableByPriority().filter((b) => b.allowsAgent(agentId));

    if (!model) return available;

    // Exact or glob match first
    const matched = available.filter((b) => b.supportsModel(model));

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
      if (!isRoutable(lcMatched)) {
        const gated = [];
        gated.eolGated = true;
        gated.eolReason = lcMatched.eol_reason;
        return gated;
      }
      return matched;
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

    const candidates = candidatesFor(model, agentId);

    if (candidates.eolGated) {
      siemEvent("model_eol_gated", { model, agentId, eol_reason: candidates.eolReason });
      throw new ModelEolError(model, candidates.eolReason);
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
   * Return a snapshot of every backend's health.
   *
   * @returns {Record<string, HealthSnapshot>}
   */
  function getHealth() {
    const out = {};
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

  return { route, getHealth, addBackend, removeBackend, getBackend, resolveAgentTarget };
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
 * lifecycle:{state}, capabilities}`) straight off the on-disk discovery
 * cache (the same file discovery.mjs's refresh cycle writes), so the router
 * never depends on index.mjs's in-memory catalog or triggers a network
 * fetch. The id-to-capabilities mapping itself is NOT reimplemented here
 * (card C7): it delegates to `buildCapabilityCatalog()`
 * (../ranking/catalog.mjs), the same function index.mjs's `buildRankCatalog()`
 * (card P3.3, the /admin/models/rank suggest-only API) delegates to, so this
 * live routing path and the admin explain-tool can never again silently
 * diverge on how a metrics snapshot (or its absence) feeds capability
 * derivation. Before this card, this function hardcoded
 * `deriveCapabilities(entry, { metrics: {} })` inline, a second, uninjectable
 * copy of what buildRankCatalog already did with an injectable
 * `opts.metricsFn`. Never throws: a missing/unreadable cache file yields an
 * empty catalog.
 *
 * @returns {Array<object>}
 */
function buildMatchCatalog() {
  let cache;
  try {
    cache = loadDiscoveryCache(MATCH_CATALOG_CACHE_PATH);
  } catch {
    cache = {};
  }
  const models = Array.isArray(cache && cache.models) ? cache.models : [];
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
 * @param {?function(object): void} [siem=null]
 *   Optional best-effort SIEM hook. Called with a fully-structured
 *   {@link module:siem/events.GatewayEvent} at each request lifecycle point
 *   (auth decision, route/model selected, upstream error, failover, and
 *   completion with status/latency/tokens). The hook MUST NEVER block or throw
 *   into the hot path — invocations are guarded and any error is swallowed.
 * @returns {Promise<{
 *   status: number,
 *   headers: Record<string, string>,
 *   body: Buffer,
 *   backendId: string,
 *   failover: boolean,
 *   queueWaitMs?: number,
 * }>}
 */
export async function routeAndSend(router, request, upstreamPath, method, clientHeaders, body, usePool = true, siem = null) {
  const pool = usePool ? getPool() : null;

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
  // The hook is best-effort: guarded (typeof check) and fully swallowed so a
  // throwing or slow consumer can never break or delay routing.
  const _siemRequestId = randomUUID();
  const emitSiem = (type, details = {}, ctx = {}) => {
    if (typeof siem !== "function") return;
    try {
      siem(createEvent(type, details, {
        request_id: _siemRequestId,
        ...(request?.agentId ? { agent_id: request.agentId } : {}),
        ...(request?.model   ? { model:    request.model }   : {}),
        ...ctx,
      }));
    } catch {
      // SIEM must never break routing.
    }
  };

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
  if (isRegistryRouted(request)) {
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
          throw err;
        }
        if (!candidates || candidates.length === 0) {
          console.warn("[router] registry resolved to anthropic but no anthropic backend configured");
        }
      } else {
        // External llama backend (ornith .100:8082 / qwen-vl chiap08:11436, …).
        // Kept in an ISOLATED pool so it never joins normal model-name routing
        // (would otherwise shadow concrete-model backends via wildcard match).
        const b = getRegBackend("reg:" + reg.backend, reg.url);
        const localCandidate = {
          backendId: b.id,
          backendUrl: b.url,
          authHeaders: {},
          backend: b,
          localUrl: reg.url, // tag: record the health outcome of this attempt
          model: reg.model, // tag: model-granular throttle cooldown keying (card 9e28de88)
        };
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
        const fc = getFailoverConfig();
        const fb = fc.enabled && isLocalUrl(reg.url) ? router.getBackend(fc.fallbackBackend) : null;
        if (fb) {
          // Bound the local completion so a wedged upstream (accepts the socket,
          // never replies) 504s and the candidate loop fails over, instead of
          // hanging. Idempotent on the shared reg backend instance.
          b.timeout_ms = fc.completionTimeoutMs;
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
          const healthy = await probeLocalHealth(reg.url, fc);
          if (healthy) {
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
            emitSiem("failover", {
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
    try {
      candidates = await router.route(request);
    } catch (err) {
      if (err instanceof ModelEolError) return eolGatedResponse(err);
      throw err;
    }
  }

  // ── SIEM: auth decision + route/model selected (live request path) ──
  // Emitted once, on the primary candidate, before any upstream call.
  {
    const primary = candidates[0] || {};
    const authType = primary.backend?.auth_type || "none";
    const authOk = authType === "none" ||
      (primary.authHeaders && Object.keys(primary.authHeaders).length > 0);
    emitSiem("auth", { success: !!authOk, method: authType }, { backend: primary.backendId });
    emitSiem("request", {
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
      emitSiem("failover", {
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

    // Merge auth headers into a sanitized copy of client headers
    const forwardHeaders = { ...clientHeaders };
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
    // Internal card id (energy/cost attribution) must never reach a
    // third-party provider (NVIDIA, OpenRouter, etc).
    delete forwardHeaders["x-sk-card-id"];

    const targetUrl = new URL(backendUrl);
    const queueStart = Date.now();

    // Acquire a connection pool slot (waits if at capacity)
    let slot = null;
    if (pool) {
      try {
        slot = await pool.acquire(backendId);
      } catch (err) {
        // Pool rejected (queue full) — log and fall back to serving a 503
        console.error(`[routeAndSend] pool rejected backend=${backendId}: ${err.message}`);
        emitSiem("error", {
          type: "pool_capacity_exceeded",
          status_code: 503,
          backend: backendId,
          message: err.message,
        }, { backend: backendId });
        return {
          status: 503,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({
            error: {
              message: `Backend ${backendId} is at capacity. Queue full.`,
              code: "capacity_exceeded",
              backend: backendId,
            }
          })),
          backendId,
          failover: didFailover,
        };
      }
    }

    const queueWaitMs = Date.now() - queueStart;

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
          const raw = await sendUpstream(tr.path, method, aHeaders, tr.body, targetUrl, backend.timeout_ms);
          if (raw && raw.status >= 400) {
            let d = "";
            try { d = raw.body?.toString("utf-8").slice(0, 600); } catch { /* ignore */ }
            const reqTokens = (() => { try { return JSON.parse(tr.body.toString("utf-8")).max_tokens; } catch { return "?"; } })();
            console.warn(`[router] anthropic ${raw.status} err (sent max_tokens=${reqTokens}): ${d}`);
          }
          res = toOpenAIResponse(raw, request.model);
        } else {
          res = await sendUpstream(upstreamPath, method, forwardHeaders, attemptBody, targetUrl, backend.timeout_ms);
        }
      } else {
        res = await sendUpstream(upstreamPath, method, forwardHeaders, attemptBody, targetUrl, backend.timeout_ms);
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
        pool.release(backendId);
      }
      // Pair every enterMeter with an exit here, even on a thrown upstream,
      // so the in-flight count can never leak and drift upward. This runs
      // after attemptConcurrency has already been captured above, so the
      // leak-proofing and the read no longer share a moment in time.
      exitMeter(meterUrl);
    }

    const latencyMs = (Date.now() - queueStart) - meterBeforeMs;

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
      const basis = resolveBasis({ metered: measured !== null, backendIsLocal: isLocalUrl(backendUrl) });
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
    recordModelOutcome(request.model, { status: res.status, now: Date.now() });

    // Feed the real completion outcome back into the local-health verdict so a
    // wedged local backend that got past the probe but then hung/errored is
    // marked unhealthy immediately (subsequent requests skip it), and a healthy
    // completion keeps it live — faster convergence than the probe TTL alone.
    if (candidates[i].localUrl) recordLocalOutcome(candidates[i].localUrl, healthy);

    // Dead-alias auto-quarantine transitions (card 2d1f3a2c). Mirror the
    // failover pattern: a stdout JSON line (always) plus a structured SIEM
    // event via the shared emitter (best-effort). Quarantine removes the alias
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
      emitSiem("anomaly", {
        type: isQ ? "backend_quarantine" : "backend_recovery",
        backend: backendId,
        consecutive_failures: qTransition.consecutiveFailures,
        threshold: qTransition.threshold,
      }, {
        backend: backendId,
        severity: isQ ? "warning" : "info",
      });
    }

    lastResult = { ...res, backendId, failover: didFailover, queueWaitMs };
    if (attemptEnergy) lastResult.energy = attemptEnergy;
    // Only attached when something was actually observed, so the disabled
    // path returns a result whose shape is unchanged, field for field.
    if (energyAttempts.length > 0) lastResult.energyAttempts = energyAttempts;

    // Card 9e28de88 fix #1: 429/402 join >=500 as failover-worthy, so a
    // throttled door advances the loop instead of being handed back to the
    // caller. `healthy` above already kept backend health/lifecycle out of
    // this decision entirely.
    const retryElsewhere = isFailoverStatus(res.status);
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
        emitSiem("error", {
          type: "upstream_client_error",
          status_code: res.status,
          backend: backendId,
        }, { backend: backendId });
      }
      // Completion — status + latency + best-effort token usage.
      emitSiem("response", {
        status: res.status,
        latency_ms: latencyMs,
        queue_wait_ms: queueWaitMs,
        failover: didFailover,
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
      emitSiem("anomaly", {
        type: "rate_limited",
        backend: backendId,
        status_code: res.status,
        cooldown_ms: cooldownMs,
      }, { backend: backendId, severity: "info" });
      continue;
    }

    console.warn(
      `[router] ${res.status} ERROR backend=${backendId} latency=${latencyMs}ms` +
      (i < candidates.length - 1 ? " — trying next backend" : " — no more backends")
    );
    // Retryable upstream failure (>=500) — one error event per failed attempt.
    emitSiem("error", {
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
      `tried=[${throttledAttempts.map((t) => `${t.backendId}/${t.model}`).join(", ")}]`
    );
    emitSiem("response", {
      status: 429,
      failover: didFailover,
      all_backends_failed: true,
      all_throttled: true,
    }, { backend: lastResult?.backendId ?? null });
    return {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(retryAfterSec) },
      body: Buffer.from(payload, "utf-8"),
      backendId: lastResult?.backendId ?? null,
      failover: didFailover,
    };
  }

  // All backends failed for some other (non-throttle) reason: return the
  // last response so the caller can relay the error.
  emitSiem("response", {
    status: lastResult?.status ?? 502,
    failover: didFailover,
    all_backends_failed: true,
  }, { backend: lastResult?.backendId });
  return lastResult;
}
