/**
 * generic-bucket-capacity.test.mjs: the generic size buckets (sk-s, sk-m,
 * sk-l, sk-xl) as first-class fleet routing targets.
 *
 *   /v1/models  a generic bucket is advertised when AT LEAST ONE fenced,
 *               tool-capable reasoning member qualifies (not all, unlike a
 *               focused alias), with members + member_backends listed.
 *   /queue      one capacity-domain row per qualified bucket, summing member
 *               pool max/active (a shared pool domain counted once).
 *   /health     one aggregate row per qualified bucket.
 *   fences      routing.bucket_excluded_models, generic_bucket_providers and
 *               generic_bucket_excluded_models never let an excluded model
 *               count, and the generic-only fences leave focused aliases alone.
 *
 * Run with: node --test tests/generic-bucket-capacity.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  genericBucketQualification,
  applyGenericBucketMetadata,
  genericBucketQueueRows,
  genericBucketHealthRows,
  GENERIC_BUCKET_IDS,
} from '../src/policy/generic-bucket-status.mjs';
import { genericBucketFence, isGenericBucket, parseBucketId } from '../src/policy/buckets.mjs';

const QUALIFIED_CARD = {
  reasoning: true, supported_parameters: ['tools', 'tool_choice'], tier: 'paid-cloud', size_class: 'L',
};

/** A concrete /v1/models row on a remote public provider. */
const row = (id, provider, overrides = {}) => ({
  id, object: 'model', owned_by: provider, provider, advertised: true, stale: false,
  status: 'available', card: { ...QUALIFIED_CARD }, ...overrides,
});

const bucketEntry = (id) => ({ id, object: 'model', provider: 'skgateway', owned_by: 'skgateway', kind: 'bucket' });

const opts = (data) => ({ membership: data, lifecycle: () => null });

function project(data, cfg = {}) {
  const q = genericBucketQualification(data, cfg, opts(data));
  return { q, out: applyGenericBucketMetadata(data, q) };
}

