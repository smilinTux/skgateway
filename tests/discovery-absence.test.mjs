/**
 * discovery-absence.test.mjs: catalog-absence tracking in discovery (card
 * P1.3).
 *
 * Covers `reconcilePresence()` (the pure per-cycle presence reconciler built
 * on lifecycle.mjs's `applyCatalogPresence`, card P1.1) directly, and its
 * wiring into `discoverCatalog()` (persisting to the shared lifecycle store
 * from model_catalog_store.mjs, card P1.2) across synthetic discovery
 * cycles. No network: every provider fetch is injected.
 *
 * Run with:  node --test tests/discovery-absence.test.mjs
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reconcilePresence, discoverCatalog } from '../src/discovery.mjs';
import { getLifecycle, _resetCacheForTests } from '../src/discovery/model_catalog_store.mjs';
import { THRESHOLDS } from '../src/discovery/lifecycle.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'skgw-discovery-absence-'));
let _seq = 0;
function freshPath() {
  return join(DIR, `store-${_seq++}.json`);
}

beforeEach(() => {
  _resetCacheForTests();
});

describe('reconcilePresence (pure)', () => {
  test('a model present every cycle stays active with absent_cycles at 0', () => {
    let store = {};
    for (let cycle = 0; cycle < 3; cycle++) {
      store = reconcilePresence(store, ['nvidia/alive'], 'nvidia', 1000 * cycle);
    }
    assert.equal(store['nvidia/alive'].state, 'active');
    assert.equal(store['nvidia/alive'].absent_cycles, 0);
  });

  test('default provider: one absent cycle flips active -> suspect', () => {
    let store = reconcilePresence({}, ['nvidia/a', 'nvidia/b'], 'nvidia', 0);
    // b drops out of the next fetch.
    store = reconcilePresence(store, ['nvidia/a'], 'nvidia', 1000);
    assert.equal(store['nvidia/b'].state, 'suspect');
    assert.equal(store['nvidia/b'].absent_cycles, 1);
    assert.equal(store['nvidia/a'].state, 'active');
  });

  test('openrouter needs 2 absent cycles to reach suspect (1 is not enough)', () => {
    let store = reconcilePresence({}, ['openrouter/free-model:free'], 'openrouter', 0);
    store = reconcilePresence(store, [], 'openrouter', 1000);
    assert.equal(store['openrouter/free-model:free'].state, 'active');
    assert.equal(store['openrouter/free-model:free'].absent_cycles, 1);

    store = reconcilePresence(store, [], 'openrouter', 2000);
    assert.equal(store['openrouter/free-model:free'].state, 'suspect');
    assert.equal(store['openrouter/free-model:free'].absent_cycles, 2);
  });

  test('absent for absentEolThreshold (3) cycles reaches eol (dropped_from_catalog)', () => {
    let store = reconcilePresence({}, ['nvidia/dying'], 'nvidia', 0);
    store = reconcilePresence(store, [], 'nvidia', 1000);
    store = reconcilePresence(store, [], 'nvidia', 2000);
    assert.equal(store['nvidia/dying'].state, 'suspect');
    store = reconcilePresence(store, [], 'nvidia', 3000);
    assert.equal(store['nvidia/dying'].state, 'eol');
    assert.equal(store['nvidia/dying'].eol_reason, 'dropped_from_catalog');
    assert.equal(store['nvidia/dying'].absent_cycles, THRESHOLDS.absentEolThreshold);
  });

  test('reappearance after eol (with a prior verification) recovers eol -> active', () => {
    let store = {
      'nvidia/back': {
        state: 'eol',
        last_verified_at: 500,
        consecutive_permanent_errors: 0,
        absent_cycles: 3,
        eol_reason: 'dropped_from_catalog',
        eol_at: 3000,
      },
    };
    store = reconcilePresence(store, ['nvidia/back'], 'nvidia', 4000);
    assert.equal(store['nvidia/back'].state, 'active');
    assert.equal(store['nvidia/back'].absent_cycles, 0);
  });

  test('a brand-new id (never seen before) seeds a fresh active record', () => {
    const store = reconcilePresence({}, ['nvidia/brand-new'], 'nvidia', 0);
    assert.equal(store['nvidia/brand-new'].state, 'active');
    assert.equal(store['nvidia/brand-new'].absent_cycles, 0);
  });
});

describe('discoverCatalog wires presence tracking into the shared lifecycle store', () => {
  test('a model missing from a live nvidia cycle becomes suspect in the store', async () => {
    const path = freshPath();
    const cache = {};
    const localModels = [];

    await discoverCatalog({
      localModels,
      nvidiaFetch: async () => ({ data: [{ id: 'nvidia/alpha' }, { id: 'nvidia/beta' }] }),
      openrouterFetch: async () => ({ data: [] }),
      cache,
      now: () => 1000,
      lifecycleStorePath: path,
    });

    await discoverCatalog({
      localModels,
      nvidiaFetch: async () => ({ data: [{ id: 'nvidia/alpha' }] }),
      openrouterFetch: async () => ({ data: [] }),
      cache,
      now: () => 2000,
      lifecycleStorePath: path,
    });

    const alpha = getLifecycle('nvidia/alpha', path);
    const beta = getLifecycle('nvidia/beta', path);
    assert.equal(alpha.state, 'active');
    assert.equal(beta.state, 'suspect');
    assert.equal(beta.absent_cycles, 1);
  });

  test('openrouter absence honors the 2-cycle suspect threshold end to end', async () => {
    const path = freshPath();
    const cache = {};
    const localModels = [];
    const openrouterModel = { id: 'openrouter/free-thing', pricing: { prompt: '0', completion: '0' } };

    await discoverCatalog({
      localModels,
      nvidiaFetch: async () => ({ data: [] }),
      openrouterFetch: async () => ({ data: [openrouterModel] }),
      cache,
      now: () => 1000,
      lifecycleStorePath: path,
    });

    // cycle 2: gone once - still active per the openrouter 2-cycle grace.
    await discoverCatalog({
      localModels,
      nvidiaFetch: async () => ({ data: [] }),
      openrouterFetch: async () => ({ data: [] }),
      cache,
      now: () => 2000,
      lifecycleStorePath: path,
    });
    // discoverCatalog writes the lifecycle store straight to disk without
    // warming model_catalog_store.mjs's own mtime/TTL cache (see the doc
    // comment on discovery.mjs's loadLifecycleStoreFresh); reset that cache
    // before each getLifecycle read below so it re-stats instead of serving
    // a copy from before the write it just raced past in wall-clock time.
    _resetCacheForTests();
    assert.equal(getLifecycle('openrouter/free-thing', path).state, 'active');

    // cycle 3: gone twice - now suspect.
    await discoverCatalog({
      localModels,
      nvidiaFetch: async () => ({ data: [] }),
      openrouterFetch: async () => ({ data: [] }),
      cache,
      now: () => 3000,
      lifecycleStorePath: path,
    });
    _resetCacheForTests();
    assert.equal(getLifecycle('openrouter/free-thing', path).state, 'suspect');
  });

  test('a failed provider fetch does not count as absence for that provider (cache fallback)', async () => {
    const path = freshPath();
    const cache = {};
    const localModels = [];

    await discoverCatalog({
      localModels,
      nvidiaFetch: async () => ({ data: [{ id: 'nvidia/gamma' }] }),
      openrouterFetch: async () => ({ data: [] }),
      cache,
      now: () => 1000,
      lifecycleStorePath: path,
    });
    _resetCacheForTests();
    assert.equal(getLifecycle('nvidia/gamma', path).state, 'active');

    // nvidia fetch throws this cycle: served from cache, must NOT be treated
    // as an absence signal.
    await discoverCatalog({
      localModels,
      nvidiaFetch: async () => {
        throw new Error('network down');
      },
      openrouterFetch: async () => ({ data: [] }),
      cache,
      now: () => 2000,
      lifecycleStorePath: path,
    });

    _resetCacheForTests();
    const lc = getLifecycle('nvidia/gamma', path);
    assert.equal(lc.state, 'active');
    assert.equal(lc.absent_cycles, 0);
  });

  test('reappearing after eol in a live discovery cycle recovers to active', async () => {
    const path = freshPath();
    const cache = {};
    const localModels = [];

    // Seed the store directly with an eol'd, previously-verified model.
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        'nvidia/phoenix': {
          state: 'eol',
          last_verified_at: 100,
          consecutive_permanent_errors: 0,
          absent_cycles: 3,
          eol_reason: 'dropped_from_catalog',
          eol_at: 900,
          provider: 'nvidia',
        },
      }),
    );

    await discoverCatalog({
      localModels,
      nvidiaFetch: async () => ({ data: [{ id: 'nvidia/phoenix' }] }),
      openrouterFetch: async () => ({ data: [] }),
      cache,
      now: () => 5000,
      lifecycleStorePath: path,
    });

    const lc = getLifecycle('nvidia/phoenix', path);
    assert.equal(lc.state, 'active');
  });
});
