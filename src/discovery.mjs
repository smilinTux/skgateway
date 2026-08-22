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

// Card C13: the single source of truth is discovery/classify.mjs. This export
// is kept because tests/discovery.test.mjs asserts its exact id-only behavior,
// and because parseNvidia/parseOpenRouterFree below are the pre-adapter
// functions whose output shape those tests pin.
import { isChatModelId } from './discovery/classify.mjs';

/** Kept as a named export: tests/discovery.test.mjs pins this exact behavior. */
export const isChatModel = isChatModelId;

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
import {
  STORE_PATH as LIFECYCLE_STORE_PATH,
  assertNotProductionStoreInTest,
  isTestRun,
} from './discovery/model_catalog_store.mjs';
import * as nvidiaAdapter from './discovery/providers/nvidia.mjs';
import * as openrouterAdapter from './discovery/providers/openrouter.mjs';
import * as opencodeAdapter from './discovery/providers/opencode.mjs';
import * as anthropicWrapperAdapter from './discovery/providers/anthropic-wrapper.mjs';
import {
  probeModels,
  DEFAULT_PROBE_BUDGET,
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS as DEFAULT_PROBE_MAX_TOKENS,
  DEFAULT_POOL_BACKEND_ID,
} from './discovery/probe.mjs';
import { getPool } from './proxy/connection-pool.mjs';
import { getConfig } from './config.mjs';
// Pure predicates, no imports of their own, so this cannot cycle back here.
// Reused rather than re-derived so servingConfigModels() and
// advertise.mjs's tagLocalModels() can never disagree about which ids are paid.
import { isAnthropicBackend, isAnthropicModelId } from './proxy/anthropic-adapter.mjs';

/**
 * The real, per-node discovery cache path, ignoring any env override. Kept
 * separate from CACHE_PATH so the test guard below still knows which file is
 * the live one even when a suite has pointed CACHE_PATH somewhere safe. Same
 * split model_catalog_store.mjs uses for the lifecycle store.
 */
export const PRODUCTION_CACHE_PATH = join(homedir(), '.config', 'skgateway', 'model_catalog_cache.json');

/**
 * Discovery cache path, env override honoured.
 *
 * THE OVERRIDE IS NOT NEW, IT WAS ONLY HALF WIRED. router.mjs has read
 * `SKGATEWAY_MODEL_CATALOG_CACHE_PATH` for its MATCH_CATALOG_CACHE_PATH since
 * card P4.2, but the WRITER here ignored it and always used the production
 * path. Reader and writer could therefore point at two different files under
 * the same env var, which is its own bug, and it meant no suite could redirect
 * the write at all.
 *
 * Measured 2026-08-16: `~/.config/skgateway/model_catalog_cache.json` held 96
 * models, 79 nvidia, 16 openrouter and exactly one `local` whose id was
 * `c3-neutral`. That id exists nowhere on this fleet; it is the fixture in
 * tests/refresh-catalog-probe-wiring.test.mjs. The live daemon's in-memory
 * catalog at the same moment held 111 models (anthropic 4, local 3,
 * chiap08-qwen38 2, opencode 7, nvidia 79, openrouter 16), i.e. the daemon
 * had produced a CORRECT catalog including every sovereign and Anthropic
 * model and written it here, and the test suite then overwrote the file. Three
 * `npm test` runs were observed advancing its mtime and lastRefreshedAt while
 * dropping the anthropic, local and opencode rows.
 *
 * This is the same class of defect card affa0aac / C2 fixed for the lifecycle
 * store, on the second file in the same directory: running the test suite was
 * a fleet mutation event. See [[test-suites-write-to-the-real-fleet]].
 */
const CACHE_PATH =
  process.env.SKGATEWAY_MODEL_CATALOG_CACHE_PATH || PRODUCTION_CACHE_PATH;

/**
 * Refuse to let a test run write the live discovery cache. Mirrors
 * assertNotProductionStoreInTest() exactly, including throwing rather than
 * no-opping: a silent refusal is the same shape of problem as the silent write
 * it replaces. tests/_setup.mjs is the belt (it defaults the env var for every
 * test process before any module is imported); this is the brace, for a runner
 * invoked without `--import ./tests/_setup.mjs`.
 *
 * @param {string} path the path a writer is about to open
 * @throws {Error} when a test run targets the live cache
 */
