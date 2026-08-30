/**
 * family-preference.test.mjs: card 93220ffc / SKW-ROUTE-03
 *
 * Optional family and cost preference, narrowing only.
 *
 * Tests that:
 * 1. A request with a family preference lands on that family when available
 * 2. A preference naming a family absent from the resolved set falls back to
 *    cost-ranked selection WITHOUT widening the member set
 * 3. Prefer 'free' is REFUSED at internal and secret sensitivity
 * 4. Callers name families, never model ids
 * 5. BUCKET_RE is unchanged
 *
 * Run with: node --test --import ./tests/_setup.mjs tests/family-preference.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateFamilyPreference,
  applyFamilyPreference,
  selectMember,
  parseBucketId,
  isBucketId,
} from '../src/policy/buckets.mjs';
import { TRUST_ZONES } from '../src/policy/sensitivity.mjs';

describe('SKW-ROUTE-03: validateFamilyPreference', () => {
  test('null or empty preference is valid and yields null', () => {
    assert.deepEqual(validateFamilyPreference(null), {
      valid: true,
      preference: null,
      reason: null,
    });
    assert.deepEqual(validateFamilyPreference([]), {
      valid: true,
      preference: null,
      reason: null,
    });
    assert.deepEqual(validateFamilyPreference(undefined), {
      valid: true,
      preference: null,
      reason: null,
    });
  });

  test('valid family names are accepted', () => {
    const result = validateFamilyPreference(['claude', 'codex', 'glm']);
    assert.equal(result.valid, true);
    assert.deepEqual(result.preference, ['claude', 'codex', 'glm']);
    assert.equal(result.reason, null);
  });

  test('preference entries are normalized to lowercase', () => {
    const result = validateFamilyPreference(['CLAUDE', 'Codex', 'GLM']);
    assert.equal(result.valid, true);
    assert.deepEqual(result.preference, ['claude', 'codex', 'glm']);
  });

  test('non-string entries are rejected', () => {
    const result = validateFamilyPreference(['claude', 123]);
    assert.equal(result.valid, false);
    assert.equal(result.preference, null);
    assert.match(result.reason, /must be strings, got number/);
  });

  test('AC 4: raw model ids with slashes are rejected', () => {
    const result = validateFamilyPreference(['openai/gpt-4']);
    assert.equal(result.valid, false);
    assert.equal(result.preference, null);
    assert.match(result.reason, /must name a family, not a raw model id/);
    assert.match(result.reason, /openai\/gpt-4/);
  });

  test('AC 4: raw model ids with version patterns are rejected', () => {
    for (const badId of [
      'gpt-4-3.5',
      'claude-3.5-sonnet',
      'qwen-72b-v1',
      'llama-3.1-70b',
    ]) {
      const result = validateFamilyPreference([badId]);
      assert.equal(result.valid, false, `${badId} should be rejected`);
      assert.match(result.reason, /must name a family, not a raw model id/);
    }
  });

  test('AC 4: raw model ids with parameter count patterns are rejected', () => {
    const result = validateFamilyPreference(['gpt-4-turbo-128k']);
    assert.equal(result.valid, false);
    assert.match(result.reason, /must name a family, not a raw model id/);
  });

  test('valid family names with hyphens and underscores are accepted', () => {
    const result = validateFamilyPreference(['deep-seek', 'minimax_ai', 'gemma-2']);
    assert.equal(result.valid, true);
    assert.deepEqual(result.preference, ['deep-seek', 'minimax_ai', 'gemma-2']);
  });

  test('family names must start with a letter', () => {
    const result = validateFamilyPreference(['123family', '_invalid', '9gpt']);
    assert.equal(result.valid, false);
    assert.match(result.reason, /must start with a letter/);
  });
});

describe('SKW-ROUTE-03: validateFamilyPreference - free constraint', () => {
  test('AC 3: prefer "free" is allowed at public sensitivity', () => {
    const result = validateFamilyPreference(['free'], 'public');
    assert.equal(result.valid, true);
    assert.deepEqual(result.preference, ['free']);
  });

  test('AC 3: prefer "free" is REFUSED at internal sensitivity', () => {
    const result = validateFamilyPreference(['free'], 'internal');
    assert.equal(result.valid, false);
    assert.equal(result.preference, null);
    assert.match(result.reason, /not allowed at sensitivity="internal"/);
    assert.match(result.reason, /free remote providers train on submitted content/);
  });

  test('AC 3: prefer "free" is REFUSED at secret sensitivity', () => {
    const result = validateFamilyPreference(['free'], 'secret');
    assert.equal(result.valid, false);
    assert.equal(result.preference, null);
    assert.match(result.reason, /not allowed at sensitivity="secret"/);
    assert.match(result.reason, /free remote providers train on submitted content/);
  });

  test('prefer "free" is rejected in a mixed preference list at internal', () => {
    const result = validateFamilyPreference(['claude', 'free', 'codex'], 'internal');
    assert.equal(result.valid, false);
    assert.match(result.reason, /not allowed at sensitivity="internal"/);
  });

  test('free is normalized to lowercase and validated against sensitivity', () => {
    const result = validateFamilyPreference(['FREE'], 'public');
    assert.equal(result.valid, true);
    assert.deepEqual(result.preference, ['free']);
  });
});

describe('SKW-ROUTE-03: applyFamilyPreference', () => {
  const members = [
    { id: 'claude-opus', card: { family: 'claude' }, cost_tier: 'paid-cloud' },
    { id: 'gpt-4', card: { family: 'codex' }, cost_tier: 'paid-cloud' },
    { id: 'glm-4', card: { family: 'glm' }, cost_tier: 'free-remote' },
    { id: 'ornith-35b', card: { family: 'ornith' }, cost_tier: 'local' },
    { id: 'llama-3', card: { family: 'llama' }, cost_tier: 'local' },
  ];

  test('AC 1: a preference lands on that family when available', () => {
    const result = applyFamilyPreference(members, ['claude']);
    assert.equal(result.length, members.length);
    assert.equal(result[0].id, 'claude-opus');
    assert.equal(result[0].card.family, 'claude');
  });

  test('preference respects order: first preferred family first', () => {
    const result = applyFamilyPreference(members, ['glm', 'claude']);
    assert.equal(result[0].id, 'glm-4');
    assert.equal(result[1].id, 'claude-opus');
  });

  test('multiple members of the same preferred family are grouped together', () => {
    const multiFamily = [
      { id: 'claude-3', card: { family: 'claude' }, cost_tier: 'paid-cloud' },
      { id: 'claude-3.5', card: { family: 'claude' }, cost_tier: 'paid-cloud' },
      { id: 'gpt-4', card: { family: 'codex' }, cost_tier: 'paid-cloud' },
    ];
    const result = applyFamilyPreference(multiFamily, ['claude']);
    assert.equal(result[0].id, 'claude-3');
    assert.equal(result[1].id, 'claude-3.5');
    assert.equal(result[2].id, 'gpt-4');
  });

  test('AC 2: absent families fall back to cost-ranked order without widening', () => {
    const result = applyFamilyPreference(members, ['nonexistent-family']);
    // All members should be present, just reordered
    assert.equal(result.length, members.length);
    // Original order is preserved when nothing matches
    assert.deepEqual(result.map(m => m.id), members.map(m => m.id));
  });

  test('AC 2: THE INVARIANT - member set is never widened', () => {
    const originalIds = new Set(members.map(m => m.id));
    const result = applyFamilyPreference(members, ['claude', 'codex']);
    const resultIds = new Set(result.map(m => m.id));

    // Same members, no new ones added
    assert.deepEqual(resultIds, originalIds);
  });

  test('empty members returns empty', () => {
    assert.deepEqual(applyFamilyPreference([], ['claude']), []);
    assert.deepEqual(applyFamilyPreference(null, ['claude']), null);
    assert.deepEqual(applyFamilyPreference(undefined, ['claude']), undefined);
  });

  test('null preference returns members unchanged', () => {
    const result = applyFamilyPreference(members, null);
    assert.deepEqual(result, members);
  });

  test('empty preference returns members unchanged', () => {
    const result = applyFamilyPreference(members, []);
    assert.deepEqual(result, members);
  });
});

describe('SKW-ROUTE-03: applyFamilyPreference - free special case', () => {
  const members = [
    { id: 'local-1', card: { family: 'llama' }, cost_tier: 'local' },
    { id: 'free-1', card: { family: 'glm' }, cost_tier: 'free-remote' },
    { id: 'free-2', card: { family: 'qwen' }, cost_tier: 'free-remote' },
    { id: 'paid-1', card: { family: 'claude' }, cost_tier: 'paid-cloud' },
  ];

  test('prefer "free" matches free-remote cost tier', () => {
    const result = applyFamilyPreference(members, ['free']);
    assert.equal(result.length, members.length);
    // Free-remote members come first
    assert.equal(result[0].cost_tier, 'free-remote');
    assert.equal(result[1].cost_tier, 'free-remote');
    assert.equal(result[0].id, 'free-1');
    assert.equal(result[1].id, 'free-2');
  });

  test('prefer "free" can be mixed with family names', () => {
    const result = applyFamilyPreference(members, ['claude', 'free']);
    // Claude (paid) first, then free-remote, then remaining
    assert.equal(result[0].id, 'paid-1');
    assert.equal(result[1].cost_tier, 'free-remote');
    assert.equal(result[2].cost_tier, 'free-remote');
  });

  test('no free-remote members: preference has no effect', () => {
    const noFree = [
      { id: 'local-1', card: { family: 'llama' }, cost_tier: 'local' },
      { id: 'paid-1', card: { family: 'claude' }, cost_tier: 'paid-cloud' },
    ];
    const result = applyFamilyPreference(noFree, ['free']);
    // Order unchanged since no matches
    assert.deepEqual(result.map(m => m.id), noFree.map(m => m.id));
  });
});

describe('SKW-ROUTE-03: applyFamilyPreference - partial matches', () => {
  const members = [
    { id: 'a1', card: { family: 'alpha' }, cost_tier: 'local' },
    { id: 'b1', card: { family: 'beta' }, cost_tier: 'local' },
    { id: 'a2', card: { family: 'alpha' }, cost_tier: 'paid-cloud' },
    { id: 'c1', card: { family: 'gamma' }, cost_tier: 'paid-cloud' },
  ];

  test('preferred families first, then unmatched in original order', () => {
    const result = applyFamilyPreference(members, ['beta', 'gamma']);
    assert.deepEqual(result.map(m => m.id), ['b1', 'c1', 'a1', 'a2']);
  });

  test('family matching is case-insensitive', () => {
    const result = applyFamilyPreference(members, ['ALPHA', 'Beta']);
    assert.deepEqual(result.map(m => m.id), ['a1', 'a2', 'b1', 'c1']);
  });
});

describe('SKW-ROUTE-03: selectMember with family preference', () => {
  const members = [
    { id: 'local-a', card: { family: 'llama' }, cost_tier: 'local' },
    { id: 'local-b', card: { family: 'ornith' }, cost_tier: 'local' },
    { id: 'free-a', card: { family: 'glm' }, cost_tier: 'free-remote' },
    { id: 'paid-a', card: { family: 'claude' }, cost_tier: 'paid-cloud' },
  ];

  test('selectMember applies cost ranking first, then family preference within cheapest tier', () => {
    // Cost ranking puts local first, then free-remote, then paid-cloud
    // Family preference for 'claude' (paid-cloud) should NOT override cost
    const selected = selectMember(members, 0, ['claude']);
    // Still selects from local tier because cost is primary
    assert.equal(selected.cost_tier, 'local');
  });

  test('selectMember with preference for family in cheapest tier', () => {
    const selected = selectMember(members, 0, ['ornith']);
    // Selects ornith from the local (cheapest) tier
    assert.equal(selected.id, 'local-b');
  });

  test('selectMember without preference uses cost ranking only', () => {
    const selected = selectMember(members, 0, null);
    assert.equal(selected.cost_tier, 'local');
  });

  test('selectMember with empty preference uses cost ranking only', () => {
    const selected = selectMember(members, 0, []);
    assert.equal(selected.cost_tier, 'local');
  });

  test('selectMember with preference matching multiple in cheapest tier', () => {
    // Multiple local members, prefer 'llama'
    const selected = selectMember(members, 0, ['llama']);
    assert.equal(selected.id, 'local-a');
    assert.equal(selected.cost_tier, 'local');
  });

  test('selectMember with preference for non-cheapest tier still picks cheapest', () => {
    // Prefer 'claude' (paid-cloud) but local is cheaper
    const selected = selectMember(members, 0, ['claude', 'glm']);
    // Should still pick from local tier
    assert.equal(selected.cost_tier, 'local');
  });
});

describe('SKW-ROUTE-03: AC 5 - BUCKET_RE is unchanged', () => {
  test('BUCKET_RE matches the exact pattern from card 2ba73bf9', () => {
    // The bucket regex should be exactly: /^sk-(s|m|l|xl)-(public|internal|secret)$/i
    // We verify this indirectly through parseBucketId and isBucketId
    assert.ok(parseBucketId('sk-s-public'));
    assert.ok(parseBucketId('sk-m-internal'));
    assert.ok(parseBucketId('sk-xl-secret'));
    assert.ok(parseBucketId('SK-L-PUBLIC')); // case-insensitive

    // Should reject non-bucket patterns
    assert.ok(!parseBucketId('sk-default'));
    assert.ok(!parseBucketId('sk-auto'));
    assert.ok(!parseBucketId('sk-xl-secrets'));
    assert.ok(!parseBucketId('claude-opus'));
  });

  test('parseBucketId uses BUCKET_RE and is unchanged', () => {
    const result = parseBucketId('sk-xl-public');
    assert.deepEqual(result, {
      bucket: 'sk-xl-public',
      model_class: 'XL',
      sensitivity: 'public',
    });
  });

  test('isBucketId uses BUCKET_RE and is unchanged', () => {
    assert.ok(isBucketId('sk-s-public'));
    assert.ok(isBucketId('sk-m-internal'));
    assert.ok(isBucketId('sk-xl-secret'));
    assert.ok(!isBucketId('sk-default'));
    assert.ok(!isBucketId('sk-auto'));
    assert.ok(!isBucketId('sk-xl-secrets'));
  });
});

describe('SKW-ROUTE-03: integration - preference with bucket resolution', () => {
  test('AC 2 negative test: preference cannot reach outside the bucket', () => {
    // Simulate a resolved bucket that only has local models
    const bucketMembers = [
      {
        id: 'local-llama',
        card: { family: 'llama' },
        cost_tier: 'local',
        trust_zone: TRUST_ZONES.SOVEREIGN_LOCAL,
        model_class: 'L',
      },
      {
        id: 'local-ornith',
        card: { family: 'ornith' },
        cost_tier: 'local',
        trust_zone: TRUST_ZONES.SOVEREIGN_LOCAL,
        model_class: 'L',
      },
    ];

    // Try to prefer a family that doesn't exist in this bucket
    const result = applyFamilyPreference(bucketMembers, ['claude', 'codex']);

    // Should only return the original members, no widening
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(m => m.id), ['local-llama', 'local-ornith']);

    // Verify no new members were added
    const originalIds = new Set(bucketMembers.map(m => m.id));
    const resultIds = new Set(result.map(m => m.id));
    assert.deepEqual(resultIds, originalIds);
  });

  test('preference works within a cost-ranked set', () => {
    // Cost-ordered members (local, then free-remote, then paid-cloud)
    const costOrdered = [
      { id: 'local-a', card: { family: 'llama' }, cost_tier: 'local' },
      { id: 'local-b', card: { family: 'ornith' }, cost_tier: 'local' },
      { id: 'free-a', card: { family: 'glm' }, cost_tier: 'free-remote' },
      { id: 'paid-a', card: { family: 'claude' }, cost_tier: 'paid-cloud' },
    ];

    // Apply preference for 'ornith' (in the cheapest tier)
    const result = applyFamilyPreference(costOrdered, ['ornith']);

    // Ornith should be first, then the rest in cost order
    assert.equal(result[0].id, 'local-b');
    assert.equal(result[1].cost_tier, 'local');
    assert.equal(result[2].cost_tier, 'free-remote');
    assert.equal(result[3].cost_tier, 'paid-cloud');
  });
});
