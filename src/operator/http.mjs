/**
 * skgateway's self-served operator-plane HTTP facet: `/operator/v1/*`.
 *
 * Epic c880017b, Phase 3 item 4 of docs/OPERATOR_PLANE_MIGRATION.md (skcapstone
 * repo): skgateway's declared `spec.cli` is dead on the control-plane node (the
 * `skgateway` binary is not on PATH there), so ATLAS could only see it through
 * an advisory, fail-open, in-process seat adapter. This module serves the same
 * `skoperator.observation/v1` contract (docs/OPERATOR_PLANE_REMOTE_STANDARD.md)
 * directly off the daemon that already runs on :18780, self-served per the
 * standard's decision #3 ("An HTTP-native app MAY serve its own facet at a
 * registered endpoint, same wire contract"). This fixes the dead-cli problem
 * without waiting for the node move.
 *
 * Scope of THIS module (deliberately narrow):
 *   - GET  /operator/v1/healthz  — process liveness only, says nothing about apps.
 *   - GET  /operator/v1/readyz   — can this facet currently produce AUTHORITATIVE
 *                                  observations (are its required data sources
 *                                  wired and callable), distinct from healthz.
 *   - GET  /operator/v1/explain  — the contract: kinds/conditions/actions, and
 *                                  an explicit act-is-reserved note.
 *   - GET  /operator/v1/observe  — one signed-shape (unsigned: no capauth signer
 *                                  wired yet) `skoperator.observation/v1`
 *                                  envelope built from REAL in-process signals.
 *   - POST /operator/v1/act      — ALWAYS 501. Actuation is out of scope while
 *                                  ATLAS is frozen; this path exists only so a
 *                                  caller can tell "refused" apart from "does
 *                                  not exist" (mirrors the Phase 1 node-agent
 *                                  reference, src/skcapstone/fleet/operator_http.py).
 *
 * NOT in scope here (deferred to the phase that actually registers this
 * endpoint with the fleet object store): capauth request-signing verification
 * of inbound calls, and producer-signing of outbound envelopes. Both are wire
 * additions on top of this contract, not changes to it — every envelope this
 * module returns carries an explicit `signature: null, signer_fpr: null` pair
 * (never a silently-missing key that could be mistaken for "not yet checked"),
 * matching how the Python reference's `sign_envelope()` behaves with no signer
 * configured. These routes are public GETs on this daemon today (see the
 * `PUBLIC_ROUTES` entries added alongside this module in policy/authz_routes.mjs
 * and index.mjs): they reveal no secrets, only the same class of operational
 * health this gateway already exposes unauthenticated on /health and /status.
 *
 * Fail-closed discipline (the rule that matters most here): every condition
 * below is computed from data this process can genuinely observe in-process
 * (router.getHealth(), the connection pool's live stats, the discovery
 * catalog's freshness/provider-health cache) — never from a self-HTTP round
 * trip, and never defaulted to healthy on missing/thrown evidence. Compare
 * this to operator.mjs's `defaultProbe()` (used by the CLI path, unmodified by
 * this module) which explicitly "fails SAFE (reports healthy)" when it cannot
 * reach the gateway over HTTP — exactly the anti-pattern this facet exists to
 * not repeat. Unreachable, Unknown and Unauthorized are three distinct states
 * per the standard (section 7); this module only ever produces `Unknown` (with
 * a specific reason) on missing/failed evidence, never `True`.
 *
 * Everything here is pure and injectable (same testability discipline as
 * operator.mjs / operator/manifest.mjs): `buildObservation()` and the request
 * handlers take their data sources as explicit parameters, so tests never boot
 * the live gateway, and index.mjs wires the real router/pool/discovery objects
 * in at the single call site (near the other route handlers, see /health,
 * /status, /.well-known/skworld-module.json).
 *
 * @module operator/http
 */

import { KINDS, ACTIONS } from "./operator.mjs";

