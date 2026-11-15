import { parseResetDelayMs } from "../proxy/reset-time.mjs";

const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000;
const records = new Map();

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
  const delayMs = parseResetDelayMs(value, now);
  return delayMs === null ? null : new Date(now + delayMs).toISOString();
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

export function observeProviderUsage(provider, response, { now = Date.now() } = {}) {
  if (!Object.hasOwn(HEADER_SCHEMAS, provider)) return;
  const prior = records.get(provider);
  const windows = parseProviderQuota(provider, response?.headers, { now });
  persistHeaderWindows(provider, windows, now);
  
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

export function _resetProviderUsageForTests() { records.clear(); }

// ─── pck3: persisted provider snapshot for GET /status provider_usage ───
// The latest figures per backend and source survive restarts in metrics.db
// (table provider_snapshot). Sources: "headers" (rate-limit headers of real
// calls, Codex and zai) and "balance" (DeepSeek /user/balance, hourly).
// No new completion probes. No raw headers, no credentials are stored.
export const STATUS_BACKENDS = ["codex", "deepseek", "zai"];
const PERSIST_EVERY_MS = 60_000;
let snapshotDb = null;
let snapshotHook = null;
const lastPersist = new Map();
const memorySnapshots = new Map(); // "backend\tsource" -> { observed_at, data }

/** Attach metrics.db (may be null) and an alert hook (backend, source, data, now). */
export function attachProviderStore({ db = null, onSnapshot = null } = {}) {
  snapshotDb = db;
  snapshotHook = onSnapshot;
  if (db) db.exec(`CREATE TABLE IF NOT EXISTS provider_snapshot (
    backend TEXT NOT NULL, source TEXT NOT NULL, observed_at TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (backend, source));
    CREATE TABLE IF NOT EXISTS deepseek_balance_log (observed_at TEXT NOT NULL, currency TEXT NOT NULL, total_balance REAL);
    CREATE INDEX IF NOT EXISTS idx_deepseek_balance_log_ts ON deepseek_balance_log (observed_at);`);
}

function saveSnapshot(backend, source, data, now, { force = false } = {}) {
  const k = `${backend}\t${source}`;
  const observed_at = new Date(now).toISOString();
  memorySnapshots.set(k, { observed_at, data });
  try { snapshotHook?.(backend, source, data, now); } catch { /* alerts never break routing */ }
  if (!snapshotDb || (!force && now - (lastPersist.get(k) || 0) < PERSIST_EVERY_MS)) return;
  lastPersist.set(k, now);
  try {
    snapshotDb.prepare(`INSERT INTO provider_snapshot (backend, source, observed_at, data) VALUES (?, ?, ?, ?)
      ON CONFLICT (backend, source) DO UPDATE SET observed_at = excluded.observed_at, data = excluded.data`)
      .run(backend, source, observed_at, JSON.stringify(data));
  } catch (e) { console.warn(`[provider-usage] snapshot persist failed: ${e.message}`); }
}

const windowView = (w) => ({
  name: w.name, unit: w.unit || "count", limit: w.limit, remaining: w.remaining,
  used_percent: w.limit > 0 ? Math.round(((w.limit - w.remaining) / w.limit) * 1000) / 10 : null,
  reset_at: w.reset_at ?? null,
});

/** Called from observeProviderUsage when a real call carried quota headers. */
function persistHeaderWindows(provider, windows, now) {
  if (STATUS_BACKENDS.includes(provider) && windows.length) saveSnapshot(provider, "headers", { windows: windows.map(windowView) }, now);
}

export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";

/**
 * GET the DeepSeek balance (free, no tokens). The key is used only for the
 * authorization header; errors carry the HTTP status only, never the key.
 */
export async function pollDeepseekBalance({ key, fetchFn = globalThis.fetch, now = Date.now } = {}) {
  if (!key) return { ok: false, reason: "no_key" };
  let res;
  try {
    res = await fetchFn(DEEPSEEK_BALANCE_URL, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  } catch (e) { return { ok: false, reason: `fetch_failed:${e?.name || "error"}` }; }
  if (!res.ok) return { ok: false, reason: `http_${res.status}` };
  let body;
  try { body = await res.json(); } catch { return { ok: false, reason: "bad_json" }; }
  // {} or null or no balance rows is a failed read, never a fresh snapshot.
  if (!body || typeof body !== "object" || !Array.isArray(body.balance_infos) || !body.balance_infos.length) return { ok: false, reason: "empty_balance" };
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const balances = (body?.balance_infos || []).map((b) => ({
    currency: String(b.currency || ""), total_balance: num(b.total_balance),
    granted_balance: num(b.granted_balance), topped_up_balance: num(b.topped_up_balance),
  }));
  const data = { is_available: body?.is_available === true, balances };
  const t = now();
  saveSnapshot("deepseek", "balance", data, t, { force: true });
  if (snapshotDb) {
    try {
      const ins = snapshotDb.prepare("INSERT INTO deepseek_balance_log (observed_at, currency, total_balance) VALUES (?, ?, ?)");
      for (const b of balances) ins.run(new Date(t).toISOString(), b.currency, b.total_balance);
    } catch (e) { console.warn(`[provider-usage] balance history write failed: ${e.message}`); }
  }
  return { ok: true, data };
}

/**
 * The provider_usage block of GET /status. Every backend in STATUS_BACKENDS is
 * present; a backend with no snapshot has observed_at null and age_seconds null.
 */
export function providerUsageStatus({ now = Date.now() } = {}) {
  const rows = new Map(memorySnapshots);
  if (snapshotDb) {
    try {
      for (const r of snapshotDb.prepare("SELECT backend, source, observed_at, data FROM provider_snapshot").all()) {
        const k = `${r.backend}\t${r.source}`;
        const mem = rows.get(k);
        if (!mem || mem.observed_at < r.observed_at) rows.set(k, { observed_at: r.observed_at, data: JSON.parse(r.data) });
      }
    } catch { /* memory only */ }
  }
  const age = (iso) => (iso ? Math.max(0, Math.round((now - Date.parse(iso)) / 1000)) : null);
  const backends = {};
  for (const backend of STATUS_BACKENDS) {
    const sources = {};
    let newest = null;
    for (const [k, v] of rows) {
      const [b, source] = k.split("\t");
      if (b !== backend) continue;
      sources[source] = { observed_at: v.observed_at, age_seconds: age(v.observed_at), ...v.data };
      if (!newest || v.observed_at > newest) newest = v.observed_at;
    }
    backends[backend] = { backend, observed_at: newest, age_seconds: age(newest), sources };
  }
  return { schema: "skgw-provider-usage/1", generated_at: new Date(now).toISOString(), backends };
}

export function _resetProviderStoreForTests() { snapshotDb = null; snapshotHook = null; lastPersist.clear(); memorySnapshots.clear(); }
