/**
 * model_catalog_store.mjs: thin file-backed persistence for per-model
 * lifecycle records (docs/specs/2026-08-08-model-ranking-routing-intelligence-
 * arch.md section 4.2; card P1.2).
 *
 * Wraps the pure state machine in lifecycle.mjs with a JSON store keyed by
 * model id. This is per-node derived state, like `metrics.db` and discovery's
 * own `model_catalog_cache.json` (src/discovery.mjs): it is NOT Syncthing-
 * synced (only `registry.yaml` policy is). The router's candidate loop calls
 * `recordModelOutcome()` for every completion so 404/410s against an
 * actively-used model count toward EOL detection even without a probe sweep;
 * a later discovery cycle (card P1.3) additionally records catalog-presence
 * signals into the same store.
 *
 * Reads are mtime/TTL cached, like `loadRatings()` in classifiers/empirical.mjs:
 * within `ttlMs` of the last check the in-memory copy is returned with no
 * `stat`/`read` syscall at all; once the TTL has elapsed the file's mtime is
 * checked and the store is only re-parsed if it actually changed. Writes are
 * fail-soft (mirrors `saveCache()` in discovery.mjs): any read, parse, or
 * write failure is swallowed so a store hiccup never reaches a request path.
 *
 * @module discovery/model_catalog_store
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { defaultLifecycle, applyCompletionOutcome } from "./lifecycle.mjs";

/** Absolute path to the lifecycle store JSON (env override honoured). */
export const STORE_PATH =
  process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH ||
  join(homedir(), ".config", "skgateway", "model_catalog_store.json");

/**
 * How long a `loadCatalogStore()` call may serve the in-memory copy before
 * re-checking the file's mtime. Keeps the router's per-request read cost at
 * zero in the common case while still picking up writes from other cycles
 * (discovery presence sweep, admin tools) within a bounded window.
 */
const DEFAULT_TTL_MS = 2000;

// Module-level cache. Path-scoped: a different `path` argument (tests use
// unique temp paths) always forces a fresh stat, so tests never need to reset
// this to avoid cross-test contamination.
let _cache = null;
let _cacheMtime = -1;
let _cachePath = null;
let _lastCheckAt = -1;

/**
 * Load the lifecycle store (model id -> lifecycle record). mtime/TTL cached
 * as described in the module doc comment. Missing or unreadable/malformed
 * file => `{}` (fail-soft; never throws).
 *
 * @param {string} [path]
 * @param {{ttlMs?: number, now?: () => number}} [opts]
 * @returns {Record<string, object>}
 */
export function loadCatalogStore(path = STORE_PATH, opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const clock = opts.now || Date.now;
  const now = clock();

  if (_cache && _cachePath === path && _lastCheckAt >= 0 && now - _lastCheckAt < ttlMs) {
    return _cache;
  }

  try {
    const st = statSync(path);
    if (!(_cache && _cachePath === path && _cacheMtime === st.mtimeMs)) {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw);
      _cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      _cacheMtime = st.mtimeMs;
    }
    _cachePath = path;
    _lastCheckAt = now;
  } catch {
    if (!_cache || _cachePath !== path) {
      _cache = {};
      _cacheMtime = -1;
      _cachePath = path;
    }
    _lastCheckAt = now;
  }
  return _cache;
}

/** Persist `store` to `path` and warm the cache with it. Fail-soft: never throws. */
function saveCatalogStore(store, path) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(store, null, 2));
    _cache = store;
    _cachePath = path;
    _lastCheckAt = Date.now();
    try {
      _cacheMtime = statSync(path).mtimeMs;
    } catch {
      // best-effort mtime warm; a later read will simply re-stat and re-read.
      _cacheMtime = -1;
    }
  } catch {
    // Persistence is best-effort: a write failure (read-only fs, missing
    // permissions, disk full) must never break the caller's request path or
    // discovery cycle.
  }
}

/**
 * Current lifecycle record for `modelId`, or a fresh `defaultLifecycle()` if
 * the model has never been recorded. Never throws.
 *
 * @param {string} modelId
 * @param {string} [path]
 * @returns {object} lifecycle record (shape: lifecycle.mjs `defaultLifecycle()`).
 */
export function getLifecycle(modelId, path = STORE_PATH) {
  try {
    const store = loadCatalogStore(path);
    return store[modelId] || defaultLifecycle();
  } catch {
    return defaultLifecycle();
  }
}

/**
 * Record the outcome of one completion request against `modelId`'s lifecycle
 * (the passive signal from section 4.2: a 2xx resets toward `active`, a
 * 404/410 counts toward `eol`). Fail-soft by construction: any read, parse,
 * or write error is swallowed so a store hiccup never affects the response
 * the router is about to return. This does NOT touch backend health or the
 * router's failover decision; it is purely a bookkeeping side effect.
 *
 * @param {string} modelId
 * @param {{status: number, now?: number}} outcome
 * @param {string} [path]
 * @returns {void}
 */
export function recordModelOutcome(modelId, { status, now = Date.now() } = {}, path = STORE_PATH) {
  if (!modelId) return;
  try {
    const store = loadCatalogStore(path);
    const prev = store[modelId] || defaultLifecycle();
    const next = applyCompletionOutcome(prev, { status, now });
    saveCatalogStore({ ...store, [modelId]: next }, path);
  } catch {
    // fail-soft, see doc comment above.
  }
}

/**
 * Test-only: clear the in-memory cache. Not needed for cross-path isolation
 * (the cache is path-scoped already) but useful when a test reuses one path
 * and wants to force a fresh disk read.
 */
export function _resetCacheForTests() {
  _cache = null;
  _cacheMtime = -1;
  _cachePath = null;
  _lastCheckAt = -1;
}