export function assertNotProductionCacheInTest(path) {
  if (!isTestRun()) return;
  if (resolve(path) !== resolve(PRODUCTION_CACHE_PATH)) return;
  throw new Error(
    `refusing to write the production discovery cache from a test run: ${PRODUCTION_CACHE_PATH}. ` +
      'Set SKGATEWAY_MODEL_CATALOG_CACHE_PATH to a temp path before importing any module ' +
      'that captures it (discovery.mjs and router.mjs both bind it at module load).',
  );
}

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

/**
 * The ids this provider is DECLARED to serve in the gateway config
 * (`backends.<provider>.models`), as a Set. Wildcard patterns are skipped:
 * they are not concrete ids and cannot be reconciled against a catalog.
 *
 * Fail-soft: getConfig() throws when no config has been loaded (every unit
 * test that never boots the gateway), and a missing declaration list simply
 * means we fall back to the previous behavior for that provider.
 *
 * @param {string} provider
 * @returns {Set<string>}
 */
function declaredModelsFor(provider) {
  try {
    const models = getConfig()?.backends?.[provider]?.models;
    if (!Array.isArray(models)) return new Set();
    return new Set(models.filter((m) => typeof m === 'string' && !m.includes('*')));
  } catch {
    return new Set();
  }
}

/**
 * The concrete model ids DECLARED by backends other than `probeProvider`
 * (incident inc-2026-08-18-qwen38-eol / problem
 * prob-2026-08-18-model-discovery-validation).
 *
 * The probe sweep for a provider hits that ONE provider's endpoint, so a 410
 * from it is evidence about that provider only. An id a different backend
 * declares — a local llama.cpp alias like `qwen38-abliterated` on chiap08, or
 * a multi-provider id still live on another remote provider — must not be
 * retired on one provider's say-so: "only EOL if ALL providers fail". Those
 * ids are excluded from the sweep (probe.mjs's `excludedIds`); the
 * claimer's own 410s from real traffic still count via the claimer-aware
 * `recordModelOutcome()` (model_catalog_store.mjs), so a genuinely dead
 * model on its only claimer is still condemned.
 *
 * Wildcard patterns (`dolphin-*`) are skipped: they are patterns, not ids,
 * the same convention `declaredModelsFor()` follows. Fail-soft like
 * `declaredModelsFor()`: no config loaded => empty set => the sweep behaves
 * exactly as before.
 *
 * @param {string} probeProvider the provider the sweep probes (e.g. 'nvidia')
 * @param {Record<string, {models?: string[]}>} [backends] config.backends; omit to read the live config
 * @returns {Set<string>}
 */
export function declaredModelsElsewhere(probeProvider, backends) {
  if (backends === undefined) {
    try {
      backends = getConfig()?.backends;
    } catch {
      backends = undefined;
    }
  }
  const out = new Set();
  for (const [name, b] of Object.entries(backends || {})) {
    if (name === probeProvider || !b) continue;
    for (const m of b.models || []) {
      if (typeof m === 'string' && !m.includes('*')) out.add(m);
    }
  }
  return out;
}

