import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetch, normalize } from '../src/discovery/providers/anthropic-wrapper.mjs';

test('normalize keeps Claude chat IDs as paid anthropic models', () => {
  assert.deepEqual(normalize({ data: [
    { id: 'claude-sonnet-new' },
    { id: 'not-claude' },
  ]}), [{ id: 'claude-sonnet-new', provider: 'anthropic', free: false, card: null }]);
});

test('fetch authenticates against the wrapper models endpoint', async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, opts) => {
    seen = { url: String(url), opts };
    return { ok: true, json: async () => ({ data: [] }) };
  };
  try {
    await fetch('http://127.0.0.1:18782/v1', 'secret');
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.url, 'http://127.0.0.1:18782/v1/models');
  assert.equal(seen.opts.headers.authorization, 'Bearer secret');
});

test('fetch fails closed without the wrapper token', async () => {
  await assert.rejects(() => fetch('http://127.0.0.1:18782/v1', ''), /token is unset/);
});
