/**
 * buckets.test.mjs: card 2ba73bf9 / C9, addressing a pool instead of a model.
 *
 * The property under test is not "the happy path resolves". It is that a bucket
 * cannot quietly hand back something the caller forbade. Every rot problem in
 * the 767adc4e epic came from a stale model id, and the counter-risk of pools
 * is that they hide WHICH model answered, so the constraints have to hold
 * without anyone watching a specific id.
 *
 * Run with:  node --test tests/buckets.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBucketId,
  isBucketId,
  allBuckets,
  classRank,
  meetsClassFloor,
  resolveBucket,
  selectMember,
  gradeVocabulary,
} from '../src/policy/buckets.mjs';
import { TRUST_ZONES } from '../src/policy/sensitivity.mjs';

const entry = (id, { zone, measured, declared } = {}) => ({
  id,
  capabilities: {
    ...(zone !== undefined ? { trust_zone: zone } : {}),
    ...(measured ? { measured_class: measured } : {}),
    ...(declared ? { size_class: declared } : {}),
  },
});

describe('C9: bucket addressing', () => {
  test('a bucket is a model id, so no client change is needed', () => {
    const b = parseBucketId('sk-xl-secret');
    assert.deepEqual(b, { bucket: 'sk-xl-secret', model_class: 'XL', sensitivity: 'secret' });
    assert.equal(isBucketId('sk-s-public'), true);
  });

  test('an ordinary model id is not a bucket', () => {
    for (const id of ['big-pickle', 'openai/gpt-oss-20b', 'sk-default', 'sk-auto', 'claude-opus-4-8']) {
      assert.equal(parseBucketId(id), null, `${id} must route normally`);
    }
  });

  test('a NEAR MISS does not resolve, it falls through loudly', () => {
    // A typo must never land on something permissive. `sk-xl-secrets` is not
    // "close enough" to secret; it is an unknown model, which is loud.
    for (const near of ['sk-xl-secrets', 'sk-xxl-secret', 'sk--secret', 'sk-xl-', 'sk-xl-Secret ']) {
      const parsed = parseBucketId(near);
      if (parsed) assert.equal(parsed.sensitivity, 'secret', 'only exact case-insensitive matches may resolve');
      else assert.equal(parsed, null);
    }
    assert.equal(parseBucketId('sk-xl-secrets'), null);
  });

  test('the taxonomy is the canonical vocabulary, not a local invention', () => {
    const v = gradeVocabulary();
    assert.deepEqual(v.model_class.values, ['S', 'M', 'L', 'XL']);
    assert.deepEqual(v.sensitivity.values, ['public', 'internal', 'secret']);
    // risk is a SEPARATE axis and must not have been folded into the bucket id
    assert.deepEqual(v.risk.values, ['low', 'med', 'high', 'crit']);
    assert.equal(allBuckets().length, 12, '4 classes x 3 sensitivities');
  });
});

describe('C9: the capability floor is HARD', () => {
  test('a measured class satisfies its own floor and below', () => {
    assert.equal(meetsClassFloor(entry('a', { measured: 'XL' }), 'L').ok, true);
    assert.equal(meetsClassFloor(entry('a', { measured: 'L' }), 'L').ok, true);
    assert.equal(meetsClassFloor(entry('a', { measured: 'M' }), 'L').ok, false);
  });

  test('a declared parameter size is a PRIOR, and labelled as one', () => {
    const r = meetsClassFloor(entry('a', { declared: 'XL' }), 'L');
    assert.equal(r.ok, true);
    assert.equal(r.basis, 'declared-size-prior', 'must not masquerade as an assessment');
  });

  test('MEASURED beats DECLARED, never the other way round', () => {
    // A 550B model that measurably cannot do the work must not ride its size.
    const r = meetsClassFloor(entry('big-but-weak', { declared: 'XL', measured: 'S' }), 'L');
    assert.equal(r.ok, false);
    assert.equal(r.basis, 'measured');
  });

  test('UNKNOWN capability clears only the S floor', () => {
    assert.equal(meetsClassFloor(entry('mystery'), 'S').ok, true);
    for (const floor of ['M', 'L', 'XL']) {
      assert.equal(
        meetsClassFloor(entry('mystery'), floor).ok,
        false,
        'absence of evidence is not evidence of capability',
      );
    }
  });
});

describe('C9: eligibility composes the floor with the sovereignty ceiling', () => {
  const catalog = [
    entry('ornith-35b', { zone: TRUST_ZONES.SOVEREIGN_LOCAL, measured: 'L' }),
    entry('claude-opus', { zone: TRUST_ZONES.PAID_CONTRACTUAL, measured: 'XL' }),
    entry('big-pickle', { zone: TRUST_ZONES.FREE_REMOTE, measured: 'L' }),
    entry('tiny-free', { zone: TRUST_ZONES.FREE_REMOTE, measured: 'S' }),
    entry('mystery', { measured: 'XL' }), // no zone at all
  ];

  test('a secret bucket admits only sovereign, however capable the rest are', () => {
    const { members } = resolveBucket({ bucket: { model_class: 'L', sensitivity: 'secret' }, catalog });
    assert.deepEqual(members.map((m) => m.id), ['ornith-35b']);
  });

  test('an internal bucket excludes free-remote but keeps paid-contractual', () => {
    const { members } = resolveBucket({ bucket: { model_class: 'L', sensitivity: 'internal' }, catalog });
    assert.deepEqual(members.map((m) => m.id).sort(), ['claude-opus', 'ornith-35b']);
  });

  test('a public bucket still enforces the capability floor', () => {
    const { members, rejected } = resolveBucket({ bucket: { model_class: 'L', sensitivity: 'public' }, catalog });
    assert.ok(members.some((m) => m.id === 'big-pickle'));
    assert.ok(!members.some((m) => m.id === 'tiny-free'), 'S cannot serve an L bucket');
    assert.ok(rejected.find((r) => r.id === 'tiny-free').reason.includes('below floor L'));
  });

  test('an unknown trust zone is excluded from anything but public', () => {
    const { members, rejected } = resolveBucket({ bucket: { model_class: 'XL', sensitivity: 'internal' }, catalog });
    assert.ok(!members.some((m) => m.id === 'mystery'));
    assert.match(rejected.find((r) => r.id === 'mystery').reason, /unknown/);
  });

  test('lifecycle exclusion still applies', () => {
    const { members } = resolveBucket({
      bucket: { model_class: 'L', sensitivity: 'public' },
      catalog,
      isRoutable: (e) => e.id !== 'big-pickle',
    });
    assert.ok(!members.some((m) => m.id === 'big-pickle'));
  });

  test('NEGATIVE CONTROL: an empty pool is empty, never quietly widened', () => {
    // XL work at secret sensitivity, with no sovereign XL model in the fleet.
    // The correct answer is NOTHING, so the caller gets a 503 rather than a
    // capable-but-forbidden model. If this ever returns members, the bucket has
    // started substituting across a boundary, which is the exact silent
    // downgrade this design exists to prevent.
    const { members, rejected } = resolveBucket({
      bucket: { model_class: 'XL', sensitivity: 'secret' },
      catalog,
    });
    assert.equal(members.length, 0);
    assert.ok(rejected.length > 0, 'and it must be able to explain why');
  });
});

describe('C9: rotation spreads load rather than hammering the favourite', () => {
  const members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  test('successive requests walk the pool', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map((i) => selectMember(members, i).id), ['a', 'b', 'c', 'a', 'b']);
  });

  test('an empty pool selects nothing rather than throwing', () => {
    assert.equal(selectMember([], 0), null);
    assert.equal(selectMember(null, 3), null);
  });

  test('a negative or absurd counter is still in range', () => {
    for (const c of [-1, -7, 1e9, 0.5]) {
      assert.ok(members.includes(selectMember(members, c)));
    }
  });
});