/**
 * The subset of `fullStore` that belongs to `provider` for presence
 * reconciliation, plus the ids `provider` is declared to serve.
 *
 * CARD 7330bb05 / C1, the root cause of the 2026-08-14 catalog inversion.
 * This used to return ONLY entries already carrying `lc.provider === provider`.
 * Lifecycle records born on the completion path never carry that tag:
 * `recordModelOutcome()` writes `applyCompletionOutcome()` output, and none of
 * lifecycle.mjs's completion transitions set `provider` (only
 * `reconcilePresence` does). So a model declared in `backends.<provider>.models`
 * that the live fetch never returns could never enter presence reconciliation:
 * it could not accumulate `absent_cycles`, could not reach `absentEolThreshold`,
 * and was structurally immune to the very mechanism built to retire it.
 *
 * Measured consequence: 7 ids gone from NVIDIA's catalog sat at
 * `absent_cycles: 0, provider: null` while being advertised, and 6 of them
 * answered 410 to a real completion. Their only remaining death path was three
 * consecutive permanent errors from REAL traffic, which bills a caller a failed
 * request per increment.
 *
 * The declaration is the missing third input alongside the store and the fetch.
 * Two deliberate constraints:
 *
 *   - A declared id is only adopted when the record has NO provider tag. We
 *     never steal an id already attributed to a different provider, because
 *     reconciling it against the wrong catalog would retire a live model.
 *   - A declared id with no store record at all is seeded with
 *     `defaultLifecycle()` so it enters the sweep on the very first cycle.
 *     Declared-but-never-seen is exactly the "config bug" case this must catch,
 *     and it has no record precisely because nothing has ever routed to it.
 *
 * This does NOT guess a provider for untagged completion-path records. A model
 * id alone does not identify its backend; only the config declaration does.
 *
 * @param {Record<string, object>} fullStore
 * @param {string} provider
 * @param {Set<string>} [declaredIds]
 * @returns {Record<string, object>}
 */
