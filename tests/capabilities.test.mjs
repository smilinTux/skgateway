/**
 * capabilities.test.mjs (card P3.1): src/ranking/capabilities.mjs.
 *
 * Covers: card-derived dims (tool_use/vision/ctx_tokens) + their basis tags,
 * injected-metrics empirical dims (latency/success_rate), the reasoning/
 * coding priors-vs-ratings split via the REAL empirical.mjs modelStats() (a
 * temp ratings.jsonl fixture, not a mock, per "reuses modelStats(); does not
 * reimplement ratings parsing"), and sovereignty tiering via isLocalUrl().
 *
 * Run with:  node --test tests/capabilities.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveCapabilities } from '../src/ranking/capabilities.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'skgw-capabilities-'));
let _seq = 0;
function freshRatingsPath() {
  return join(DIR, `ratings-${_seq++}.jsonl`);
}

function writeRatings(path, rows) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

describe('tool_use', () => {
  test('basis card, score 1 when supported_parameters includes tools', () => {
    const card = { id: 'openrouter/x', card: { supported_parameters: ['tools', 'tool_choice'], source: 'openrouter' } };
    const caps = deriveCapabilities(card, {});
    assert.deepEqual(caps.tool_use, { score: 1, basis: 'card' });
  });

  test('basis card, score 0 when a real card declares no tools', () => {
    const card = { id: 'openrouter/y', card: { supported_parameters: ['structured_outputs'], source: 'openrouter' } };
    const caps = deriveCapabilities(card, {});
    assert.deepEqual(caps.tool_use, { score: 0, basis: 'card' });
  });

  test('basis heuristic (never card) when the card itself is a guess', () => {
    const card = { id: 'nvidia/qwen3.5-122b-a10b', card: { supported_parameters: [], source: 'heuristic' } };
    const caps = deriveCapabilities(card, {});
    assert.deepEqual(caps.tool_use, { score: 0, basis: 'heuristic' });
  });
});

describe('vision', () => {
  test('true for an image input modality', () => {
    const card = { id: 'openrouter/vl', card: { modality: 'text+image->text' } };
    assert.equal(deriveCapabilities(card, {}).vision, true);
  });

  test('false for a text-only modality', () => {
    const card = { id: 'openrouter/txt', card: { modality: 'text->text' } };
    assert.equal(deriveCapabilities(card, {}).vision, false);
  });

  test('an image OUTPUT-only model is not vision-input capable', () => {
    const card = { id: 'openrouter/gen', card: { modality: 'text->image' } };
    assert.equal(deriveCapabilities(card, {}).vision, false);
  });

  test('a direct boolean vision field (registry-style) wins over modality', () => {
    const card = { id: 'local/backend-model', card: { vision: true, modality: 'text->text' } };
    assert.equal(deriveCapabilities(card, {}).vision, true);
  });
});

describe('ctx_tokens', () => {
  test('from card.context_length', () => {
    const card = { id: 'openrouter/x', card: { context_length: 262144 } };
    assert.equal(deriveCapabilities(card, {}).ctx_tokens, 262144);
  });

  test('null when the card declares nothing (never guessed)', () => {
    const card = { id: 'nvidia/bare', card: {} };
    assert.equal(deriveCapabilities(card, {}).ctx_tokens, null);
  });
});

describe('latency_p50_ms / success_rate (empirical, injected)', () => {
  test('sourced straight from injected metrics', () => {
    const card = { id: 'nvidia/used-model', card: {} };
    const caps = deriveCapabilities(card, { metrics: { latency_p50_ms: 2400, success_rate: 0.98 } });
    assert.equal(caps.latency_p50_ms, 2400);
    assert.equal(caps.success_rate, 0.98);
  });

  test('null (no fabricated value) when metrics are absent', () => {
    const card = { id: 'nvidia/unused-model', card: {} };
    const caps = deriveCapabilities(card, {});
    assert.equal(caps.latency_p50_ms, null);
    assert.equal(caps.success_rate, null);
  });
});

describe('reasoning / coding: ratings vs prior (reuses empirical.mjs modelStats)', () => {
  test('basis ratings, normalized score, when the model has rated rows', () => {
    const path = freshRatingsPath();
    // mean = (5+3)/2 = 4 -> normalized (4-1)/4 = 0.75
    writeRatings(path, [
      { ts: 1, chat_id: 'c', msg_id: 1, model: 'nvidia/rated-model', prompt_class: 'reasoning', score: 5 },
      { ts: 2, chat_id: 'c', msg_id: 2, model: 'nvidia/rated-model', prompt_class: 'reasoning', score: 3 },
    ]);
    const card = { id: 'nvidia/rated-model', card: {} };
    const caps = deriveCapabilities(card, { ratings: { path } });
    assert.equal(caps.reasoning.basis, 'ratings');
    assert.equal(caps.reasoning.score, 0.75);
  });

  test('basis prior (never card) when there are no rated rows for this model', () => {
    const path = freshRatingsPath();
    writeRatings(path, [
      { ts: 1, chat_id: 'c', msg_id: 1, model: 'nvidia/someone-else', prompt_class: 'reasoning', score: 5 },
    ]);
    const card = { id: 'nvidia/plain-model', card: {} };
    const caps = deriveCapabilities(card, { ratings: { path } });
    assert.equal(caps.reasoning.basis, 'prior');
    assert.notEqual(caps.reasoning.basis, 'card');
    assert.equal(caps.coding.basis, 'prior');
    assert.notEqual(caps.coding.basis, 'card');
  });

  test('id-family prior boost: a "-thinking" id scores above the baseline reasoning prior', () => {
    const path = freshRatingsPath();
    writeRatings(path, []);
    const baseline = deriveCapabilities({ id: 'nvidia/plain-7b', card: {} }, { ratings: { path } });
    const boosted = deriveCapabilities({ id: 'qwen/qwen3.5-32b-thinking', card: {} }, { ratings: { path } });
    assert.equal(baseline.reasoning.basis, 'prior');
    assert.equal(boosted.reasoning.basis, 'prior');
    assert.ok(boosted.reasoning.score > baseline.reasoning.score);
  });

  test('id-family prior boost: a "-coder" id scores above the baseline coding prior', () => {
    const path = freshRatingsPath();
    writeRatings(path, []);
    const baseline = deriveCapabilities({ id: 'qwen/qwen3.5-32b-instruct', card: {} }, { ratings: { path } });
    const boosted = deriveCapabilities({ id: 'qwen/qwen3.5-32b-coder', card: {} }, { ratings: { path } });
    assert.ok(boosted.coding.score > baseline.coding.score);
  });

  test('NVIDIA heuristic-parsed variant fields drive the prior too (not just the raw id)', () => {
    const path = freshRatingsPath();
    writeRatings(path, []);
    const card = {
      id: 'qwen/qwen3.5-122b-a10b',
      card: { source: 'heuristic', variant: 'thinking', variants: ['thinking'] },
    };
    const caps = deriveCapabilities(card, { ratings: { path } });
    const plain = deriveCapabilities({ id: 'other/plain', card: {} }, { ratings: { path } });
    assert.ok(caps.reasoning.score > plain.reasoning.score);
  });

  test('no reasoning or coding score ever claims basis card', () => {
    const cases = [
      { id: 'openrouter/x', card: { supported_parameters: ['tools'], source: 'openrouter' } },
      { id: 'nvidia/y', card: { source: 'heuristic' } },
    ];
    for (const c of cases) {
      const caps = deriveCapabilities(c, {});
      assert.notEqual(caps.reasoning.basis, 'card');
      assert.notEqual(caps.coding.basis, 'card');
    }
  });
});

describe('sovereignty', () => {
  test('local: loopback/private serving url, free (or unspecified)', () => {
    const card = { id: 'ornith-tiny', provider: 'ornith', free: true, url: 'http://192.168.0.100:8082', card: {} };
    assert.equal(deriveCapabilities(card, {}).sovereignty, 'local');
  });

  test('free-remote: remote url, free discovery provider', () => {
    const card = { id: 'qwen/qwen3.5-122b-a10b', provider: 'nvidia', free: true, url: 'https://integrate.api.nvidia.com', card: {} };
    assert.equal(deriveCapabilities(card, {}).sovereignty, 'free-remote');
  });

  test('free-remote: no url at all (openrouter/nvidia cards carry none), free tag decides', () => {
    const card = { id: 'openrouter/free-model', provider: 'openrouter', free: true, card: {} };
    assert.equal(deriveCapabilities(card, {}).sovereignty, 'free-remote');
  });

  test('paid-cloud: not free, regardless of remote url', () => {
    const card = { id: 'anthropic/claude-x', provider: 'openrouter', free: false, url: 'https://openrouter.ai', card: {} };
    assert.equal(deriveCapabilities(card, {}).sovereignty, 'paid-cloud');
  });

  test('paid-cloud: a paid model tunnelled through a LOOPBACK wrapper is never reported local', () => {
    // e.g. the claude-code-api local wrapper (design 4.3): url is loopback,
    // but the model itself is a paid Anthropic family id, so free=false
    // (tagLocalModels() already folds isAnthropicModelId() into `free`).
    const card = { id: 'claude-sonnet-4-6', provider: 'claude-code-api', free: false, url: 'http://127.0.0.1:18782', card: {} };
    assert.equal(deriveCapabilities(card, {}).sovereignty, 'paid-cloud');
  });

  test('a curated card.tier is authoritative (static models carry no serving url)', () => {
    // local ornith is a static entry with no url, so isLocalUrl() cannot see
    // it; the operator-declared overlay tier decides so the local-first ladder
    // orders it correctly.
    const ornith = { id: 'ornith-1.0-35b', provider: 'ornith', free: true, card: { tier: 'local' } };
    assert.equal(deriveCapabilities(ornith, {}).sovereignty, 'local');
    const claude = { id: 'claude-opus-4-8', provider: 'anthropic', free: true, card: { tier: 'paid-cloud' } };
    assert.equal(deriveCapabilities(claude, {}).sovereignty, 'paid-cloud');
  });

  test('an invalid card.tier falls back to the url/free heuristic', () => {
    const card = { id: 'x', provider: 'nvidia', free: true, card: { tier: 'bogus' } };
    assert.equal(deriveCapabilities(card, {}).sovereignty, 'free-remote');
  });
});

describe('full shape', () => {
  test('returns every dimension the design specifies', () => {
    const card = {
      id: 'openrouter/full-example',
      provider: 'openrouter',
      free: true,
      card: {
        context_length: 131072,
        modality: 'text+image->text',
        supported_parameters: ['tools'],
        source: 'openrouter',
      },
    };
    const caps = deriveCapabilities(card, { metrics: { latency_p50_ms: 900, success_rate: 1 } });
    // One identifier per line, deliberately. Packed several to a line, this
    // list reads to gitleaks' generic-api-key heuristic as a quoted key sitting
    // next to a high-entropy value, and it failed the secret scan on every push
    // for hours. There is no secret here, only a sorted list of capability
    // field names. Do not re-pack it, and do not quote an example of the
    // offending shape in a comment either: the first attempt at this note did
    // exactly that and tripped the scanner a second time.
    assert.deepEqual(Object.keys(caps).sort(), [
      'coding',
      'ctx_tokens',
      'latency_p50_ms',
      'reasoning',
      'size_class',
      'sovereignty',
      'success_rate',
      'throughput_tps',
      'tool_use',
      'trust_zone',
      'vision',
    ]);
    assert.equal(caps.tool_use.score, 1);
    assert.equal(caps.tool_use.basis, 'card');
    assert.equal(caps.vision, true);
    assert.equal(caps.ctx_tokens, 131072);
    assert.equal(caps.latency_p50_ms, 900);
    assert.equal(caps.success_rate, 1);
    assert.equal(caps.sovereignty, 'free-remote');
    assert.ok(['ratings', 'prior'].includes(caps.reasoning.basis));
    assert.ok(['ratings', 'prior'].includes(caps.coding.basis));
    assert.equal(caps.size_class, null);
    assert.equal(caps.trust_zone, 2);
    assert.equal(caps.throughput_tps, null);
  });
});

describe('size_class (card N2)', () => {
  test('surfaced straight off the card when it is a valid S/M/L/XL value', () => {
    const card = { id: 'x', card: { size_class: 'XL' } };
    assert.equal(deriveCapabilities(card, {}).size_class, 'XL');
  });

  test('null when the card carries no size_class', () => {
    const card = { id: 'x', card: {} };
    assert.equal(deriveCapabilities(card, {}).size_class, null);
  });

  test('null when the card carries an invalid value (never passed through)', () => {
    const card = { id: 'x', card: { size_class: 'bogus' } };
    assert.equal(deriveCapabilities(card, {}).size_class, null);
  });

  test('distinguishes an XL free MoE model from a small free model, the concrete fleet test', () => {
    const ultra = { id: 'nvidia/nemotron-3-ultra-550b-a55b', provider: 'nvidia', free: true, card: { size_class: 'XL', params_b: 550, active_params_b: 55 } };
    const nano = { id: 'nvidia/nvidia-nemotron-nano-9b-v2', provider: 'nvidia', free: true, card: { size_class: 'M', params_b: 9 } };
    const ultraCaps = deriveCapabilities(ultra, {});
    const nanoCaps = deriveCapabilities(nano, {});
    assert.equal(ultraCaps.size_class, 'XL');
    assert.equal(nanoCaps.size_class, 'M');
    assert.notEqual(ultraCaps.size_class, nanoCaps.size_class);
  });
});

describe('trust_zone (card N2)', () => {
  test('zone 0: sovereignty local, regardless of any providers map', () => {
    const card = { id: 'ornith-1.0-9b', provider: 'local', free: true, card: { tier: 'local' } };
    assert.equal(deriveCapabilities(card, {}).trust_zone, 0);
  });

  test('zone 1: paid-cloud with a verified contractual-zero posture', () => {
    const card = { id: 'claude-opus-4-8', provider: 'anthropic', free: false, card: { tier: 'paid-cloud' } };
    const providers = { anthropic: { data_retention: 'contractual-zero', verified: '2026-08-15' } };
    assert.equal(deriveCapabilities(card, { providers }).trust_zone, 1);
  });

  test('zone 2: free-remote, any posture', () => {
    const card = { id: 'nvidia/x', provider: 'nvidia', free: true, card: { tier: 'free-remote' } };
    const providers = { nvidia: { data_retention: 'trains', verified: '2026-08-15' } };
    assert.equal(deriveCapabilities(card, { providers }).trust_zone, 2);
  });

  test('zone 2: paid-cloud but the posture is not contractual-zero (fail to least-trusted)', () => {
    const card = { id: 'x', provider: 'somepaid', free: false, card: { tier: 'paid-cloud' } };
    const providers = { somepaid: { data_retention: 'retains', verified: '2026-08-15' } };
    assert.equal(deriveCapabilities(card, { providers }).trust_zone, 2);
  });

  test('zone 2: paid-cloud with no providers map at all (missing signal fails to least-trusted)', () => {
    const card = { id: 'x', provider: 'somepaid', free: false, card: { tier: 'paid-cloud' } };
    assert.equal(deriveCapabilities(card, {}).trust_zone, 2);
  });

  test('a per-model card.data_retention override wins over the providers map', () => {
    const card = { id: 'x', provider: 'openrouter', free: false, card: { tier: 'paid-cloud', data_retention: 'contractual-zero' } };
    const providers = { openrouter: { data_retention: 'trains' } };
    assert.equal(deriveCapabilities(card, { providers }).trust_zone, 1);
  });

  test('anthropic-direct backend name resolves to the anthropic provider posture', () => {
    const card = { id: 'claude-opus-4-8', provider: 'anthropic-direct', free: false, card: { tier: 'paid-cloud' } };
    const providers = { anthropic: { data_retention: 'contractual-zero' } };
    assert.equal(deriveCapabilities(card, { providers }).trust_zone, 1);
  });
});

describe('throughput_tps (card N2, injected, measured)', () => {
  test('sourced straight from injected metrics', () => {
    const card = { id: 'x', card: {} };
    assert.equal(deriveCapabilities(card, { metrics: { throughput_tps: 42.5 } }).throughput_tps, 42.5);
  });

  test('null (never fabricated) when metrics are absent', () => {
    const card = { id: 'x', card: {} };
    assert.equal(deriveCapabilities(card, {}).throughput_tps, null);
  });
});
