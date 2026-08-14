import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  marginalJoules, imputeJoules, resolveBasis, coeffsForModel,
  usageFromSSE, attributeShare,
} from '../src/metrics/energy.mjs';

test('marginalJoules: delta of two counter reads', () => {
  assert.equal(marginalJoules({ counter_j: 1000 }, { counter_j: 2713 }), 1713);
});

test('marginalJoules: null when either read is missing', () => {
  assert.equal(marginalJoules(null, { counter_j: 100 }), null);
  assert.equal(marginalJoules({ counter_j: 100 }, null), null);
  assert.equal(marginalJoules(null, null), null);
});

test('marginalJoules: a counter that went backwards means a restart, not negative energy', () => {
  // The meter restarted mid-request. We cannot know the energy, so say so
  // rather than reporting a negative or a bogus huge number.
  assert.equal(marginalJoules({ counter_j: 5000 }, { counter_j: 12 }), null);
});

test('marginalJoules: zero is a real answer, not a missing one', () => {
  // The GPU genuinely did nothing, because a cloud backend served the request.
  assert.equal(marginalJoules({ counter_j: 700 }, { counter_j: 700 }), 0);
});

test('imputeJoules: linear in tokens', () => {
  const c = { j_per_input_token: 0.5, j_per_output_token: 2.85 };
  assert.equal(imputeJoules({ input_tokens: 100, output_tokens: 600 }, c), 50 + 1710);
});

test('imputeJoules: null when no coefficients are known', () => {
  // Better to record "unknown" than to invent a number and call it data.
  assert.equal(imputeJoules({ input_tokens: 100, output_tokens: 600 }, null), null);
});

test('imputeJoules: missing token counts count as zero', () => {
  const c = { j_per_input_token: 0.5, j_per_output_token: 2.85 };
  assert.equal(imputeJoules({ output_tokens: 600 }, c), 1710);
});

test('resolveBasis: measured wins when the meter answered', () => {
  assert.equal(resolveBasis({ metered: true, backendIsLocal: true }), 'measured_gpu');
});

test('resolveBasis: local without a meter is imputed_local', () => {
  assert.equal(resolveBasis({ metered: false, backendIsLocal: true }), 'imputed_local');
});

test('resolveBasis: remote is always imputed_cloud', () => {
  assert.equal(resolveBasis({ metered: false, backendIsLocal: false }), 'imputed_cloud');
});

test('coeffsForModel: exact match beats prefix', () => {
  const table = {
    'ornith-1.0-9b': { j_per_output_token: 2.85 },
    'ornith': { j_per_output_token: 9.99 },
  };
  assert.equal(coeffsForModel('ornith-1.0-9b', table).j_per_output_token, 2.85);
});

test('coeffsForModel: prefix match when no exact entry', () => {
  const table = { 'claude-': { j_per_output_token: 120 } };
  assert.equal(coeffsForModel('claude-opus-4-8', table).j_per_output_token, 120);
});

test('coeffsForModel: null for an unknown model', () => {
  assert.equal(coeffsForModel('some-new-model', { 'claude-': {} }), null);
});

test('usageFromSSE: pulls usage out of the final data chunk', () => {
  const body = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}',
    'data: {"choices":[{"delta":{"content":" there"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":51,"completion_tokens":600}}',
    'data: [DONE]',
    '',
  ].join('\n\n');
  const u = usageFromSSE(body);
  assert.equal(u.input_tokens, 51);
  assert.equal(u.output_tokens, 600);
});

test('usageFromSSE: tolerates a Buffer', () => {
  const body = Buffer.from('data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n');
  assert.deepEqual(usageFromSSE(body), { input_tokens: 1, output_tokens: 2 });
});

test('usageFromSSE: null when no chunk carries usage', () => {
  // Do not fabricate a zero: zero tokens and unknown tokens are different facts.
  const body = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
  assert.equal(usageFromSSE(body), null);
});

test('usageFromSSE: null for non-SSE input', () => {
  assert.equal(usageFromSSE('{"usage":{"prompt_tokens":1}}'), null);
  assert.equal(usageFromSSE(''), null);
  assert.equal(usageFromSSE(null), null);
});

test('attributeShare: sole tenant gets all the energy', () => {
  assert.equal(attributeShare(1713, 600, 600), 1713);
});

test('attributeShare: two tenants split by output tokens', () => {
  assert.equal(attributeShare(1000, 250, 1000), 250);
});

test('attributeShare: unknown totals fall back to the whole amount', () => {
  // Over-attributing to one request is safer than silently losing the energy.
  assert.equal(attributeShare(1000, 0, 0), 1000);
});