/** Wire schema string for the observation envelope (atlas-observation-contract.md). */
export const SCHEMA = "skoperator.observation/v1";

/** This facet's app identifier, stamped on the envelope and every condition. */
export const APP = "skgateway";

/** Envelope/condition default TTL (standard section 7: "envelope default ttl 300s"). */
export const DEFAULT_TTL_SECONDS = 300;

/**
 * The conditions this HTTP facet reports. A superset of the CLI adapter's
 * CONDITIONS (operator.mjs / skgateway_adapter.py: UpstreamServing,
 * PoolHealthy) — those two names are kept IDENTICAL so a later dual-read
 * parity check (migration doc Phase 3) can compare this facet's authoritative
 * reading against the seat's advisory one condition-for-condition. CatalogFresh
 * is new: a genuinely-knowable signal (discovery.mjs's catalogStatus()) the
 * CLI-probe path never had access to, since it only ever read /health.
 */
export const CONDITIONS = ["UpstreamServing", "PoolHealthy", "CatalogFresh"];

/** ISO-8601 "now", injectable for tests (`now` may be a Date.now-like fn or a ms number). */
function nowIso(now) {
  const ms = typeof now === "function" ? now() : now ?? Date.now();
  return new Date(ms).toISOString();
}

/**
 * One condition entry in the `skoperator.observation/v1` shape (matches
 * docs/atlas-observation-contract.md's example exactly: type/status/app/
 * observed_at/ttl_seconds/provenance/scope/polarity, plus an optional
 * reason/message pair for non-True status).
 *
 * @param {string} type
 * @param {string} object   the kind of thing this condition is about (upstreams,
 *   connection-pool, model-catalog), mirrors operator.mjs's `object` field.
 * @param {"True"|"False"|"Unknown"} status
 * @param {string} observedAt ISO-8601 timestamp, computed once per envelope.
 * @param {{reason?: string, message?: string}} [extra]
 * @returns {object}
 */
function condition(type, object, status, observedAt, extra = {}) {
  const out = {
    type,
    status,
    app: APP,
    object,
    observed_at: observedAt,
    ttl_seconds: DEFAULT_TTL_SECONDS,
    provenance: "self-served:skgateway",
    scope: "local",
    // All three conditions here are "True is healthy": firing (an incident-
    // worthy state) is exactly the False reading, same polarity operator.mjs's
    // _b()/CLI adapter already use for these condition names.
    polarity: "problem_when_false",
  };
  if (extra.reason) out.reason = extra.reason;
  if (extra.message) out.message = extra.message;
  return out;
}

/**
 * UpstreamServing from the router's OWN live health table (router.getHealth()),
 * in-process — never a self-HTTP call to /health.
 *
 * Deliberately conservative per the fail-closed rule: a backend that has never
 * been observed (`status: "unknown"`, see router.mjs's Backend.getHealth() doc
 * comment re: the 2026-08-16 incident where an unobserved dead backend read as
 * healthy) contributes NO evidence either way. True requires at least one
 * OBSERVED backend and zero observed backends in "down" or "degraded" state;
 * a router with backends but none yet observed reports Unknown, never True —
 * "no evidence of failure" is not the same claim as "serving".
 *
 * @param {Record<string, {status?: string, observed?: boolean, quarantined?: boolean}>} healthMap
 * @param {string} observedAt
 * @returns {object}
 */
