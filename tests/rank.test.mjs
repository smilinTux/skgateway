/**
 * rank.test.mjs (card P3.2): src/ranking/rank.mjs.
 *
 * Covers: hard filters (lifecycle active-only, require block, allowlist,
 * availability), sovereignty tiering (strict, never crossed by score),
 * basis-weighted scoring within a tier (empirical dominates priors), and
 * determinism/purity of `rankModels()`.
 *
 * Catalog entries here mirror the design doc 4.1 record shape: each has
 * `id`, `free`, `lifecycle: {state}`, and `capabilities` (the P3.1
 * `deriveCapabilities()` output shape), assembled by whatever caller wires
 * discovery + capability derivation together (out of scope for this card).
 *
 * Run with:  node --test tests/rank.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { rankModels } from '../src/ranking/rank.mjs';

function active() {
  return { state: 'active', last_verified_at: null, consecutive_permanent_errors: 0, absent_cycles: 0, eol_reason: null, eol_at: null };
}
function eol(reason = 'provider_410') {
  return { state: 'eol', last_verified_at: null, consecutive_permanent_errors: 3, absent_cycles: 0, eol_reason: reason, eol_at: 1 };
}
function dead() {
  return { state: 'dead', last_verified_at: null, consecutive_permanent_errors: 3, absent_cycles: 3, eol_reason: 'provider_410', eol_at: 1 };
}
function suspect() {
  return { state: 'suspect', last_verified_at: null, consecutive_permanent_errors: 1, absent_cycles: 1, eol_reason: null, eol_at: null };
}

function caps(overrides = {}) {
  return {
    tool_use: { score: 0, basis: 'card' },
    vision: false,
    ctx_tokens: 32768,
    latency_p50_ms: null,
    success_rate: null,
    reasoning: { score: 0.5, basis: 'prior' },
    coding: { score: 0.5, basis: 'prior' },
    sovereignty: 'free-remote',
    ...overrides,
  };
}

function entry(id, { lifecycle = active(), capabilities = caps(), free = true } = {}) {
  return { id, free, lifecycle, capabilities };
}

function findResult(results, id) {
  const r = results.find((x) => x.id === id);
  assert.ok(r, `expected a result for ${id}`);
  return r;
}

describe('hard filters: lifecycle', () => {
  test('active passes, is not excluded', () => {
    const results = rankModels([entry('m-active')], {});
    const r = findResult(results, 'm-active');
    assert.equal(r.excluded_reason, null);
    assert.ok(typeof r.rank === 'number');
  });

  test('eol is excluded, never ranked', () => {
    const results = rankModels([entry('m-eol', { lifecycle: eol() })], {});
    const r = findResult(results, 'm-eol');
    assert.equal(r.excluded_reason, 'lifecycle:eol');
    assert.equal(r.score, null);
    assert.equal(r.rank, null);
  });

  test('dead is excluded, never ranked', () => {
    const results = rankModels([entry('m-dead', { lifecycle: dead() })], {});
    const r = findResult(results, 'm-dead');
    assert.equal(r.excluded_reason, 'lifecycle:dead');
    assert.equal(r.rank, null);
  });

  test('suspect is excluded from ranking (ranker only picks confidently-active models)', () => {
    const results = rankModels([entry('m-suspect', { lifecycle: suspect() })], {});
    const r = findResult(results, 'm-suspect');
    assert.equal(r.excluded_reason, 'lifecycle:suspect');
  });

  test('missing lifecycle is excluded (unknown state, never guessed routable)', () => {
    const results = rankModels([{ id: 'm-no-lc', free: true, capabilities: caps() }], {});
    const r = findResult(results, 'm-no-lc');
    assert.equal(r.excluded_reason, 'lifecycle:unknown');
  });
});

describe('hard filters: require block', () => {
  test('require.tool_use=true excludes a model without declared tool use', () => {
    const results = rankModels(
      [entry('no-tools', { capabilities: caps({ tool_use: { score: 0, basis: 'card' } }) })],
      { require: { tool_use: true } },
    );
    assert.equal(findResult(results, 'no-tools').excluded_reason, 'require:tool_use');
  });

  test('require.tool_use=true admits a model that declares tool use', () => {
    const results = rankModels(
      [entry('has-tools', { capabilities: caps({ tool_use: { score: 1, basis: 'card' } }) })],
      { require: { tool_use: true } },
    );
    assert.equal(findResult(results, 'has-tools').excluded_reason, null);
  });

  test('require.min_ctx excludes a model below the context floor', () => {
    const results = rankModels(
      [entry('small-ctx', { capabilities: caps({ ctx_tokens: 8192 }) })],
      { require: { min_ctx: 32768 } },
    );
    assert.equal(findResult(results, 'small-ctx').excluded_reason, 'require:min_ctx');
  });

  test('require.min_ctx excludes a model with no declared ctx at all', () => {
    const results = rankModels(
      [entry('no-ctx', { capabilities: caps({ ctx_tokens: null }) })],
      { require: { min_ctx: 32768 } },
    );
    assert.equal(findResult(results, 'no-ctx').excluded_reason, 'require:min_ctx');
  });

  test('require.vision excludes a non-vision model', () => {
    const results = rankModels(
      [entry('text-only', { capabilities: caps({ vision: false }) })],
      { require: { vision: true } },
    );
    assert.equal(findResult(results, 'text-only').excluded_reason, 'require:vision');
  });

  test('require.max_latency_p50_ms excludes a model slower than the ceiling', () => {
    const results = rankModels(
      [entry('slow', { capabilities: caps({ latency_p50_ms: 9000 }) })],
      { require: { max_latency_p50_ms: 3000 } },
    );
    assert.equal(findResult(results, 'slow').excluded_reason, 'require:max_latency_p50_ms');
  });

  test('require.max_latency_p50_ms does NOT exclude a model with unknown (no traffic yet) latency', () => {
    const results = rankModels(
      [entry('unknown-latency', { capabilities: caps({ latency_p50_ms: null }) })],
      { require: { max_latency_p50_ms: 3000 } },
    );
    assert.equal(findResult(results, 'unknown-latency').excluded_reason, null);
  });

  // Card C5 negative control (the actual deliverable). Before the fix, an
  // unrecognized require key fell through `requireFailureReason()` to
  // `return null` (pass), which silently admitted every candidate: a filter
  // that looks enforced and enforces nothing. A test that only checked the
  // four known keys above stayed green through that entire defect, which is
  // exactly why it shipped. This asserts the opposite: a key the ranker does
  // not implement (e.g. the incoming trust-zone/sensitivity gating from card
  // N1) must exclude the candidate, and the reason must name the offending
  // key so an operator can see what happened, not silently admit it to a
  // free remote model the config asserts it cannot reach.
  test('an unimplemented require key excludes the candidate (fails closed, not silently)', () => {
    const results = rankModels(
      [entry('would-be-admitted', { capabilities: caps({ tool_use: { score: 1, basis: 'card' } }) })],
      { require: { sensitivity: 'secret' } },
    );
    const r = findResult(results, 'would-be-admitted');
    assert.equal(r.excluded_reason, 'require:unknown:sensitivity');
    assert.equal(r.score, null);
    assert.equal(r.rank, null);
  });

  test('a known require key alongside an unknown one still fails closed on the unknown key', () => {
    const results = rankModels(
      [entry('mixed', { capabilities: caps({ tool_use: { score: 1, basis: 'card' } }) })],
      { require: { tool_use: true, min_class: 'XL' } },
    );
    assert.equal(findResult(results, 'mixed').excluded_reason, 'require:unknown:min_class');
  });
});

describe('hard filters: allowlist + availability', () => {
  test('empty/absent allowlist admits everything (mirrors applyAllowlist semantics)', () => {
    const results = rankModels([entry('a'), entry('b')], {}, { allowlist: [] });
    assert.equal(findResult(results, 'a').excluded_reason, null);
    assert.equal(findResult(results, 'b').excluded_reason, null);
  });

  test('a non-empty allowlist excludes ids not on it', () => {
    const results = rankModels([entry('allowed'), entry('blocked')], {}, { allowlist: ['allowed'] });
    assert.equal(findResult(results, 'allowed').excluded_reason, null);
    assert.equal(findResult(results, 'blocked').excluded_reason, 'not_allowlisted');
  });

  test('isModelAvailable=false excludes with unavailable', () => {
    const results = rankModels([entry('down')], {}, { isModelAvailable: () => false });
    assert.equal(findResult(results, 'down').excluded_reason, 'unavailable');
  });

  test('no isModelAvailable injected assumes available (fail open, like isModelAvailable() itself)', () => {
    const results = rankModels([entry('unknown-avail')], {});
    assert.equal(findResult(results, 'unknown-avail').excluded_reason, null);
  });

  test('isModelAvailable is called with the model id', () => {
    const seen = [];
    rankModels([entry('probe-me')], {}, { isModelAvailable: (id) => { seen.push(id); return true; } });
    assert.deepEqual(seen, ['probe-me']);
  });
});

describe('sovereignty tiering: strict, never crossed by score', () => {
  test('a local candidate ranks ahead of a MUCH better-scoring free-remote candidate', () => {
    const local = entry('local-weak', {
      capabilities: caps({ sovereignty: 'local', reasoning: { score: 0.1, basis: 'prior' }, success_rate: 0.1 }),
    });
    const remote = entry('remote-strong', {
      capabilities: caps({ sovereignty: 'free-remote', reasoning: { score: 0.99, basis: 'ratings' }, success_rate: 0.99 }),
    });
    const results = rankModels([remote, local], { prefer: ['reasoning', 'success_rate'], tier: ['local', 'free-remote'] });
    const localR = findResult(results, 'local-weak');
    const remoteR = findResult(results, 'remote-strong');
    assert.ok(localR.rank < remoteR.rank, 'local should rank ahead of free-remote regardless of score');
  });

  test('a tier ladder that omits paid-cloud excludes paid-cloud candidates entirely', () => {
    const paid = entry('paid', { free: false, capabilities: caps({ sovereignty: 'paid-cloud' }) });
    const results = rankModels([paid], { tier: ['local', 'free-remote'] });
    assert.equal(findResult(results, 'paid').excluded_reason, 'tier:not_in_ladder');
  });

  test('with no tier ladder given, a sensible sovereign-first default still orders local ahead of paid-cloud', () => {
    const local = entry('local-x', { capabilities: caps({ sovereignty: 'local' }) });
    const paid = entry('paid-x', { free: false, capabilities: caps({ sovereignty: 'paid-cloud' }) });
    const results = rankModels([paid, local], {});
    assert.ok(findResult(results, 'local-x').rank < findResult(results, 'paid-x').rank);
  });

  test('ranks are a single contiguous 1..N sequence across tier buckets, in ladder order', () => {
    const a = entry('t-local', { capabilities: caps({ sovereignty: 'local' }) });
    const b = entry('t-remote', { capabilities: caps({ sovereignty: 'free-remote' }) });
    const c = entry('t-paid', { free: false, capabilities: caps({ sovereignty: 'paid-cloud' }) });
    const results = rankModels([c, b, a], { tier: ['local', 'free-remote', 'paid-cloud'] });
    assert.equal(findResult(results, 't-local').rank, 1);
    assert.equal(findResult(results, 't-remote').rank, 2);
    assert.equal(findResult(results, 't-paid').rank, 3);
  });
});

describe('basis-weighted scoring within a tier: empirical dominates priors', () => {
  test('a ratings-basis score beats a numerically higher prior-basis score', () => {
    const priorHigh = entry('prior-high', {
      capabilities: caps({ sovereignty: 'local', reasoning: { score: 0.9, basis: 'prior' } }),
    });
    const ratingsModerate = entry('ratings-moderate', {
      capabilities: caps({ sovereignty: 'local', reasoning: { score: 0.7, basis: 'ratings' } }),
    });
    const results = rankModels([priorHigh, ratingsModerate], { prefer: ['reasoning'], tier: ['local'] });
    const p = findResult(results, 'prior-high');
    const r = findResult(results, 'ratings-moderate');
    assert.ok(r.rank < p.rank, 'ratings-basis (weight 0.8) should outrank prior-basis (weight 0.3) despite a lower raw score');
  });

  test('eval-basis outranks ratings-basis at an equal raw score', () => {
    const evalEntry = entry('eval-basis', {
      capabilities: caps({ sovereignty: 'local', coding: { score: 0.6, basis: 'eval' } }),
    });
    const ratingsEntry = entry('ratings-basis', {
      capabilities: caps({ sovereignty: 'local', coding: { score: 0.6, basis: 'ratings' } }),
    });
    const results = rankModels([ratingsEntry, evalEntry], { prefer: ['coding'], tier: ['local'] });
    assert.ok(findResult(results, 'eval-basis').rank < findResult(results, 'ratings-basis').rank);
  });

  test('breakdown surfaces each prefer dimension with its value and basis', () => {
    const results = rankModels(
      [entry('breakdown-me', { capabilities: caps({ sovereignty: 'local', tool_use: { score: 1, basis: 'card' } }) })],
      { prefer: ['tool_use', 'reasoning'], tier: ['local'] },
    );
    const r = findResult(results, 'breakdown-me');
    assert.ok(r.breakdown);
    assert.equal(r.breakdown.tool_use.value, 1);
    assert.equal(r.breakdown.tool_use.basis, 'card');
    assert.ok('reasoning' in r.breakdown);
  });

  test('excluded candidates carry no breakdown', () => {
    const results = rankModels([entry('excluded-x', { lifecycle: eol() })], { prefer: ['reasoning'] });
    assert.equal(findResult(results, 'excluded-x').breakdown, null);
  });
});

describe('determinism and purity', () => {
  test('same inputs produce the same output on repeated calls', () => {
    const catalog = [
      entry('x', { capabilities: caps({ sovereignty: 'local', reasoning: { score: 0.4, basis: 'prior' } }) }),
      entry('y', { capabilities: caps({ sovereignty: 'local', reasoning: { score: 0.8, basis: 'ratings' } }) }),
      entry('z', { lifecycle: eol() }),
    ];
    const requirements = { require: { min_ctx: 1000 }, prefer: ['reasoning'], tier: ['local'] };
    const r1 = rankModels(catalog, requirements);
    const r2 = rankModels(catalog, requirements);
    assert.deepEqual(r1, r2);
  });

  test('does not mutate the input catalog', () => {
    const catalog = [entry('immutable-check')];
    const snapshot = JSON.parse(JSON.stringify(catalog));
    rankModels(catalog, { prefer: ['reasoning'] });
    assert.deepEqual(catalog, snapshot);
  });

  test('an injected now does not change the outcome (accepted for interface stability only)', () => {
    const catalog = [entry('now-agnostic')];
    const r1 = rankModels(catalog, {}, { now: () => 1000 });
    const r2 = rankModels(catalog, {}, { now: () => 999999999 });
    assert.deepEqual(r1, r2);
  });
});

describe('empty catalog', () => {
  test('returns an empty array', () => {
    assert.deepEqual(rankModels([], {}), []);
  });
});
