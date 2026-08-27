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
  orderMembersByCost,
  selectMember,
  gradeVocabulary,
  measuredClassCeiling,
  effectiveClass,
} from '../src/policy/buckets.mjs';
import { TRUST_ZONES } from '../src/policy/sensitivity.mjs';

// `declared` is the parameter-size PRIOR (card f942d93b). `failed` names a
// capability the assessment measured as failing, which CAPS the class. There is
// deliberately no way to express "measured class = XL": measurement is evidence
// against a class, never for one. See measuredClassCeiling().
const entry = (id, { zone, declared, failed } = {}) => ({
  id,
  capabilities: {
    ...(zone !== undefined ? { trust_zone: zone } : {}),
    ...(declared ? { size_class: declared } : {}),
  },
  ...(failed
    ? {
        lifecycle: {
          measured_capabilities: {
            tool_call: { status: failed === 'tool_call' ? 'fail' : 'pass' },
            structured_output: { status: failed === 'structured_output' ? 'fail' : 'pass' },
            instruction_following: { status: 'pass' },
          },
        },
      }
    : {}),
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
  test('the declared prior satisfies its own floor and below', () => {
    assert.equal(meetsClassFloor(entry('a', { declared: 'XL' }), 'L').ok, true);
    assert.equal(meetsClassFloor(entry('a', { declared: 'L' }), 'L').ok, true);
    assert.equal(meetsClassFloor(entry('a', { declared: 'M' }), 'L').ok, false);
  });

  test('a declared parameter size is a PRIOR, and labelled as one', () => {
    const r = meetsClassFloor(entry('a', { declared: 'XL' }), 'L');
    assert.equal(r.ok, true);
    assert.equal(r.basis, 'declared-size-prior', 'must not masquerade as an assessment');
  });

  test('MEASURED beats DECLARED, never the other way round', () => {
    // A 550B model that measurably cannot hold a tool call must not ride its
    // size into an L bucket.
    const r = meetsClassFloor(entry('big-but-weak', { declared: 'XL', failed: 'tool_call' }), 'L');
    assert.equal(r.ok, false);
    assert.match(r.basis, /measured-ceiling/);
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
    entry('ornith-35b', { zone: TRUST_ZONES.SOVEREIGN_LOCAL, declared: 'L' }),
    entry('claude-opus', { zone: TRUST_ZONES.PAID_CONTRACTUAL, declared: 'XL' }),
    entry('big-pickle', { zone: TRUST_ZONES.FREE_REMOTE, declared: 'L' }),
    entry('tiny-free', { zone: TRUST_ZONES.FREE_REMOTE, declared: 'S' }),
    entry('mystery', { declared: 'XL' }), // no zone at all
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

  test('members expose family and declared cost separately from trust', () => {
    const decorated = {
      ...entry('claude-opus', { zone: TRUST_ZONES.PAID_CONTRACTUAL, declared: 'XL' }),
      card: { family: 'claude', cost_tier: 'paid-cloud' },
    };
    const { members } = resolveBucket({
      bucket: { model_class: 'XL', sensitivity: 'internal' },
      catalog: [decorated],
    });
    assert.deepEqual(members, [{
      id: 'claude-opus',
      class_basis: 'declared-size-prior',
      model_class: 'XL',
      trust_zone: TRUST_ZONES.PAID_CONTRACTUAL,
      family: 'claude',
      cost_tier: 'paid-cloud',
    }]);
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

describe('C9: cost-ranked selection rotates only among equal-cost members', () => {
  const members = [
    { id: 'paid', cost_tier: 'paid-cloud' },
    { id: 'local-a', cost_tier: 'local' },
    { id: 'free', cost_tier: 'free-remote' },
    { id: 'local-b', cost_tier: 'local' },
  ];

  test('successive requests share the cheapest tier without spilling into costlier tiers', () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4].map((i) => selectMember(members, i).id),
      ['local-a', 'local-b', 'local-a', 'local-b', 'local-a'],
    );
  });

  test('DRILL: an S-graded public card moves from blind fleet rotation to the sovereign local tier', () => {
    const liveShape = [
      ...Array.from({ length: 17 }, (_, i) => ({ id: `paid-${i}`, cost_tier: 'paid-cloud' })),
      ...Array.from({ length: 9 }, (_, i) => ({ id: `free-${i}`, cost_tier: 'free-remote' })),
      ...Array.from({ length: 7 }, (_, i) => ({ id: `local-${i}`, cost_tier: 'local' })),
    ];
    const counts = (chosen) => chosen.reduce((out, member) => {
      out[member.cost_tier] = (out[member.cost_tier] || 0) + 1;
      return out;
    }, {});
    const before = counts(Array.from({ length: 66 }, (_, i) => liveShape[i % liveShape.length]));
    const after = counts(Array.from({ length: 66 }, (_, i) => selectMember(liveShape, i)));

    assert.deepEqual(before, { 'paid-cloud': 34, 'free-remote': 18, local: 14 });
    assert.deepEqual(after, { local: 66 });
  });

  test('the failover chain exhausts equal-cost peers before costlier tiers', () => {
    assert.deepEqual(
      orderMembersByCost(members, 1).map((m) => m.id),
      ['local-b', 'local-a', 'free', 'paid'],
    );
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

  test('NEGATIVE CONTROL: ranking cannot admit a member rejected by the trust ceiling', () => {
    const catalog = [
      {
        ...entry('local', { zone: TRUST_ZONES.SOVEREIGN_LOCAL, declared: 'L' }),
        capabilities: { trust_zone: TRUST_ZONES.SOVEREIGN_LOCAL, size_class: 'L', sovereignty: 'local' },
      },
      {
        ...entry('free', { zone: TRUST_ZONES.FREE_REMOTE, declared: 'L' }),
        capabilities: { trust_zone: TRUST_ZONES.FREE_REMOTE, size_class: 'L', sovereignty: 'free-remote' },
      },
    ];
    const { members: eligible, rejected } = resolveBucket({
      bucket: { model_class: 'L', sensitivity: 'secret' },
      catalog,
    });

    assert.deepEqual(eligible.map((m) => m.id), ['local']);
    assert.deepEqual(orderMembersByCost(eligible, 0).map((m) => m.id), ['local']);
    assert.equal(rejected.some((r) => r.id === 'free'), true, 'free-remote stays excluded');
  });

  test('the cost and trust ladders remain independent', () => {
    const eligible = [
      { id: 'paid-zone-1', cost_tier: 'paid-cloud', trust_zone: TRUST_ZONES.PAID_CONTRACTUAL },
      { id: 'free-zone-2', cost_tier: 'free-remote', trust_zone: TRUST_ZONES.FREE_REMOTE },
    ];
    assert.deepEqual(
      orderMembersByCost(eligible, 0).map((m) => m.id),
      ['free-zone-2', 'paid-zone-1'],
      'free-remote is cheaper even though it is less trusted; cost must not impersonate trust',
    );
  });
});

// ── the seam between the two halves of C9 ───────────────────────────────────
//
// The bucket layer needs a class; the assessment half produces capabilities
// (tool_call, structured_output, ...). Nothing derived one from the other until
// this bridge, so without it every model fell back to the declared parameter
// size and "measured, not declared" would have been aspirational.
describe('C9: measurement can only LOWER a class, never raise it', () => {
  const m = (over) => ({
    tool_call: { status: 'pass' },
    structured_output: { status: 'pass' },
    instruction_following: { status: 'pass' },
    ...over,
  });

  test('a model that cannot hold a tool call is capped at S regardless of size', () => {
    // The whole reason declared size is only a prior. A 550B that fails a tool
    // call is not an XL-capable model, it is a large model that cannot do the
    // work the bucket promises.
    const { cap } = measuredClassCeiling(m({ tool_call: { status: 'fail' } }));
    assert.equal(cap, 'S');
    assert.equal(effectiveClass('XL', m({ tool_call: { status: 'fail' } })).cls, 'S');
  });

  test('failing schema or instruction following caps at M', () => {
    assert.equal(measuredClassCeiling(m({ structured_output: { status: 'fail' } })).cap, 'M');
    assert.equal(measuredClassCeiling(m({ instruction_following: { status: 'fail' } })).cap, 'M');
  });

  test('PASSING everything does NOT promote above the declared prior', () => {
    // Passing a tool-call assertion proves a model can emit a tool call. It
    // proves nothing about architecture-level reasoning, which is what an XL
    // floor claims. Measurement is evidence AGAINST, not evidence FOR.
    const r = effectiveClass('M', m());
    assert.equal(r.cls, 'M', 'a passing battery must not turn an M model into an XL one');
    assert.equal(r.basis, 'declared-size-prior');
  });

  test('UNMEASURED caps nothing, so a throttled model is not demoted', () => {
    // A 429 during assessment means we learned nothing. Demoting for it would
    // evict a good model for being popular, undoing the distinction the
    // assessment half draws between unmeasured and incapable.
    for (const status of ['unmeasured', undefined]) {
      const { cap } = measuredClassCeiling(m({ tool_call: { status } }));
      assert.equal(cap, null, `status=${status} must not cap`);
    }
    assert.equal(effectiveClass('XL', m({ tool_call: { status: 'unmeasured' } })).cls, 'XL');
  });

  test('no measurement at all leaves the prior untouched', () => {
    assert.equal(effectiveClass('L', null).cls, 'L');
    assert.equal(effectiveClass(null, null).cls, null);
  });

  test('end to end: a measured failure removes a model from an L bucket', () => {
    const big = {
      id: 'big-but-weak',
      capabilities: { size_class: 'XL', trust_zone: 0 },
      lifecycle: { measured_capabilities: m({ tool_call: { status: 'fail' } }) },
    };
    const { members, rejected } = resolveBucket({
      bucket: { model_class: 'L', sensitivity: 'secret' },
      catalog: [big],
    });
    assert.equal(members.length, 0, 'declared XL must not carry a model that failed the measurement');
    assert.match(rejected[0].reason, /measured-ceiling/);
  });
});