export function summarizeUpstream(healthMap, observedAt) {
  const entries = Object.entries(healthMap || {});
  if (entries.length === 0) {
    return condition("UpstreamServing", "upstreams", "Unknown", observedAt, {
      reason: "NoBackendsConfigured",
      message: "no backends are registered on this router",
    });
  }
  const observed = entries.filter(([, h]) => h?.status && h.status !== "unknown");
  const down = observed.filter(([, h]) => h.status === "down").map(([id]) => id);
  const degraded = observed.filter(([, h]) => h.status === "degraded").map(([id]) => id);

  if (down.length > 0) {
    return condition("UpstreamServing", "upstreams", "False", observedAt, {
      reason: "BackendDown",
      message: `down: ${down.join(", ")}`,
    });
  }
  if (degraded.length > 0) {
    return condition("UpstreamServing", "upstreams", "False", observedAt, {
      reason: "BackendDegraded",
      message: `degraded (recovering, not yet confirmed up): ${degraded.join(", ")}`,
    });
  }
  if (observed.length === 0) {
    return condition("UpstreamServing", "upstreams", "Unknown", observedAt, {
      reason: "NoObservedTraffic",
      message: "no backend has served a request yet; unobserved is not evidence of health",
    });
  }
  return condition("UpstreamServing", "upstreams", "True", observedAt, {});
}

/**
 * PoolHealthy from the router's quarantine flags plus the connection pool's
 * own live totals (pool.getTotalStats()), in-process.
 *
 * False when any backend is quarantined (an upstream the router itself has
 * pulled out of rotation) OR the pool is genuinely backed up right now
 * (capacity configured and at least one request currently queued for it —
 * real backpressure, not a point-in-time blip inferred from error rates).
 * Unknown when the pool stats source is missing/malformed rather than
 * defaulting to healthy.
 *
 * @param {Record<string, {quarantined?: boolean}>} healthMap
 * @param {{totalActive?: number, totalQueued?: number, totalCapacity?: number}|null} poolStats
 * @param {string} observedAt
 * @returns {object}
 */
export function summarizePool(healthMap, poolStats, observedAt) {
  const quarantined = Object.entries(healthMap || {})
    .filter(([, h]) => h?.quarantined)
    .map(([id]) => id);
  if (quarantined.length > 0) {
    return condition("PoolHealthy", "connection-pool", "False", observedAt, {
      reason: "AliasQuarantined",
      message: `quarantined: ${quarantined.join(", ")}`,
    });
  }
  if (!poolStats || typeof poolStats.totalCapacity !== "number") {
    return condition("PoolHealthy", "connection-pool", "Unknown", observedAt, {
      reason: "ProbeFailed",
      message: "connection-pool stats unavailable",
    });
  }
  if (poolStats.totalCapacity > 0 && (poolStats.totalQueued || 0) > 0) {
    return condition("PoolHealthy", "connection-pool", "False", observedAt, {
      reason: "PoolSaturated",
      message: `${poolStats.totalQueued} request(s) queued against ${poolStats.totalCapacity} capacity`,
    });
  }
  return condition("PoolHealthy", "connection-pool", "True", observedAt, {});
}

/**
 * CatalogFresh from discovery.mjs's catalogStatus() (already computed by the
 * live gateway for GET /admin/models/status — this reuses that exact signal,
 * it does not recompute anything).
 *
 * Unknown (not True, not False) when discovery is turned off in config: a
 * disabled feature has no freshness to report, and reporting "fresh" would
 * misstate that discovery is even running. False when the cached status says
 * `stale` (a provider fetch is currently failing, or the whole catalog has
 * aged well past its refresh window per discovery.mjs's own overdue rule).
 *
 * @param {{stale?: boolean, ageSeconds?: number|null, providers?: Record<string,{ok?: boolean}>}|null} catalogStatus
 * @param {boolean} discoveryEnabled
 * @param {string} observedAt
 * @returns {object}
 */
export function summarizeCatalog(catalogStatus, discoveryEnabled, observedAt) {
  if (discoveryEnabled === false) {
    return condition("CatalogFresh", "model-catalog", "Unknown", observedAt, {
      reason: "DiscoveryDisabled",
      message: "discovery.enabled=false; no catalog freshness signal to report",
    });
  }
  if (!catalogStatus || typeof catalogStatus !== "object") {
    return condition("CatalogFresh", "model-catalog", "Unknown", observedAt, {
      reason: "ProbeFailed",
      message: "catalog status unavailable",
    });
  }
  if (catalogStatus.stale) {
    const downProviders = Object.entries(catalogStatus.providers || {})
      .filter(([, p]) => p?.ok === false)
      .map(([name]) => name);
    return condition("CatalogFresh", "model-catalog", "False", observedAt, {
      reason: downProviders.length ? "ProviderUnreachable" : "CatalogOverdue",
      message: downProviders.length
        ? `provider fetch failing: ${downProviders.join(", ")}`
        : `catalog age ${catalogStatus.ageSeconds ?? "unknown"}s exceeds the refresh window`,
    });
  }
  return condition("CatalogFresh", "model-catalog", "True", observedAt, {});
}

