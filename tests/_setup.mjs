/**
 * _setup.mjs: global test bootstrap, preloaded via `node --test --import`.
 *
 * Card affa0aac / C2. Before this existed, a test only avoided writing the REAL
 * per-node lifecycle store (~/.config/skgateway/model_catalog_store.json) if its
 * author remembered to set SKGATEWAY_MODEL_CATALOG_STORE_PATH by hand. Twenty
 * six test files did not, so running `npm test` mutated production state: the
 * store was found holding records stamped with injected test clocks (eol_at
 * 1000 / 4000 / 10000) and synthetic fixture ids, and one model's absent_cycles
 * was observed moving 24 -> 36 -> 60 across a single session purely because the
 * suite ran. That corruption hid 83 live models and advertised 6 dead ones.
 *
 * Setting the env var per suite is the fix that keeps needing to be remembered.
 * This sets it once, for every test process, before ANY module is imported.
 * That ordering is the whole point: src/discovery.mjs binds
 * LIFECYCLE_STORE_PATH at module load, so an override applied inside a test
 * body is already too late (tests/router-model-outcome.test.mjs documents this
 * hazard at its own line 26).
 *
 * This is the belt. The brace is assertNotProductionStoreInTest() in
 * model_catalog_store.mjs, which throws if anything still reaches the live path
 * during a test run. Two layers on purpose: this file can be bypassed by
 * invoking node --test directly without --import, and the guard catches that.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH) {
  const dir = mkdtempSync(join(tmpdir(), 'skgw-test-store-'));
  process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = join(dir, 'model_catalog_store.json');
}

// SAME CLASS OF BUG, SECOND FILE IN THE SAME DIRECTORY, found 2026-08-16.
// discovery.mjs's saveCache() defaulted to the PRODUCTION discovery cache
// (~/.config/skgateway/model_catalog_cache.json) with no env override and no
// guard, even though router.mjs has read SKGATEWAY_MODEL_CATALOG_CACHE_PATH
// for its own MATCH_CATALOG_CACHE_PATH since card P4.2. Reader honoured the
// variable, writer ignored it.
//
// Measured: that file held 96 models whose only `local` entry was
// `c3-neutral`, the fixture id from tests/refresh-catalog-probe-wiring.test.
// mjs, while the live daemon's in-memory catalog held 111 including 4
// anthropic, 3 local, 2 chiap08-qwen38 and 7 opencode. The daemon had written
// a correct catalog and `npm test` had overwritten it, repeatedly: three runs
// were watched advancing the file's mtime while dropping those rows. Since
// the bucket router MATCHES against that file, running the test suite
// silently emptied the sovereign and internal tiers on a live node.
//
// Same fix as the store above: set it once, for every test process, before
// any module is imported. discovery.mjs and router.mjs both bind the path at
// module load, so an assignment inside a test body is already too late.
if (!process.env.SKGATEWAY_MODEL_CATALOG_CACHE_PATH) {
  const dir = mkdtempSync(join(tmpdir(), 'skgw-test-cache-'));
  process.env.SKGATEWAY_MODEL_CATALOG_CACHE_PATH = join(dir, 'model_catalog_cache.json');
}

// Same class of bug, third variable. src/proxy/registry.mjs binds
// REGISTRY_PATH at module load from $SKMODELS_REGISTRY, defaulting to the REAL
// per-node file ~/.skcapstone/models/registry.yaml. Twelve test files remember
// to point that at a fixture or a nonexistent path; the rest inherit whatever
// the developer's box happens to hold. tests/siem-live-hook.test.mjs did not
// remember, so on a node with a populated registry the router registry-routed
// its fake "m" model to the LIVE ornith backend at 192.168.0.100:8082 and the
// assertion `backend === "fake"` failed with "reg:ornith" after an 8.7s round
// trip to the LAN. On a bare CI runner the file is absent, so it passed there:
// green CI, red developer box, which is the worst possible split.
//
// Default it to a path that cannot exist. loadRegistry() already treats an
// unreadable registry as empty, so this is the "no registry configured" case,
// which is the correct baseline for a unit test. A suite that needs a registry
// still assigns SKMODELS_REGISTRY itself at module scope before importing
// registry.mjs, and that assignment still wins.
if (!process.env.SKMODELS_REGISTRY) {
  process.env.SKMODELS_REGISTRY = join(
    tmpdir(), 'skgw-test-no-registry', 'nonexistent-registry.yaml',
  );
}

// Belt and braces: also mark this as a test run explicitly, so the guard trips
// even on a runner that does not set NODE_TEST_CONTEXT.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
