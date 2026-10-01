/**
 * card-overrides.test.mjs (card P2.2): the manual card overlay.
 *
 * Preserves Chef's validated per-model knowledge (context windows,
 * known-slow flags) that used to live only as skgateway.yaml comments, as
 * committed data in config/model-cards.overrides.yaml (design doc 5.1 item 2
 * / section 2.6). Precedence: fresh provider card > manual overlay >
 * heuristic (source tags reflect the winner).
 *
 * Run with: node --test tests/card-overrides.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadCardOverrides,
  applyCardOverlay,
  applyCardOverlays,
  discoverCatalog,
  CARD_OVERRIDES_PATH,
} from '../src/discovery.mjs';
import {
  QUALIFICATION_RESPONSE_SCHEMA_HASH,
  qualificationCaseSetHash,
} from '../qualification/deepseek/evaluate.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'skgw-card-overrides-'));
let _seq = 0;
function freshPath() {
  return join(DIR, `overrides-${_seq++}.yaml`);
}

test('loadCardOverrides reads the real committed overlay file', () => {
  const overrides = loadCardOverrides(CARD_OVERRIDES_PATH);
  assert.ok(overrides['deepseek-ai/deepseek-v4-pro'], 'deepseek-v4-pro should have an overlay entry');
  assert.equal(overrides['deepseek-ai/deepseek-v4-pro'].context_length, 1048576);
  assert.match(overrides['deepseek-ai/deepseek-v4-pro'].notes, /slow/);
});

test('qualified worker IDs have explicit generation policy distinct from model limits', () => {
  const overrides = loadCardOverrides(CARD_OVERRIDES_PATH);
  for (const id of ['deepseek-flash', 'sk-zai-m', 'gpt-5.6-sol',
    'qwen3.8-27b-huihui-abliterated-q4_k_m']) {
    assert.equal(overrides[id]?.generation_default_tokens, 8192, id);
  }
  const qwen = overrides['qwen3.8-27b-huihui-abliterated-q4_k_m'];
  assert.equal(qwen.context_length, 131072);
  assert.equal(qwen.max_output_tokens, 16384);
  assert.equal(qwen.min_output_tokens, 8192);
  assert.equal(overrides['gpt-5.6-sol'].max_output_tokens, null);
});

test('DeepSeek Flash and Pro carry bounded reviewed qualification evidence', () => {
  const overrides = loadCardOverrides(CARD_OVERRIDES_PATH);
  for (const id of ['deepseek-ai/deepseek-v4-flash', 'deepseek-ai/deepseek-v4-pro']) {
    const card = overrides[id];
    assert.equal(card.size_class, 'L');
    assert.equal(card.qualification.reviewed, true);
    assert.equal(card.qualification.status, 'pass');
    assert.equal(card.qualification.qualified_class, 'L');
    for (const key of ['case_set_hash', 'response_schema_hash', 'result_hash']) {
      assert.match(card.qualification[key], /^[a-f0-9]{64}$/);
    }
    assert.equal(card.qualification.case_set_hash, qualificationCaseSetHash());
    assert.equal(card.qualification.response_schema_hash, QUALIFICATION_RESPONSE_SCHEMA_HASH);
  }
});

test('DeepSeek reviewed evidence survives card overlay enrichment', () => {
  const overrides = loadCardOverrides(CARD_OVERRIDES_PATH);
  const model = {
    id: 'deepseek-ai/deepseek-v4-flash',
    provider: 'deepseek',
    card: { source: 'deepseek', size_class: null },
  };
  const out = applyCardOverlay(model, overrides);
  assert.equal(out.card.size_class, 'L');
  assert.equal(out.card.qualification.reviewed, true);
  assert.equal(out.card.source, 'manual');
});

test('loadCardOverrides is fail-soft on a missing file', () => {
  assert.deepEqual(loadCardOverrides(join(DIR, 'does-not-exist.yaml')), {});
});

test('loadCardOverrides is fail-soft on a malformed file', () => {
  const path = freshPath();
  writeFileSync(path, '::: not: yaml: at: all:::');
  assert.deepEqual(loadCardOverrides(path), {});
});

test('loadCardOverrides is fail-soft when the file has no overrides: key', () => {
  const path = freshPath();
  writeFileSync(path, 'unrelated: true\n');
  assert.deepEqual(loadCardOverrides(path), {});
});

test('applyCardOverlay: overlay wins over a heuristic card, source becomes manual', () => {
  const model = {
    id: 'qwen/qwen3.5-122b-a10b',
    provider: 'nvidia',
    free: true,
    card: { context_length: null, max_output_tokens: null, source: 'heuristic', fetched_at: 1000 },
  };
  const overrides = { 'qwen/qwen3.5-122b-a10b': { context_length: 262144 } };
  const out = applyCardOverlay(model, overrides);
  assert.equal(out.card.context_length, 262144);
  assert.equal(out.card.source, 'manual');
  // fetched_at and other existing fields are preserved, not clobbered.
  assert.equal(out.card.fetched_at, 1000);
});

test('applyCardOverlay: a fresh provider card wins over the overlay (untouched)', () => {
  const model = {
    id: 'some/openrouter-model:free',
    provider: 'openrouter',
    free: true,
    card: { context_length: 32768, source: 'openrouter', fetched_at: 1000 },
  };
  const overrides = { 'some/openrouter-model:free': { context_length: 999999 } };
  const out = applyCardOverlay(model, overrides);
  assert.equal(out.card.context_length, 32768);
  assert.equal(out.card.source, 'openrouter');
});

test('applyCardOverlay: no matching override entry leaves a heuristic card untouched', () => {
  const model = {
    id: 'some/unlisted-model',
    provider: 'nvidia',
    free: true,
    card: { context_length: null, source: 'heuristic', fetched_at: 1000 },
  };
  const out = applyCardOverlay(model, { 'other/model': { context_length: 1 } });
  assert.equal(out.card.context_length, null);
  assert.equal(out.card.source, 'heuristic');
});

test('applyCardOverlay: a card-LESS static model gets a card CREATED from the overlay', () => {
  // claude/ornith are static config models discovery never gives a card, so the
  // curated overlay is their only card. A matching override CREATES one (source
  // 'manual') so they become rankable + show in the model dex.
  const model = { id: 'local-model', provider: 'local', free: true };
  const out = applyCardOverlay(model, {
    'local-model': { context_length: 262144, supported_parameters: ['tools'] },
  });
  assert.equal(out.card.context_length, 262144);
  assert.deepEqual(out.card.supported_parameters, ['tools']);
  assert.equal(out.card.source, 'manual');
});

test('applyCardOverlay: a card-less model with NO matching override stays card-less', () => {
  const model = { id: 'unlisted-local', provider: 'local', free: true };
  const out = applyCardOverlay(model, { 'other-model': { context_length: 1 } });
  assert.equal(out.card, undefined);
});

test('applyCardOverlays maps across a catalog array', () => {
  const models = [
    { id: 'a', provider: 'nvidia', free: true, card: { context_length: null, source: 'heuristic' } },
    { id: 'b', provider: 'openrouter', free: true, card: { context_length: 8192, source: 'openrouter' } },
  ];
  const overrides = { a: { context_length: 111 }, b: { context_length: 999 } };
  const out = applyCardOverlays(models, overrides);
  assert.equal(out.find((m) => m.id === 'a').card.context_length, 111);
  assert.equal(out.find((m) => m.id === 'a').card.source, 'manual');
  assert.equal(out.find((m) => m.id === 'b').card.context_length, 8192);
  assert.equal(out.find((m) => m.id === 'b').card.source, 'openrouter');
});

test('discoverCatalog() applies the overlay to heuristic NVIDIA cards end-to-end', async () => {
  const cache = {};
  const res = await discoverCatalog({
    localModels: [],
    nvidiaFetch: async () => ({ data: [{ id: 'qwen/qwen3.5-122b-a10b', object: 'model' }] }),
    openrouterFetch: async () => ({ data: [] }),
    cache,
    lifecycleStorePath: null,
    cardOverrides: { 'qwen/qwen3.5-122b-a10b': { context_length: 262144 } },
  });
  const model = res.models.find((m) => m.id === 'qwen/qwen3.5-122b-a10b');
  assert.equal(model.card.context_length, 262144);
  assert.equal(model.card.source, 'manual');
});

test('discoverCatalog() leaves a fresh OpenRouter card untouched even with a matching override', async () => {
  const cache = {};
  const res = await discoverCatalog({
    localModels: [],
    nvidiaFetch: async () => ({ data: [] }),
    openrouterFetch: async () => ({
      data: [{ id: 'x/y:free', context_length: 8192, pricing: { prompt: '0', completion: '0' } }],
    }),
    cache,
    lifecycleStorePath: null,
    cardOverrides: { 'x/y:free': { context_length: 999999 } },
  });
  const model = res.models.find((m) => m.id === 'x/y:free');
  assert.equal(model.card.context_length, 8192);
  assert.equal(model.card.source, 'openrouter');
});