/**
 * Resolve an injected source that may be a value or a zero-arg (sync or
 * async) function, swallowing any throw into `fallback`. Shared by
 * buildObservation()'s three independent data sources so one broken source
 * degrades only ITS OWN condition(s) to Unknown rather than 500ing the whole
 * envelope.
 *
 * @template T
 * @param {T | (() => T|Promise<T>)} source
 * @param {T} fallback
 * @returns {Promise<{value: T, error: Error|null}>}
 */
async function resolveSource(source, fallback) {
  try {
    const value = typeof source === "function" ? await source() : source;
    return { value: value === undefined ? fallback : value, error: null };
  } catch (error) {
    return { value: fallback, error };
  }
}

/**
 * Build one `skoperator.observation/v1` envelope for skgateway from live (or
 * injected, for tests) data sources. Never throws: any source that is missing
 * or throws degrades only its own condition(s) to Unknown/ProbeFailed.
 *
 * @param {object} sources
 * @param {() => Record<string, object>} [sources.getHealth] router.getHealth
 * @param {() => {totalActive?: number, totalQueued?: number, totalCapacity?: number}} [sources.getPoolStats] pool.getTotalStats
 * @param {() => Promise<object>|object} [sources.getCatalogStatus] discovery catalogStatus()
 * @param {boolean|(() => boolean)} [sources.discoveryEnabled]
 * @param {number|(() => number)} [sources.now]
 * @returns {Promise<object>} the envelope
 */
export async function buildObservation(sources = {}) {
  const observedAt = nowIso(sources.now);

  const { value: healthMap, error: healthError } = await resolveSource(sources.getHealth, null);
  const { value: poolStats } = await resolveSource(sources.getPoolStats, null);
  const { value: catalogStatus } = await resolveSource(sources.getCatalogStatus, null);
  const { value: discoveryEnabled } = await resolveSource(sources.discoveryEnabled, true);

  const conditions = [];
  if (healthError || healthMap === null) {
    const message = healthError
      ? `router health probe threw: ${healthError.message}`
      : "router health source not wired";
    conditions.push(
      condition("UpstreamServing", "upstreams", "Unknown", observedAt, { reason: "ProbeFailed", message }),
    );
    conditions.push(
      condition("PoolHealthy", "connection-pool", "Unknown", observedAt, {
        reason: "ProbeFailed",
        message: "cannot assess pool health without backend health",
      }),
    );
  } else {
    conditions.push(summarizeUpstream(healthMap, observedAt));
    conditions.push(summarizePool(healthMap, poolStats, observedAt));
  }
  conditions.push(summarizeCatalog(catalogStatus, discoveryEnabled, observedAt));

  return {
    schema: SCHEMA,
    app: APP,
    observed_at: observedAt,
    // No capauth signer wired for this facet yet (see module docstring):
    // explicit null pair, never a silently-absent key.
    signature: null,
    signer_fpr: null,
    conditions,
  };
}

/**
 * skgateway's self-description in the operator-contract shape, served at
 * GET /operator/v1/explain. `conditions` is exactly CONDITIONS (the set
 * observe() actually reports); `actions` documents what the standard/
 * reversible actions WOULD do (unchanged from operator.mjs's ACTIONS) even
 * though `act` itself always 501s over this HTTP facet today.
 *
 * @returns {object}
 */
