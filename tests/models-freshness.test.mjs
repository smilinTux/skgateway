// Freshness observability for the dynamic model catalog: discoverCatalog must
// stamp `lastRefreshedAt` on the cache when a cycle completes, catalogStatus
// must summarize freshness + counts, a forced re-discovery must re-run the
// fetchers and advance the timestamp, and the whole path must fail soft when a
// provider fetch throws. All hermetic: injected fetchers + injected clock, no
// network, no module state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCatalog, catalogStatus } from '../src/discovery.mjs';

const local = [{ id: 'ornith-tiny', provider: 'local', free: true }];

function nvJson(ids) {
  return { data: ids.map((id) => ({ id })) };
}
function orJson(ids) {
  return { data: ids.map((id) => ({ id, pricing: { prompt: '0', completion: '0' } })) };
}

test('discoverCatalog stamps lastRefreshedAt from the injected clock', async () => {
  const cache = {};
  const res = await discoverCatalog({
    localModels: local,
    nvidiaFetch: async () => nvJson(['qwen/qwen3.5-122b']),
    openrouterFetch: async () => orJson(['google/gemma-4:free']),
    cache,
    now: () => 1000,
  });
  assert.equal(res.stale, false);
  assert.equal(res.lastRefreshedAt, 1000);
  assert.equal(cache.lastRefreshedAt, 1000);
});

test('catalogStatus reports lastRefreshedAt, age, refresh window, and counts', async () => {
  const cache = {};
  const { models } = await discoverCatalog({
    localModels: local,
    nvidiaFetch: async () => nvJson(['qwen/a', 'qwen/b']),
    openrouterFetch: async () => orJson(['g/c:free']),
    cache,
    now: () => 10_000,
  });
  const status = catalogStatus({
    catalog: models,
    cache,
    refreshSeconds: 3600,
    now: () => 25_000, // 15s after the refresh
  });
  assert.equal(status.lastRefreshedAt, 10_000);
  assert.equal(status.ageSeconds, 15);
  assert.equal(status.refreshSeconds, 3600);
  assert.equal(status.total, 4); // ornith-tiny + 2 nvidia + 1 openrouter
  assert.equal(status.freeCount, 4);
  assert.equal(status.providerCounts.local, 1);
  assert.equal(status.providerCounts.nvidia, 2);
  assert.equal(status.providerCounts.openrouter, 1);
});

test('catalogStatus is null-safe before the first refresh', () => {
  const status = catalogStatus({ catalog: [], cache: {}, refreshSeconds: 3600, now: () => 5000 });
  assert.equal(status.lastRefreshedAt, null);
  assert.equal(status.ageSeconds, null);
  assert.equal(status.total, 0);
  assert.equal(status.freeCount, 0);
});

test('forced re-discovery re-invokes the fetchers and advances the timestamp', async () => {
  const cache = {};
  let nvCalls = 0;
  let orCalls = 0;
  let clock = 1000;
  const nvidiaFetch = async () => { nvCalls += 1; return nvJson(['qwen/a']); };
  const openrouterFetch = async () => { orCalls += 1; return orJson(['g/c:free']); };

  const first = await discoverCatalog({ localModels: local, nvidiaFetch, openrouterFetch, cache, now: () => clock });
  assert.equal(nvCalls, 1);
  assert.equal(orCalls, 1);
  assert.equal(first.lastRefreshedAt, 1000);

  // Force a second discovery (simulates POST /admin/models/refresh bypassing the
  // interval): the fetchers must run again and the timestamp must advance.
  clock = 4000;
  const second = await discoverCatalog({ localModels: local, nvidiaFetch, openrouterFetch, cache, now: () => clock });
  assert.equal(nvCalls, 2, 'nvidia fetcher re-invoked on forced refresh');
  assert.equal(orCalls, 2, 'openrouter fetcher re-invoked on forced refresh');
  assert.ok(second.lastRefreshedAt > first.lastRefreshedAt, 'lastRefreshedAt advanced');
  assert.equal(second.lastRefreshedAt, 4000);
});

