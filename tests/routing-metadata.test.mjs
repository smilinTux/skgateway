import { test } from 'node:test';
import assert from 'node:assert/strict';

import { declareRoutingMetadata, familyMetadataForId } from '../src/discovery/routing-metadata.mjs';
import { buildCapabilityCatalog } from '../src/ranking/catalog.mjs';

const providers = {
  local: { data_retention: 'local-only', cost_tier: 'local' },
  anthropic: { data_retention: 'contractual-zero', cost_tier: 'paid-cloud' },
  codex: { data_retention: 'trains', cost_tier: 'paid-cloud' },
  nvidia: { data_retention: 'trains', cost_tier: 'free-remote' },
  zai: { data_retention: 'unknown', cost_tier: 'paid-cloud' },
};

test('reviewed family map covers the named routing families and catalog peers', () => {
  const cases = {
    'gpt-5.6-sol': 'codex',
    'claude-opus-5': 'claude',
    'moonshotai/kimi-k2.6': 'kimi',
    'glm-5': 'glm',
    'ornith-1.5-9b': 'ornith',
    'qwen/qwen3.5-397b-a17b': 'qwen',
    'deepseek-ai/deepseek-v4-pro': 'deepseek',
    'mistralai/mistral-medium-3.5-128b': 'mistral',
    'meta/llama-3.3-70b-instruct': 'llama',
    'minimaxai/minimax-m2.7': 'minimax',
  };
  for (const [id, family] of Object.entries(cases)) {
    assert.deepEqual(familyMetadataForId(id), { family }, id);
  }
});

test('unknown live ids are explicitly unfamilied with a reason', () => {
  const result = declareRoutingMetadata({ id: 'newvendor/novel-model', provider: 'nvidia', card: {} }, providers);
  assert.equal(result.card.family, null);
  assert.match(result.card.unfamilied_reason, /No reviewed broad-family mapping/);
  assert.equal(result.card.cost_tier, 'free-remote');
});

test('catalog mapping declares family and cost for every live row', () => {
  const entries = [
    { id: 'claude-opus-5', provider: 'anthropic', free: false, card: { tier: 'paid-cloud' } },
    { id: 'gpt-5.6-sol', provider: 'codex', free: false, card: { tier: 'paid-cloud' } },
    { id: 'glm-5', provider: 'zai', free: false, card: { tier: 'paid-cloud' } },
    { id: 'ornith-1.5-9b', provider: 'local', free: true, card: { tier: 'local' } },
    { id: 'qwen/qwen3.5-397b-a17b', provider: 'nvidia', free: true, card: { family: 'qwen3.5' } },
  ];
  const catalog = buildCapabilityCatalog(entries, {
    providers,
    getLifecycleFn: () => ({ state: 'active' }),
  });
  assert.deepEqual(catalog.map((entry) => [entry.card.family, entry.card.cost_tier]), [
    ['claude', 'paid-cloud'],
    ['codex', 'paid-cloud'],
    ['glm', 'paid-cloud'],
    ['ornith', 'local'],
    ['qwen', 'free-remote'],
  ]);
});

test('free is recorded with provider training posture, not presented as merely cheap', () => {
  assert.equal(providers.nvidia.cost_tier, 'free-remote');
  assert.equal(providers.nvidia.data_retention, 'trains');
});
