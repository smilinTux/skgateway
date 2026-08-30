import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  bucketPlacement,
  buildEvaluatedCatalog,
  classifyProbe,
  probeModel,
} from '../scripts/evaluate-openrouter-free.mjs';

const card = {
  id: 'vendor/model-30b:free',
  provider: 'openrouter',
  free: true,
  card: {
    context_length: 32768,
    max_output_tokens: 4096,
    modality: 'text->text',
    supported_parameters: ['tools', 'reasoning'],
    size_class: 'L',
    pricing: { prompt: '0', completion: '0' },
    source: 'openrouter',
  },
};

test('classifyProbe keeps throttling active and permanent absence explicit', () => {
  assert.deepEqual(classifyProbe({ status: 429 }), {
    health: 'throttled', lifecycle: 'active', reason: 'rate_limited',
  });
  assert.deepEqual(classifyProbe({ status: 410 }), {
    health: 'unavailable', lifecycle: 'eol_candidate', reason: 'provider_410',
  });
  assert.deepEqual(classifyProbe({ error: 'timeout' }), {
    health: 'unmeasured', lifecycle: 'suspect', reason: 'timeout',
  });
});

test('probeModel records attribution without retaining prompt or response text', async () => {
  const result = await probeModel(card.id, {
    apiKey: 'test-reference-only',
    fetchFn: async (_url, options) => {
      assert.equal(options.headers.authorization, 'Bearer test-reference-only');
      return new Response(JSON.stringify({
        model: 'served/model',
        choices: [{ message: { content: 'OPENROUTER_PUBLIC_OK' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(result.requested_model, card.id);
  assert.equal(result.served_model, 'served/model');
  assert.equal(result.content_present, true);
  assert.equal(JSON.stringify(result).includes('OPENROUTER_PUBLIC_OK'), false);
});

test('probeModel distinguishes client cancellation from timeout', async () => {
  const fetchFn = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  const cancelled = await probeModel(card.id, {
    apiKey: 'test-reference-only', fetchFn, cancelAfterMs: 1,
  });
  assert.equal(cancelled.health, 'cancelled');
  const timeout = await probeModel(card.id, {
    apiKey: 'test-reference-only', fetchFn, timeoutMs: 1,
  });
  assert.equal(timeout.reason, 'timeout');
});

test('evaluated catalog carries capabilities and an explicit decision for every bucket', () => {
  const probe = {
    requested_model: card.id,
    health: 'available',
    lifecycle: 'active',
    latency_ms: 125,
  };
  const [entry] = buildEvaluatedCatalog([card], [probe]);
  assert.equal(entry.capabilities.tool_use.score, 1);
  assert.equal(entry.capabilities.trust_zone, 2);
  assert.equal(entry.bucket_placement.length, 12);
  assert.equal(entry.bucket_placement.find((item) => item.bucket === 'sk-l-public').eligible, true);
  assert.match(
    entry.bucket_placement.find((item) => item.bucket === 'sk-l-internal').reason,
    /trust_zone 2 exceeds ceiling 1/,
  );
  assert.deepEqual(entry.bucket_placement, bucketPlacement(entry));
});
