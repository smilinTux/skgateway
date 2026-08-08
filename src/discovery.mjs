// Pure provider parsing/filtering. Network + cache live in this file too (Task 2)
// but these three functions never touch the network.
//
// isChatModel/parseNvidia/parseOpenRouterFree predate the provider-adapter
// split (card P2.1, src/discovery/providers/{nvidia,openrouter}.mjs). They
// are kept here, byte-for-byte behavior-compatible, because tests/discovery.
// test.mjs imports and asserts their exact id-only output shape directly.
// discoverCatalog() below no longer calls them: it calls the adapters'
// normalize() so the merged catalog carries the full ModelCard (design doc
// 4.1) instead of discarding everything but the id. The adapters duplicate
// the same NON_CHAT/isFree filters (see the doc comment in each adapter for
// why: importing them from here would make discovery.mjs and the adapters it
// imports circularly dependent).

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
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as yamlLoad } from 'js-yaml';
import { defaultLifecycle, applyCatalogPresence, THRESHOLDS as LIFECYCLE_THRESHOLDS } from './discovery/lifecycle.mjs';
import { STORE_PATH as LIFECYCLE_STORE_PATH } from './discovery/model_catalog_store.mjs';
import * as nvidiaAdapter from './discovery/providers/nvidia.mjs';
import * as openrouterAdapter from './discovery/providers/openrouter.mjs';
import {
  probeModels,
  DEFAULT_PROBE_BUDGET,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS as DEFAULT_PROBE_MAX_TOKENS,
  DEFAULT_POOL_BACKEND_ID,
} from './discovery/probe.mjs';
import { getPool } from './proxy/connection-pool.mjs';

const CACHE_PATH = join(homedir(), '.config', 'skgateway', 'model_catalog_cache.json');

// Card P2.2: the committed manual card overlay (config/model-cards.overrides.yaml),
// resolved relative to this file so it works the same from any cwd.
const __dirname = dirname(fileURLToPath(import.meta.url));
export const CARD_OVERRIDES_PATH = resolve(__dirname, '..', 'config', 'model-cards.overrides.yaml');

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

/**
 * Load the manual card overlay (card P2.2, design doc 5.1 item 2 / section
 * 2.6): Chef's validated per-model knowledge (context windows, known-slow
 * flags) preserved as committed data instead of living only in YAML
 * comments. Fail-soft, matching every other store loader in this module: a
 * missing file, malformed YAML, or a file with no top-level `overrides:` map
 * all yield `{}` so a broken overlay never breaks a discovery cycle.
 *
 * @param {string} [path]
 * @returns {Record<string, object>} model id -> override fields (e.g. `{context_length, notes}`)
 */
export function loadCardOverrides(path = CARD_OVERRIDES_PATH) {
  try {
    const parsed = yamlLoad(readFileSync(path, 'utf8'));
    const overrides = parsed && typeof parsed === 'object' ? parsed.overrides : null;
    return overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
  } catch {
    return {};
  }
}

/**
 * Apply the manual overlay to one merged-catalog entry (card P2.2, extended by
 * the model-dex work). Precedence (design doc 5.1): fresh provider card >
 * manual overlay > heuristic > (nothing). A "fresh provider card" is any card
 * whose `source` is a live provider (e.g. OpenRouter, whose adapter always
 * ships a full provider-declared card): it is left untouched. Everything else
 * is created-or-enriched from the operator-curated overlay and tagged
 * `source:'manual'`:
 *   - a `source:'heuristic'` card (NVIDIA bare-id parsing) is enriched;
 *   - a card-LESS entry (a static/config model like claude or a local ornith,
 *     which discovery never gives a card) has a card CREATED from the overlay,
 *     so our own curated cards can feed the ranker + the model dex.
 * Pure: no I/O, returns a new object rather than mutating `model`.
 *
 * @param {object} model a merged-catalog entry, `{id, provider, free, card?}`
 * @param {Record<string, object>} overrides id -> override fields
 * @returns {object} `model`, overlaid when applicable
 */
const _FRESH_PROVIDER_SOURCES = new Set(["openrouter"]);

export function applyCardOverlay(model, overrides) {
  const override = overrides && overrides[model.id];
  if (!override) return model;
  const src = model.card && model.card.source;
  // Never clobber a live provider's authoritative card.
  if (src && _FRESH_PROVIDER_SOURCES.has(src)) return model;
  return {
    ...model,
    card: {
      ...(model.card || {}),
      ...override,
      source: 'manual',
    },
  };
}

