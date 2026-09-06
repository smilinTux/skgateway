import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservation, parseObservation, serializeObservation, isFresh, observationKey } from '../src/metrics/observations.mjs';

const base = { source: 'skgateway', lane: 'gateway_observed', route: '/v1/chat', model: 'model-a', backend: 'backend-a', agent: 'jarvis', node: 'node-a', observed_at: '2026-09-06T00:00:00.000Z', ttl_seconds: 60, watermark: 'wm-1', request_count: 2, error_count: 1, request_latency: { buckets: [{ le: 1, count: 1 }, { le: 5, count: 2 }], count: 2, sum: 4 } };

test('creates versioned bounded observation and round trips JSON', () => {
  const observation = createObservation(base);
  assert.equal(observation.contract, 'skgateway.observation.v1');
  assert.equal(observation.lane, 'gateway_observed');
  assert.equal(observation.counts.requests, 2);
  assert.deepEqual(parseObservation(serializeObservation(observation)), observation);
});

test('keeps lanes distinct and freshness explicit', () => {
  const harness = createObservation({ ...base, lane: 'harness_reported' });
  assert.notEqual(observationKey(harness), observationKey(createObservation(base)));
  assert.equal(isFresh(createObservation(base), Date.parse(base.observed_at) + 59999), true);
  assert.equal(isFresh(createObservation(base), Date.parse(base.observed_at) + 60001), false);
});

test('rejects forbidden fields, malformed lines, and unbounded histograms', () => {
  assert.throws(() => createObservation({ ...base, prompt: 'nope' }), /forbidden/);
  assert.throws(() => parseObservation('{bad'), /malformed|Expected|Unexpected/);
  assert.equal(createObservation({ ...base, request_latency: { buckets: Array.from({ length: 33 }, (_, i) => ({ le: i, count: i })) } }).latency.request, null);
});
