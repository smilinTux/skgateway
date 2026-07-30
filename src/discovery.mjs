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

export async function discoverCatalog(opts) {
  const { localModels = [], nvidiaFetch, openrouterFetch, cache = {}, now = Date.now } = opts;
  let stale = false;
  let nvidia = [];
  let openrouter = [];
  try {
    nvidia = parseNvidia(await nvidiaFetch());
  } catch {
    stale = true;
    nvidia = (cache.models || []).filter((m) => m.provider === 'nvidia');
  }
  try {
    openrouter = parseOpenRouterFree(await openrouterFetch());
  } catch {
    stale = true;
    openrouter = (cache.models || []).filter((m) => m.provider === 'openrouter');
  }
  const models = mergeCatalog(localModels, nvidia, openrouter).map((m) => ({ ...m, stale }));
  cache.models = models;
  // Freshness observability: record when this discovery cycle completed. The
  // cycle is fail-soft (a throwing provider falls back to cache above and only
  // flips `stale`), so a completed cycle always advances the timestamp, even a
  // partially-stale one. `lastRefreshedAt` is unix ms; `now` is injectable so
  // tests can drive the clock deterministically.
  cache.lastRefreshedAt = now();
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
 * @returns {{lastRefreshedAt:(number|null), ageSeconds:(number|null), refreshSeconds:number, providerCounts:object, total:number, freeCount:number}}
 */
export function catalogStatus({ catalog = [], cache = {}, refreshSeconds = 0, now = Date.now } = {}) {
  const lastRefreshedAt = typeof cache.lastRefreshedAt === 'number' ? cache.lastRefreshedAt : null;
  const ageSeconds = lastRefreshedAt == null ? null : Math.max(0, Math.round((now() - lastRefreshedAt) / 1000));
  const providerCounts = {};
  let freeCount = 0;
  for (const m of catalog) {
    const p = m.provider || m.owned_by || 'unknown';
    providerCounts[p] = (providerCounts[p] || 0) + 1;
    if (m.free) freeCount += 1;
  }
  return {
    lastRefreshedAt,
    ageSeconds,
    refreshSeconds,
    providerCounts,
    total: catalog.length,
    freeCount,
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
