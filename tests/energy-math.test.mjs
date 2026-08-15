import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  marginalJoules, imputeJoules, resolveBasis, coeffsForModel,
  usageFromSSE, attributeShare, resolveMeterUrl, energyRowsFrom, energyHeaders,
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

// ─── resolveMeterUrl: backend id, synthetic reg:* id, or URL host ───────────
// Finding C2. An exact-id-only lookup misses registry-routed traffic, which is
// the main path and the exact traffic the spec's motivating incident is about,
// and misses it silently by falling through to imputation.

const METER = 'http://192.168.0.100:9420/energy';

test('resolveMeterUrl: a plain backend id resolves exactly', () => {
  assert.equal(resolveMeterUrl({ local: METER }, 'local', 'http://10.0.0.5:8082/v1'), METER);
});

test('resolveMeterUrl: a registry-routed reg:* id finds the plain configured key', () => {
  // getRegBackend() invents "reg:<backend>"; no operator writes that in YAML.
  assert.equal(resolveMeterUrl({ ornith: METER }, 'reg:ornith', 'http://192.168.0.100:8082/v1'), METER);
});

test('resolveMeterUrl: a configured reg:* key is found from the plain id too', () => {
  assert.equal(resolveMeterUrl({ 'reg:ornith': METER }, 'ornith', 'http://192.168.0.100:8082/v1'), METER);
});

test('resolveMeterUrl: falls back to the backend URL host:port, then the bare host', () => {
  // Backends carry no node identity (spec 4.5); the URL is the only locality signal.
  assert.equal(
    resolveMeterUrl({ '192.168.0.100:8082': METER }, 'reg:whatever', 'http://192.168.0.100:8082/v1'),
    METER,
  );
  assert.equal(
    resolveMeterUrl({ '192.168.0.100': METER }, 'reg:whatever', 'http://192.168.0.100:8082/v1'),
    METER,
  );
});

test('resolveMeterUrl: host:port wins over the bare host', () => {
  // Two backends on one box may be different devices; the specific key is the
  // one the operator meant.
  const meters = { '192.168.0.100': 'http://wrong/energy', '192.168.0.100:8082': METER };
  assert.equal(resolveMeterUrl(meters, 'x', 'http://192.168.0.100:8082/v1'), METER);
});

test('resolveMeterUrl: null when nothing matches, and never throws on junk', () => {
  assert.equal(resolveMeterUrl({ other: METER }, 'local', 'http://10.0.0.5:8082/v1'), null);
  assert.equal(resolveMeterUrl({}, 'local', 'not a url'), null);
  assert.equal(resolveMeterUrl(null, 'local', 'http://x/v1'), null);
  assert.equal(resolveMeterUrl({ local: METER }, undefined, undefined), null);
});

// ─── energyRowsFrom: one row per metered attempt ────────────────────────────
// Finding C3. Reads are per attempt, so writes are too.

test('energyRowsFrom: nothing observed means no rows (the disabled path)', () => {
  assert.deepEqual(energyRowsFrom({}), []);
  assert.deepEqual(energyRowsFrom(null), []);
});

test('energyRowsFrom: the ordinary one-attempt request still writes exactly one row', () => {
  const energy = { joules: 1713, basis: 'measured_gpu', node: 'dot100' };
  assert.deepEqual(energyRowsFrom({ energy }), [energy]);
});

test('energyRowsFrom: a failover writes one row per attempt, not just the winner', () => {
  const attempts = [
    { joules: 900, basis: 'measured_gpu', node: 'dot100', backendId: 'primary' },
    { joules: null, basis: 'imputed_cloud', node: null, backendId: 'fallback' },
  ];
  const rows = energyRowsFrom({ energy: attempts[1], energyAttempts: attempts });
  assert.equal(rows.length, 2, 'the failed local attempt burned real joules and must be recorded');
  assert.deepEqual(rows.map((r) => r.backendId), ['primary', 'fallback']);
});

// ─── energyHeaders: return energy to the caller (spec 4.5) ──────────────────
// Finding C5. Absent, never empty, for anything we do not know.

test('energyHeaders: nothing to report emits no headers', () => {
  assert.deepEqual(energyHeaders(undefined), {});
  assert.deepEqual(energyHeaders(null), {});
});

test('energyHeaders: a measured request returns joules, basis and node', () => {
  assert.deepEqual(
    energyHeaders({ joules: 1713, basis: 'measured_gpu', node: 'dot100' }),
    {
      'x-sk-energy-joules': '1713',
      'x-sk-energy-basis': 'measured_gpu',
      'x-sk-energy-node': 'dot100',
    },
  );
});

test('energyHeaders: zero joules is a real answer and is reported', () => {
  // The cloud-served negative control: 0 and unknown are different facts.
  assert.equal(energyHeaders({ joules: 0, basis: 'imputed_cloud' })['x-sk-energy-joules'], '0');
});

test('energyHeaders: unknown joules omits the header rather than sending an empty one', () => {
  const h = energyHeaders({ joules: null, basis: 'imputed_local', node: null });
  assert.equal('x-sk-energy-joules' in h, false, 'an empty header reads as a measurement of nothing');
  assert.equal('x-sk-energy-node' in h, false);
  assert.equal(h['x-sk-energy-basis'], 'imputed_local', 'the basis still explains the gap');
});
