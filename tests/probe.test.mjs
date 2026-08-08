/**
 * probe.test.mjs — EOL probe sweep (card P2.3).
 *
 * Covers `selectProbeCandidates()` / `probeModels()` (src/discovery/probe.mjs)
 * directly with an injected fake completion runner + fake pool + fake clock,
 * and the cadence wiring into `discoverCatalog()` (src/discovery.mjs) via
 * `discovery.probe_seconds`. No network: every fetch/completion is injected.
 *
 * Run with:  node --test tests/probe.test.mjs
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  selectProbeCandidates,
  probeModels,
  DEFAULT_PROBE_BUDGET,
  DEFAULT_TRAFFIC_WINDOW_MS,
} from '../src/discovery/probe.mjs';
import { defaultLifecycle } from '../src/discovery/lifecycle.mjs';
import { discoverCatalog } from '../src/discovery.mjs';
import { getLifecycle, _resetCacheForTests } from '../src/discovery/model_catalog_store.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'skgw-probe-'));
let _seq = 0;
function freshPath() {
  return join(DIR, `store-${_seq++}.json`);
}

beforeEach(() => {
  _resetCacheForTests();
});

const SEVEN_DAYS = DEFAULT_TRAFFIC_WINDOW_MS;
const NOW = 100 * SEVEN_DAYS; // comfortably past any window math below

function lc(overrides = {}) {
  return { ...defaultLifecycle(), ...overrides };
}

describe('selectProbeCandidates (pure)', () => {
  test('excludes models with live traffic inside the window', () => {
    const store = {
      fresh: lc({ last_verified_at: NOW - 1000 }), // just verified
      stale: lc({ last_verified_at: NOW - SEVEN_DAYS - 1 }), // just outside window
    };
    const ids = selectProbeCandidates(store, { now: NOW });
    assert.deepEqual(ids, ['stale']);
  });

  test('never-verified models (last_verified_at null) are eligible', () => {
    const store = { unknown: lc({ last_verified_at: null }) };
    const ids = selectProbeCandidates(store, { now: NOW });
    assert.deepEqual(ids, ['unknown']);
  });

  test('dead models are never selected (tombstone, not probe-revivable)', () => {
    const store = { gone: lc({ state: 'dead', last_verified_at: null }) };
    const ids = selectProbeCandidates(store, { now: NOW });
    assert.deepEqual(ids, []);
  });

  test('respects the budget cap', () => {
    const store = {};
    for (let i = 0; i < 30; i++) {
      store[`m${i}`] = lc({ last_verified_at: null });
    }
    const ids = selectProbeCandidates(store, { now: NOW, budget: 5 });
    assert.equal(ids.length, 5);
  });

  test('budget <= 0 selects nothing', () => {
    const store = { a: lc({ last_verified_at: null }) };
    assert.deepEqual(selectProbeCandidates(store, { now: NOW, budget: 0 }), []);
  });

  test('default budget is ~20', () => {
    assert.equal(DEFAULT_PROBE_BUDGET, 20);
  });

  test('orders never-verified before older-verified before newer-verified', () => {
    const store = {
      newerVerified: lc({ last_verified_at: NOW - SEVEN_DAYS - 10 }),
      olderVerified: lc({ last_verified_at: NOW - SEVEN_DAYS - 5000 }),
      neverVerified: lc({ last_verified_at: null }),
    };
    const ids = selectProbeCandidates(store, { now: NOW });
    assert.deepEqual(ids, ['neverVerified', 'olderVerified', 'newerVerified']);
  });

  test('provider filter scopes selection to one provider', () => {
    const store = {
      'nvidia/a': lc({ last_verified_at: null, provider: 'nvidia' }),
      'openrouter/b': lc({ last_verified_at: null, provider: 'openrouter' }),
    };
    const ids = selectProbeCandidates(store, { now: NOW, provider: 'nvidia' });
    assert.deepEqual(ids, ['nvidia/a']);
  });
});

describe('probeModels (fake completion runner + fake pool + fake clock)', () => {
  test('a 410 probe flips the model to eol with reason probe_failed', async () => {
    const store = { dying: lc({ last_verified_at: null }) };
    const next = await probeModels(store, {
      now: () => NOW,
      runProbe: async () => ({ ok: false, status: 410 }),
    });
    assert.equal(next.dying.state, 'eol');
    assert.equal(next.dying.eol_reason, 'probe_failed');
  });

  test('a 200 probe records last_verified_at and promotes to active', async () => {
    const store = { warm: lc({ state: 'suspect', last_verified_at: null }) };
    const next = await probeModels(store, {
      now: () => NOW,
      runProbe: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(next.warm.state, 'active');
    assert.equal(next.warm.last_verified_at, NOW);
  });

  test('a non-410 failure (timeout) only demotes active -> suspect, no escalation', async () => {
    const store = { flaky: lc({ state: 'active', last_verified_at: null }) };
    const next = await probeModels(store, {
      now: () => NOW,
      runProbe: async () => {
        throw new Error('timeout');
      },
    });
    assert.equal(next.flaky.state, 'suspect');
  });

  test('models with recent traffic are left untouched (never probed)', async () => {
    let calls = 0;
    const store = { busy: lc({ last_verified_at: NOW - 1000 }) };
    const next = await probeModels(store, {
      now: () => NOW,
      runProbe: async () => {
        calls++;
        return { ok: true, status: 200 };
      },
    });
    assert.equal(calls, 0);
    assert.deepEqual(next.busy, store.busy);
  });

  test('no runProbe supplied is a safe no-op (disable path)', async () => {
    const store = { a: lc({ last_verified_at: null }) };
    const next = await probeModels(store, { now: () => NOW });
    assert.deepEqual(next, store);
  });

  test('budget caps the number of probes actually run', async () => {
    let calls = 0;
    const store = {};
    for (let i = 0; i < 30; i++) store[`m${i}`] = lc({ last_verified_at: null });
    await probeModels(store, {
      now: () => NOW,
      budget: 5,
      runProbe: async () => {
        calls++;
        return { ok: true, status: 200 };
      },
    });
    assert.equal(calls, 5);
  });

  test('probes go through the pool: acquire/release called once per candidate, never unbounded', async () => {
    const acquired = [];
    const released = [];
    const fakePool = {
      acquire: async (id) => {
        acquired.push(id);
        return { id };
      },
      release: (id) => {
        released.push(id);
      },
    };
    const store = { a: lc({ last_verified_at: null }), b: lc({ last_verified_at: null }) };
    await probeModels(store, {
      now: () => NOW,
      pool: fakePool,
      poolBackendId: 'nvidia',
      runProbe: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(acquired.length, 2);
    assert.equal(released.length, 2);
    assert.ok(acquired.every((id) => id === 'nvidia'));
  });

  test('a pool acquire failure (queue full) skips that id without marking it dead', async () => {
    const fakePool = {
      acquire: async () => {
        throw new Error('queue full');
      },
      release: () => {},
    };
    const store = { a: lc({ state: 'active', last_verified_at: null }) };
    const next = await probeModels(store, {
      now: () => NOW,
      pool: fakePool,
      runProbe: async () => ({ ok: false, status: 410 }),
    });
    // never actually probed, so the lifecycle is untouched (not flipped to eol)
    assert.equal(next.a.state, 'active');
  });

  test('a runProbe rejection is treated as a failed (non-410) outcome, not a throw', async () => {
    const store = { a: lc({ state: 'active', last_verified_at: null }) };
    await assert.doesNotReject(
      probeModels(store, {
        now: () => NOW,
        runProbe: async () => {
          throw new Error('boom');
        },
      }),
    );
  });
});

describe('discoverCatalog wires the probe sweep into the existing refresh cadence', () => {
  function noopFetch() {
    return async () => ({ data: [] });
  }

  test('probeSeconds: 0 disables the sweep (runProbe never called)', async () => {
    const path = freshPath();
    let calls = 0;
    await discoverCatalog({
      localModels: [],
      nvidiaFetch: noopFetch(),
      openrouterFetch: noopFetch(),
      cache: {},
      now: () => NOW,
      lifecycleStorePath: path,
      probeSeconds: 0,
      probeRunProbe: async () => {
        calls++;
        return { ok: true, status: 200 };
      },
    });
    assert.equal(calls, 0);
  });

  test('a due probe sweep probes a long-tail model and persists the outcome', async () => {
    const path = freshPath();
    const cache = {};

    // Cycle 1: seed the store with one nvidia model, never verified.
    await discoverCatalog({
      localModels: [],
      nvidiaFetch: async () => ({ data: [{ id: 'nvidia/longtail' }] }),
      openrouterFetch: noopFetch(),
      cache,
      now: () => 0,
      lifecycleStorePath: path,
      probeSeconds: 0, // no sweep yet this cycle
    });

    let calls = 0;
    await discoverCatalog({
      localModels: [],
      nvidiaFetch: async () => ({ data: [{ id: 'nvidia/longtail' }] }),
      openrouterFetch: noopFetch(),
      cache,
      now: () => 1000,
      lifecycleStorePath: path,
      probeSeconds: 60, // due (cache has no lastProbedAt yet)
      probeRunProbe: async (id) => {
        calls++;
        assert.equal(id, 'nvidia/longtail');
        return { ok: true, status: 200 };
      },
    });

    assert.equal(calls, 1);
    _resetCacheForTests();
    const record = getLifecycle('nvidia/longtail', path);
    assert.equal(record.last_verified_at, 1000);
    assert.equal(cache.lastProbedAt, 1000);
  });

  test('a sweep that already ran within probeSeconds does not run again', async () => {
    const path = freshPath();
    const cache = {};

    await discoverCatalog({
      localModels: [],
      nvidiaFetch: async () => ({ data: [{ id: 'nvidia/x' }] }),
      openrouterFetch: noopFetch(),
      cache,
      now: () => 0,
      lifecycleStorePath: path,
      probeSeconds: 1000, // seconds
      probeRunProbe: async () => ({ ok: true, status: 200 }),
    });
    assert.equal(cache.lastProbedAt, 0);

    let calls = 0;
    await discoverCatalog({
      localModels: [],
      nvidiaFetch: async () => ({ data: [{ id: 'nvidia/x' }] }),
      openrouterFetch: noopFetch(),
      cache,
      now: () => 5000, // 5s later, well under the 1000s cadence
      lifecycleStorePath: path,
      probeSeconds: 1000,
      probeRunProbe: async () => {
        calls++;
        return { ok: true, status: 200 };
      },
    });
    assert.equal(calls, 0);
    assert.equal(cache.lastProbedAt, 0); // unchanged: sweep was skipped, not re-run
  });

  test('a probe failure never breaks the discovery cycle (fail-soft)', async () => {
    const path = freshPath();
    const cache = {};
    const { models } = await discoverCatalog({
      localModels: [],
      nvidiaFetch: async () => ({ data: [{ id: 'nvidia/y' }] }),
      openrouterFetch: noopFetch(),
      cache,
      now: () => 0,
      lifecycleStorePath: path,
      probeSeconds: 1,
      probeRunProbe: async () => {
        throw new Error('boom');
      },
    });
    assert.ok(Array.isArray(models));
    assert.equal(models.length, 1);
  });
});
