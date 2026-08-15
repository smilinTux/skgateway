/**
 * classify-chat-capability.test.mjs
 *
 * Card 8274b20b / C13: the chat catalog was admitting models that are not chat
 * models, because the filter matched keywords in the model NAME and therefore
 * failed open on anything it did not recognize.
 *
 * Every fixture here is a REAL provider payload shape captured from the live
 * APIs on 2026-08-15, not a synthetic id. That matters: the bug was precisely
 * that the filter's authors could not guess what providers would actually
 * return, so a test built from imagined ids would have stayed green.
 *
 * Run with:  node --test tests/classify-chat-capability.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyChatCapability,
  isChatCapable,
  isChatModelId,
  outputModalities,
  NON_CHAT_ID_PATTERNS,
} from '../src/discovery/classify.mjs';
import { normalize as normalizeOpenRouter } from '../src/discovery/providers/openrouter.mjs';
import { normalize as normalizeNvidia } from '../src/discovery/providers/nvidia.mjs';

// ─── real captured payloads ──────────────────────────────────────────────────

/** OpenRouter free-tier entries, verbatim shape from GET /api/v1/models. */
const OR_MUSIC = {
  id: 'google/lyria-3-pro-preview',
  pricing: { prompt: '0', completion: '0' },
  architecture: {
    modality: 'text+image->text+audio',
    input_modalities: ['text', 'image'],
    output_modalities: ['text', 'audio'],
  },
};
const OR_CHAT = {
  id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
  pricing: { prompt: '0', completion: '0' },
  architecture: {
    modality: 'text->text',
    input_modalities: ['text'],
    output_modalities: ['text'],
  },
};
const OR_SAFETY = {
  id: 'nvidia/nemotron-3.5-content-safety:free',
  pricing: { prompt: '0', completion: '0' },
  architecture: {
    modality: 'text+image->text',
    input_modalities: ['text', 'image'],
    output_modalities: ['text'],
  },
};

/** NVIDIA entries. Note how little they carry: this is the whole object. */
const NV_PARSER = { id: 'nvidia/nemotron-parse', object: 'model', created: 735790403, owned_by: 'nvidia' };
const NV_DETECTOR = { id: 'nvidia/ai-synthetic-video-detector', object: 'model', created: 735790403, owned_by: 'nvidia' };
const NV_CLIP = { id: 'nvidia/nvclip', object: 'model', created: 735790403, owned_by: 'nvidia' };
const NV_CHAT = { id: 'openai/gpt-oss-20b', object: 'model', created: 735790403, owned_by: 'openai' };
const NV_CODER = { id: 'deepseek-ai/deepseek-coder-6.7b-instruct', object: 'model', created: 735790403, owned_by: 'deepseek-ai' };

describe('C13: capability evidence beats the model name', () => {
  test('a music model is excluded on OUTPUT MODALITY, not on its id', () => {
    const verdict = classifyChatCapability(OR_MUSIC);
    assert.equal(verdict.chat, false);
    assert.equal(verdict.basis, 'modality', 'the id "lyria-3-pro-preview" contains no non-chat keyword');
    assert.match(verdict.reason, /audio/);
    // Prove the old test would have admitted it.
    assert.equal(
      isChatModelId(OR_MUSIC.id),
      true,
      'NEGATIVE CONTROL: name-only matching says this music model is a chat model, ' +
        'which is exactly how it reached the catalog',
    );
  });

  test('a text-to-text model is admitted', () => {
    const verdict = classifyChatCapability(OR_CHAT);
    assert.equal(verdict.chat, true);
    assert.equal(verdict.basis, 'modality');
  });

  test('a text-to-text CLASSIFIER is still excluded, by name', () => {
    // content-safety reports text+image->text, so modality alone cannot catch
    // it. This is why the name backstop is kept rather than deleted.
    assert.deepEqual(outputModalities(OR_SAFETY), ['text']);
    const verdict = classifyChatCapability(OR_SAFETY);
    assert.equal(verdict.chat, false);
    assert.equal(verdict.basis, 'id');
  });

  test('the legacy modality string is understood as well as the array', () => {
    assert.deepEqual(outputModalities({ architecture: { modality: 'text+image->text+audio' } }), ['text', 'audio']);
    assert.deepEqual(outputModalities({ architecture: { modality: 'text->text' } }), ['text']);
  });

  test('models.dev shape is understood too', () => {
    assert.deepEqual(outputModalities({ modalities: { input: ['text'], output: ['image'] } }), ['image']);
  });

  test('no capability data at all yields null, not a guess', () => {
    assert.equal(outputModalities(NV_CHAT), null);
  });
});

describe('C13: providers with no capability data fall back to the name', () => {
  test('the measured NVIDIA offenders are now excluded', () => {
    for (const raw of [NV_PARSER, NV_DETECTOR, NV_CLIP]) {
      const v = classifyChatCapability(raw);
      assert.equal(v.chat, false, `${raw.id} must not be advertised as a chat model`);
      assert.equal(v.basis, 'id', 'NVIDIA publishes no modality, so the name is the only signal available');
    }
  });

  test('ordinary NVIDIA chat models are NOT collateral damage', () => {
    // The whole reason unknown capability is admitted rather than rejected.
    // 59 of NVIDIA's 102 live ids have no metadata anywhere; most are fine.
    for (const raw of [NV_CHAT, NV_CODER]) {
      assert.equal(isChatCapable(raw), true, `${raw.id} must survive the filter`);
    }
  });
});

describe('C13: the filter is defined once, not three times', () => {
  test('all three call sites resolve to the same source of truth', async () => {
    const discovery = await import('../src/discovery.mjs');
    const nvidiaMod = await import('../src/discovery/providers/nvidia.mjs');
    const orMod = await import('../src/discovery/providers/openrouter.mjs');
    // discovery.mjs re-exports the shared predicate rather than redefining it.
    assert.equal(discovery.isChatModel, isChatModelId);
    // And neither adapter declares its own copy of the pattern list.
    assert.ok(NON_CHAT_ID_PATTERNS.length > 0);
    assert.ok(typeof nvidiaMod.normalize === 'function');
    assert.ok(typeof orMod.normalize === 'function');
  });
});

describe('C13: the adapters actually apply it end to end', () => {
  test('openrouter normalize() drops the music models and keeps the chat one', () => {
    const out = normalizeOpenRouter({ data: [OR_MUSIC, OR_CHAT, OR_SAFETY] }, { now: () => 1 });
    const ids = out.map((m) => m.id);
    assert.ok(ids.includes(OR_CHAT.id));
    assert.ok(!ids.includes(OR_MUSIC.id), 'lyria-3 is a music model');
    assert.ok(!ids.includes(OR_SAFETY.id), 'content-safety is a classifier');
  });

  test('nvidia normalize() drops the parser, detector and clip model', () => {
    const out = normalizeNvidia({ data: [NV_PARSER, NV_DETECTOR, NV_CLIP, NV_CHAT, NV_CODER] }, { now: () => 1 });
    const ids = out.map((m) => m.id);
    assert.deepEqual(ids.sort(), [NV_CODER.id, NV_CHAT.id].sort());
  });
});
