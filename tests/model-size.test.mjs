/**
 * model-size.test.mjs (card N2, coordination id f942d93b):
 * src/discovery/model-size.mjs, the shared id-parsing + size_class
 * derivation used by nvidia.mjs and openrouter.mjs.
 *
 * Run with: node --test tests/model-size.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SIZE_CLASSES, parseParamsFromId, parseParamsFromDescription, deriveSizeClassFromParams } from '../src/discovery/model-size.mjs';

describe('SIZE_CLASSES', () => {
  test('is the Joule Economy S/M/L/XL enum, verbatim, in rank order', () => {
    assert.deepEqual(SIZE_CLASSES, ['S', 'M', 'L', 'XL']);
  });
});

describe('parseParamsFromId', () => {
  test('MoE id: total size + active params, org/ prefix stripped', () => {
    const r = parseParamsFromId('qwen/qwen3.5-397b-a17b');
    assert.equal(r.params_b, 397);
    assert.equal(r.active_params_b, 17);
  });

  test('MoE id with a trailing :free suffix (OpenRouter convention)', () => {
    const r = parseParamsFromId('nvidia/nemotron-3-ultra-550b-a55b:free');
    assert.equal(r.params_b, 550);
    assert.equal(r.active_params_b, 55);
  });

  test('dense id: params_b only, active_params_b null', () => {
    const r = parseParamsFromId('mistralai/mistral-large-3-675b-instruct-2512');
    assert.equal(r.params_b, 675);
    assert.equal(r.active_params_b, null);
  });

  test('dense id with a :free suffix', () => {
    const r = parseParamsFromId('nvidia/nemotron-nano-9b-v2:free');
    assert.equal(r.params_b, 9);
    assert.equal(r.active_params_b, null);
  });

  test('a version fragment like "3.5" never false-matches as a param count', () => {
    const r = parseParamsFromId('nvidia/nemotron-3.5-lightning-30b-a3b');
    assert.equal(r.params_b, 30);
    assert.equal(r.active_params_b, 3);
  });

  test('an id with no size token yields null/null, never a guess', () => {
    const r = parseParamsFromId('big-pickle');
    assert.equal(r.params_b, null);
    assert.equal(r.active_params_b, null);
  });

  test('nemotron-3-ultra-free (Zen id, no size token) also yields null/null', () => {
    const r = parseParamsFromId('nemotron-3-ultra-free');
    assert.equal(r.params_b, null);
    assert.equal(r.active_params_b, null);
  });

  test('fail-soft on non-string/empty input', () => {
    assert.deepEqual(parseParamsFromId(''), { params_b: null, active_params_b: null });
    assert.deepEqual(parseParamsFromId(null), { params_b: null, active_params_b: null });
    assert.deepEqual(parseParamsFromId(undefined), { params_b: null, active_params_b: null });
  });
});

describe('parseParamsFromDescription', () => {
  test('extracts total + active from the "<N>B active parameters out of <N>B total" phrasing', () => {
    const r = parseParamsFromDescription('an open mixture-of-experts model, with 55B active parameters out of 550B total (MoE).');
    assert.equal(r.params_b, 550);
    assert.equal(r.active_params_b, 55);
  });

  test('null/null when the phrasing is absent, never a broader free-text guess', () => {
    const r = parseParamsFromDescription('A fast, capable instruction-tuned model with 30B parameters.');
    assert.equal(r.params_b, null);
    assert.equal(r.active_params_b, null);
  });

  test('fail-soft on non-string/empty input', () => {
    assert.deepEqual(parseParamsFromDescription(''), { params_b: null, active_params_b: null });
    assert.deepEqual(parseParamsFromDescription(null), { params_b: null, active_params_b: null });
    assert.deepEqual(parseParamsFromDescription(undefined), { params_b: null, active_params_b: null });
  });
});

describe('deriveSizeClassFromParams', () => {
  test('anchor: a 9B dense model classes M (ornith-1.0-9b / nemotron-nano-9b-v2)', () => {
    assert.equal(deriveSizeClassFromParams(9), 'M');
  });

  test('anchor: a 35B dense model classes L (ornith-1.0-35b)', () => {
    assert.equal(deriveSizeClassFromParams(35), 'L');
  });

  test('anchor: a 675B dense model classes XL (mistral-large-3-675b)', () => {
    assert.equal(deriveSizeClassFromParams(675), 'XL');
  });

  test('a 550B MoE TOTAL count classes XL even though active is only 55B (design Q4: class by total)', () => {
    assert.equal(deriveSizeClassFromParams(550), 'XL');
  });

  test('null/non-finite/non-positive input never guesses a class', () => {
    assert.equal(deriveSizeClassFromParams(null), null);
    assert.equal(deriveSizeClassFromParams(undefined), null);
    assert.equal(deriveSizeClassFromParams(NaN), null);
    assert.equal(deriveSizeClassFromParams(0), null);
    assert.equal(deriveSizeClassFromParams(-5), null);
  });

  test('boundary values land on the documented side', () => {
    assert.equal(deriveSizeClassFromParams(4), 'S');
    assert.equal(deriveSizeClassFromParams(4.1), 'M');
    assert.equal(deriveSizeClassFromParams(20), 'M');
    assert.equal(deriveSizeClassFromParams(20.1), 'L');
    assert.equal(deriveSizeClassFromParams(100), 'L');
    assert.equal(deriveSizeClassFromParams(100.1), 'XL');
  });
});
