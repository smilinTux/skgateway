import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isChatModel, parseNvidia, parseOpenRouterFree } from '../src/discovery.mjs';

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
