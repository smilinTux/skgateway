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
import { join, dirname, resolve } from "node:path";
import { defaultLifecycle, applyCompletionOutcome } from "./lifecycle.mjs";

/** Absolute path to the lifecycle store JSON (env override honoured). */
export const STORE_PATH =
  process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH ||
  join(homedir(), ".config", "skgateway", "model_catalog_store.json");

/**
 * The real, per-node production store path, ignoring any env override.
 * Kept separate from STORE_PATH so the test guard below still knows which file
 * is the live one even when a suite has pointed STORE_PATH somewhere safe.
 */
export const PRODUCTION_STORE_PATH = join(
  homedir(),
  ".config",
  "skgateway",
  "model_catalog_store.json",
);

/**
 * True when this process is running under a test runner.
 *
 * `node --test` sets NODE_TEST_CONTEXT in every test child process, which is
 * the signal that works regardless of how the suite is invoked. NODE_ENV is
 * checked too so a differently-wired runner still trips the guard. Deliberately
 * NOT a config flag: a guard you can forget to switch on is not a guard.
 */
export function isTestRun() {
  return Boolean(process.env.NODE_TEST_CONTEXT) || process.env.NODE_ENV === "test";
}

/**
 * Refuse to let a test run write the live lifecycle store (card affa0aac / C2).
 *
 * On 2026-08-14 the production store was found holding records stamped with
 * injected test clocks (eol_at 1000 / 4000 / 10000) and synthetic fixture ids
 * (`x`, `qwen/a`, `g/c:free`). Running `npm test` in this repo was a fleet
 * mutation event: one model's absent_cycles was observed going 24 -> 36 -> 60
 * across a single session while it was present in the provider catalog the
 * whole time. That corruption hid 83 live models and advertised 6 dead ones.
 *
 * Most suites already redirect SKGATEWAY_MODEL_CATALOG_STORE_PATH to a temp
 * dir. This makes the ones that forget FAIL LOUDLY instead of silently
 * corrupting a real node, which is the difference between a test bug and an
 * outage. It throws rather than no-ops on purpose: a silent refusal is the same
 * shape of problem as the silent write it replaces.
 *
 * @param {string} path the path a writer is about to open
 * @throws {Error} when a test run targets the live store
 */
export function assertNotProductionStoreInTest(path) {
  if (!isTestRun()) return;
  if (resolve(path) !== resolve(PRODUCTION_STORE_PATH)) return;
  throw new Error(
    `refusing to write the production lifecycle store from a test run: ${PRODUCTION_STORE_PATH}. ` +
      "Set SKGATEWAY_MODEL_CATALOG_STORE_PATH to a temp path before importing any module " +
      "that captures it (see tests/router-model-outcome.test.mjs, which sets it above its imports " +
      "because discovery.mjs binds LIFECYCLE_STORE_PATH at module load).",
  );
}

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

/**
 * Persist `store` to `path` and warm the cache with it. Fail-soft: never throws
 * on an I/O problem.
 *
 * The test guard runs OUTSIDE the try on purpose. Everything inside is
 * swallowed by design (a store hiccup must never reach a request path), and a
 * swallowed guard would be no guard at all: the write would simply not happen
 * and nobody would learn why.
 */
function saveCatalogStore(store, path) {
  assertNotProductionStoreInTest(path);
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
 * Card f9e8002b / C14: this is USER traffic, of a shape we do not control,
 * so it can never produce `not_chat`. `applyCompletionOutcome` only reacts
 * to 2xx/404/410 and leaves every other status (400 and 500 included)
 * untouched; `not_chat` is set exclusively by `applyProbeOutcome`, reached
 * only from the probe sweep (src/discovery/probe.mjs), never from here.
 *
 * Claimer-aware permanent errors (incident inc-2026-08-18-qwen38-eol /
 * problem prob-2026-08-18-model-discovery-validation): `claiming` tells the
 * store whether the backend the attempt hit DECLARES this model (its
 * `models` list) or was only a fail-over fallback that happened to be
 * available. A 404/410 from a non-claiming backend is evidence about THAT
 * backend's catalog, not about the model — the model may be served perfectly
 * by a backend that does claim it (the qwen38 false positive: nvidia 404'd
 * `qwen38-abliterated` while chiap08's llama.cpp served it name-agnostically,
 * and those 404s still accumulated to an EOL record that then gated the
 * healthy local door). So with `claiming === false`, a 404/410 is a no-op:
 * the record is left exactly as it was. A 2xx always counts regardless (a
 * success is a success from any door), and `claiming === true` or `undefined`
 * (legacy/test callers) keep the original behavior, including the case where
 * NO backend claims the id and every door's 404 is the best evidence
 * available (card P1.6).
 *
 * @param {string} modelId
 * @param {{status: number, now?: number, claiming?: boolean}} outcome
 * @param {string} [path]
 * @returns {void}
 */
export function recordModelOutcome(modelId, { status, now = Date.now(), claiming } = {}, path = STORE_PATH) {
  if (!modelId) return;
  // Guard before the fail-soft try: this function's catch swallows everything,
  // so a guard inside it would silently do nothing. See
  // assertNotProductionStoreInTest.
  assertNotProductionStoreInTest(path);
  if (claiming === false && (status === 404 || status === 410)) return;
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
