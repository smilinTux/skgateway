/**
 * bucket-tool-use-filter.test.mjs — a bucket must not answer a TOOL request
 * with a model that cannot hold a tool call.
 *
 * resolveBucket() gated on three things: lifecycle routability, trust zone, and
 * the capability-floor size class. Size is a PRIOR, not proof, and buckets.mjs
 * says so itself: "treating absence as sufficient is how a bucket ends up
 * promising XL work and delivering a model that cannot hold a tool call."
 *
 * Measured on this fleet 2026-08-29, all reachable through `sk-*` buckets:
 *   nvidia/riva-translate-4b-instruct-v2   HTTP 400, not a chat model
 *   nvidia/ising-calibration-1.5-31b       returns prose, never tool_calls
 *   mistralai/mistral-nemotron             tool_calls fine, 0/3 on reasoning
 * Any of those could be handed to a caller that sent a `tools` array.
 *
 * The filter is CONDITIONAL on the request: only a request that actually
 * carries tools narrows the pool. A plain chat request keeps the full fleet, so
 * turning this on cannot shrink availability or start producing 503s for the
 * traffic that never needed tools.
 *
 * Run with:  node --test tests/bucket-tool-use-filter.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBucket, requiresToolUse } from '../src/policy/buckets.mjs';
import { TRUST_ZONES } from '../src/policy/sensitivity.mjs';

/** Catalog entry shaped like the merged catalog resolveBucket consumes. */
const entry = (id, { declaredTools, measuredToolCall } = {}) => ({
  id,
  capabilities: {
    trust_zone: TRUST_ZONES.SOVEREIGN_LOCAL,
    size_class: 'L',
    ...(declaredTools === undefined
      ? {}
      : { tool_use: { score: declaredTools ? 1 : 0, basis: 'card' } }),
  },
  ...(measuredToolCall
    ? { lifecycle: { measured_capabilities: { tool_call: { status: measuredToolCall } } } }
    : {}),
});

const BUCKET = { model_class: 'L', sensitivity: 'public' };
const ids = (r) => r.members.map((m) => m.id);

describe('requiresToolUse()', () => {
  test('true only for a request carrying a non-empty tools array', () => {
    assert.equal(requiresToolUse({ tools: [{ type: 'function' }] }), true);
    assert.equal(requiresToolUse({ tools: [] }), false);
    assert.equal(requiresToolUse({}), false);
    assert.equal(requiresToolUse(null), false);
    assert.equal(requiresToolUse({ tools: 'nonsense' }), false);
  });
});

describe('resolveBucket tool_use gate', () => {
  const catalog = [
    entry('good/declares-tools', { declaredTools: true }),
    entry('bad/declares-no-tools', { declaredTools: false }),
    entry('unknown/says-nothing'),
  ];

  test('OFF by default: a plain chat request keeps the whole pool', () => {
    // The safety property of turning this on: nothing gets narrower for the
    // traffic that never asked for tools.
    assert.deepEqual(
      ids(resolveBucket({ bucket: BUCKET, catalog })).sort(),
      ['bad/declares-no-tools', 'good/declares-tools', 'unknown/says-nothing'],
    );
  });

  test('ON: keeps only models with affirmative tool support', () => {
    const r = resolveBucket({ bucket: BUCKET, catalog, requireToolUse: true });
    assert.deepEqual(ids(r), ['good/declares-tools']);
  });

  test('ON: unknown is not evidence — it is excluded, not assumed capable', () => {
    const r = resolveBucket({ bucket: BUCKET, catalog, requireToolUse: true });
    assert.ok(!ids(r).includes('unknown/says-nothing'));
    const why = r.rejected.find((x) => x.id === 'unknown/says-nothing');
    assert.match(why.reason, /tool/i, 'the reject reason must name tools, so a 503 is actionable');
  });

  test('ON: a MEASURED tool_call failure overrides a card that claims tools', () => {
    // The card is a declaration; the probe is evidence. Evidence wins.
    const lying = [entry('liar/claims-tools', { declaredTools: true, measuredToolCall: 'fail' })];
    const r = resolveBucket({ bucket: BUCKET, catalog: lying, requireToolUse: true });
    assert.deepEqual(ids(r), []);
    assert.match(r.rejected[0].reason, /measured/i);
  });

  test('ON: a MEASURED tool_call pass admits a model whose card is silent', () => {
    const proven = [entry('proven/no-card', { measuredToolCall: 'pass' })];
    const r = resolveBucket({ bucket: BUCKET, catalog: proven, requireToolUse: true });
    assert.deepEqual(ids(r), ['proven/no-card']);
  });

  test('ON: an all-toolless fleet fails closed rather than serving a dud', () => {
    const r = resolveBucket({
      bucket: BUCKET,
      catalog: [entry('bad/declares-no-tools', { declaredTools: false })],
      requireToolUse: true,
    });
    assert.equal(r.members.length, 0, 'better a 503 the operator can read than a silent wrong answer');
  });
});
