import { randomUUID } from "node:crypto";

const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;
const records = new Map();
let healthSink = null;
let healthDefaults = null;

export function configureProviderHealthPersistence(store, defaults = null) {
  healthSink = store?.append instanceof Function ? store : null;
  healthDefaults = defaults && typeof defaults === "object" ? { ...defaults } : null;
}

const HEADER_SCHEMAS = {
  codex: [
    ["tokens", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens"],
    ["requests", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests"],
  ],
  zai: [
    ["requests", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests"],
    ["tokens", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens"],
  ],
  kimi: [
    ["requests", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"],
  ],
  cursor: [],
};

function finite(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function resetAt(value, now) {
  if (value === undefined || value === null || value === "") return null;
  const seconds = finite(value);
  if (seconds !== null) {
    const ms = seconds > 10_000_000_000 ? seconds : seconds * 1000;
    return new Date(ms > now ? ms : now + ms).toISOString();
  }
  const duration = String(value).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!duration) return null;
  const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[duration[2].toLowerCase()];
  return new Date(now + Number(duration[1]) * scale).toISOString();
}

/** Parse only documented, provider-owned rate-limit headers. Arbitrary headers
 * are never copied, which keeps credentials and account identifiers out. */
export function parseProviderQuota(provider, headers = {}, { now = Date.now() } = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const windows = [];
  for (const [name, limitHeader, remainingHeader, resetHeader] of HEADER_SCHEMAS[provider] || []) {
    const limit = finite(normalized[limitHeader]);
    const remaining = finite(normalized[remainingHeader]);
    const reset_at = resetAt(normalized[resetHeader], now);
    if (limit === null || remaining === null) continue;
    windows.push({ name, limit, remaining, reset_at });
  }
  if (provider === "codex") {
    for (const name of ["primary", "secondary"]) {
      const used = finite(normalized[`x-codex-${name}-used-percent`]);
      if (used === null || used > 100) continue;
      windows.push({
        name,
        limit: 100,
        remaining: 100 - used,
        reset_at: resetAt(normalized[`x-codex-${name}-reset-at`], now),
        unit: "percent",
      });
    }
  }
  return windows;
}

function retryAt(headers, now) {
  const normalized = Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
  const value = normalized["retry-after"];
  const seconds = finite(value);
  if (seconds !== null) return new Date(now + seconds * 1000).toISOString();
  const date = Date.parse(String(value || ""));
  return Number.isFinite(date) ? new Date(date).toISOString() : null;
}

export function observeProviderUsage(provider, response, { now = Date.now(), health = null } = {}) {
  if (!Object.hasOwn(HEADER_SCHEMAS, provider)) return;
  const prior = records.get(provider);
  const windows = parseProviderQuota(provider, response?.headers, { now });
  const status = Number(response?.status) || null;
  const throttled = status === 429 || status === 402;
  records.set(provider, {
    provider,
    provider_reported: windows.length
      ? { state: "fresh", observed_at: new Date(now).toISOString(), windows }
      : prior?.provider_reported?.state === "fresh"
        ? prior.provider_reported
        : { state: "unavailable", observed_at: new Date(now).toISOString(), windows: [] },
    gateway_observed: {
      state: throttled ? "exhausted" : status >= 500 ? "error" : status >= 200 && status < 300 ? "available" : "unknown",
      observed_at: new Date(now).toISOString(),
      last_status: status,
      error_count: (prior?.gateway_observed?.error_count || 0) + (status >= 400 ? 1 : 0),
      cooldown_until: throttled ? retryAt(response?.headers, now) : null,
    },
  });
  const context = health ? { ...(healthDefaults || {}), ...health } : healthDefaults;
  if (healthSink && context) {
    const resetTimes = windows.map((window) => Date.parse(window.reset_at)).filter(Number.isFinite);
    const retry = retryAt(response?.headers, now);
    const reset = retry ? Date.parse(retry) : resetTimes.length ? Math.min(...resetTimes) : null;
    const remainingRatio = windows.length ? Math.min(...windows.map((window) => window.limit > 0 ? window.remaining / window.limit : 0)) : null;
    try {
      healthSink.append({
        ...context,
        schema_version: 1,
        observation_id: context.observation_id || randomUUID(),
        observed_at: now,
        expires_at: context.expires_at || now + DEFAULT_MAX_AGE_MS,
        provider,
        source: "real_request",
        probe_cost: context.probe_cost || "unknown",
        dimensions: {
          ...(context.dimensions || {}),
          transport: status >= 200 && status < 500 ? "available" : "degraded",
          quota: status === 402 ? "exhausted" : status === 429 ? "throttled" : remainingRatio == null ? "unknown" : remainingRatio <= 0.1 ? "low" : "available",
        },
        success: status >= 200 && status < 400,
        status_class: status ? `${Math.floor(status / 100)}xx` : "none",
        provider_error_code: throttled ? (status === 402 ? "quota_exhausted" : "rate_limited") : null,
        reset_at: reset,
        quota_windows: windows.map((window) => ({ ...window, reset_at: window.reset_at ? Date.parse(window.reset_at) : null })),
      });
      records.get(provider).persistence = { state: "ready", observed_at: new Date(now).toISOString() };
    } catch {
      records.get(provider).persistence = { state: "error", observed_at: new Date(now).toISOString() };
    }
  }
}

export function providerUsageSnapshot({ now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const out = {};
  for (const provider of Object.keys(HEADER_SCHEMAS)) {
    const record = records.get(provider);
    if (!record) {
      out[provider] = {
        provider,
        provider_reported: { state: "unknown", observed_at: null, windows: [] },
        gateway_observed: { state: "unknown", observed_at: null, last_status: null, error_count: 0, cooldown_until: null },
      };
      continue;
    }
    const observed = Date.parse(record.provider_reported.observed_at);
    out[provider] = {
      ...record,
      provider_reported: now - observed > maxAgeMs && record.provider_reported.state === "fresh"
        ? { ...record.provider_reported, state: "stale" }
        : record.provider_reported,
    };
  }
  return out;
}

export function _resetProviderUsageForTests() { records.clear(); healthSink = null; healthDefaults = null; }
