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
  const { localModels = [], nvidiaFetch, openrouterFetch, cache = {} } = opts;
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
  return { models, stale };
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