function sliceByProvider(fullStore, provider, declaredIds = new Set()) {
  const slice = {};
  for (const [id, lc] of Object.entries(fullStore || {})) {
    if (!lc) continue;
    if (lc.provider === provider) slice[id] = lc;
    else if (!lc.provider && declaredIds.has(id)) slice[id] = lc;
  }
  for (const id of declaredIds) {
    if (!(id in slice)) slice[id] = defaultLifecycle();
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
  // Card affa0aac / C2: this module writes the store directly, so it needs the
  // same test guard as model_catalog_store.mjs's own writer. It sits outside
  // the try because everything inside is swallowed by design.
  assertNotProductionStoreInTest(path);
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
// Card C8: 'models.dev' added alongside 'openrouter'. opencode.mjs's card is
// a live provider-declared card (models.dev's opencode registry), not a
// heuristic guess, so it deserves the same protection from the manual
// overlay that openrouter's card gets. The null-card fallback path (a
// models.dev outage, see opencode.mjs's normalize()) sets `card: null`, so
// `src` below is undefined for that entry and it stays eligible for overlay
// enrichment, same as NVIDIA's heuristic cards.
const _FRESH_PROVIDER_SOURCES = new Set(["openrouter", "models.dev"]);

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

export function mergeCatalog(local, nvidia, openrouter, opencode, anthropic) {
  const seen = new Map();
  for (const group of [local || [], nvidia || [], openrouter || [], opencode || [], anthropic || []]) {
    for (const m of group) {
      if (!seen.has(m.id)) seen.set(m.id, m);
    }
  }
  return [...seen.values()];
}

/**
 * The models the gateway is CONFIGURED TO SERVE, as catalog entries.
 *
 * THE INVARIANT THIS EXISTS TO ENCODE: a model the gateway is configured to
 * serve is a model the router may match. Discovery ENRICHES that set; it must
 * not DEFINE it. Before this function, the live bucket/@match path defined the
 * set purely from the on-disk discovery cache, and discovery has exactly three
 * provider adapters (nvidia, openrouter, opencode). There is no Anthropic
 * adapter and no adapter for our own hardware, so no amount of refreshing
 * could ever put a Claude model or an Ornith model in that file. Measured on
 * this node 2026-08-16: GET /v1/models served 66 models including
 * ornith-1.0-9b, ornith-tiny and four claude-* ids, while the cache the router
 * matched against held 96 models of which 79 were nvidia, 16 openrouter and
 * exactly one `local` (id `c3-neutral`, which is not in any current config).
 * Neither Ornith nor any Claude model appeared. The cache was FRESH and wrong,
 * not stale and wrong, so nothing about it looked broken.
 *
 * The consequence lands precisely where sovereignty matters. `secret` has a
 * trust-zone ceiling of 0 and `internal` a ceiling of 1, so an sk-*-secret
 * bucket could only ever be filled by a local model and an sk-*-internal one
 * by a local or Anthropic model. With neither in the catalog those buckets
 * find no eligible member and 503, while the zone-2 free-remote cloud buckets
 * resolve fine. The feature fails exactly where it matters and succeeds where
 * it does not.
 *
 * SHAPE. `{id, provider, free, url}`, the same shape the provider adapters
 * emit plus the serving url:
 *   - `provider` is the OWNING BACKEND NAME, never a blanket "local", because
 *     that is what capabilities.mjs's resolveProviderPosture() keys on to find
 *     a data_retention posture (`anthropic`, `anthropic-direct`, `local`, ...).
 *   - `free` follows tagLocalModels()'s existing rule exactly: a paid cloud
 *     backend (isAnthropicBackend) OR a paid model family by id
 *     (isAnthropicModelId) is not free, even when the serving backend is the
 *     loopback claude-code-api wrapper. Getting this wrong would make
 *     deriveSovereignty() read a paid Claude as sovereign `local` compute
 *     purely because the network hop is 127.0.0.1.
 *   - `url` is carried because deriveSovereignty() falls back to
 *     `isLocalUrl(url)` for any model with no operator-declared `tier`. Drop
 *     it and `ornith-tiny` (no overlay entry) derives as `free-remote`, i.e.
 *     trust zone 2, i.e. silently excluded from every `secret` bucket. A
 *     sovereign model landing in the exposed zone is the failure this whole
 *     card is about, so the url is not optional.
 *
 * EVERY backend is included, not just the non-discovery ones.
 * advertise.mjs's tagLocalModels() skips `nvidia` and `openrouter` because
 * their ids are supposed to come from the live fetch, and for a /v1/models
 * DISPLAY tag that is right. It is wrong for a MATCH set: measured on this
 * node, 7 of the 9 concrete ids declared under `backends.nvidia.models`
 * (qwen3.5-122b-a10b, qwen3.5-397b-a17b, deepseek-v4-flash, deepseek-v4-pro,
 * mistral-medium-3.5-128b, mistral-large-3-675b, minimax-m2.7) were absent
 * from the discovery cache while buildModelCatalog() advertised all nine on
 * /v1/models. Declared-but-undiscovered is still served, so it is still
 * matchable. Wildcards (`dolphin-*`) are skipped: they are patterns, not ids,
 * exactly as tagLocalModels() and buildModelCatalog() already skip them.
 *
 * Pure: the caller passes `backends` (config.backends). No I/O here.
 *
 * @param {Record<string, {models?: string[], url?: string, auth_type?: string}>} [backends]
 * @returns {Array<{id:string, provider:string, free:boolean, url?:string}>}
 */
export function servingConfigModels(backends = {}) {
  const out = [];
  if (!backends || typeof backends !== 'object') return out;
  for (const [name, b] of Object.entries(backends)) {
    const paidBackend = isAnthropicBackend(b);
    for (const id of (b && b.models) || []) {
      if (typeof id !== 'string' || id.includes('*')) continue;
      const paid = paidBackend || isAnthropicModelId(id);
      const entry = { id, provider: name, free: !paid };
      if (typeof b.url === 'string' && b.url) entry.url = b.url;
      out.push(entry);
    }
  }
  return out;
}

/**
 * Union one serving-config entry with the discovery entry of the same id.
 *
 * WHICH SIDE WINS, and why. Discovery wins on every field it actually carries;
 * serving config supplies EXISTENCE and fills only the fields discovery has no
 * value for (in practice `url`, which no provider adapter emits).
 *
 * The reason is that a discovery entry is EVIDENCE and a serving-config entry
 * is a DECLARATION. The adapters return a provider-declared or probed `card`
 * (context_length, supported_parameters, size_class off a published parameter
 * count), a pricing-derived `free`, and a `stale` flag from the fetch cycle
 * that produced them. A serving-config entry knows none of that; it knows only
 * that an operator wrote the id under a backend. Letting the declaration win
 * would overwrite measured capability data with nothing, which is how a model
 * with a perfectly good discovered card ends up failing a class floor.
 *
 * Note this is deliberately NOT the precedence in mergeCatalog(), which puts
 * `local` first and lets first-seen win the WHOLE entry. That order is correct
 * inside discoverCatalog(), where the static list is the only description of a
 * static model and the provider groups describe disjoint id spaces. Here the
 * two sides overlap on real ids (the nine nvidia declarations above), so a
 * whole-entry winner would have to discard one side's data. A field-level
 * merge discards neither.
 *
 * The same rule also decides `provider`, and that direction is the fail-closed
 * one. If an id is reachable BOTH through a remote provider and through a
 * locally-declared backend, keeping the discovered provider keeps the worse
 * data-retention posture (`trains`, zone 2) rather than relabelling the model
 * sovereign because a same-named local backend happens to declare it. No such
 * collision exists on this fleet today; this is which way to fall if one ever
 * appears. Per-door enforcement is unaffected either way: router.mjs's
 * backendTrustZone() still judges the ACTUAL backend at failover time.
 *
 * @param {object} serving
 * @param {object} discovered
 * @returns {object}
 */
function unionEntry(serving, discovered) {
  const merged = { ...serving };
  for (const [k, v] of Object.entries(discovered || {})) {
    if (v !== undefined) merged[k] = v;
  }
  return merged;
}

/**
 * Build the catalog the router MATCHES against: the discovery cache unioned
 * with the configured serving backends, then overlaid with the committed card
 * overlay.
 *
 * THE OVERLAY IS THE POINT, not a finishing touch. applyCardOverlays() is
 * applied at cache WRITE time (discoverCatalog() below) and at the two admin
 * endpoints in index.mjs, so the curated `size_class` is baked into cached
 * rows rather than attached when they are read. A union performed downstream
 * of this function (say, inside router.mjs's buildMatchCatalog) would add
 * serving-config models that never pass through the overlay at all: they would
 * arrive with no card, meetsClassFloor() would score them `unknown`, and an
 * unknown class clears only floor `S`. claude-opus-4-8 would then be present
 * in the catalog and STILL fail sk-l-secret and sk-xl-internal, which is the
 * original symptom with an extra step. So the union happens HERE, on the same
 * side of the overlay as everything it is unioned with.
 *
 * applyCardOverlays() is idempotent over already-overlaid cached rows: a card
 * whose `source` is a live provider is returned untouched, and re-spreading
 * the same override onto a `source:'manual'` card is a no-op.
 *
 * FAILS CLOSED. The union must never WIDEN membership on an error path. A
 * missing, unreadable or not-yet-loaded config yields zero serving entries and
 * therefore the discovery cache alone, which is exactly today's behaviour, and
 * it is logged rather than swallowed silently. Same for the cache side: an
 * unreadable cache contributes nothing and the serving config stands alone.
 * Neither failure throws into a request path.
 *
 * @param {object} [opts]
 * @param {string} [opts.cachePath] discovery cache to read (defaults to CACHE_PATH)
 * @param {Record<string,object>} [opts.backends] config.backends; omit to read the live config
 * @param {Record<string,object>} [opts.overrides] card overlay; omit to read the committed file
 * @returns {Array<object>} merged catalog entries, overlay applied
 */
export function buildServingCatalog(opts = {}) {
  let cached = [];
  try {
    const cache = loadCache(opts.cachePath || CACHE_PATH);
    if (Array.isArray(cache && cache.models)) cached = cache.models;
  } catch {
    // loadCache is already fail-soft; belt and braces so a surprise here
    // degrades to "serving config only" rather than breaking routing.
  }

  let serving = [];
  if (opts.backends !== undefined) {
    serving = servingConfigModels(opts.backends);
  } else {
    try {
      serving = servingConfigModels(getConfig().backends || {});
    } catch (err) {
      // getConfig() throws when no config has been loaded (every unit test
      // that never boots the gateway) and _readAndBuild throws on an invalid
      // one. Either way: no serving entries, no widening.
      console.warn(
        `[skgateway:discovery] serving config unavailable, matching against the discovery cache alone: ${err.message}`,
      );
      serving = [];
    }
  }

  const byId = new Map();
  for (const m of serving) {
    if (m && typeof m.id === 'string' && !byId.has(m.id)) byId.set(m.id, m);
  }
  for (const m of cached) {
    if (!m || typeof m.id !== 'string') continue;
    const existing = byId.get(m.id);
    byId.set(m.id, existing ? unionEntry(existing, m) : m);
  }

  const overrides = opts.overrides || loadCardOverrides();
  return applyCardOverlays([...byId.values()], overrides);
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

// Card C8: named export like fetchNvidia/fetchOpenRouter above.
// refreshCatalog() in src/index.mjs DOES pass this through, gated on
// `discovery.providers.opencode.enabled === true` (opt-in, unlike the two
// long-standing providers which are opt-out). Off by default, but reachable:
// setting that config key genuinely enables the provider. Card C3 was the
// cautionary case, where a fully-built feature was unreachable because the
// only production call site never forwarded its option.
export async function fetchOpencode(apiKey) {
  return opencodeAdapter.fetch(apiKey);
}

export async function fetchAnthropicWrapper(baseUrl, token) {
  return anthropicWrapperAdapter.fetch(baseUrl, token);
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
    // Card C8: unlike nvidiaFetch/openrouterFetch above (no default; every
    // production call site is required to supply a real one, and every test
    // is required to supply a mock), opencodeFetch DOES default, to a stub
    // that resolves successfully with zero models. Two reasons:
    //   1. src/index.mjs's refreshCatalog() is NOT wired to pass an
    //      opencodeFetch opt yet (deliberate: this card's scope is the
    //      adapter + this module + config/skgateway.yaml.example, not the
    //      production call site, and the live config must NOT enable this
    //      provider yet per the card - see acceptance criteria). Production
    //      therefore always hits this default today, and it must behave as
    //      "not configured" (an empty, successful cycle), not as "outage"
    //      (which would set `stale: true` on every single discovery cycle
    //      the moment this branch ships, for a provider nobody turned on).
    //   2. Every existing test in this suite that calls discoverCatalog()
    //      predates this provider and does not pass opencodeFetch. Making it
    //      required like nvidiaFetch/openrouterFetch would flip `stale` to
    //      true on all of them.
    opencodeFetch = async () => ({ zen: { data: [] }, modelsDev: null }),
    anthropicFetch = null,
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
    // Card C1: the ids each provider is DECLARED to serve
    // (backends.<provider>.models). Injectable so tests can exercise the
    // declared-but-absent path without booting a config; production resolves
    // it per cycle from the live config via declaredModelsFor().
    declaredModels,
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
    // Incident inc-2026-08-18-qwen38-eol: ids another backend declares are
    // excluded from THIS provider's sweep (see declaredModelsElsewhere). 
    // Injectable for tests; the default reads the live config.
    probeExcludedIds = declaredModelsElsewhere(probeProvider),
    nvidiaApiKey = process.env.NVIDIA_API_KEY,
    // Card 2ba73bf9 / C9 (measurement half): the tier-2 capability battery
    // rides this same probe sweep (see probe.mjs's probeModels doc comment).
    // Threaded through here the same way probeSeconds/probeBudget/etc. were
    // BEFORE card 1f65cf45/C3 wired index.mjs's refreshCatalog() to actually
    // pass them: this function supports the knobs correctly, but nothing in
    // this repo's index.mjs reads a `discovery.capability_*` config key yet,
    // so production never reaches this path today. That is deliberate, not
    // an oversight: C9's measurement half is out-of-scope for touching
    // index.mjs or enabling anything in live config (both explicitly
    // reserved). Whoever wires cfg.discovery through should follow the exact
    // pattern C3 used for probeSeconds, and should NOT add a
    // `discovery.capability_seconds`-shaped config doc comment until that
    // wiring lands, for the same reason C3 itself exists: documenting a key
    // nothing reads is worse than not documenting it.
    capabilityBudget,
    capabilityIntervalMs,
    capabilityTimeoutMs,
    chatComplete,
    probeRunCapabilityAssessment,
  } = opts;
  const at = now();
  let stale = false;
  let nvidia = [];
  let openrouter = [];
  let opencode = [];
  let anthropic = [];
  let nvidiaOk = false;
  let openrouterOk = false;
  let opencodeOk = false;
  let anthropicOk = false;
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
  try {
    // Card C8: opencodeAdapter.fetch() throws only on a Zen failure (a real
    // provider outage); a models.dev-only failure is swallowed inside the
    // adapter and surfaces here as a successful fetch with `modelsDev: null`,
    // which normalize() turns into null-card entries rather than an empty
    // list (see opencode.mjs's doc comments for both fetch() and normalize()).
    opencode = opencodeAdapter.normalize(await opencodeFetch(), { now: () => at });
    opencodeOk = true;
    recordProvider(cache, 'opencode', { ok: true, count: opencode.length, at });
  } catch (e) {
    stale = true;
    opencode = (cache.models || []).filter((m) => m.provider === 'opencode');
    recordProvider(cache, 'opencode', { ok: false, count: opencode.length, at, error: String(e?.message || e) });
  }
  if (typeof anthropicFetch === 'function') {
    try {
      anthropic = anthropicWrapperAdapter.normalize(await anthropicFetch());
      anthropicOk = true;
      recordProvider(cache, 'anthropic', { ok: true, count: anthropic.length, at });
    } catch (e) {
      stale = true;
      anthropic = (cache.models || []).filter((m) => m.provider === 'anthropic');
      recordProvider(cache, 'anthropic', { ok: false, count: anthropic.length, at, error: String(e?.message || e) });
    }
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
          sliceByProvider(fullStore, 'nvidia', declaredModels?.nvidia ?? declaredModelsFor('nvidia')),
          nvidia.map((m) => m.id),
          'nvidia',
          at,
          thresholds,
        );
        updated = { ...updated, ...reconciled };
      }
      if (openrouterOk) {
        const reconciled = reconcilePresence(
          sliceByProvider(fullStore, 'openrouter', declaredModels?.openrouter ?? declaredModelsFor('openrouter')),
          openrouter.map((m) => m.id),
          'openrouter',
          at,
          thresholds,
        );
        updated = { ...updated, ...reconciled };
      }
      if (opencodeOk) {
        const reconciled = reconcilePresence(
          sliceByProvider(fullStore, 'opencode', declaredModels?.opencode ?? declaredModelsFor('opencode')),
          opencode.map((m) => m.id),
          'opencode',
          at,
          thresholds,
        );
        updated = { ...updated, ...reconciled };
      }
      if (anthropicOk) {
        const reconciled = reconcilePresence(
          sliceByProvider(fullStore, 'anthropic', declaredModels?.anthropic ?? declaredModelsFor('anthropic')),
          anthropic.map((m) => m.id),
          'anthropic',
          at,
          thresholds,
        );
        updated = { ...updated, ...reconciled };
      }
      if (nvidiaOk || openrouterOk || opencodeOk || anthropicOk) saveLifecycleStore(updated, lifecycleStorePath);
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
          excludedIds: probeExcludedIds,
          pool: probePool || getPool(),
          poolBackendId: DEFAULT_POOL_BACKEND_ID,
          now: () => at,
          runProbe,
          // Card 2ba73bf9 / C9: undefined unless a caller explicitly opts in
          // (no production default for chatComplete, mirroring runProbe's own
          // no-silent-network-default discipline); probeModels() treats a
          // missing chatComplete as tier 2 fully disabled, tier 1 unaffected.
          chatComplete,
          runCapabilityAssessment: probeRunCapabilityAssessment,
          capabilityBudget,
          capabilityIntervalMs,
          capabilityTimeoutMs,
        });
        saveLifecycleStore(probed, lifecycleStorePath);
        cache.lastProbedAt = at;
      }
    } catch {
      // fail-soft, see doc comment above.
    }
  }

  const overrides = cardOverrides || loadCardOverrides(cardOverridesPath);
  // Static entries on the Anthropic backends are cold-start seeds only. Once
  // the authenticated wrapper answered successfully, exclude those seeds so
  // an absent/retired id cannot leak back into the cache through localModels.
  const effectiveLocal = anthropicOk
    ? localModels.filter((m) => m.provider !== 'anthropic' && m.provider !== 'anthropic-direct')
    : localModels;
  const models = applyCardOverlays(
    mergeCatalog(effectiveLocal, nvidia, openrouter, opencode, anthropic),
    overrides,
  ).map((m) => ({ ...m, stale }));
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
  // Outside the try, same as saveLifecycleStore(): everything inside is
  // swallowed by design, and a guard that gets swallowed is not a guard.
  assertNotProductionCacheInTest(path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2));
  } catch {
    // cache persistence is best-effort; never throw into a request path
  }
}
