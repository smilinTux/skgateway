/**
 * model-address.test.mjs: card ce839ab2 / C11.
 *
 * The motivating incident: a lifecycle-store repair script's dry run would have
 * retired claude-opus-4-8, ornith-1.0-9b, qwen3.8-27b and others, all alive,
 * because they were "absent from NVIDIA's catalog". A bare model id carries no
 * provenance, so absence from a provider catalog read as evidence about models
 * that never came from one.
 *
 * The tests that matter here are the ambiguity ones. A naming scheme that
 * resolves a near-miss to something plausible is worse than no scheme, because
 * it mis-addresses silently.
 *
 * Run with:  node --test tests/model-address.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEPARATOR,
  parseModelAddress,
  isNamespaced,
  formatModelAddress,
  toUpstreamModel,
  addressMatches,
  withAddress,
} from '../src/policy/model-address.mjs';

const HOSTS = new Set(['nvidia', 'openrouter', 'opencode', 'chiap08-qwen38', 'local', 'anthropic']);

describe('C11: bare ids keep working, no flag day', () => {
  test('every shape a client sends today parses as bare', () => {
    for (const id of [
      'qwen3.8-27b',
      'openai/gpt-oss-20b',
      'nvidia/nemotron-nano-9b-v2',
      'liquid/lfm-2.5-2.6b:free',
      'claude-opus-4-8',
      'sk-default',
      'sk-l-internal',
    ]) {
      const a = parseModelAddress(id);
      assert.equal(a.host, null, `${id} must stay bare without a host hint`);
      assert.equal(a.model, id);
    }
  });

  test('a bare address matches on model id alone (today behavior)', () => {
    const entry = { id: 'openai/gpt-oss-20b', provider: 'nvidia' };
    assert.equal(addressMatches('openai/gpt-oss-20b', entry), true);
  });
});

describe('C11: the canonical separator cannot collide', () => {
  test('provider ids containing slashes still parse correctly', () => {
    const a = parseModelAddress(`nvidia${SEPARATOR}openai/gpt-oss-20b`);
    assert.deepEqual(a, { host: 'nvidia', model: 'openai/gpt-oss-20b', form: 'canonical' });
  });

  test('Chef\'s examples round-trip', () => {
    for (const [host, model] of [
      ['chiap08', 'qwen3.8-27b'],
      ['192.168.0.100', 'ornith-1.0-9b'],
    ]) {
      const s = formatModelAddress(host, model);
      assert.deepEqual(parseModelAddress(s), { host, model, form: 'canonical' });
    }
  });

  test('a malformed address does NOT half-resolve', () => {
    // An empty half is malformed, not an invitation to guess a host.
    for (const bad of [`${SEPARATOR}model-only`, `host-only${SEPARATOR}`]) {
      assert.equal(parseModelAddress(bad).host, null, `${bad} must not resolve a host`);
    }
  });
});

describe('C11: the single-slash form is resolved by LOOKUP, never by guessing', () => {
  test('a known backend prefix resolves', () => {
    const a = parseModelAddress('nvidia/nemotron-nano-9b-v2', { knownHosts: HOSTS });
    assert.deepEqual(a, { host: 'nvidia', model: 'nemotron-nano-9b-v2', form: 'slash' });
  });

  test('THE AMBIGUITY CASE: a vendor prefix is not a host', () => {
    // `openai/gpt-oss-20b` is served BY nvidia. `openai` is the model's vendor.
    // Guessing on the first slash would mis-address it to a host called openai
    // that does not exist, which is exactly the silent mis-addressing this card
    // exists to remove.
    const a = parseModelAddress('openai/gpt-oss-20b', { knownHosts: HOSTS });
    assert.equal(a.host, null, 'openai is not one of our backends, so this stays bare');
    assert.equal(a.model, 'openai/gpt-oss-20b');
  });

  test('without a host list the slash form is never assumed', () => {
    const a = parseModelAddress('nvidia/nemotron-nano-9b-v2');
    assert.equal(a.host, null, 'no lookup available means no guess');
  });
});

describe('C11: namespacing disambiguates a model served by several providers', () => {
  // Measured 2026-08-15: nine models are free from two or more providers.
  const viaNvidia = { id: 'openai/gpt-oss-20b', provider: 'nvidia' };
  const viaOpenRouter = { id: 'openai/gpt-oss-20b', provider: 'openrouter' };

  test('a namespaced address selects one door and rejects the other', () => {
    const addr = formatModelAddress('nvidia', 'openai/gpt-oss-20b');
    assert.equal(addressMatches(addr, viaNvidia), true);
    assert.equal(addressMatches(addr, viaOpenRouter), false);
  });

  test('a bare address still matches both, as it does today', () => {
    assert.equal(addressMatches('openai/gpt-oss-20b', viaNvidia), true);
    assert.equal(addressMatches('openai/gpt-oss-20b', viaOpenRouter), true);
  });

  test('the host must match the model, not merely be present', () => {
    assert.equal(addressMatches(formatModelAddress('opencode', 'openai/gpt-oss-20b'), viaNvidia), false);
  });
});

describe('C11: upstream never sees our internal host names', () => {
  test('the concrete model is what goes on the wire', () => {
    assert.equal(toUpstreamModel(`chiap08${SEPARATOR}qwen3.8-27b`), 'qwen3.8-27b');
    assert.equal(toUpstreamModel('qwen3.8-27b'), 'qwen3.8-27b');
    assert.equal(
      toUpstreamModel(`nvidia${SEPARATOR}openai/gpt-oss-20b`),
      'openai/gpt-oss-20b',
      'a provider has never heard of our backend names',
    );
  });
});

describe('C11: advertising is ADDITIVE', () => {
  test('id stays bare and address is added alongside', () => {
    const out = withAddress({ id: 'big-pickle', provider: 'opencode' });
    assert.equal(out.id, 'big-pickle', 'existing clients keep working unchanged');
    assert.equal(out.address, `opencode${SEPARATOR}big-pickle`);
  });

  test('an entry with no provider is passed through untouched', () => {
    const out = withAddress({ id: 'mystery' });
    assert.equal(out.address, undefined);
    assert.equal(out.id, 'mystery');
  });

  test('isNamespaced answers the question callers actually ask', () => {
    assert.equal(isNamespaced(`local${SEPARATOR}ornith-1.0-9b`), true);
    assert.equal(isNamespaced('ornith-1.0-9b'), false);
  });
});

describe('C11: the category error that motivated this card', () => {
  test('a namespaced local model is visibly not a provider-catalog model', () => {
    // The repair script asked "is this id absent from NVIDIA's catalog?" and a
    // bare `ornith-1.0-9b` could not answer "that question does not apply to
    // me". A namespaced one can, without any script-local special casing.
    const local = parseModelAddress(`chiap08-qwen38${SEPARATOR}qwen3.8-27b`, { knownHosts: HOSTS });
    assert.equal(local.host, 'chiap08-qwen38');
    assert.ok(
      !['nvidia', 'openrouter', 'opencode'].includes(local.host),
      'provenance is in the data, so catalog-absence logic cannot reach it by accident',
    );
  });
});
