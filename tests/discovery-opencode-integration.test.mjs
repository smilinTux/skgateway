/**
 * discovery-opencode-integration.test.mjs (card 6cc8aac3 / C8): opencode
 * wired into discoverCatalog() end to end, mirroring the acceptance criteria
 * that are only observable at that level (they need the full lifecycle-store
 * round trip, not just normalize() in isolation - see
 * tests/providers-opencode.test.mjs for the adapter-only tests):
 *
 *   - A Zen fetch failure is treated as an outage and never counts toward
 *     absent_cycles, matching the existing nvidia/openrouter guards
 *     (discovery-absence.test.mjs's "a failed provider fetch does not count
 *     as absence" test, replayed here for opencode).
 *   - opencode gets the same 2-cycle absentSuspectThreshold grace as
 *     openrouter (lifecycle.mjs), not the 1-cycle default.
 *   - Omitting opencodeFetch entirely (every pre-C8 test, and production
 *     until src/index.mjs is wired) behaves as "not configured" (an empty,
 *     successful cycle), not as an outage: `stale` must stay false.
 *
 * Run with: node --test tests/discovery-opencode-integration.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverCatalog } from '../src/discovery.mjs';
import { getLifecycle, _resetCacheForTests } from '../src/discovery/model_catalog_store.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'skgw-discovery-opencode-'));
let _seq = 0;
function freshPath() {
  return join(DIR, `store-${_seq++}.json`);
}

const ZEN_ONE = { data: [{ id: 'big-pickle' }] };
const MODELS_DEV_ONE = {
  opencode: {
    models: {
      'big-pickle': { id: 'big-pickle', modalities: { input: ['text'], output: ['text'] }, cost: { input: 0, output: 0 } },
    },
  },
};

describe('discoverCatalog wires opencode presence tracking the same way nvidia/openrouter are wired', () => {
  test('omitting opencodeFetch entirely (the default, matching production today) is NOT treated as an outage', async () => {
    const res = await discoverCatalog({
      localModels: [],
      nvidiaFetch: async () => ({ data: [] }),
      openrouterFetch: async () => ({ data: [] }),
      cache: {},
      now: () => 1000,
      lifecycleStorePath: freshPath(),
    });
    assert.equal(res.stale, false);
  });

  test('a Zen fetch failure does not count toward absent_cycles (cache fallback, exactly like nvidia/openrouter)', async () => {
    const path = freshPath();
    const cache = {};
    const localModels = [];

    await discoverCatalog({
      localModels,
      nvidiaFetch: async () => ({ data: [] }),
      openrouterFetch: async () => ({ data: [] }),
      opencodeFetch: async () => ({ zen: ZEN_ONE, modelsDev: MODELS_DEV_ONE }),
      cache,
      now: () => 1000,
      lifecycleStorePath: path,
    });
    _resetCacheForTests();
    assert.equal(getLifecycle('big-pickle', path).state, 'active');

    // Zen throws this cycle: served from cache, must NOT be treated as an
    // absence signal, and `stale` must flip true (the outage IS visible,
    // just not misattributed to the model going away).
    const res = await discoverCatalog({
      localModels,
      nvidiaFetch: async () => ({ data: [] }),
      openrouterFetch: async () => ({ data: [] }),
      opencodeFetch: async () => {
        throw new Error('opencode 503');
      },
      cache,
      now: () => 2000,
      lifecycleStorePath: path,
    });

    assert.equal(res.stale, true);
    _resetCacheForTests();
    const lc = getLifecycle('big-pickle', path);
    assert.equal(lc.state, 'active');
    assert.equal(lc.absent_cycles, 0);
  });

  test('a models.dev-only failure inside the opencode fetch does NOT flip stale (Zen still succeeded)', async () => {
    const path = freshPath();
    const res = await discoverCatalog({
      localModels: [],
      nvidiaFetch: async () => ({ data: [] }),
      openrouterFetch: async () => ({ data: [] }),
      opencodeFetch: async () => ({ zen: ZEN_ONE, modelsDev: null }),
      cache: {},
      now: () => 1000,
      lifecycleStorePath: path,
    });
    assert.equal(res.stale, false);
    const bigPickle = res.models.find((m) => m.id === 'big-pickle');
    assert.ok(bigPickle, 'big-pickle still served with a null card');
    assert.equal(bigPickle.card, null);
  });

  test('opencode absence honors the 2-cycle suspect threshold end to end, same grace as openrouter', async () => {
    const path = freshPath();
    const cache = {};
    const localModels = [];
    const opencodeFetchWith = (zenData) => async () => ({
      zen: { data: zenData },
      modelsDev: MODELS_DEV_ONE,
    });

    await discoverCatalog({
      localModels,
      nvidiaFetch: async () => ({ data: [] }),
      openrouterFetch: async () => ({ data: [] }),
      opencodeFetch: opencodeFetchWith([{ id: 'big-pickle' }]),
      cache,
      now: () => 1000,
      lifecycleStorePath: path,
    });

    // cycle 2: gone once - still active per opencode's 2-cycle grace.
    await discoverCatalog({
      localModels,
      nvidiaFetch: async () => ({ data: [] }),
      openrouterFetch: async () => ({ data: [] }),
      opencodeFetch: opencodeFetchWith([]),
      cache,
      now: () => 2000,
      lifecycleStorePath: path,
    });
    _resetCacheForTests();
    assert.equal(getLifecycle('big-pickle', path).state, 'active');

    // cycle 3: gone twice - now suspect.
    await discoverCatalog({
      localModels,
      nvidiaFetch: async () => ({ data: [] }),
      openrouterFetch: async () => ({ data: [] }),
      opencodeFetch: opencodeFetchWith([]),
      cache,
      now: () => 3000,
      lifecycleStorePath: path,
    });
    _resetCacheForTests();
    assert.equal(getLifecycle('big-pickle', path).state, 'suspect');
  });

  test('big-pickle survives the full discoverCatalog round trip end to end (proves the join at the top level, not just normalize())', async () => {
    const res = await discoverCatalog({
      localModels: [],
      nvidiaFetch: async () => ({ data: [] }),
      openrouterFetch: async () => ({ data: [] }),
      opencodeFetch: async () => ({
        zen: { data: [{ id: 'big-pickle' }, { id: 'claude-opus-5' }] },
        modelsDev: {
          opencode: {
            models: {
              'big-pickle': { id: 'big-pickle', modalities: { output: ['text'] }, cost: { input: 0, output: 0 } },
              'claude-opus-5': { id: 'claude-opus-5', modalities: { output: ['text'] }, cost: { input: 5, output: 25 } },
            },
          },
        },
      }),
      cache: {},
      now: () => 1000,
      lifecycleStorePath: freshPath(),
    });
    const ids = res.models.map((m) => m.id);
    assert.ok(ids.includes('big-pickle'));
    assert.ok(!ids.includes('claude-opus-5'));
  });
});
