/**
 * providers-openrouter.test.mjs (card P2.1): the OpenRouter adapter keeps the
 * full ModelCard (design doc 4.1/5.1) instead of discarding everything but
 * the id. `normalize()` is pure (a captured `/models` JSON fixture in, a
 * ModelCard[] out); `fetch()` is the network call, exercised here with a
 * stubbed `globalThis.fetch` so the test stays hermetic (no network).
 *
 * Run with: node --test tests/providers-openrouter.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetch as fetchOpenRouter, normalize } from '../src/discovery/providers/openrouter.mjs';

// Captured shape of https://openrouter.ai/api/v1/models (trimmed to the
// fields the design doc calls out: context_length, supported_parameters,
// architecture.modality, pricing, top_provider.max_completion_tokens,
// description, created). Mixes a free chat model, a paid chat model (must be
// dropped by the free filter), and a free non-chat model (must be dropped by
// the existing isChatModel filter) so both filters are exercised.
const OPENROUTER_FIXTURE = {
  data: [
    {
      id: 'google/gemma-4-31b-it:free',
      name: 'Google: Gemma 4 31B Instruct (free)',
      created: 1786000000,
      description: 'A fast, capable instruction-tuned model.',
      context_length: 131072,
      architecture: { modality: 'text->text', input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0', completion: '0', request: '0', image: '0' },
      top_provider: { context_length: 131072, max_completion_tokens: 8192, is_moderated: false },
      supported_parameters: ['tools', 'tool_choice', 'reasoning', 'structured_outputs', 'temperature'],
    },
    {
      id: 'qwen/qwen3.5-vl-72b:free',
      name: 'Qwen: Qwen3.5 VL 72B (free)',
      created: 1786100000,
      description: 'Vision-language model.',
      context_length: 262144,
      architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: { prompt: '0', completion: '0' },
      top_provider: { context_length: 262144, max_completion_tokens: 32768 },
      supported_parameters: ['tools', 'structured_outputs'],
    },
    {
      id: 'anthropic/claude-x',
      name: 'Anthropic: Claude X (paid)',
      created: 1786200000,
      description: 'Paid frontier model.',
      context_length: 200000,
      architecture: { modality: 'text->text' },
      pricing: { prompt: '0.003', completion: '0.015' },
      top_provider: { context_length: 200000, max_completion_tokens: 8192 },
      supported_parameters: ['tools', 'reasoning'],
    },
    {
      id: 'nvidia/nemotron-3.5-content-safety:free',
      name: 'Content safety classifier (free)',
      created: 1786300000,
      description: 'Not a chat model.',
      context_length: 4096,
      architecture: { modality: 'text->text' },
      pricing: { prompt: '0', completion: '0' },
      top_provider: { context_length: 4096, max_completion_tokens: 4 },
      supported_parameters: [],
    },
  ],
};

test('normalize() keeps only free chat models (free filter + isChatModel filter preserved)', () => {
  const cards = normalize(OPENROUTER_FIXTURE, { now: () => 5000 });
  const ids = cards.map((c) => c.id);
  assert.deepEqual(ids, ['google/gemma-4-31b-it:free', 'qwen/qwen3.5-vl-72b:free']);
});

test('normalize() retains the full card instead of discarding fields', () => {
  const [gemma] = normalize(OPENROUTER_FIXTURE, { now: () => 5000 });
  assert.equal(gemma.id, 'google/gemma-4-31b-it:free');
  assert.equal(gemma.provider, 'openrouter');
  assert.equal(gemma.free, true);
  assert.ok(gemma.card, 'card block present');
  assert.equal(gemma.card.context_length, 131072);
  assert.equal(gemma.card.max_output_tokens, 8192);
  assert.equal(gemma.card.modality, 'text->text');
  assert.deepEqual(gemma.card.supported_parameters, [
    'tools', 'tool_choice', 'reasoning', 'structured_outputs', 'temperature',
  ]);
  assert.equal(gemma.card.description, 'A fast, capable instruction-tuned model.');
  assert.deepEqual(gemma.card.pricing, { prompt: '0', completion: '0', request: '0', image: '0' });
  assert.equal(gemma.card.source, 'openrouter');
  assert.equal(gemma.card.fetched_at, 5000);
});

test('normalize() surfaces reasoning/structured_outputs booleans from supported_parameters (card N2)', () => {
  const cards = normalize(OPENROUTER_FIXTURE, { now: () => 5000 });
  const gemma = cards.find((c) => c.id === 'google/gemma-4-31b-it:free');
  const vl = cards.find((c) => c.id === 'qwen/qwen3.5-vl-72b:free');
  assert.equal(gemma.card.reasoning, true);
  assert.equal(gemma.card.structured_outputs, true);
  assert.equal(vl.card.reasoning, false);
  assert.equal(vl.card.structured_outputs, true);
});

test('normalize() distinguishes an XL free MoE model (550B total) from a small free model (9B), the concrete fleet test', () => {
  const fixture = {
    data: [
      {
        id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        context_length: 1000000,
        architecture: { modality: 'text->text' },
        pricing: { prompt: '0', completion: '0' },
        top_provider: { max_completion_tokens: 65536 },
        supported_parameters: ['tools', 'reasoning'],
      },
      {
        id: 'nvidia/nemotron-nano-9b-v2:free',
        context_length: 128000,
        architecture: { modality: 'text->text' },
        pricing: { prompt: '0', completion: '0' },
        top_provider: { max_completion_tokens: null },
        supported_parameters: ['tools', 'reasoning', 'structured_outputs'],
      },
    ],
  };
  const cards = normalize(fixture, { now: () => 5000 });
  const ultra = cards.find((c) => c.id === 'nvidia/nemotron-3-ultra-550b-a55b:free');
  const nano = cards.find((c) => c.id === 'nvidia/nemotron-nano-9b-v2:free');
  assert.equal(ultra.card.params_b, 550);
  assert.equal(ultra.card.active_params_b, 55);
  assert.equal(ultra.card.size_class, 'XL');
  assert.equal(ultra.card.params_basis, 'id-pattern');
  assert.equal(nano.card.params_b, 9);
  assert.equal(nano.card.active_params_b, null);
  assert.equal(nano.card.size_class, 'M');
  assert.notEqual(ultra.card.size_class, nano.card.size_class);
});

test('normalize() falls back to description prose for params when the id carries no size token (real live case)', () => {
  // Measured 2026-08-15: the live OpenRouter id is
  // "nvidia/nemotron-3.5-lightning:free" (no size token at all), unlike the
  // sibling NVIDIA raw catalog id "nemotron-3.5-lightning-30b-a3b". Its own
  // description states the split in prose.
  const fixture = {
    data: [{
      id: 'nvidia/nemotron-3.5-lightning:free',
      description: 'NVIDIA Nemotron 3.5 Lightning is an open mixture-of-experts model from NVIDIA, with 3B active parameters out of 30B total. It is suited for high-throughput agentic workloads.',
      context_length: 1000000,
      architecture: { modality: 'text->text' },
      pricing: { prompt: '0', completion: '0' },
      top_provider: { max_completion_tokens: 65536 },
      supported_parameters: ['tools', 'reasoning'],
    }],
  };
  const [card] = normalize(fixture, { now: () => 5000 });
  assert.equal(card.card.params_b, 30);
  assert.equal(card.card.active_params_b, 3);
  assert.equal(card.card.size_class, 'L');
  assert.equal(card.card.params_basis, 'description');
});

test('normalize() surfaces vision modality for a multimodal card', () => {
  const cards = normalize(OPENROUTER_FIXTURE, { now: () => 5000 });
  const vl = cards.find((c) => c.id === 'qwen/qwen3.5-vl-72b:free');
  assert.equal(vl.card.modality, 'text+image->text');
});

test('normalize() defaults fetched_at to Date.now() when no clock is injected', () => {
  const before = Date.now();
  const [gemma] = normalize(OPENROUTER_FIXTURE);
  const after = Date.now();
  assert.ok(gemma.card.fetched_at >= before && gemma.card.fetched_at <= after);
});

test('normalize() is fail-soft on a malformed/empty payload (never throws)', () => {
  assert.deepEqual(normalize({}), []);
  assert.deepEqual(normalize(null), []);
  assert.deepEqual(normalize({ data: null }), []);
});

test('normalize() defaults missing optional card fields to null instead of throwing', () => {
  const cards = normalize({
    data: [{ id: 'bare/free-model:free', pricing: { prompt: '0', completion: '0' } }],
  }, { now: () => 1 });
  assert.equal(cards.length, 1);
  const [card] = cards;
  assert.equal(card.card.context_length, null);
  assert.equal(card.card.max_output_tokens, null);
  assert.equal(card.card.modality, null);
  assert.deepEqual(card.card.supported_parameters, []);
  assert.equal(card.card.description, null);
  assert.equal(card.card.reasoning, false);
  assert.equal(card.card.structured_outputs, false);
  assert.equal(card.card.params_b, null);
  assert.equal(card.card.active_params_b, null);
  assert.equal(card.card.size_class, null);
  assert.equal(card.card.params_basis, null);
});

test('fetch() GETs the OpenRouter models endpoint and returns parsed JSON', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ data: [] }) };
  };
  try {
    const json = await fetchOpenRouter();
    assert.deepEqual(json, { data: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/models');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch() throws on a non-ok response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  try {
    await assert.rejects(() => fetchOpenRouter(), /openrouter 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