describe('/v1/models generic bucket advertisement', () => {
  test('advertised when ONE of several members qualifies; only qualified members listed', () => {
    const data = [
      bucketEntry('sk-m'),
      row('zai-flagship', 'zai'),
      row('deepseek-no-tools', 'deepseek', { card: { ...QUALIFIED_CARD, supported_parameters: ['tools'] } }),
      row('deepseek-stale', 'deepseek', { stale: true }),
    ];
    const { out } = project(data);
    const m = out.find((e) => e.id === 'sk-m');
    assert.equal(m.advertised, true);
    assert.equal(m.stale, false);
    assert.equal(m.provider, 'skgateway');
    assert.equal(m.owned_by, 'skgateway');
    assert.equal(m.kind, 'bucket');
    assert.deepEqual(m.card, {
      size_class: 'M', reasoning: true, supported_parameters: ['tools', 'tool_choice', 'reasoning'], tier: 'paid-cloud',
    });
    assert.deepEqual(m.members, ['zai-flagship']);
    assert.deepEqual(m.member_backends, ['zai']);
  });

  test('tier is omitted when qualified members disagree', () => {
    const data = [
      bucketEntry('sk-m'),
      row('zai-flagship', 'zai'),
      row('deepseek-v4', 'deepseek', { card: { ...QUALIFIED_CARD, tier: 'other' } }),
    ];
    const m = project(data).out.find((e) => e.id === 'sk-m');
    assert.equal(m.advertised, true);
    assert.equal(Object.hasOwn(m.card, 'tier'), false);
    assert.deepEqual(m.members.sort(), ['deepseek-v4', 'zai-flagship']);
    assert.deepEqual(m.member_backends.sort(), ['deepseek', 'zai']);
  });

  test('not advertised when no member qualifies; no card claims', () => {
    const data = [
      bucketEntry('sk-m'),
      row('zai-no-reasoning', 'zai', { card: { ...QUALIFIED_CARD, reasoning: false } }),
      row('deepseek-unavailable', 'deepseek', { status: 'unavailable' }),
      row('zai-throttled', 'zai', { capacity: { state: 'throttled' } }),
      row('zai-unadvertised', 'zai', { advertised: false }),
    ];
    const m = project(data).out.find((e) => e.id === 'sk-m');
    assert.equal(m.advertised, false);
    assert.equal(m.stale, true);
    assert.equal(m.card, undefined);
    assert.equal(m.members, undefined);
  });

  test('focused aliases and concrete rows pass through untouched', () => {
    const focused = { ...bucketEntry('sk-zai-m'), advertised: true };
    const concrete = row('zai-flagship', 'zai');
    const data = [focused, concrete, bucketEntry('sk-m-public')];
    const { out } = project(data);
    assert.equal(out[0], focused);
    assert.equal(out[1], concrete);
    assert.equal(out[2], data[2], 'only sk-s/sk-m/sk-l/sk-xl are projected');
  });

  test('excluded models never count: advertise, bucket and generic exclusions', () => {
    const data = [bucketEntry('sk-m'), row('a', 'zai'), row('b', 'deepseek'), row('c', 'zai')];
    for (const cfg of [
      { advertise: { excluded_models: ['a', 'b', 'c'] } },
      { routing: { bucket_excluded_models: ['a', 'b', 'c'] } },
      { routing: { generic_bucket_excluded_models: ['a', 'b', 'c'] } },
    ]) {
      const m = project(data, cfg).out.find((e) => e.id === 'sk-m');
      assert.equal(m.advertised, false, JSON.stringify(cfg));
    }
    const partial = project(data, { routing: { generic_bucket_excluded_models: ['a'] } })
      .out.find((e) => e.id === 'sk-m');
    assert.deepEqual(partial.members.sort(), ['b', 'c']);
  });

  test('generic_bucket_providers limits members to the listed providers (glm alias resolves to zai)', () => {
    const data = [bucketEntry('sk-m'), row('a', 'zai'), row('b', 'deepseek'), row('k', 'kimi-for-coding')];
    const onlyDeepseek = project(data, { routing: { generic_bucket_providers: ['deepseek'] } })
      .out.find((e) => e.id === 'sk-m');
    assert.deepEqual(onlyDeepseek.members, ['b']);
    const glm = project(data, { routing: { generic_bucket_providers: ['glm', 'deepseek'] } })
      .out.find((e) => e.id === 'sk-m');
    assert.deepEqual(glm.members.sort(), ['a', 'b']);
    const none = project(data, { routing: { generic_bucket_providers: ['openrouter'] } })
      .out.find((e) => e.id === 'sk-m');
    assert.equal(none.advertised, false);
  });

  test('every generic bucket id gets a qualification entry', () => {
    const { q } = project([row('a', 'zai')]);
    assert.deepEqual([...q.keys()].sort(), [...GENERIC_BUCKET_IDS].sort());
  });
});

describe('/queue generic bucket rows', () => {
  const stats = {
    zai: { capacityDomain: 'zai', members: ['zai'], active: 2, queued: 1, max: 8, maxQueue: 50, queueTimeoutMs: 1000, totalProcessed: 10 },
    deepseek: { capacityDomain: 'deepseek', members: ['deepseek'], active: 1, queued: 0, max: 4, maxQueue: 20, queueTimeoutMs: 3000, totalProcessed: 5 },
    'deepseek-alt': { capacityDomain: 'deepseek', members: ['deepseek', 'deepseek-alt'], active: 1, queued: 0, max: 4, maxQueue: 20 },
  };

  test('sums member maxes/active and lists member backends', () => {
    const data = [row('a', 'zai'), row('b', 'deepseek')];
    const q = genericBucketQualification(data, {}, opts(data));
    const rows = genericBucketQueueRows(q, (id) => stats[id]);
    assert.ok(rows['sk-m']);
    assert.equal(rows['sk-m'].capacityDomain, 'sk-m');
    assert.deepEqual(rows['sk-m'].members.sort(), ['deepseek', 'zai']);
    assert.equal(rows['sk-m'].max, 12);
    assert.equal(rows['sk-m'].active, 3);
    assert.equal(rows['sk-m'].queued, 1);
    assert.equal(rows['sk-m'].maxQueue, 70);
    assert.equal(rows['sk-m'].queueTimeoutMs, 3000);
  });

  test('two member backends sharing one pool domain count once', () => {
    const data = [row('b', 'deepseek'), row('c', 'deepseek-alt', { provider: 'deepseek' })];
    const q = genericBucketQualification(data, {}, opts(data));
    const rows = genericBucketQueueRows(q, (id) => stats[id]);
    assert.deepEqual(rows['sk-m'].members.sort(), ['deepseek', 'deepseek-alt']);
    assert.equal(rows['sk-m'].max, 4);
  });

  test('a bucket with no qualified member has no row; fences shrink members and max', () => {
    const data = [row('a', 'zai'), row('b', 'deepseek')];
    const cfg = { routing: { generic_bucket_providers: ['zai'] } };
    const q = genericBucketQualification(data, cfg, opts(data));
    const rows = genericBucketQueueRows(q, (id) => stats[id]);
    assert.deepEqual(rows['sk-m'].members, ['zai']);
    assert.equal(rows['sk-m'].max, 8);
    const none = genericBucketQualification([], {}, opts([]));
    assert.deepEqual(genericBucketQueueRows(none, (id) => stats[id]), {});
  });
});

