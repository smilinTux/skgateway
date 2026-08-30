/**
 * eval.test.mjs — card P3.5, the micro-eval harness.
 *
 * The battery itself already existed (capability-assessment.mjs, card C9's
 * measurement half: tool_call, structured_output, instruction_following,
 * min_output_tokens). Two things were missing, and together they meant it had
 * never produced a single fact in production:
 *
 *   1. NOTHING SUPPLIED `chatComplete`. probe.mjs takes it as an injected
 *      option and disables tier 2 when it is absent; no production caller ever
 *      passed one. The battery was dead code on this node.
 *   2. NOTHING READ THE RESULT. `deriveToolUse()` looked only at the provider
 *      card, so a measured pass/fail never reached `capabilities.tool_use`,
 *      which is what rank.mjs and (since the bucket tool gate) resolveBucket
 *      actually consume.
 *
 * Design 6.3: "Results land in capabilities.*.score with basis: 'eval'. This is
 * the only way tool_use: reliable becomes real; everything before it is
 * declared capability."
 *
 * Grading stays deterministic string/shape matching, never LLM-judged, so this
 * is a smoke test and not a benchmark (risk 6).
 *
 * Run with:  node --test tests/eval.test.mjs
 */

process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH ||= '/tmp/skgw-eval-test-store.json';

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';

import { deriveCapabilities } from '../src/ranking/capabilities.mjs';
import { buildCapabilityCatalog } from '../src/ranking/catalog.mjs';
import { runModelEval, isEvalEligible } from '../src/ranking/eval.mjs';
import { _resetCacheForTests } from '../src/discovery/model_catalog_store.mjs';

const STORE = process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH;

/** A measured record shaped like capability-assessment.mjs emits. */
const measuredRecord = (status) => ({
  tool_call: {
    capability: 'measured',
    status,
    assertion: 'capability.tool_call.v1',
    measured_at: 1_700_000_000_000,
    evidence: null,
  },
});

describe('measured tool_call reaches capabilities.tool_use', () => {
  test('a measured PASS scores 1 with basis eval', () => {
    const caps = deriveCapabilities({ id: 'm', card: {} }, { measured: measuredRecord('pass') });
    assert.equal(caps.tool_use.score, 1);
    assert.equal(caps.tool_use.basis, 'eval');
  });

  test('a measured FAIL scores 0 with basis eval, overriding a card that claims tools', () => {
    // The card is a provider CLAIM. The probe is evidence. Evidence wins, which
    // is the whole point of the harness.
    const card = { supported_parameters: ['tools'] };
    const declared = deriveCapabilities({ id: 'm', card });
    assert.equal(declared.tool_use.score, 1, 'precondition: the card alone would say yes');

    const caps = deriveCapabilities({ id: 'm', card }, { measured: measuredRecord('fail') });
    assert.equal(caps.tool_use.score, 0);
    assert.equal(caps.tool_use.basis, 'eval');
  });

  test('unmeasured falls back to the card, never inventing evidence', () => {
    const caps = deriveCapabilities(
      { id: 'm', card: { supported_parameters: ['tools'] } },
      { measured: measuredRecord('unmeasured') },
    );
    assert.equal(caps.tool_use.score, 1);
    assert.equal(caps.tool_use.basis, 'card');
  });

  test('no measured record at all is unchanged legacy behaviour', () => {
    const caps = deriveCapabilities({ id: 'm', card: { supported_parameters: ['tools'] } });
    assert.equal(caps.tool_use.basis, 'card');
  });
});

describe('buildCapabilityCatalog threads measured evidence through', () => {
  test('lifecycle.measured_capabilities reaches the derived vector', () => {
    // Without this wiring the harness writes facts nobody reads.
    const [entry] = buildCapabilityCatalog(
      [{ id: 'm', card: { supported_parameters: ['tools'] } }],
      {
        getLifecycleFn: () => ({ state: 'active', measured_capabilities: measuredRecord('fail') }),
        providers: null,
      },
    );
    assert.equal(entry.capabilities.tool_use.score, 0);
    assert.equal(entry.capabilities.tool_use.basis, 'eval');
  });
});

describe('isEvalEligible', () => {
  test('free and local models only, per design 6.3', () => {
    assert.equal(isEvalEligible({ capabilities: { sovereignty: 'local' } }), true);
    assert.equal(isEvalEligible({ capabilities: { sovereignty: 'free-remote' } }), true);
    assert.equal(isEvalEligible({ capabilities: { sovereignty: 'paid-cloud' } }), false);
  });

  test('unknown sovereignty is not eligible: never spend on an assumption', () => {
    assert.equal(isEvalEligible({ capabilities: {} }), false);
    assert.equal(isEvalEligible(null), false);
  });
});

describe('runModelEval', () => {
  beforeEach(() => {
    if (existsSync(STORE)) rmSync(STORE);
    // loadCatalogStore() memoizes per path. Drop it so each case starts from
    // disk, otherwise a previous case's in-memory store is what gets merged
    // and rewritten.
    _resetCacheForTests();
  });

  /** A fake completion runner that emits a well-formed tool_call. */
  const goodRunner = async (_id, req) => {
    if (Array.isArray(req.tools) && req.tools.length) {
      return {
        ok: true,
        status: 200,
        json: {
          choices: [{
            message: {
              role: 'assistant',
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: req.tools[0].function.name, arguments: '{"city":"Paris"}' },
              }],
            },
          }],
        },
      };
    }
    return { ok: true, status: 200, json: { choices: [{ message: { content: 'PONG' } }] } };
  };

  test('persists a measured record the store can read back', async () => {
    const out = await runModelEval('probe/model', { chatComplete: goodRunner, storePath: STORE });
    assert.equal(out.model, 'probe/model');
    assert.ok(out.measured_capabilities, 'returns what it measured');

    const persisted = JSON.parse(readFileSync(STORE, 'utf-8'));
    assert.ok(persisted['probe/model'].measured_capabilities.tool_call,
      'the record must survive in model_catalog_store.json, not just be returned');
  });

  test('a run does not clobber unrelated models in the store', async () => {
    writeFileSync(STORE, JSON.stringify({ 'other/model': { state: 'active' } }), 'utf-8');
    _resetCacheForTests(); // the write above bypassed the cache; re-read it
    await runModelEval('probe/model', { chatComplete: goodRunner, storePath: STORE });
    const persisted = JSON.parse(readFileSync(STORE, 'utf-8'));
    assert.ok(persisted['other/model'], 'a sibling record must survive the merge');
    assert.ok(persisted['probe/model']);
  });

  test('never auto-runs: importing the module completes no calls on its own', async () => {
    // Acceptance criterion: "Never runs in the hot path or refresh loop."
    let called = 0;
    const counting = async (...a) => { called += 1; return goodRunner(...a); };
    await import('../src/ranking/eval.mjs');
    assert.equal(called, 0, 'import must not trigger a battery');
    await runModelEval('probe/model', { chatComplete: counting, storePath: STORE });
    assert.ok(called > 0, 'and it must only run when explicitly invoked');
  });
});