test('fail-soft: a throwing provider still completes, stamps, and marks stale', async () => {
  const cache = { models: [{ id: 'cached-nv', provider: 'nvidia', free: true }] };
  const res = await discoverCatalog({
    localModels: local,
    nvidiaFetch: async () => { throw new Error('nvidia down'); },
    openrouterFetch: async () => orJson(['g/c:free']),
    cache,
    now: () => 7777,
  });
  assert.equal(res.stale, true, 'a provider outage flags the catalog stale');
  assert.equal(res.lastRefreshedAt, 7777, 'timestamp still stamped on a fail-soft cycle');
  const ids = res.models.map((m) => m.id);
  assert.ok(ids.includes('cached-nv'), 'falls back to cached nvidia entries');
  assert.ok(ids.includes('g/c:free'), 'live openrouter entries still served');

  const status = catalogStatus({ catalog: res.models, cache, refreshSeconds: 60, now: () => 7777 + 5000 });
  assert.equal(status.ageSeconds, 5);
  assert.equal(status.providerCounts.nvidia, 1);
});

test('discoverCatalog records per-provider health (ok on success)', async () => {
  const cache = {};
  await discoverCatalog({
    localModels: local,
    nvidiaFetch: async () => nvJson(['qwen/a', 'qwen/b']),
    openrouterFetch: async () => orJson(['g/c:free']),
    cache,
    now: () => 1000,
  });
  assert.equal(cache.providers.nvidia.ok, true);
  assert.equal(cache.providers.nvidia.count, 2);
  assert.equal(cache.providers.nvidia.lastSuccessAt, 1000);
  assert.equal(cache.providers.nvidia.lastError, null);
  assert.equal(cache.providers.openrouter.ok, true);
  assert.equal(cache.providers.openrouter.lastSuccessAt, 1000);
});

test('discoverCatalog records the last error and preserves last-success time on a provider outage', async () => {
  // First cycle succeeds so we have a known-good lastSuccessAt for nvidia.
  const cache = {};
  await discoverCatalog({
    localModels: local,
    nvidiaFetch: async () => nvJson(['qwen/a']),
    openrouterFetch: async () => orJson(['g/c:free']),
    cache,
    now: () => 1000,
  });
  assert.equal(cache.providers.nvidia.lastSuccessAt, 1000);

  // Second cycle: nvidia is down. Its lastError is captured, lastErrorAt is set,
  // but the earlier lastSuccessAt is preserved so operators can see the gap.
  await discoverCatalog({
    localModels: local,
    nvidiaFetch: async () => { throw new Error('nvidia 503'); },
    openrouterFetch: async () => orJson(['g/c:free']),
    cache,
    now: () => 5000,
  });
  assert.equal(cache.providers.nvidia.ok, false);
  assert.equal(cache.providers.nvidia.lastError, 'nvidia 503');
  assert.equal(cache.providers.nvidia.lastErrorAt, 5000);
  assert.equal(cache.providers.nvidia.lastSuccessAt, 1000, 'last successful fetch time preserved across the outage');
  assert.equal(cache.providers.openrouter.ok, true, 'openrouter unaffected by nvidia outage (per-upstream isolation)');
});

test('catalogStatus surfaces per-provider health, last error, and flips stale when a provider is down', async () => {
  const cache = {};
  const res = await discoverCatalog({
    localModels: local,
    nvidiaFetch: async () => { throw new Error('nvidia down'); },
    openrouterFetch: async () => orJson(['g/c:free']),
    cache,
    now: () => 1000,
  });
  const status = catalogStatus({
    catalog: res.models,
    cache,
    refreshSeconds: 60,
    now: () => 1000 + 4000, // 4s later
  });
  assert.equal(status.stale, true, 'a downed provider marks the catalog stale');
  assert.equal(status.providers.nvidia.ok, false);
  assert.equal(status.providers.nvidia.lastError, 'nvidia down');
  assert.equal(status.providers.openrouter.ok, true);
  assert.equal(status.providers.openrouter.lastError, null);
  assert.equal(status.providers.openrouter.successAgeSeconds, 4);
});

test('catalogStatus flips stale when the catalog is overdue past twice its refresh window', () => {
  // All providers healthy, but the last refresh is ancient: the poller is wedged.
  const cache = {
    lastRefreshedAt: 0,
    providers: { nvidia: { ok: true, count: 3, lastSuccessAt: 0 } },
  };
  const fresh = catalogStatus({ catalog: [], cache, refreshSeconds: 60, now: () => 200 * 1000 });
  assert.equal(fresh.stale, true, '200s age vs 60s window (>2x=120s) is overdue');
  const ok = catalogStatus({ catalog: [], cache, refreshSeconds: 60, now: () => 90 * 1000 });
  assert.equal(ok.stale, false, '90s age vs 60s window (<2x=120s) is not yet overdue');
});
