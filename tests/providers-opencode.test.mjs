/**
 * providers-opencode.test.mjs (card 6cc8aac3 / C8): the OpenCode Zen adapter.
 *
 * Unlike nvidia.mjs/openrouter.mjs, this adapter joins TWO independently
 * fail-soft sources: Zen's /v1/models (which ids are live) and models.dev's
 * `opencode` registry key (what each one is, including cost). `normalize()`
 * is pure (a captured `{zen, modelsDev}` payload in, a ModelCard[] out);
 * `fetch()`/`fetchZenModels()`/`fetchModelsDevRegistry()` are the network
 * calls, exercised here with a stubbed `globalThis.fetch` so the test stays
 * hermetic (no network).
 *
 * All fixture values below are REAL, captured live 2026-08-15 from
 * https://opencode.ai/zen/v1/models and https://models.dev/api.json (trimmed
 * to the fields normalize() reads), not synthetic. The one exception is
 * explicitly marked: classify.mjs's non-chat exclusion has no live example in
 * opencode's real catalog to capture (every model.dev opencode entry reports
 * text-only output; unlike OpenRouter, there is currently no lyria-3-style
 * music model here), so that one test constructs a hypothetical id using the
 * same id-pattern backstop classify.mjs already uses for every other
 * capability-free provider (NVIDIA).
 *
 * Run with: node --test tests/providers-opencode.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetch as fetchOpencode,
  fetchZenModels,
  fetchModelsDevRegistry,
  normalize,
} from '../src/discovery/providers/opencode.mjs';

// Captured 2026-08-15: GET https://opencode.ai/zen/v1/models returned 200,
// unauthenticated, 62 models, {id, object, created, owned_by} only (no
// pricing, no capability data at all - the reason this adapter needs a
// second source). Trimmed to five representative real ids: two paid frontier
// models (claude-opus-5, gpt-5) and three of the seven models confirmed live
// AND free that same session (big-pickle, deepseek-v4-flash-free, hy3-free).
const ZEN_FIXTURE = {
  object: 'list',
  data: [
    { id: 'claude-opus-5', object: 'model', created: 1786773625, owned_by: 'opencode' },
    { id: 'gpt-5', object: 'model', created: 1786773625, owned_by: 'opencode' },
    { id: 'big-pickle', object: 'model', created: 1786773625, owned_by: 'opencode' },
    { id: 'deepseek-v4-flash-free', object: 'model', created: 1786773625, owned_by: 'opencode' },
    { id: 'hy3-free', object: 'model', created: 1786773625, owned_by: 'opencode' },
  ],
};

// Captured 2026-08-15: GET https://models.dev/api.json, the `opencode` key's
// `models` map, for the same five ids above. Real cost/limit/capability
// values, not fabricated. Note claude-opus-5 and gpt-5 both carry nonzero
// cost (must be excluded); big-pickle carries NO `-free` suffix and IS free
// (cost.input === 0 && cost.output === 0) - the case this whole adapter
// exists for.
const MODELS_DEV_FIXTURE = {
  opencode: {
    id: 'opencode',
    env: ['OPENCODE_API_KEY'],
    api: 'https://opencode.ai/zen/v1',
    models: {
      'claude-opus-5': {
        id: 'claude-opus-5',
        name: 'Claude Opus 5',
        description: 'Strongest Claude Opus model for coding, agents, and professional work',
        reasoning: true,
        tool_call: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        limit: { context: 1000000, output: 128000 },
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      },
      'gpt-5': {
        id: 'gpt-5',
        name: 'GPT-5',
        description: 'GPT model for general reasoning, writing, coding, and tool-assisted tasks',
        reasoning: true,
        tool_call: true,
        structured_output: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 400000, input: 272000, output: 128000 },
        cost: { input: 1.07, output: 8.5, cache_read: 0.107 },
      },
      'big-pickle': {
        id: 'big-pickle',
        name: 'Big Pickle',
        description: 'Reasoning model for deliberate analysis, multi-step problem solving, and tool use',
        reasoning: true,
        tool_call: true,
        structured_output: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 200000, input: 160000, output: 32000 },
        cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      },
      'deepseek-v4-flash-free': {
        id: 'deepseek-v4-flash-free',
        name: 'DeepSeek V4 Flash Free',
        description: 'Official DeepSeek V4 Flash release with enhanced agentic capabilities',
        reasoning: true,
        tool_call: true,
        structured_output: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 200000, output: 128000 },
        cost: { input: 0, output: 0, cache_read: 0 },
      },
      'hy3-free': {
        id: 'hy3-free',
        name: 'Hy3 Free',
        description: 'Tencent Hy reasoning model for coding, instruction following, and agent tasks',
        reasoning: true,
        tool_call: true,
        structured_output: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 190000, output: 64000 },
        cost: { input: 0, output: 0, cache_read: 0 },
      },
    },
  },
};

test('normalize() joins Zen (liveness) with models.dev (the card): free chat models kept, paid ones dropped', () => {
  const cards = normalize({ zen: ZEN_FIXTURE, modelsDev: MODELS_DEV_FIXTURE }, { now: () => 5000 });
  const ids = cards.map((c) => c.id).sort();
  assert.deepEqual(ids, ['big-pickle', 'deepseek-v4-flash-free', 'hy3-free']);
});

test('big-pickle is included despite carrying NO "-free" suffix (free is decided by cost, never the id)', () => {
  const cards = normalize({ zen: ZEN_FIXTURE, modelsDev: MODELS_DEV_FIXTURE }, { now: () => 5000 });
  const bigPickle = cards.find((c) => c.id === 'big-pickle');
  assert.ok(bigPickle, 'big-pickle must be present');
  assert.equal(bigPickle.free, true);
  assert.equal(bigPickle.id.endsWith('-free'), false);
});

test('a paid model with nonzero cost is excluded even though Zen still serves it live', () => {
  const cards = normalize({ zen: ZEN_FIXTURE, modelsDev: MODELS_DEV_FIXTURE }, { now: () => 5000 });
  assert.ok(!cards.some((c) => c.id === 'claude-opus-5'));
  assert.ok(!cards.some((c) => c.id === 'gpt-5'));
});

test('a "-free"-suffixed id is still excluded when its real cost is nonzero (suffix is not the signal)', () => {
  // Constructed adversarial case: no such id exists live today (every real
  // "-free" id in the captured registry is genuinely zero-cost), but the
  // point of the card is that the SUFFIX must never be trusted. Prove the
  // filter would catch a lying suffix if one ever showed up.
  const cards = normalize({
    zen: { data: [{ id: 'decoy-free', object: 'model' }] },
    modelsDev: { opencode: { models: { 'decoy-free': { id: 'decoy-free', modalities: { output: ['text'] }, cost: { input: 2, output: 4 } } } } },
  }, { now: () => 1 });
  assert.deepEqual(cards, []);
});

test('normalize() keeps the full ModelCard from models.dev (context, limits, tool_call, reasoning, cost)', () => {
  const cards = normalize({ zen: ZEN_FIXTURE, modelsDev: MODELS_DEV_FIXTURE }, { now: () => 5000 });
  const bigPickle = cards.find((c) => c.id === 'big-pickle');
  assert.equal(bigPickle.provider, 'opencode');
  assert.ok(bigPickle.card, 'card block present');
  assert.equal(bigPickle.card.context_length, 200000);
  assert.equal(bigPickle.card.max_output_tokens, 32000);
  assert.equal(bigPickle.card.modality, 'text->text');
  assert.deepEqual(bigPickle.card.supported_parameters, ['tools', 'tool_choice', 'reasoning', 'structured_outputs']);
  assert.equal(bigPickle.card.description, 'Reasoning model for deliberate analysis, multi-step problem solving, and tool use');
  assert.deepEqual(bigPickle.card.pricing, { prompt: '0', completion: '0' });
  assert.equal(bigPickle.card.source, 'models.dev');
  assert.equal(bigPickle.card.fetched_at, 5000);
});

test('card N1: every card is tagged trust zone 2 / free-remote and ineligible for secret sensitivity', () => {
  const cards = normalize({ zen: ZEN_FIXTURE, modelsDev: MODELS_DEV_FIXTURE }, { now: () => 5000 });
  for (const c of cards) {
    assert.equal(c.card.tier, 'free-remote');
    assert.equal(c.card.trust_zone, 2);
    assert.equal(c.card.sensitivity_max, 'public');
  }
});

test('models.dev unreachable: Zen ids are still served with a null card, provider is not dropped', () => {
  const cards = normalize({ zen: ZEN_FIXTURE, modelsDev: null }, { now: () => 5000 });
  const ids = cards.map((c) => c.id).sort();
  // Nothing is excluded by cost (unknown, not false), and classify.mjs falls
  // back to its id-pattern backstop with no modality evidence, which admits
  // all five of these real ids (none matches a non-chat pattern).
  assert.deepEqual(ids, ['big-pickle', 'claude-opus-5', 'deepseek-v4-flash-free', 'gpt-5', 'hy3-free']);
  for (const c of cards) {
    assert.equal(c.card, null);
    assert.equal(c.free, null, `${c.id} must be "unknown", not guessed true or false`);
  }
});

test('models.dev registry present but missing this one id: treated the same as an outage for that id (unknown, not dropped)', () => {
  const cards = normalize({
    zen: { data: [{ id: 'brand-new-unlisted-model' }] },
    modelsDev: { opencode: { models: {} } },
  }, { now: () => 1 });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].free, null);
  assert.equal(cards[0].card, null);
});

test('non-chat exclusion via classify.mjs: a real chat id passes, a constructed non-chat-pattern id is excluded', () => {
  // No real non-chat example exists in opencode's live catalog to capture
  // (every models.dev opencode entry reports text-only output, unlike
  // OpenRouter's lyria-3 music models), so this exercises classify.mjs's
  // id-pattern backstop directly, the same path NVIDIA's adapter is always
  // on. A free, zero-cost, "rerank"-named id must still be excluded.
  const cards = normalize({
    zen: { data: [{ id: 'big-pickle' }, { id: 'opencode-rerank-v1' }] },
    modelsDev: {
      opencode: {
        models: {
          'big-pickle': MODELS_DEV_FIXTURE.opencode.models['big-pickle'],
          'opencode-rerank-v1': {
            id: 'opencode-rerank-v1',
            modalities: { input: ['text'], output: ['text'] },
            cost: { input: 0, output: 0 },
          },
        },
      },
    },
  }, { now: () => 1 });
  const ids = cards.map((c) => c.id);
  assert.ok(ids.includes('big-pickle'));
  assert.ok(!ids.includes('opencode-rerank-v1'));
});

test('normalize() is fail-soft on a malformed/empty payload (never throws)', () => {
  assert.deepEqual(normalize({}), []);
  assert.deepEqual(normalize(null), []);
  assert.deepEqual(normalize({ zen: null, modelsDev: null }), []);
  assert.deepEqual(normalize({ zen: { data: null }, modelsDev: null }), []);
});

test('normalize() defaults fetched_at to Date.now() when no clock is injected', () => {
  const before = Date.now();
  const cards = normalize({ zen: ZEN_FIXTURE, modelsDev: MODELS_DEV_FIXTURE });
  const after = Date.now();
  const bigPickle = cards.find((c) => c.id === 'big-pickle');
  assert.ok(bigPickle.card.fetched_at >= before && bigPickle.card.fetched_at <= after);
});

test('fetchZenModels() GETs the Zen models endpoint unauthenticated when no key is given', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ data: [] }) };
  };
  try {
    const json = await fetchZenModels();
    assert.deepEqual(json, { data: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://opencode.ai/zen/v1/models');
    assert.equal(calls[0].opts, undefined, 'no headers invented when no api key is given');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchZenModels() sends OPENCODE_API_KEY as an optional bearer when given, and nothing else', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ data: [] }) };
  };
  try {
    await fetchZenModels('sk-test-key-123');
    assert.deepEqual(calls[0].opts, { headers: { authorization: 'Bearer sk-test-key-123' } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchZenModels() throws on a non-ok response (a 401 or 429 becomes a normal fetch failure, not a special case)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  try {
    await assert.rejects(() => fetchZenModels(), /opencode 429/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchModelsDevRegistry() throws on a non-ok response', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  try {
    await assert.rejects(() => fetchModelsDevRegistry(), /models\.dev 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch(): Zen failing propagates (a real provider outage), models.dev is never even reached', async () => {
  let modelsDevCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('opencode.ai')) return { ok: false, status: 500 };
    modelsDevCalled = true;
    return { ok: true, json: async () => ({}) };
  };
  try {
    await assert.rejects(() => fetchOpencode(), /opencode 500/);
    assert.equal(modelsDevCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch(): models.dev failing does NOT propagate, resolves with modelsDev: null', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('opencode.ai')) return { ok: true, json: async () => ZEN_FIXTURE };
    return { ok: false, status: 500 };
  };
  try {
    const result = await fetchOpencode();
    assert.deepEqual(result.zen, ZEN_FIXTURE);
    assert.equal(result.modelsDev, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetch(): both sources succeeding returns both, unmodified', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('opencode.ai')) return { ok: true, json: async () => ZEN_FIXTURE };
    return { ok: true, json: async () => MODELS_DEV_FIXTURE };
  };
  try {
    const result = await fetchOpencode('sk-test-key');
    assert.deepEqual(result.zen, ZEN_FIXTURE);
    assert.deepEqual(result.modelsDev, MODELS_DEV_FIXTURE);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
