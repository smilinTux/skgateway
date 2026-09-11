const PROVIDERS = new Set(["local", "codex", "kimi", "zai", "cursor", "openrouter"]);
const SCOPES = new Set(["provider", "account", "backend", "model"]);
const SOURCES = new Set(["real_request", "catalog_poll", "account_poll", "credential_metadata", "local_control"]);
const PROBE_COSTS = new Set(["zero", "token", "unknown"]);
const MODES = new Set(["disabled", "monitor_only", "canary", "active"]);
const CIRCUITS = new Set(["closed", "open", "half_open"]);
const ERROR_CODES = new Set([
  "rate_limited", "quota_exhausted", "auth_rejected", "credential_missing",
  "credential_expired", "entitlement_denied", "transport_failure",
  "capacity_saturated", "malformed_response", "empty_response", "cooldown_active",
]);

const DIMENSIONS = Object.freeze({
  transport: new Set(["unknown", "available", "degraded", "unavailable"]),
  auth: new Set(["unknown", "ready", "near_expiry", "expired", "missing", "rejected"]),
  entitlement: new Set(["unknown", "fresh", "stale", "denied"]),
  quota: new Set(["not_applicable", "unknown", "available", "low", "throttled", "exhausted"]),
  capacity: new Set(["unknown", "available", "saturated", "quarantined"]),
  inference: new Set(["unknown", "available", "degraded", "unavailable"]),
});

const TOP_LEVEL = new Set([
  "schema_version", "observation_id", "observed_at", "expires_at", "gateway_instance",
  "boot_id", "runtime_revision", "config_revision", "provider", "backend_id", "account_ref",
  "model_id", "bucket_id", "logical_route", "scope", "source", "probe_cost", "configured_mode",
  "circuit_state", "quarantine_scope", "quarantine_reason", "next_due_at", "reset_at",
  "backoff_step", "credential_generation", "half_open_lease", "dimensions", "success",
  "status_class", "provider_error_code", "latency_ms", "request_count", "failure_count",
  "monitor_cycle", "catalog_count", "catalog_hash", "quota_windows",
]);

const FORBIDDEN_KEY = /(authorization|credential(?!_generation)|token|secret|prompt|response|raw|session|capability|account_id|user_id|url|host|path|header|body)/i;

function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value;
}

function keys(value, allowed, name) {
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEY.test(key)) throw new TypeError(`${name}.${key} is forbidden`);
    if (!allowed.has(key)) throw new TypeError(`${name}.${key} is unknown`);
  }
}

function string(value, name, { nullable = false, max = 256 } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f]/.test(value)) throw new TypeError(`${name} must be a bounded non-empty string`);
  return value;
}

function integer(value, name, { nullable = false, min = 0 } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < min) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
}

