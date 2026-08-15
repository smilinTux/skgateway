/**
 * providers-nvidia.test.mjs (card P2.1): the NVIDIA adapter. NVIDIA's
 * `/v1/models` is bare ids (design doc 5.1), so `normalize()` does heuristic
 * family/size/variant parsing of the id (`source:'heuristic'`) instead of
 * scraping build.nvidia.com (Q2). `fetch()` is exercised with a stubbed
 * `globalThis.fetch` so the test stays hermetic (no network).
 *
 * Run with: node --test tests/providers-nvidia.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetch as fetchNvidia, normalize } from '../src/discovery/providers/nvidia.mjs';

// Captured shape of https://integrate.api.nvidia.com/v1/models: essentially
// bare ids (`id`, `object`, `owned_by`), no context/modality/pricing card.
const NVIDIA_FIXTURE = {
  data: [
    { id: 'qwen/qwen3.5-122b-a10b', object: 'model', owned_by: 'qwen' },
    { id: 'meta/llama-3.3-70b-instruct', object: 'model', owned_by: 'meta' },
    { id: 'deepseek-ai/deepseek-r1-thinking', object: 'model', owned_by: 'deepseek-ai' },
    { id: 'qwen/qwen3.5-coder-32b-instruct', object: 'model', owned_by: 'qwen' },
    { id: 'qwen/qwen3.5-vl-72b-instruct', object: 'model', owned_by: 'qwen' },
    { id: 'baai/bge-m3', object: 'model', owned_by: 'baai' },
    { id: 'nvidia/nemotron-3.5-content-safety', object: 'model', owned_by: 'nvidia' },
  ],
};

test('normalize() drops non-chat ids (embeddings/safety/guard), same isChatModel filter', () => {
  const cards = normalize(NVIDIA_FIXTURE, { now: () => 5000 });
  const ids = cards.map((c) => c.id);
  assert.ok(!ids.includes('baai/bge-m3'));
  assert.ok(!ids.includes('nvidia/nemotron-3.5-content-safety'));
  assert.equal(ids.length, 5);
});

test('normalize() tags every card provider:nvidia, free:true, source:heuristic', () => {
  const cards = normalize(NVIDIA_FIXTURE, { now: () => 5000 });
  for (const c of cards) {
    assert.equal(c.provider, 'nvidia');
    assert.equal(c.free, true);
    assert.equal(c.card.source, 'heuristic');
    assert.equal(c.card.fetched_at, 5000);
  }
});

test('normalize() heuristically parses a MoE id: total size + active params', () => {
  const cards = normalize(NVIDIA_FIXTURE, { now: () => 5000 });
  const qwen = cards.find((c) => c.id === 'qwen/qwen3.5-122b-a10b');
  assert.equal(qwen.card.org, 'qwen');
  assert.equal(qwen.card.family, 'qwen3.5');
  assert.equal(qwen.card.size, '122b');
  assert.equal(qwen.card.active_params, '10b');
  assert.equal(qwen.card.variant, null);
});

test('normalize() heuristically parses org/family/size/variant for a dense instruct id', () => {
  const cards = normalize(NVIDIA_FIXTURE, { now: () => 5000 });
  const llama = cards.find((c) => c.id === 'meta/llama-3.3-70b-instruct');
  assert.equal(llama.card.org, 'meta');
  assert.equal(llama.card.family, 'llama-3.3');
  assert.equal(llama.card.size, '70b');
  assert.equal(llama.card.variant, 'instruct');
  assert.deepEqual(llama.card.variants, ['instruct']);
});

test('normalize() detects a -thinking variant with no parseable size', () => {
  const cards = normalize(NVIDIA_FIXTURE, { now: () => 5000 });
  const r1 = cards.find((c) => c.id === 'deepseek-ai/deepseek-r1-thinking');
  assert.equal(r1.card.family, 'deepseek-r1');
  assert.equal(r1.card.size, null);
  assert.equal(r1.card.variant, 'thinking');
});

test('normalize() detects a coder variant', () => {
  const cards = normalize(NVIDIA_FIXTURE, { now: () => 5000 });
  const coder = cards.find((c) => c.id === 'qwen/qwen3.5-coder-32b-instruct');
  assert.equal(coder.card.family, 'qwen3.5');
  assert.equal(coder.card.size, '32b');
  assert.deepEqual(coder.card.variants, ['coder', 'instruct']);
});

test('normalize() flags vision modality for a -vl- id, text->text otherwise', () => {
  const cards = normalize(NVIDIA_FIXTURE, { now: () => 5000 });
  const vl = cards.find((c) => c.id === 'qwen/qwen3.5-vl-72b-instruct');
  const llama = cards.find((c) => c.id === 'meta/llama-3.3-70b-instruct');
  assert.equal(vl.card.modality, 'text+image->text');
  assert.equal(llama.card.modality, 'text->text');
});

test('normalize() never claims declared tool support or a context length it does not have', () => {
  const cards = normalize(NVIDIA_FIXTURE, { now: () => 5000 });
  for (const c of cards) {
    assert.deepEqual(c.card.supported_parameters, []);
    assert.equal(c.card.context_length, null);
    assert.equal(c.card.max_output_tokens, null);
  }
});

test('normalize() adds numeric params_b/active_params_b and a heuristic size_class (card N2)', () => {
  const cards = normalize(NVIDIA_FIXTURE, { now: () => 5000 });
  const qwen = cards.find((c) => c.id === 'qwen/qwen3.5-122b-a10b');
  assert.equal(qwen.card.params_b, 122);
  assert.equal(qwen.card.active_params_b, 10);
  assert.equal(qwen.card.size_class, 'XL');

  const llama = cards.find((c) => c.id === 'meta/llama-3.3-70b-instruct');
  assert.equal(llama.card.params_b, 70);
  assert.equal(llama.card.active_params_b, null);
  assert.equal(llama.card.size_class, 'L');
});

test('normalize() leaves params_b/active_params_b/size_class null when the id carries no size token', () => {
  const cards = normalize(NVIDIA_FIXTURE, { now: () => 5000 });
  const r1 = cards.find((c) => c.id === 'deepseek-ai/deepseek-r1-thinking');
  assert.equal(r1.card.params_b, null);
  assert.equal(r1.card.active_params_b, null);
  assert.equal(r1.card.size_class, null);
});

test('normalize() distinguishes an XL MoE model (550B total) from a small dense one (9B), the concrete fleet test', () => {
  const fixture = {
    data: [
      { id: 'nvidia/nemotron-3-ultra-550b-a55b', object: 'model', owned_by: 'nvidia' },
      { id: 'nvidia/nvidia-nemotron-nano-9b-v2', object: 'model', owned_by: 'nvidia' },
    ],
  };
  const cards = normalize(fixture, { now: () => 5000 });
  const ultra = cards.find((c) => c.id === 'nvidia/nemotron-3-ultra-550b-a55b');
  const nano = cards.find((c) => c.id === 'nvidia/nvidia-nemotron-nano-9b-v2');
  assert.equal(ultra.card.params_b, 550);
  assert.equal(ultra.card.active_params_b, 55);
  assert.equal(ultra.card.size_class, 'XL');
  assert.equal(nano.card.params_b, 9);
  assert.equal(nano.card.size_class, 'M');
  assert.notEqual(ultra.card.size_class, nano.card.size_class);
});

test('normalize() is fail-soft on a malformed/empty payload (never throws)', () => {
  assert.deepEqual(normalize({}), []);
  assert.deepEqual(normalize(null), []);
  assert.deepEqual(normalize({ data: null }), []);
});

test('normalize() defaults fetched_at to Date.now() when no clock is injected', () => {
  const before = Date.now();
  const cards = normalize({ data: [{ id: 'meta/llama-3.3-8b-instruct' }] });
  const after = Date.now();
  assert.ok(cards[0].card.fetched_at >= before && cards[0].card.fetched_at <= after);
});

test('fetch() GETs the NVIDIA models endpoint with a bearer token and returns parsed JSON', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ data: [] }) };
  };
  try {
    const json = await fetchNvidia('sk-test-key');
    assert.deepEqual(json, { data: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://integrate.api.nvidia.com/v1/models');
    assert.equal(calls[0].opts.headers.authorization, 'Bearer sk-test-key');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch() throws on a non-ok response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  try {
    await assert.rejects(() => fetchNvidia('bad-key'), /nvidia 401/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
