/**
 * discovery-cache-production-guard.test.mjs: `npm test` must not overwrite the
 * live discovery cache.
 *
 * THE INCIDENT, measured 2026-08-16 while investigating why the bucket router
 * matched against a catalog holding no sovereign and no Anthropic model.
 *
 *   ~/.config/skgateway/model_catalog_cache.json held 96 models: 79 nvidia, 16
 *   openrouter, and exactly one `local` whose id was `c3-neutral`. That id is
 *   on no backend on this fleet. It is the fixture in
 *   tests/refresh-catalog-probe-wiring.test.mjs.
 *
 *   The live daemon's own in-memory catalog at the same moment, read from
 *   GET /admin/models/status, held 111 models: anthropic 4, local 3,
 *   chiap08-qwen38 2, opencode 7, nvidia 79, openrouter 16. So the daemon had
 *   produced a CORRECT catalog including every sovereign and Anthropic model
 *   and written it to that file. `npm test` then overwrote it. Three runs were
 *   watched advancing the file's mtime and lastRefreshedAt while dropping the
 *   anthropic, local, chiap08-qwen38 and opencode rows.
 *
 * Because buildMatchCatalog() reads that file, running the test suite silently
 * emptied the `secret` and `internal` tiers on a live node: every sk-*-secret
 * and sk-*-internal bucket loses its only eligible members, while the zone-2
 * cloud buckets keep working. Nothing reports it, and the file's mtime is
 * fresh, so it reads as a healthy catalog.
 *
 * This is card affa0aac / C2's defect on the second file in the same
 * directory. That card gave the LIFECYCLE store an env override plus
 * assertNotProductionStoreInTest(); the discovery cache next to it got
 * neither, even though router.mjs had read SKGATEWAY_MODEL_CATALOG_CACHE_PATH
 * for its own MATCH_CATALOG_CACHE_PATH since card P4.2. The reader honoured
 * the variable and the writer ignored it.
 *
 * Run with:  node --test --import ./tests/_setup.mjs tests/discovery-cache-production-guard.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const {
  saveCache,
  loadCache,
  PRODUCTION_CACHE_PATH,
  assertNotProductionCacheInTest,
} = await import('../src/discovery.mjs');

describe('the discovery cache cannot be written by a test run', () => {
  test('saveCache() throws rather than touching the production cache', () => {
    // Throws rather than no-ops on purpose: a silent refusal is the same shape
    // of problem as the silent write it replaces. Nothing is written either
    // way, which is what the mtime check below confirms.
    const before = existsSync(PRODUCTION_CACHE_PATH)
      ? readFileSync(PRODUCTION_CACHE_PATH, 'utf8')
      : null;

    assert.throws(
      () => saveCache({ models: [{ id: 'c3-neutral', provider: 'local', free: true }] }, PRODUCTION_CACHE_PATH),
      /refusing to write the production discovery cache/,
    );

    const after = existsSync(PRODUCTION_CACHE_PATH)
      ? readFileSync(PRODUCTION_CACHE_PATH, 'utf8')
      : null;
    assert.equal(after, before, 'the live catalog on this node must be byte-identical afterwards');
  });

  test('the guard is scoped to the production path, not to writing in general', () => {
    // NEGATIVE CONTROL. A guard that blocked every write would make the whole
    // suite unrunnable and would not prove anything about the path check.
    const dir = mkdtempSync(join(tmpdir(), 'skgw-cache-guard-'));
    const safe = join(dir, 'model_catalog_cache.json');

    assert.doesNotThrow(() => assertNotProductionCacheInTest(safe));
    saveCache({ models: [{ id: 'fixture-model', provider: 'local', free: true }] }, safe);
    assert.deepEqual(loadCache(safe).models, [{ id: 'fixture-model', provider: 'local', free: true }]);
  });

  test('tests/_setup.mjs points the DEFAULT write path away from production', () => {
    // The belt, asserted directly. Without it, every suite that calls
    // saveCache() with no explicit path would now THROW instead of silently
    // corrupting the node, which is better but still a broken suite. The env
    // var is what makes the default safe; the guard only catches a runner
    // invoked without --import.
    const configured = process.env.SKGATEWAY_MODEL_CATALOG_CACHE_PATH;
    assert.ok(configured, 'tests/_setup.mjs must set SKGATEWAY_MODEL_CATALOG_CACHE_PATH');
    assert.notEqual(
      resolve(configured), resolve(PRODUCTION_CACHE_PATH),
      'the default write path must not be the live cache',
    );

    // And the default really is that path: saving with no path argument writes
    // the fixture, not the production file.
    saveCache({ models: [{ id: 'default-path-probe', provider: 'local', free: true }] });
    assert.equal(loadCache(configured).models[0].id, 'default-path-probe');
  });
});
