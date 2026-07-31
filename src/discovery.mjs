// Pure provider parsing/filtering. Network + cache live in this file too (Task 2)
// but these three functions never touch the network.

const NON_CHAT = [
  /embed/i, /\bbge\b/i, /rerank/i, /content-safety/i, /guard/i,
  /\bfuyu\b/i, /\bocr\b/i, /vision-embed/i, /moderation/i,
];

export function isChatModel(id) {
  if (!id || typeof id !== 'string') return false;
  return !NON_CHAT.some((re) => re.test(id));
}

export function parseNvidia(json) {
  const data = (json && json.data) || [];
  return data
    .map((m) => m.id)
    .filter(isChatModel)
    .map((id) => ({ id, provider: 'nvidia', free: true }));
}

function isFree(m) {
  if (String(m.id || '').endsWith(':free')) return true;
  const p = m.pricing || {};
  return String(p.prompt) === '0' && String(p.completion) === '0';
}

export function parseOpenRouterFree(json) {
  const data = (json && json.data) || [];
  return data
    .filter(isFree)
    .map((m) => m.id)
    .filter(isChatModel)
    .map((id) => ({ id, provider: 'openrouter', free: true }));
}

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const CACHE_PATH = join(homedir(), '.config', 'skgateway', 'model_catalog_cache.json');

export function mergeCatalog(local, nvidia, openrouter) {
  const seen = new Map();
  for (const group of [local || [], nvidia || [], openrouter || []]) {
    for (const m of group) {
      if (!seen.has(m.id)) seen.set(m.id, m);
    }
  }
  return [...seen.values()];
}