function enumeration(value, values, name) {
  if (!values.has(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function dimensions(input = {}) {
  object(input, "dimensions"); keys(input, new Set(Object.keys(DIMENSIONS)), "dimensions");
  return Object.fromEntries(Object.entries(DIMENSIONS).map(([name, values]) => [name, enumeration(input[name] ?? "unknown", values, `dimensions.${name}`)]));
}

function lease(input) {
  if (input == null) return null;
  object(input, "half_open_lease"); keys(input, new Set(["owner", "expires_at"]), "half_open_lease");
  return { owner: string(input.owner, "half_open_lease.owner"), expires_at: integer(input.expires_at, "half_open_lease.expires_at") };
}

function quotaWindows(input) {
  if (input == null) return [];
  if (!Array.isArray(input) || input.length > 16) throw new TypeError("quota_windows must be a bounded array");
  return input.map((item, i) => {
    object(item, `quota_windows[${i}]`); keys(item, new Set(["name", "limit", "remaining", "reset_at", "unit"]), `quota_windows[${i}]`);
    const limit = Number(item.limit); const remaining = Number(item.remaining);
    if (!Number.isFinite(limit) || limit < 0 || !Number.isFinite(remaining) || remaining < 0) throw new TypeError("quota window values must be finite and non-negative");
    return { name: string(item.name, "quota window name", { max: 64 }), limit, remaining, reset_at: integer(item.reset_at, "quota window reset_at", { nullable: true }), unit: string(item.unit, "quota window unit", { nullable: true, max: 32 }) };
  });
}

export function normalizeObservation(input) {
  object(input, "observation"); keys(input, TOP_LEVEL, "observation");
  const observedAt = integer(input.observed_at, "observed_at");
  const expiresAt = integer(input.expires_at, "expires_at");
  if (expiresAt < observedAt) throw new TypeError("expires_at must not precede observed_at");
  const success = input.success == null ? null : input.success;
  if (success !== null && typeof success !== "boolean") throw new TypeError("success must be boolean or null");
  const statusClass = input.status_class == null ? null : enumeration(input.status_class, new Set(["1xx", "2xx", "3xx", "4xx", "5xx", "none"]), "status_class");
  const errorCode = input.provider_error_code == null ? null : enumeration(input.provider_error_code, ERROR_CODES, "provider_error_code");
  const out = {
    schema_version: input.schema_version === 1 ? 1 : (() => { throw new TypeError("schema_version must be 1"); })(),
    observation_id: string(input.observation_id, "observation_id"), observed_at: observedAt, expires_at: expiresAt,
    gateway_instance: string(input.gateway_instance, "gateway_instance"), boot_id: string(input.boot_id, "boot_id"),
    runtime_revision: string(input.runtime_revision, "runtime_revision"), config_revision: string(input.config_revision, "config_revision"),
    provider: enumeration(input.provider, PROVIDERS, "provider"), backend_id: string(input.backend_id, "backend_id", { nullable: true }),
    account_ref: string(input.account_ref, "account_ref"), model_id: string(input.model_id, "model_id", { nullable: true }),
    bucket_id: string(input.bucket_id, "bucket_id", { nullable: true }), logical_route: string(input.logical_route, "logical_route", { nullable: true }),
    scope: enumeration(input.scope, SCOPES, "scope"), source: enumeration(input.source, SOURCES, "source"),
    probe_cost: enumeration(input.probe_cost, PROBE_COSTS, "probe_cost"), configured_mode: enumeration(input.configured_mode, MODES, "configured_mode"),
    circuit_state: enumeration(input.circuit_state, CIRCUITS, "circuit_state"),
    quarantine_scope: input.quarantine_scope == null ? null : enumeration(input.quarantine_scope, SCOPES, "quarantine_scope"),
    quarantine_reason: string(input.quarantine_reason, "quarantine_reason", { nullable: true }),
    next_due_at: integer(input.next_due_at, "next_due_at", { nullable: true }), reset_at: integer(input.reset_at, "reset_at", { nullable: true }),
    backoff_step: integer(input.backoff_step ?? 0, "backoff_step"), credential_generation: string(input.credential_generation, "credential_generation", { nullable: true }),
    half_open_lease: lease(input.half_open_lease), dimensions: dimensions(input.dimensions), success,
    status_class: statusClass, provider_error_code: errorCode,
    latency_ms: integer(input.latency_ms, "latency_ms", { nullable: true }), request_count: integer(input.request_count ?? 0, "request_count"),
    failure_count: integer(input.failure_count ?? 0, "failure_count"), monitor_cycle: string(input.monitor_cycle, "monitor_cycle", { nullable: true }),
    catalog_count: integer(input.catalog_count, "catalog_count", { nullable: true }), catalog_hash: string(input.catalog_hash, "catalog_hash", { nullable: true }),
    quota_windows: quotaWindows(input.quota_windows),
  };
  if (out.half_open_lease && out.half_open_lease.expires_at < observedAt) throw new TypeError("half_open_lease expires before observation");
  if (out.failure_count > out.request_count && out.request_count > 0) throw new TypeError("failure_count exceeds request_count");
  return Object.freeze(out);
}

export const PROVIDER_HEALTH_SCHEMA_VERSION = 1;
