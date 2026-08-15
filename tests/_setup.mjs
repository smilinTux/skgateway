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

// Belt and braces: also mark this as a test run explicitly, so the guard trips
// even on a runner that does not set NODE_TEST_CONTEXT.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