export async function fetchNvidia(apiKey) {
  const r = await fetch('https://integrate.api.nvidia.com/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) throw new Error(`nvidia ${r.status}`);
  return r.json();
}

export async function fetchOpenRouter() {
  const r = await fetch('https://openrouter.ai/api/v1/models');
  if (!r.ok) throw new Error(`openrouter ${r.status}`);
  return r.json();
}

/**
 * Record the outcome of one provider's fetch cycle onto the cache so the
 * freshness endpoint can report per-provider health (last success, last error,
 * whether it is currently being served from cache). This is pure bookkeeping on
 * the injected cache object; it never throws and never touches the network.
 *
 * @param {object} cache   the discovery cache (mutated in place)
 * @param {string} name    provider name ("nvidia" | "openrouter")
 * @param {object} outcome
 * @param {boolean} outcome.ok    true if the live fetch succeeded
 * @param {number}  outcome.count models retained for this provider this cycle
 * @param {number}  outcome.at    unix ms of this cycle
 * @param {string} [outcome.error] error message when ok is false
 */
function recordProvider(cache, name, { ok, count, at, error }) {
  cache.providers = cache.providers || {};
  const prev = cache.providers[name] || {};
  const entry = {
    ok: Boolean(ok),
    count,
    lastAttemptAt: at,
    // Preserve the last SUCCESSFUL fetch time across failures so operators can
    // see how long a provider has actually been degraded, not just when it was
    // last probed.
    lastSuccessAt: ok ? at : (prev.lastSuccessAt ?? null),
    lastError: ok ? null : (error ?? 'unknown error'),
    lastErrorAt: ok ? (prev.lastErrorAt ?? null) : at,
  };
  cache.providers[name] = entry;
}

export async function discoverCatalog(opts) {
  const { localModels = [], nvidiaFetch, openrouterFetch, cache = {}, now = Date.now } = opts;
  const at = now();
  let stale = false;
  let nvidia = [];
  let openrouter = [];
  try {
    nvidia = parseNvidia(await nvidiaFetch());
    recordProvider(cache, 'nvidia', { ok: true, count: nvidia.length, at });
  } catch (e) {
    stale = true;
    nvidia = (cache.models || []).filter((m) => m.provider === 'nvidia');
    recordProvider(cache, 'nvidia', { ok: false, count: nvidia.length, at, error: String(e?.message || e) });
  }
  try {
    openrouter = parseOpenRouterFree(await openrouterFetch());
    recordProvider(cache, 'openrouter', { ok: true, count: openrouter.length, at });
  } catch (e) {
    stale = true;
    openrouter = (cache.models || []).filter((m) => m.provider === 'openrouter');
    recordProvider(cache, 'openrouter', { ok: false, count: openrouter.length, at, error: String(e?.message || e) });
  }
  const models = mergeCatalog(localModels, nvidia, openrouter).map((m) => ({ ...m, stale }));
  cache.models = models;
  // Freshness observability: record when this discovery cycle completed. The
  // cycle is fail-soft (a throwing provider falls back to cache above and only
  // flips `stale`), so a completed cycle always advances the timestamp, even a
  // partially-stale one. `lastRefreshedAt` is unix ms; `now` is injectable so
  // tests can drive the clock deterministically.
  cache.lastRefreshedAt = at;
  return { models, stale, lastRefreshedAt: cache.lastRefreshedAt };
}

/**
 * Pure freshness summary for the operator/model-picker: how current the
 * discovered catalog is and what it contains. No network, no module state;
 * everything is passed in so it is trivially testable.
 *
 * @param {object} args
 * @param {Array}  args.catalog        current merged catalog (each entry tagged with `provider` and `free`)
 * @param {object} args.cache          discovery cache carrying `lastRefreshedAt`
 * @param {number} args.refreshSeconds configured discovery.refresh_seconds
 * @param {Function} [args.now]        clock (defaults to Date.now)
 * @returns {{lastRefreshedAt:(number|null), ageSeconds:(number|null), refreshSeconds:number, providerCounts:object, total:number, freeCount:number, stale:boolean, providers:object}}
 */
export function catalogStatus({ catalog = [], cache = {}, refreshSeconds = 0, now = Date.now } = {}) {
  const nowMs = now();
  const lastRefreshedAt = typeof cache.lastRefreshedAt === 'number' ? cache.lastRefreshedAt : null;
  const ageSeconds = lastRefreshedAt == null ? null : Math.max(0, Math.round((nowMs - lastRefreshedAt) / 1000));
  const providerCounts = {};
  let freeCount = 0;
  for (const m of catalog) {
    const p = m.provider || m.owned_by || 'unknown';
    providerCounts[p] = (providerCounts[p] || 0) + 1;
    if (m.free) freeCount += 1;
  }

  // Per-provider health from the discovery cache (recordProvider). Each entry
  // reports whether its last live fetch succeeded, the last error string and
  // when it happened, and how long ago the provider last returned live data.
  // The live `count` prefers what the current catalog actually carries (which
  // includes cache-fallback entries) and falls back to the recorded count.
  const providers = {};
  let anyProviderDown = false;
  for (const [name, p] of Object.entries(cache.providers || {})) {
    const successAgeSeconds =
      typeof p.lastSuccessAt === 'number' ? Math.max(0, Math.round((nowMs - p.lastSuccessAt) / 1000)) : null;
    providers[name] = {
      ok: p.ok !== false,
      count: providerCounts[name] ?? (typeof p.count === 'number' ? p.count : 0),
      lastSuccessAt: typeof p.lastSuccessAt === 'number' ? p.lastSuccessAt : null,
      successAgeSeconds,
      lastError: p.ok === false ? (p.lastError ?? 'unknown error') : null,
      lastErrorAt: typeof p.lastErrorAt === 'number' ? p.lastErrorAt : null,
    };
    if (p.ok === false) anyProviderDown = true;
  }

  // The catalog is "stale" (serving something less than fully live) when either
  // a provider is currently failing its fetch (served from cache) OR the whole
  // catalog has aged well past its refresh window (poller wedged / never ran).
  const overdue =
    lastRefreshedAt != null && refreshSeconds > 0 && ageSeconds != null && ageSeconds > refreshSeconds * 2;
  const stale = anyProviderDown || overdue;

  return {
    lastRefreshedAt,
    ageSeconds,
    refreshSeconds,
    providerCounts,
    total: catalog.length,
    freeCount,
    stale,
    providers,
  };
}

export function loadCache(path = CACHE_PATH) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function saveCache(cache, path = CACHE_PATH) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2));
  } catch {
    // cache persistence is best-effort; never throw into a request path
  }
}
