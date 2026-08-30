/**
 * Hermetic guard for the chiap08 Qwen3.8 source-of-truth declaration.
 *
 * The live server reports the Huihui Q4_K_M id. The other three ids are
 * request aliases owned by the same local backend, not evidence that different
 * weights are loaded. Keep the checked-in fallback config, sanitizer limits,
 * and model-card catalog aligned with that measured fact.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVED_ID = 'qwen3.8-27b-huihui-abliterated-q4_k_m';
const MODEL_IDS = [
  SERVED_ID,
  'qwen3.8-27b-ud-q5_k_xl',
  'qwen3.8-27b',
  'qwen38-abliterated',
];

const config = loadYaml(readFileSync(join(ROOT, 'config/skgateway.yaml'), 'utf8'));
const cards = loadYaml(
  readFileSync(join(ROOT, 'config/model-cards.overrides.yaml'), 'utf8'),
).overrides;

test('both Qwen3.8 replicas claim the same canonical id and compatibility aliases', () => {
  const chiap01 = config.backends['chiap01-qwen38'];
  const chiap08 = config.backends['chiap08-qwen38'];

  assert.equal(chiap01.url, 'http://chiap01:18810/v1');
  assert.equal(chiap08.url, 'http://TAILNET_HOST:11439/v1');
  for (const backend of [chiap01, chiap08]) {
    assert.equal(backend.auth_type, 'none');
    assert.equal(backend.priority, 3);
    assert.deepEqual(backend.models, MODEL_IDS);
  }
  assert.equal(
    new Set([...chiap01.models, ...chiap08.models]).size,
    MODEL_IDS.length,
    'a replica must not create a fifth request alias',
  );
});

test('the replicas retain separate bounded capacity domains', () => {
  assert.deepEqual(config.pooling.capacity_domains['chiap08-qwen38'], {
    members: ['chiap08-qwen38', 'reg:qwen38'],
    max: 3,
    maxQueue: 8,
    queueTimeoutMs: 30_000,
  });
  assert.deepEqual(config.pooling.capacity_domains['chiap01-qwen38'], {
    members: ['chiap01-qwen38'],
    max: 2,
    maxQueue: 4,
    queueTimeoutMs: 30_000,
  });
});

test('either physical replica can route the canonical logical model', async () => {
  const { createRouter } = await import('../src/proxy/router.mjs');
  const router = createRouter({
    backends: {
      'chiap01-qwen38': config.backends['chiap01-qwen38'],
      'chiap08-qwen38': config.backends['chiap08-qwen38'],
    },
  });
  const candidates = await router.route({ model: SERVED_ID, agentId: 'replica-fold-test' });
  assert.deepEqual(candidates.map((candidate) => candidate.backendId), [
    'chiap01-qwen38',
    'chiap08-qwen38',
  ]);
});

test('every qwen38 id has the same bounded context and truthful served-model card', () => {
  for (const id of MODEL_IDS) {
    assert.deepEqual(
      config.model_limits[id],
      { max_body_bytes: 800000, max_system_bytes: 320000 },
      `${id} must retain the qualified 256K sanitizer limit`,
    );
    assert.ok(cards[id], `${id} must have a committed model card`);
    assert.equal(cards[id].context_length, 262144);
    assert.equal(cards[id].quant, 'Q4_K_M');
    assert.equal(cards[id].size_class, 'L');
    assert.equal(cards[id].vision, true);
    assert.equal(cards[id].reasoning, true);
  }
  assert.match(cards[SERVED_ID].display_name, /Huihui/);
  assert.match(cards['qwen3.8-27b-ud-q5_k_xl'].notes, new RegExp(SERVED_ID));
  assert.match(cards['qwen38-abliterated'].notes, /locally claimed/);
});
