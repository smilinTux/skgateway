import { test } from 'node:test';
import assert from 'node:assert/strict';

import { attachFamilyAndCost, COST_TIERS } from '../src/discovery/model-metadata.mjs';
import { applyCardOverlays } from '../src/discovery.mjs';
import { deriveCapabilities } from '../src/ranking/capabilities.mjs';
import { resolveBucket } from '../src/policy/buckets.mjs';

const providers = {
  local: { data_retention: 'local-only' },
  anthropic: { data_retention: 'contractual-zero' },
  opencode: { data_retention: 'trains' },
};

const ratings = { path: '/nonexistent/model-family-cost-ratings.jsonl' };

test('canonical families group the named fleet sets', () => {
  const cases = {
    'gpt-5.6-sol': 'codex',
    'claude-opus-5': 'claude',
    'kimi-k2.5': 'kimi',
    'glm-5': 'glm',
    'ornith-1.5-9b': 'ornith',
    'qwen/qwen3.5-397b-a17b': 'qwen',
  };
  for (const [id, family] of Object.entries(cases)) {
    assert.equal(attachFamilyAndCost({ id }).card.family, family);
  }
});

test('every catalog model is familied or carries an explicit reason', () => {
  const entries = applyCardOverlays([
    { id: 'claude-opus-5', provider: 'anthropic', free: false },
    { id: 'qwen/qwen3.5-397b-a17b', provider: 'nvidia', free: true, card: { family: 'qwen3.5', source: 'heuristic' } },
    { id: 'big-pickle', provider: 'opencode', free: true, card: { source: 'models.dev' } },
    { id: '', provider: 'unknown', free: null },
  ], {});
  for (const entry of entries) {
    assert.ok(entry.card.family || entry.card.unfamilied_reason, JSON.stringify(entry));
  }
  assert.equal(entries[2].card.family, 'big-pickle');
  assert.match(entries[3].card.unfamilied_reason, /id is absent/);
});

test('FREE is an economic declaration and remote FREE retains trains-on-content zone 2', () => {
  const entry = attachFamilyAndCost({ id: 'big-pickle', provider: 'opencode', free: true });
  assert.equal(entry.card.cost_tier, COST_TIERS.FREE);
  const caps = deriveCapabilities(entry, { providers, ratings });
  assert.equal(caps.cost_tier, COST_TIERS.FREE);
  assert.equal(caps.trust_zone, 2);
});

test('changing only cost tier cannot change trust zone or bucket admission', () => {
  const base = attachFamilyAndCost({
    id: 'claude-opus-5', provider: 'anthropic', free: false,
    card: { tier: 'paid-cloud', size_class: 'XL', cost_tier: COST_TIERS.SUBSCRIPTION },
  });
  const changed = { ...base, card: { ...base.card, cost_tier: COST_TIERS.FREE } };
  const beforeCaps = deriveCapabilities(base, { providers, ratings });
  const afterCaps = deriveCapabilities(changed, { providers, ratings });
  assert.equal(beforeCaps.trust_zone, 1);
  assert.equal(afterCaps.trust_zone, beforeCaps.trust_zone);

  const bucket = { model_class: 'XL', sensitivity: 'internal' };
  const before = resolveBucket({ bucket, catalog: [{ ...base, capabilities: beforeCaps }] });
  const after = resolveBucket({ bucket, catalog: [{ ...changed, capabilities: afterCaps }] });
  assert.deepEqual(after.members.map((m) => m.id), before.members.map((m) => m.id));
});

test('/admin/buckets member shape includes family and declared cost tier', () => {
  const entry = attachFamilyAndCost({
    id: 'ornith-1.5-9b', provider: 'local', free: true,
    card: { tier: 'local', size_class: 'M' },
  });
  const capabilities = deriveCapabilities(entry, { providers, ratings });
  const { members } = resolveBucket({
    bucket: { model_class: 'M', sensitivity: 'secret' },
    catalog: [{ ...entry, capabilities }],
  });
  assert.equal(members[0].family, 'ornith');
  assert.equal(members[0].cost_tier, COST_TIERS.LOCAL);
});