describe('/health generic bucket rows', () => {
  const data = [row('a', 'zai'), row('b', 'deepseek')];
  const q = genericBucketQualification(data, {}, opts(data));

  test('up when any member backend is up; latest lastCheck; not quarantined', () => {
    const rows = genericBucketHealthRows(q, {
      zai: { status: 'down', observed: true, quarantined: true, lastCheck: 100 },
      deepseek: { status: 'up', observed: true, quarantined: false, lastCheck: 200 },
    });
    assert.deepEqual(rows['sk-m'], {
      status: 'up', observed: true, quarantined: false, lastCheck: 200,
      members: rows['sk-m'].members, capacity: { current: true, state: 'available' },
    });
    assert.deepEqual(rows['sk-m'].members.sort(), ['deepseek', 'zai']);
  });

  test('quarantined only when ALL members are; best available status otherwise', () => {
    const rows = genericBucketHealthRows(q, {
      zai: { status: 'down', quarantined: true, lastCheck: 5 },
      deepseek: { status: 'degraded', quarantined: true, lastCheck: 7 },
    });
    assert.equal(rows['sk-m'].status, 'degraded');
    assert.equal(rows['sk-m'].quarantined, true);
    assert.equal(rows['sk-m'].lastCheck, 7);
  });
});

describe('genericBucketFence', () => {
  test('empty config admits everything', () => {
    const fence = genericBucketFence({});
    assert.equal(fence({ id: 'x', provider: 'nvidia' }), true);
  });
  test('provider list matches provider or owned_by, kimi family included', () => {
    const fence = genericBucketFence({ generic_bucket_providers: ['kimi', 'zai'] });
    assert.equal(fence({ id: 'k', provider: 'kimi-for-coding' }), true);
    assert.equal(fence({ id: 'z', provider: 'glm' }), true);
    assert.equal(fence({ id: 'o', provider: 'other', owned_by: 'zai' }), true);
    assert.equal(fence({ id: 'd', provider: 'deepseek' }), false);
  });
  test('isGenericBucket is true only for provider-less buckets', () => {
    assert.equal(isGenericBucket(parseBucketId('sk-m')), true);
    assert.equal(isGenericBucket(parseBucketId('sk-m-internal')), true);
    assert.equal(isGenericBucket(parseBucketId('sk-zai-m')), false);
  });
});

describe('config validation for the generic-only fences', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadConfig, getConfig } = await import('../src/config.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'skgw-generic-fence-cfg-'));
  const load = (body) => {
    const p = join(dir, `gw-${Math.random().toString(36).slice(2)}.yaml`);
    writeFileSync(p, body, 'utf8');
    return loadConfig({ configPath: p, silent: true });
  };

  test('defaults are empty arrays (today\'s behaviour)', async () => {
    await load('routing:\n  buckets_enabled: true\n');
    const cfg = getConfig();
    assert.deepEqual(cfg.routing.generic_bucket_providers, []);
    assert.deepEqual(cfg.routing.generic_bucket_excluded_models, []);
  });
  test('valid arrays load', async () => {
    await load('routing:\n  generic_bucket_providers: [zai, deepseek]\n  generic_bucket_excluded_models: [glm-4.5]\n');
    const cfg = getConfig();
    assert.deepEqual(cfg.routing.generic_bucket_providers, ['zai', 'deepseek']);
    assert.deepEqual(cfg.routing.generic_bucket_excluded_models, ['glm-4.5']);
  });
  test('non-array or malformed values are rejected', async () => {
    await assert.rejects(async () => load('routing:\n  generic_bucket_providers: zai\n'), /generic_bucket_providers/);
    await assert.rejects(async () => load('routing:\n  generic_bucket_excluded_models: [" bad id"]\n'), /generic_bucket_excluded_models/);
  });
});