/** Apply the manual overlay across a whole merged catalog (card P2.2). */
export function applyCardOverlays(models, overrides) {
  return models.map((m) => applyCardOverlay(m, overrides));
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

// fetchNvidia/fetchOpenRouter now delegate to the provider adapters (card
// P2.1); kept as named exports here because src/index.mjs's refreshCatalog()
// imports them by these names to build discoverCatalog()'s injected
// nvidiaFetch/openrouterFetch opts.
export async function fetchNvidia(apiKey) {
  return nvidiaAdapter.fetch(apiKey);
}

export async function fetchOpenRouter() {
  return openrouterAdapter.fetch();
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

/**
 * Real (network) implementation of the probe sweep's `runProbe` (card P2.3,
 * design 5.2): one warm one-word completion against NVIDIA's chat-completions
 * endpoint, aborted at `timeoutMs`. This is the same "warm one-word probe"
 * methodology Chef previously ran by hand with curl. Used only as the
 * production default when `discoverCatalog()` isn't given an explicit
 * `probeRunProbe` (tests always inject one, so this never runs under test).
 * Fail-soft: any error (including no api key) resolves `{ ok: false }`
 * rather than throwing, matching every other network call in this module.
 */
async function nvidiaCompletionProbe(id, { timeoutMs, maxTokens }, apiKey) {
  if (!apiKey) return { ok: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await globalThis.fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: id,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal: controller.signal,
    });
    return { ok: r.ok, status: r.status };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
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
    // Card P2.2: manual card overlay. `cardOverrides`, when provided
    // (tests), is used as-is; otherwise it is loaded fresh from
    // `cardOverridesPath` every cycle (hourly cadence, cheap to re-read, and
    // keeps a config edit picked up without a process restart, matching
    // config.mjs's SIGHUP-reload philosophy elsewhere in this codebase).
    cardOverridesPath = CARD_OVERRIDES_PATH,
    cardOverrides,
    // Card P2.3 (EOL probe sweep, design 5.2): piggybacks on this same
    // (hourly) refresh cadence rather than a new timer. Each cycle checks
    // `cache.lastProbedAt` against `probeSeconds` and only runs the sweep
    // when it is actually due; `probeSeconds <= 0` disables it entirely.
    // Defaults to OFF (0), not `DEFAULT_PROBE_SECONDS`: this keeps every
    // existing caller of `discoverCatalog()` (production call sites that
    // don't yet thread `discovery.probe_seconds` through, and every
    // pre-P2.3 test) behavior-identical unless a caller explicitly opts in.
    // `DEFAULT_PROBE_SECONDS` (daily, design 5.2) is exported from probe.mjs
    // for that future opt-in wiring (`probeSeconds: cfg.discovery
    // ?.probe_seconds ?? DEFAULT_PROBE_SECONDS`) to use as its own default.
    // All of `probeBudget`/`probeTimeoutMs`/`probeMaxTokens`/`probePool`/
    // `probeRunProbe`/`probeProvider`/`nvidiaApiKey` are injectable so tests
    // never touch the network; production leaves them at their defaults
    // (the real NVIDIA connection pool + a real warm-probe completion call).
    probeSeconds = 0,
    probeBudget = DEFAULT_PROBE_BUDGET,
    probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    probeMaxTokens = DEFAULT_PROBE_MAX_TOKENS,
    probePool,
    probeRunProbe,
    probeProvider = 'nvidia',
    nvidiaApiKey = process.env.NVIDIA_API_KEY,
  } = opts;
  const at = now();
  let stale = false;
  let nvidia = [];
  let openrouter = [];
  let nvidiaOk = false;
  let openrouterOk = false;
  try {
    // Card P2.1: normalize() (not the legacy parseNvidia()) so the merged
    // catalog carries the full ModelCard, not just the id.
    nvidia = nvidiaAdapter.normalize(await nvidiaFetch(), { now: () => at });
    nvidiaOk = true;
    recordProvider(cache, 'nvidia', { ok: true, count: nvidia.length, at });
  } catch (e) {
    stale = true;
    nvidia = (cache.models || []).filter((m) => m.provider === 'nvidia');
    recordProvider(cache, 'nvidia', { ok: false, count: nvidia.length, at, error: String(e?.message || e) });
  }
  try {
    // Card P2.1: normalize() (not the legacy parseOpenRouterFree()); the free
    // filter and non-chat filter are unchanged, only the discarded fields
    // are now kept (design doc 5.1).
    openrouter = openrouterAdapter.normalize(await openrouterFetch(), { now: () => at });
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

  // EOL probe sweep (card P2.3, design 5.2): off the request path, budgeted,
  // and cadenced independently of this (hourly) refresh interval. Runs at
  // most once every `probeSeconds`, tracked via `cache.lastProbedAt` the same
  // way `cache.lastRefreshedAt` tracks the refresh cadence, so it needs no
  // timer of its own. Reads the freshly-reconciled store (after the
  // catalog-absence block above) so probe candidates reflect this cycle's
  // presence signals, not last cycle's. Fail-soft throughout: a probe or
  // store failure here must never break a discovery cycle.
  if (lifecycleStorePath && probeSeconds > 0) {
    try {
      const dueAt = (typeof cache.lastProbedAt === 'number' ? cache.lastProbedAt : -Infinity) + probeSeconds * 1000;
      if (at >= dueAt) {
        const storeForProbe = loadLifecycleStoreFresh(lifecycleStorePath);
        const runProbe =
          probeRunProbe || ((id, o) => nvidiaCompletionProbe(id, o, nvidiaApiKey));
        const probed = await probeModels(storeForProbe, {
          budget: probeBudget,
          timeoutMs: probeTimeoutMs,
          maxTokens: probeMaxTokens,
          provider: probeProvider,
          pool: probePool || getPool(),
          poolBackendId: DEFAULT_POOL_BACKEND_ID,
          now: () => at,
          runProbe,
        });
        saveLifecycleStore(probed, lifecycleStorePath);
        cache.lastProbedAt = at;
      }
    } catch {
      // fail-soft, see doc comment above.
    }
  }

  const overrides = cardOverrides || loadCardOverrides(cardOverridesPath);
  const models = applyCardOverlays(mergeCatalog(localModels, nvidia, openrouter), overrides).map((m) => ({ ...m, stale }));
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
