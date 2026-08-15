/**
 * sensitivity-trust-zone.test.mjs
 *
 * Card 45d7a30b / N1: job sensitivity gates which trust zone may serve it.
 *
 * The failure mode this defends against is specific and has already happened
 * on this fleet: sk-default's sovereign backend went unreachable, the router
 * transparently failed over to a free cloud model, and everything kept
 * answering. Nothing was down. Work had simply, silently, started going to a
 * third party. Verified 2026-08-15 from provider terms, nvidia, openrouter and
 * opencode all train on submitted content, so "it still worked" and "the
 * content stayed ours" are unrelated facts.
 *
 * A sovereignty control that admits everything is indistinguishable from one
 * that works, right up until you read the logs. So the tests that matter here
 * are the ones asserting something is BLOCKED, and the negative control
 * asserting the gate is not a no-op.
 *
 * Run with:  node --test tests/sensitivity-trust-zone.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SENSITIVITY_LEVELS,
  TRUST_ZONES,
  DEFAULT_SENSITIVITY_POLICY,
  isSensitivity,
  resolveZoneCeiling,
  isZoneAllowed,
  filterByZone,
  policyFromRegistry,
} from '../src/policy/sensitivity.mjs';

describe('N1: sensitivity resolves to a trust-zone ceiling', () => {
  test('the defaults are the strict ones', () => {
    assert.equal(DEFAULT_SENSITIVITY_POLICY.secret, TRUST_ZONES.SOVEREIGN_LOCAL);
    assert.equal(DEFAULT_SENSITIVITY_POLICY.internal, TRUST_ZONES.PAID_CONTRACTUAL);
    assert.equal(DEFAULT_SENSITIVITY_POLICY.public, TRUST_ZONES.FREE_REMOTE);
  });

  test('an UNRECOGNIZED sensitivity resolves to the STRICTEST ceiling, never the loosest', () => {
    // A typo must not widen the gate. `sensitivty: secret` is the realistic
    // case, and the dangerous outcome is that it silently becomes "anything".
    for (const bad of ['sekret', 'SECRET ', '', null, undefined, 42, {}]) {
      const r = resolveZoneCeiling(bad);
      assert.equal(r.recognized, false, `${JSON.stringify(bad)} must not be recognized`);
      assert.equal(r.ceiling, TRUST_ZONES.SOVEREIGN_LOCAL);
    }
  });

  test('a malformed policy entry clamps strict rather than being trusted', () => {
    // A bad config must not become a way to widen the gate.
    for (const bad of [{ secret: 'anything' }, { secret: NaN }, { secret: 99 }, { secret: -5 }]) {
      const { ceiling } = resolveZoneCeiling('secret', { ...DEFAULT_SENSITIVITY_POLICY, ...bad });
      assert.ok(
        ceiling >= TRUST_ZONES.SOVEREIGN_LOCAL && ceiling <= TRUST_ZONES.FREE_REMOTE,
        'ceiling stays inside the zone range',
      );
      if (bad.secret === 99) assert.equal(ceiling, TRUST_ZONES.FREE_REMOTE, 'clamped, not unbounded');
      if (typeof bad.secret !== 'number' || !Number.isFinite(bad.secret)) {
        assert.equal(ceiling, TRUST_ZONES.SOVEREIGN_LOCAL, 'non-numeric clamps strict');
      }
    }
  });

  test('a deployment can loosen internal deliberately, via config not accident', () => {
    const policy = policyFromRegistry({ sensitivity_policy: { internal: TRUST_ZONES.FREE_REMOTE } });
    assert.equal(resolveZoneCeiling('internal', policy).ceiling, TRUST_ZONES.FREE_REMOTE);
    // and the levels it did NOT mention keep their strict defaults
    assert.equal(resolveZoneCeiling('secret', policy).ceiling, TRUST_ZONES.SOVEREIGN_LOCAL);
  });

  test('every declared level is recognized', () => {
    for (const l of SENSITIVITY_LEVELS) assert.equal(isSensitivity(l), true);
  });
});

describe('N1: an UNKNOWN trust zone is least-trusted, not a free pass', () => {
  test('null/undefined zone is treated as free-remote', () => {
    // N2 measured that a large share of the fleet has no resolvable provider
    // posture, so this is the common case. "We do not know where this runs"
    // must never satisfy a sovereignty requirement.
    for (const unknown of [null, undefined, NaN, 'local']) {
      assert.equal(isZoneAllowed(unknown, TRUST_ZONES.SOVEREIGN_LOCAL), false);
      assert.equal(isZoneAllowed(unknown, TRUST_ZONES.PAID_CONTRACTUAL), false);
      assert.equal(isZoneAllowed(unknown, TRUST_ZONES.FREE_REMOTE), true);
    }
  });

  test('the ordering is trust, not cost', () => {
    // secret admits only sovereign
    assert.equal(isZoneAllowed(TRUST_ZONES.SOVEREIGN_LOCAL, 0), true);
    assert.equal(isZoneAllowed(TRUST_ZONES.PAID_CONTRACTUAL, 0), false);
    assert.equal(isZoneAllowed(TRUST_ZONES.FREE_REMOTE, 0), false);
    // internal admits paid-contractual but NOT free-remote, which is the
    // deliberate inversion of the cost ladder: free is not cheaper here, it is
    // the provider that trains on the content.
    assert.equal(isZoneAllowed(TRUST_ZONES.PAID_CONTRACTUAL, 1), true);
    assert.equal(isZoneAllowed(TRUST_ZONES.FREE_REMOTE, 1), false);
  });
});

describe('N1: filtering reports what it rejected', () => {
  const zoneOf = (c) => c.zone;

  test('a secret job keeps only the sovereign candidate', () => {
    const candidates = [
      { id: 'ornith', zone: TRUST_ZONES.SOVEREIGN_LOCAL },
      { id: 'claude', zone: TRUST_ZONES.PAID_CONTRACTUAL },
      { id: 'big-pickle', zone: TRUST_ZONES.FREE_REMOTE },
      { id: 'mystery', zone: null },
    ];
    const { allowed, rejected } = filterByZone(candidates, TRUST_ZONES.SOVEREIGN_LOCAL, zoneOf);
    assert.deepEqual(allowed.map((c) => c.id), ['ornith']);
    assert.equal(rejected.length, 3);
    // The reasons must be legible: a 503 with an empty list and no explanation
    // is an outage report, not a policy decision.
    assert.match(rejected.find((r) => r.candidate.id === 'mystery').reason, /unknown/);
    assert.match(rejected.find((r) => r.candidate.id === 'claude').reason, /exceeds ceiling 0/);
  });

  test('a public job keeps everything, including unknown', () => {
    const candidates = [{ id: 'a', zone: 2 }, { id: 'b', zone: null }, { id: 'c', zone: 0 }];
    const { allowed, rejected } = filterByZone(candidates, TRUST_ZONES.FREE_REMOTE, zoneOf);
    assert.equal(allowed.length, 3);
    assert.equal(rejected.length, 0);
  });

  test('NEGATIVE CONTROL: the gate is not a no-op', () => {
    // If filterByZone ever returns everything for a secret job, the control has
    // silently become a placebo. That is precisely the shape card C5 fixed in
    // the ranker, and the reason this assertion exists rather than only
    // happy-path ones.
    const candidates = [
      { id: 'free-1', zone: TRUST_ZONES.FREE_REMOTE },
      { id: 'free-2', zone: TRUST_ZONES.FREE_REMOTE },
    ];
    const { allowed } = filterByZone(candidates, TRUST_ZONES.SOVEREIGN_LOCAL, zoneOf);
    assert.equal(allowed.length, 0, 'a secret job must have NO eligible free-remote candidate');
  });
});

describe('N1: the backend-level zone resolver', () => {
  test('classifies the fleet the way the provider terms do', async () => {
    const { backendTrustZone } = await import('../src/proxy/router.mjs');
    assert.equal(
      backendTrustZone({ backendId: 'ornith', backendUrl: 'http://192.168.0.100:8082/v1' }),
      TRUST_ZONES.SOVEREIGN_LOCAL,
    );
    assert.equal(
      backendTrustZone({ backendId: 'anthropic-direct', backendUrl: 'https://api.anthropic.com/v1' }),
      TRUST_ZONES.PAID_CONTRACTUAL,
      'Anthropic commercial terms prohibit training on Customer Content',
    );
    assert.equal(
      backendTrustZone({ backendId: 'nvidia', backendUrl: 'https://integrate.api.nvidia.com/v1' }),
      TRUST_ZONES.FREE_REMOTE,
      'nvidia free tier trains on submitted content',
    );
    assert.equal(
      backendTrustZone({ backendId: 'opencode', backendUrl: 'https://opencode.ai/zen/v1' }),
      TRUST_ZONES.FREE_REMOTE,
    );
    assert.equal(
      backendTrustZone({}),
      TRUST_ZONES.FREE_REMOTE,
      'an unrecognizable backend is least-trusted, never assumed safe',
    );
  });
});
