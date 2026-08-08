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
import { defaultLifecycle, applyCatalogPresence, THRESHOLDS as LIFECYCLE_THRESHOLDS } from './discovery/lifecycle.mjs';
import { STORE_PATH as LIFECYCLE_STORE_PATH } from './discovery/model_catalog_store.mjs';

const CACHE_PATH = join(homedir(), '.config', 'skgateway', 'model_catalog_cache.json');

export { LIFECYCLE_STORE_PATH };

/**
 * Pure per-cycle catalog-presence reconciler (card P1.3, design doc 4.2 /
 * 5.1). `store` is a plain map of model id -> lifecycle record, scoped by the
 * caller to whatever ids it already knows belong to `provider` (a fresh id
 * present only in `fetchedIds` seeds a brand-new record, per
 * `applyCatalogPresence`/`defaultLifecycle` in lifecycle.mjs). Every id that
 * is either already a key of `store` or present in `fetchedIds` this cycle is
 * reconciled and tagged with `provider` so a later cycle can re-scope it
 * (lifecycle.mjs's six fields are untouched; `provider` rides alongside them
 * and is preserved across state transitions because every lifecycle.mjs
 * transition spreads `{...lc, ...}`). No I/O, no clock of its own: the caller
 * passes `now` (and, optionally, `thresholds` to override the Q5 per-provider
 * defaults from lifecycle.mjs).
 *
 * @param {Record<string, object>} store
 * @param {Iterable<string>} fetchedIds ids this provider's live catalog fetch returned this cycle
 * @param {string} provider
 * @param {number} now
 * @param {object} [thresholds]
 * @returns {Record<string, object>} a NEW map, one entry per reconciled id
 */
export function reconcilePresence(store, fetchedIds, provider, now, thresholds = LIFECYCLE_THRESHOLDS) {
  const fetchedSet = fetchedIds instanceof Set ? fetchedIds : new Set(fetchedIds || []);
  const knownIds = new Set([...Object.keys(store || {}), ...fetchedSet]);
  const next = {};
  for (const id of knownIds) {
    const lc = (store && store[id]) || defaultLifecycle();
    const present = fetchedSet.has(id);
    next[id] = { ...applyCatalogPresence(lc, { present, provider, now, thresholds }), provider };
  }
  return next;
}

/** The subset of `fullStore` this module previously tagged as belonging to `provider`. */
function sliceByProvider(fullStore, provider) {
  const slice = {};
  for (const [id, lc] of Object.entries(fullStore || {})) {
    if (lc && lc.provider === provider) slice[id] = lc;
  }
  return slice;
}

/**
 * Read the shared lifecycle store straight off disk, deliberately bypassing
 * model_catalog_store.mjs's mtime/TTL cache: discovery cycles are hourly, not
 * a request hot path, and this module writes the same file directly
 * (`saveLifecycleStore` below) without warming that module's private cache,
 * so reading through it here could serve a pre-write copy across cycles that
 * run inside one process (e.g. tests) within its TTL window. A fresh read
 * costs nothing at this cadence and keeps this module's read/write pair
 * self-consistent. Fail-soft: missing/unreadable/malformed file => `{}`.
 */
function loadLifecycleStoreFresh(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Persist the lifecycle store to `path`. Fail-soft: a write error never breaks a discovery cycle. */
function saveLifecycleStore(store, path) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2));
  } catch {
    // persistence is best-effort, see doc comment on discoverCatalog's
    // lifecycleStorePath handling below.
  }
}

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
  const {
    localModels = [],
    nvidiaFetch,
    openrouterFetch,
    cache = {},
    now = Date.now,
    // Card P1.3: where the shared model lifecycle store (model_catalog_store.mjs)
    // lives. Defaults to the same real path recordModelOutcome() writes
    // (router.mjs), so production discovery cycles feed catalog-absence
    // signals into it with zero extra wiring; tests redirect it via the
    // SKGATEWAY_MODEL_CATALOG_STORE_PATH env var (same convention as
    // tests/router-model-outcome.test.mjs) or by passing this opt directly.
    lifecycleStorePath = LIFECYCLE_STORE_PATH,
    thresholds = LIFECYCLE_THRESHOLDS,
  } = opts;
  const at = now();
  let stale = false;
  let nvidia = [];
  let openrouter = [];
  let nvidiaOk = false;
  let openrouterOk = false;
  try {
    nvidia = parseNvidia(await nvidiaFetch());
    nvidiaOk = true;
    recordProvider(cache, 'nvidia', { ok: true, count: nvidia.length, at });
  } catch (e) {
    stale = true;
    nvidia = (cache.models || []).filter((m) => m.provider === 'nvidia');
    recordProvider(cache, 'nvidia', { ok: false, count: nvidia.length, at, error: String(e?.message || e) });
  }
  try {
    openrouter = parseOpenRouterFree(await openrouterFetch());
    openrouterOk = true;
    recordProvider(cache, 'openrouter', { ok: true, count: openrouter.length, at });
  } catch (e) {
    stale = true;
    openrouter = (cache.models || []).filter((m) => m.provider === 'openrouter');
    recordProvider(cache, 'openrouter', { ok: false, count: openrouter.length, at, error: String(e?.message || e) });
  }

  // Catalog-absence tracking (card P1.3): only a REAL live fetch is evidence
  // of presence/absence. A provider that threw this cycle fell back to the
  // discovery cache above (`stale = true`) - that is a fetch outage, not
  // proof any model actually left the catalog, so it must never count toward
  // a model's absent_cycles. Fail-soft: this is per-node derived bookkeeping,
  // never allowed to break a discovery cycle.
  if (lifecycleStorePath) {
    try {
      const fullStore = loadLifecycleStoreFresh(lifecycleStorePath);
      let updated = { ...fullStore };
      if (nvidiaOk) {
        const reconciled = reconcilePresence(
          sliceByProvider(fullStore, 'nvidia'),
          nvidia.map((m) => m.id),
          'nvidia',
          at,
          thresholds,
        );
        updated = { ...updated, ...reconciled };
      }
      if (openrouterOk) {
        const reconciled = reconcilePresence(
          sliceByProvider(fullStore, 'openrouter'),
          openrouter.map((m) => m.id),
          'openrouter',
          at,
          thresholds,
        );
        updated = { ...updated, ...reconciled };
      }
      if (nvidiaOk || openrouterOk) saveLifecycleStore(updated, lifecycleStorePath);
    } catch {
      // fail-soft, see doc comment above.
    }
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