export function explain() {
  return {
    schema: "skoperator.explain/v1",
    app: APP,
    kinds: [...KINDS, "catalog"],
    conditions: [...CONDITIONS],
    actions: ACTIONS.map((a) => ({ ...a })),
    act: {
      implemented: false,
      reserved: true,
      reason:
        "act is reserved and always returns 501 on this facet; actuation is out of scope while ATLAS " +
        "is frozen (docs/OPERATOR_PLANE_MIGRATION.md Phase 3 item 4, OPERATOR_PLANE_REMOTE_STANDARD.md " +
        "section 4)",
    },
  };
}

/** Write one JSON response and end it. */
function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * GET /operator/v1/healthz — liveness of THIS PROCESS only. If this handler
 * runs at all, the process is up; it says nothing about any app/backend
 * condition (standard section 4).
 */
export function handleHealthz(req, res) {
  writeJson(res, 200, { status: "ok", service: APP, uptime: process.uptime() });
}

/**
 * GET /operator/v1/readyz — readiness to serve AUTHORITATIVE observations,
 * distinct from healthz. Fails closed (503) when the facet's REQUIRED data
 * sources (router health, connection-pool stats) are missing or throw on
 * call; a caller must then treat this facet's observations as Unknown
 * (AgentNotReady), never as data (standard section 4). Catalog freshness is
 * NOT required for readiness: a discovery-disabled or not-yet-refreshed
 * catalog is normal operation (summarizeCatalog reports it Unknown on its
 * own), not a "this facet cannot answer" state.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{getHealth?: Function, getPoolStats?: Function}} deps
 */
export function handleReadyz(req, res, deps = {}) {
  const failing = [];
  if (typeof deps.getHealth !== "function") {
    failing.push("router health source not wired");
  } else {
    try {
      deps.getHealth();
    } catch (e) {
      failing.push(`router health probe failed: ${e.message}`);
    }
  }
  if (typeof deps.getPoolStats !== "function") {
    failing.push("connection-pool stats source not wired");
  } else {
    try {
      deps.getPoolStats();
    } catch (e) {
      failing.push(`connection-pool stats probe failed: ${e.message}`);
    }
  }
  if (failing.length > 0) {
    writeJson(res, 503, { ready: false, failing });
    return;
  }
  writeJson(res, 200, { ready: true, failing: [] });
}

/** GET /operator/v1/explain — the contract JSON (see explain() above). */
export function handleExplain(req, res) {
  writeJson(res, 200, explain());
}

/**
 * GET /operator/v1/observe — one `skoperator.observation/v1` envelope built
 * from live (or injected) data sources. Never throws into a 500: any source
 * failure degrades to per-condition Unknown (see buildObservation()).
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {object} deps see buildObservation()'s `sources` parameter
 */
export async function handleObserve(req, res, deps = {}) {
  const envelope = await buildObservation(deps);
  writeJson(res, 200, envelope);
}

/**
 * POST /operator/v1/act — ALWAYS 501. Actuation is out of scope for this
 * facet (ATLAS is frozen; this card explicitly forbids implementing act).
 * The path exists only so a caller can tell "refused" apart from "does not
 * exist", mirroring the Phase 1 node-agent reference
 * (src/skcapstone/fleet/operator_http.py's identical reserved-501 stub).
 */
export function handleAct(req, res) {
  writeJson(res, 501, {
    error: "act is reserved, not implemented",
    note:
      "actuation is out of scope for this facet while ATLAS is frozen; this path exists only so a " +
      "caller can tell 'refused' apart from 'does not exist' (OPERATOR_PLANE_REMOTE_STANDARD.md section 4)",
  });
}

export default {
  SCHEMA,
  APP,
  DEFAULT_TTL_SECONDS,
  CONDITIONS,
  summarizeUpstream,
  summarizePool,
  summarizeCatalog,
  buildObservation,
  explain,
  handleHealthz,
  handleReadyz,
  handleExplain,
  handleObserve,
  handleAct,
};
