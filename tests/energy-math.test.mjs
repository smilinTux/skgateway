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

// Regression: found by deploying skmeter to a node with no GPU. The payload
// carried counter_j 0.0, the gateway computed a delta of 0, and real work was
// recorded as joules 0 with basis measured_gpu.
test("marginalJoules: a meter with no power source is unknowable, not zero", () => {
  const dead = { samples_n: 0, metering: "unavailable", node: "n1" };
  assert.equal(marginalJoules(dead, dead), null);
});

test("marginalJoules: an omitted counter_j is null even without the flag", () => {
  // Defence in depth for an older meter build that omits counter_j silently.
  const dead = { samples_n: 0, node: "n1" };
  assert.equal(marginalJoules(dead, dead), null);
});

test("marginalJoules: a genuine measured zero from an ACTIVE meter stays zero", () => {
  // The GPU was sampled and truly did nothing because a cloud backend served
  // the request. That is a real measurement and must not collapse to null.
  const a = { counter_j: 700, samples_n: 512, metering: "active" };
  const b = { counter_j: 700, samples_n: 530, metering: "active" };
  assert.equal(marginalJoules(a, b), 0);
});

import {
  paramsFromModelId, derivedCoeffs,
  MEASURED_J_PER_TOKEN_PER_B, CLOUD_J_PER_TOKEN_PER_B, INPUT_TOKEN_RATIO,
} from '../src/metrics/energy.mjs';

test('paramsFromModelId: plain dense sizes', () => {
  assert.deepEqual(paramsFromModelId('ornith-1.0-9b'), { total_b: 9, active_b: 9 });
  assert.deepEqual(paramsFromModelId('meta/llama-3.1-70b-instruct'), { total_b: 70, active_b: 70 });
});

test('paramsFromModelId: MoE uses ACTIVE params, because compute tracks active', () => {
  // 550B total but only 55B active. Charging 550 would overstate it 10x.
  assert.deepEqual(paramsFromModelId('nvidia/nemotron-3-ultra-550b-a55b'), { total_b: 550, active_b: 55 });
  assert.deepEqual(paramsFromModelId('qwen/qwen3.5-397b-a17b'), { total_b: 397, active_b: 17 });
});

test('paramsFromModelId: a :free suffix does not hide the size', () => {
  assert.deepEqual(paramsFromModelId('google/gemma-4-26b-a4b-it:free'), { total_b: 26, active_b: 4 });
});

test('paramsFromModelId: unparseable returns null, never a guess', () => {
  // Frontier models do not publish parameter counts. Recording "unknown" beats
  // inventing a number, which is the whole design rule of this module.
  assert.equal(paramsFromModelId('claude-opus-4-8'), null);
  assert.equal(paramsFromModelId('thinkingmachines/inkling'), null);
  assert.equal(paramsFromModelId(''), null);
  assert.equal(paramsFromModelId(null), null);
});

test('paramsFromModelId: active can never exceed total', () => {
  const p = paramsFromModelId('weird-7b-a99b');
  assert.ok(p.active_b <= p.total_b);
});

test('derivedCoeffs: scales with active params and discounts input tokens', () => {
  const c = derivedCoeffs('meta/llama-3.1-70b-instruct');
  assert.ok(Math.abs(c.j_per_output_token - 70 * CLOUD_J_PER_TOKEN_PER_B) < 1e-9);
  assert.ok(Math.abs(c.j_per_input_token - c.j_per_output_token * INPUT_TOKEN_RATIO) < 1e-9);
});

test('derivedCoeffs: null for an unparseable id', () => {
  assert.equal(derivedCoeffs('claude-opus-4-8'), null);
});

test('coeffsForModel: a curated entry BEATS derivation', () => {
  // This is load bearing. Our own ornith runs on a consumer card and was
  // MEASURED at 2.85 J/token; derivation would apply the datacenter discount
  // and return ~0.95, understating local energy threefold and making local
  // look artificially cheap against cloud.
  const table = { ornith: { j_per_output_token: 2.85, j_per_input_token: 0.285 } };
  assert.equal(coeffsForModel('ornith-1.0-9b', table).j_per_output_token, 2.85);
});

test('coeffsForModel: falls back to derivation when nothing is curated', () => {
  const c = coeffsForModel('nvidia/nemotron-3-super-120b-a12b', {});
  assert.ok(c && c.j_per_output_token > 0);
  assert.ok(Math.abs(c.j_per_output_token - 12 * CLOUD_J_PER_TOKEN_PER_B) < 1e-9);
});

test('the anchor constants match the documented measurement', () => {
  // 2.85 J/token measured on a 9B, so 0.317 J per token per billion.
  assert.ok(Math.abs(MEASURED_J_PER_TOKEN_PER_B - 2.85 / 9) < 0.002);
});

import { backendIsLocal } from '../src/metrics/energy.mjs';

test('backendIsLocal: a loopback WRAPPER must not launder cloud work as local', () => {
  // The anthropic backend is a proxy on 127.0.0.1:18782. A URL test calls it
  // local, so every Anthropic request was filed imputed_local when the work
  // really happens in Anthropic's datacenter. Config must win.
  const urlIsLocal = (u) => u.includes('127.0.0.1');
  const locality = { anthropic: 'remote' };
  assert.equal(backendIsLocal('anthropic', 'http://127.0.0.1:18782/v1', locality, urlIsLocal), false);
});

test('backendIsLocal: falls back to the URL heuristic when undeclared', () => {
  const urlIsLocal = (u) => u.includes('192.168.');
  assert.equal(backendIsLocal('local', 'http://192.168.0.100:8082/v1', {}, urlIsLocal), true);
  assert.equal(backendIsLocal('nvidia', 'https://integrate.api.nvidia.com/v1', {}, urlIsLocal), false);
});

test('backendIsLocal: an explicit local declaration also wins', () => {
  assert.equal(backendIsLocal('odd', 'https://example.com/v1', { odd: 'local' }, () => false), true);
});

test('backendIsLocal: a throwing heuristic degrades to remote, never crashes', () => {
  const boom = () => { throw new Error('bad url'); };
  assert.equal(backendIsLocal('x', 'not-a-url', {}, boom), false);
});
