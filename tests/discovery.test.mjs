import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isChatModel, parseNvidia, parseOpenRouterFree, mergeCatalog, discoverCatalog } from '../src/discovery.mjs';

test('isChatModel drops embeddings, vision, safety', () => {
  assert.equal(isChatModel('meta/llama-3.3-70b-instruct'), true);
  assert.equal(isChatModel('baai/bge-m3'), false);
  assert.equal(isChatModel('nvidia/embed-qa-4'), false);
  assert.equal(isChatModel('adept/fuyu-8b'), false);
  assert.equal(isChatModel('nvidia/nemotron-3.5-content-safety'), false);
});

test('parseNvidia keeps chat ids, tags provider+free', () => {
  const out = parseNvidia({ data: [{ id: 'qwen/qwen3.5-122b-a10b' }, { id: 'baai/bge-m3' }] });
  assert.deepEqual(out, [{ id: 'qwen/qwen3.5-122b-a10b', provider: 'nvidia', free: true }]);
});

test('parseOpenRouterFree keeps only free chat models', () => {
  const json = { data: [
    { id: 'google/gemma-4-31b-it:free', pricing: { prompt: '0', completion: '0' } },
    { id: 'anthropic/claude-x', pricing: { prompt: '0.003', completion: '0.015' } },
    { id: 'nvidia/nemotron-3.5-content-safety:free', pricing: { prompt: '0', completion: '0' } },
  ] };
  const out = parseOpenRouterFree(json).map(m => m.id);
  assert.deepEqual(out, ['google/gemma-4-31b-it:free']);
});

test('mergeCatalog dedups by id, local wins', () => {
  const out = mergeCatalog(
    [{ id: 'ornith-tiny', provider: 'local', free: true }],
    [{ id: 'ornith-tiny', provider: 'nvidia', free: true }, { id: 'qwen/x', provider: 'nvidia', free: true }],
    [{ id: 'g/y:free', provider: 'openrouter', free: true }],
  );
  const byId = Object.fromEntries(out.map((m) => [m.id, m.provider]));
  assert.equal(byId['ornith-tiny'], 'local');
  assert.equal(byId['qwen/x'], 'nvidia');
  assert.equal(byId['g/y:free'], 'openrouter');
});

test('discoverCatalog serves cache + marks stale when a provider throws', async () => {
  const cache = { models: [{ id: 'cached', provider: 'nvidia', free: true }] };
  const res = await discoverCatalog({
    localModels: [{ id: 'ornith-tiny', provider: 'local', free: true }],
    nvidiaFetch: async () => { throw new Error('down'); },
    openrouterFetch: async () => ({ data: [] }),
    cache,
  });
  assert.equal(res.stale, true);
  const ids = res.models.map((m) => m.id);
  assert.ok(ids.includes('ornith-tiny'));
  assert.ok(ids.includes('cached'));
});
