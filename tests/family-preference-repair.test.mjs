/**
 * Family preference repair tests (card 1e26943e)
 *
 * Tests the comma-separated x-sk-prefer contract, validation, and application.
 * Key invariants:
 * - Preference is validated as broad family tokens or sovereign/free, never raw model ids
 * - free is refused outside public sensitivity
 * - Preference applies only within the cheapest already-eligible gateway tier
 * - Uses top-level family field from resolveBucket, not member.card.family
 * - Comma-separated contract (not JSON)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateFamilyPreference,
  applyFamilyPreference,
  selectMember,
  orderMembersByCost,
} from '../src/policy/buckets.mjs';

describe('validateFamilyPreference', () => {
  it('accepts null/undefined/empty as valid with null preference', () => {
    assert.strictEqual(validateFamilyPreference(null).valid, true);
    assert.strictEqual(validateFamilyPreference(null).preference, null);
    assert.strictEqual(validateFamilyPreference(undefined).valid, true);
    assert.strictEqual(validateFamilyPreference('').valid, true);
  });

  it('accepts a single valid family name', () => {
    const result = validateFamilyPreference('claude');
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.preference, ['claude']);
    assert.strictEqual(result.reason, null);
  });

  it('accepts multiple comma-separated family names', () => {
    const result = validateFamilyPreference('claude,codex,sovereign');
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.preference, ['claude', 'codex', 'sovereign']);
    assert.strictEqual(result.reason, null);
  });

  it('normalizes family names to lowercase', () => {
    const result = validateFamilyPreference('Claude,CODEX,Free');
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.preference, ['claude', 'codex', 'free']);
  });

  it('rejects raw model ids with slashes', () => {
    const result = validateFamilyPreference('openai/gpt-4');
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.preference, null);
    assert.ok(result.reason?.includes('must name a family, not a raw model id'));
  });

  it('rejects raw model ids with version patterns', () => {
    assert.strictEqual(validateFamilyPreference('gpt-4.0').valid, false);
    assert.strictEqual(validateFamilyPreference('model-3.5-turbo').valid, false);
    assert.strictEqual(validateFamilyPreference('llama-v1').valid, false);
    assert.strictEqual(validateFamilyPreference('llama-v2').valid, false);
  });

  it('rejects raw model ids with parameter count patterns', () => {
    assert.strictEqual(validateFamilyPreference('llama-128k').valid, false);
    assert.strictEqual(validateFamilyPreference('model-70b').valid, false);
    assert.strictEqual(validateFamilyPreference('model-7b').valid, false);
    assert.strictEqual(validateFamilyPreference('llama-8b').valid, false);
  });

  it('accepts "sovereign" at any sensitivity', () => {
    assert.strictEqual(validateFamilyPreference('sovereign', 'public').valid, true);
    assert.strictEqual(validateFamilyPreference('sovereign', 'internal').valid, true);
    assert.strictEqual(validateFamilyPreference('sovereign', 'secret').valid, true);
  });

  it('accepts "free" at public sensitivity only', () => {
    assert.strictEqual(validateFamilyPreference('free', 'public').valid, true);
    assert.strictEqual(validateFamilyPreference('free', 'internal').valid, false);
    assert.strictEqual(validateFamilyPreference('free', 'secret').valid, false);
  });

  it('rejects "free" at non-public sensitivity with clear reason', () => {
    const result = validateFamilyPreference('free', 'internal');
    assert.strictEqual(result.valid, false);
    assert.ok(result.reason?.includes('not allowed at sensitivity'));
    assert.ok(result.reason?.includes('free remote providers train on submitted content'));
  });

  it('rejects invalid family names', () => {
    assert.strictEqual(validateFamilyPreference('123invalid').valid, false);
    assert.strictEqual(validateFamilyPreference('invalid!name').valid, false);
    assert.strictEqual(validateFamilyPreference('invalid.name').valid, false);
  });

  it('handles whitespace around commas', () => {
    const result = validateFamilyPreference('claude , codex , free');
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.preference, ['claude', 'codex', 'free']);
  });

  it('handles empty entries in comma list', () => {
    const result = validateFamilyPreference('claude,,codex');
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.preference, ['claude', 'codex']);
  });
});

describe('applyFamilyPreference', () => {
  const members = [
    { id: 'model-a', family: 'claude', cost_tier: 'local', trust_zone: 'sovereign' },
    { id: 'model-b', family: 'codex', cost_tier: 'local', trust_zone: 'sovereign' },
    { id: 'model-c', family: 'claude', cost_tier: 'free-remote', trust_zone: 'public' },
    { id: 'model-d', family: 'qwen', cost_tier: 'paid-cloud', trust_zone: 'public' },
  ];

  it('returns original order when no preference', () => {
    const result = applyFamilyPreference(members, null);
    assert.strictEqual(result.length, members.length);
    assert.strictEqual(result[0].id, 'model-a');
  });

  it('returns original order when empty preference', () => {
    const result = applyFamilyPreference(members, []);
    assert.strictEqual(result.length, members.length);
    assert.strictEqual(result[0].id, 'model-a');
  });

  it('moves preferred families to front in preference order', () => {
    const result = applyFamilyPreference(members, ['codex', 'claude']);
    assert.strictEqual(result.length, members.length);
    // codex members first
    assert.strictEqual(result[0].id, 'model-b');
    // then claude members
    assert.strictEqual(result[1].id, 'model-a');
    assert.strictEqual(result[2].id, 'model-c');
    // then others
    assert.strictEqual(result[3].id, 'model-d');
  });

  it('matches "free" to free-remote cost tier', () => {
    const result = applyFamilyPreference(members, ['free']);
    assert.strictEqual(result.length, members.length);
    // free-remote member first
    assert.strictEqual(result[0].id, 'model-c');
    assert.strictEqual(result[0].cost_tier, 'free-remote');
  });

  it('matches "sovereign" to sovereign trust zone', () => {
    const result = applyFamilyPreference(members, ['sovereign']);
    assert.strictEqual(result.length, members.length);
    // sovereign members first
    assert.strictEqual(result[0].id, 'model-a');
    assert.strictEqual(result[0].trust_zone, 'sovereign');
    assert.strictEqual(result[1].id, 'model-b');
    assert.strictEqual(result[1].trust_zone, 'sovereign');
  });

  it('preserves original order within matched families', () => {
    const result = applyFamilyPreference(members, ['claude']);
    assert.strictEqual(result.length, members.length);
    assert.strictEqual(result[0].id, 'model-a');
    assert.strictEqual(result[1].id, 'model-c');
  });

  it('never adds new members (THE INVARIANT)', () => {
    const result = applyFamilyPreference(members, ['nonexistent']);
    assert.strictEqual(result.length, members.length);
    const originalIds = new Set(members.map(m => m.id));
    const resultIds = new Set(result.map(m => m.id));
    assert.deepStrictEqual(originalIds, resultIds);
  });

  it('handles members with null family', () => {
    const membersWithNull = [
      { id: 'model-a', family: 'claude', cost_tier: 'local', trust_zone: 'sovereign' },
      { id: 'model-b', family: null, cost_tier: 'local', trust_zone: 'sovereign' },
      { id: 'model-c', family: 'codex', cost_tier: 'local', trust_zone: 'sovereign' },
    ];
    const result = applyFamilyPreference(membersWithNull, ['claude', 'codex']);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].id, 'model-a'); // claude
    assert.strictEqual(result[1].id, 'model-c'); // codex
    assert.strictEqual(result[2].id, 'model-b'); // null family, unmatched
  });

  it('uses top-level family field, not card.family', () => {
    const membersWithCard = [
      {
        id: 'model-a',
        family: 'claude', // top-level field
        card: { family: 'different' }, // nested field (should be ignored)
        cost_tier: 'local',
        trust_zone: 'sovereign',
      },
      {
        id: 'model-b',
        family: 'codex',
        cost_tier: 'local',
        trust_zone: 'sovereign',
      },
    ];
    const result = applyFamilyPreference(membersWithCard, ['claude']);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0].id, 'model-a'); // matches top-level family
  });
});

describe('selectMember with family preference', () => {
  const members = [
    { id: 'local-codex-1', family: 'codex', cost_tier: 'local', trust_zone: 'sovereign' },
    { id: 'local-claude-1', family: 'claude', cost_tier: 'local', trust_zone: 'sovereign' },
    { id: 'free-codex-1', family: 'codex', cost_tier: 'free-remote', trust_zone: 'public' },
    { id: 'paid-claude-1', family: 'claude', cost_tier: 'paid-cloud', trust_zone: 'public' },
  ];

  it('selects from cheapest tier when no preference', () => {
    const selected = selectMember(members, 0, null);
    assert.ok(selected);
    assert.strictEqual(selected.cost_tier, 'local');
  });

  it('applies preference only within cheapest tier', () => {
    const selected = selectMember(members, 0, ['claude']);
    assert.ok(selected);
    assert.strictEqual(selected.cost_tier, 'local'); // still cheapest
    assert.strictEqual(selected.family, 'claude'); // preference applied within tier
  });

  it('falls back to normal rotation when preference has no match in cheapest tier', () => {
    const selected = selectMember(members, 0, ['qwen']); // no qwen in cheapest tier
    assert.ok(selected);
    assert.strictEqual(selected.cost_tier, 'local');
    // Should be one of the local models (normal rotation)
    assert.ok(['local-codex-1', 'local-claude-1'].includes(selected.id));
  });

  it('never selects from costlier tier when cheaper tier exists', () => {
    const selected = selectMember(members, 0, ['claude']);
    assert.ok(selected);
    assert.strictEqual(selected.cost_tier, 'local');
    assert.notStrictEqual(selected.cost_tier, 'paid-cloud');
  });

  it('rotates within cheapest tier when multiple matches', () => {
    const selected1 = selectMember(members, 0, ['claude', 'codex']);
    const selected2 = selectMember(members, 1, ['claude', 'codex']);
    assert.ok(selected1);
    assert.ok(selected2);
    assert.strictEqual(selected1.cost_tier, 'local');
    assert.strictEqual(selected2.cost_tier, 'local');
    // Counter should affect rotation
  });

  it('handles "free" preference correctly', () => {
    const freeMembers = [
      { id: 'free-1', family: 'codex', cost_tier: 'free-remote', trust_zone: 'public' },
      { id: 'free-2', family: 'claude', cost_tier: 'free-remote', trust_zone: 'public' },
      { id: 'paid-1', family: 'codex', cost_tier: 'paid-cloud', trust_zone: 'public' },
    ];
    const selected = selectMember(freeMembers, 0, ['free']);
    assert.ok(selected);
    assert.strictEqual(selected.cost_tier, 'free-remote');
  });

  it('handles "sovereign" preference correctly', () => {
    const sovereignMembers = [
      { id: 'sov-1', family: 'codex', cost_tier: 'local', trust_zone: 'sovereign' },
      { id: 'sov-2', family: 'claude', cost_tier: 'local', trust_zone: 'sovereign' },
      { id: 'public-1', family: 'codex', cost_tier: 'local', trust_zone: 'public' },
    ];
    const selected = selectMember(sovereignMembers, 0, ['sovereign']);
    assert.ok(selected);
    assert.strictEqual(selected.trust_zone, 'sovereign');
  });

  it('returns null when no members', () => {
    const selected = selectMember([], 0, ['claude']);
    assert.strictEqual(selected, null);
  });
});

describe('preference does not widen the resolved set', () => {
  it('AC 2 negative test: preference cannot reach outside the bucket', () => {
    // Simulate a bucket with only local codex models
    const localOnly = [
      { id: 'local-codex-1', family: 'codex', cost_tier: 'local', trust_zone: 'sovereign' },
      { id: 'local-codex-2', family: 'codex', cost_tier: 'local', trust_zone: 'sovereign' },
    ];

    // Preference for claude (not in bucket) should fall back to cost-ranked
    const selected = selectMember(localOnly, 0, ['claude']);
    assert.ok(selected);
    assert.strictEqual(selected.id, 'local-codex-1'); // falls back to original
    assert.strictEqual(selected.family, 'codex'); // no widening to claude
  });

  it('member set is never widened', () => {
    const originalMembers = [
      { id: 'model-1', family: 'codex', cost_tier: 'local', trust_zone: 'sovereign' },
      { id: 'model-2', family: 'claude', cost_tier: 'local', trust_zone: 'sovereign' },
    ];

    const originalIds = new Set(originalMembers.map(m => m.id));

    // Apply various preferences
    for (const pref of [['claude'], ['codex'], ['qwen'], ['sovereign'], ['free']]) {
      const selected = selectMember(originalMembers, 0, pref);
      if (selected) {
        assert.ok(originalIds.has(selected.id), `Member ${selected.id} not in original set for preference ${pref}`);
      }
    }
  });
});

describe('comma-separated contract', () => {
  it('validates comma-separated string (not JSON array)', () => {
    // The new contract uses comma-separated strings, not JSON
    const result = validateFamilyPreference('claude,codex,free');
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.preference, ['claude', 'codex', 'free']);
  });

  it('handles single entry without comma', () => {
    const result = validateFamilyPreference('claude');
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.preference, ['claude']);
  });

  it('rejects JSON array format', () => {
    // The old card 93220ffc used JSON arrays, which should fail now
    const result = validateFamilyPreference('["claude","codex"]');
    assert.strictEqual(result.valid, false);
    // JSON array format is invalid - should use comma-separated instead
    assert.ok(result.reason);
  });
});
