import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { orderMembersByGenericWeight } from '../src/policy/buckets.mjs';
import {
  genericPolicyRevision,
  normalizeGenericParticipation,
} from '../src/policy/generic-participation.mjs';

const policy = normalizeGenericParticipation({
  providers: {
    deepseek: { enabled: true, weight: 45 },
    zai: { enabled: true, weight: 35 },
    kimi: { enabled: true, weight: 10 },
    codex: { enabled: false, weight: 10 },
  },
});

const members = [
  { id: 'zai-b', provider: 'zai' },
  { id: 'deepseek-a', provider: 'deepseek' },
  { id: 'kimi-a', provider: 'kimi' },
  { id: 'codex-a', provider: 'codex' },
  { id: 'zai-a', provider: 'glm' },
  { id: 'deepseek-b', provider: 'deepseek' },
];

describe('G4 generic weighted provider rotation', () => {
  test('the default 900 request schedule is exactly 450/350/100/0', () => {
    const counts = { deepseek: 0, zai: 0, kimi: 0, codex: 0 };
    for (let counter = 0; counter < 900; counter++) {
      const picked = orderMembersByGenericWeight(members, counter, 'sk-l', policy)[0];
      counts[picked.provider === 'glm' ? 'zai' : picked.provider]++;
    }
    assert.deepEqual(counts, { deepseek: 450, zai: 350, kimi: 100, codex: 0 });
  });

  test('aliases and multiple models do not inflate provider tickets', () => {
    const counts = { deepseek: 0, zai: 0, kimi: 0 };
    for (let counter = 0; counter < 90; counter++) {
      const picked = orderMembersByGenericWeight(members, counter, 'sk-l', policy)[0];
      const provider = picked.provider === 'glm' ? 'zai' : picked.provider;
      counts[provider]++;
    }
    assert.deepEqual(counts, { deepseek: 45, zai: 35, kimi: 10 });
  });

  test('an absent provider has no tickets and remaining weight redistributes', () => {
    const withoutDeepSeek = members.filter((member) => member.provider !== 'deepseek');
    const counts = { zai: 0, kimi: 0 };
    for (let counter = 0; counter < 45; counter++) {
      const picked = orderMembersByGenericWeight(withoutDeepSeek, counter, 'sk-l', policy)[0];
      counts[picked.provider === 'glm' ? 'zai' : picked.provider]++;
    }
    assert.deepEqual(counts, { zai: 35, kimi: 10 });
  });

  test('disabled and zero-weight pools fail closed', () => {
    assert.deepEqual(
      orderMembersByGenericWeight([{ id: 'codex-a', provider: 'codex' }], 0, 'sk-l', policy),
      [],
    );
  });

  test('invalid counters and ambiguous model families fail closed', () => {
    for (const counter of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.deepEqual(orderMembersByGenericWeight(members, counter, 'sk-l', policy), []);
    }
    assert.deepEqual(orderMembersByGenericWeight([
      { id: 'same', provider: 'zai' },
      { id: 'same', provider: 'deepseek' },
    ], 0, 'sk-l', policy), []);
  });

  test('selection carries only sanitized effective attribution', () => {
    const [picked] = orderMembersByGenericWeight(members, 0, 'sk-l', policy);
    assert.equal(picked.generic_policy_revision, genericPolicyRevision(policy));
    assert.equal(picked.generic_rotation_counter, 0);
    assert.equal(picked.generic_provider_weight, 45);
    assert.equal(picked.generic_participation_reason, 'enabled');
    assert.equal('credentials' in picked, false);
    assert.equal('prompt' in picked, false);
  });

  test('focused routes bypass generic disabling and preserve cost ordering', () => {
    const focused = orderMembersByGenericWeight(
      [{ id: 'codex-a', provider: 'codex', cost_tier: 'paid-cloud' }],
      0,
      'sk-codex-l',
      policy,
    );
    assert.equal(focused[0].id, 'codex-a');
    assert.equal(focused[0].generic_participation_reason, 'focused-route');
  });
});
