/**
 * generic-bucket-router-integration.test.mjs: router.mjs integration for
 * chi's unmerged generic bucket policy wiring (inventory item 6):
 *
 *   1. `routing.bucket_excluded_models` removes a model from GENERIC bucket
 *      membership, and the exclusion survives a simulated discovery refresh
 *      (the catalog cache is rewritten with the excluded model still present;
 *      it must stay excluded because the config fence is re-applied on
 *      every resolve, not baked into a one-time lifecycle flag).
 *   2. A generic bucket's member ordering actually uses
 *      `routing.generic_participation`'s weights end to end through
 *      `routeAndSend()`, not just in the pure `orderMembersByGenericWeight()`
 *      unit tests.
 *   3. The per-candidate-model transport-rejection check
 *      (`request-limits.mjs`, applied per candidate in the retry loop):
 *      a candidate whose resolved model has a tighter configured byte limit
 *      than the request is skipped in favor of a candidate that fits, and a
 *      request too large for every candidate's limit gets 413 with the
 *      conversation untouched, never an upstream call.
 *
 * Same fixture conventions as tests/bucket-routing-integration.test.mjs:
 * isolated FIX_DIR, every path-based store pinned before importing
 * router.mjs (which captures each as a module-level constant at import
 * time).
 *
 * Run with: node --test tests/generic-bucket-router-integration.test.mjs
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIX_DIR = mkdtempSync(join(tmpdir(), 'skgw-generic-bucket-router-'));
const REGISTRY_PATH = join(FIX_DIR, 'registry.yaml');
const STORE_PATH = join(FIX_DIR, 'model_catalog_store.json');
const CATALOG_CACHE_PATH = join(FIX_DIR, 'model_catalog_cache.json');
const CAPACITY_PATH = join(FIX_DIR, 'capacity_store.json');
process.env.SKMODELS_REGISTRY = REGISTRY_PATH;
process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = STORE_PATH;
process.env.SKGATEWAY_MODEL_CATALOG_CACHE_PATH = CATALOG_CACHE_PATH;
process.env.SKGATEWAY_CAPACITY_STORE_PATH = CAPACITY_PATH;

const { createRouter, routeAndSend } = await import('../src/proxy/router.mjs');
const { loadConfig } = await import('../src/config.mjs');
const { _resetCacheForTests } = await import('../src/discovery/model_catalog_store.mjs');

const HEADERS = { 'content-type': 'application/json' };
const bodyFor = (model, extra = {}) => Buffer.from(JSON.stringify({
  model, messages: [{ role: 'user', content: 'hi' }], ...extra,
}));

let _cfgSeq = 0;
function applyConfig({ buckets_enabled = true, generic_participation, bucket_excluded_models, model_limits } = {}) {
  const p = join(FIX_DIR, `gw-${_cfgSeq++}.yaml`);
  const lines = ['routing:', `  buckets_enabled: ${buckets_enabled}`];
  if (generic_participation) {
    lines.push('  generic_participation:');
    lines.push(`    providers: ${JSON.stringify(generic_participation.providers || {})}`);
  }
  if (bucket_excluded_models) {
    lines.push(`  bucket_excluded_models: ${JSON.stringify(bucket_excluded_models)}`);
  }
  if (model_limits) {
    lines.push('model_limits:');
    for (const [model, limits] of Object.entries(model_limits)) {
      lines.push(`  ${JSON.stringify(model)}:`);
      for (const [key, value] of Object.entries(limits)) lines.push(`    ${key}: ${value}`);
    }
  }
  writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  return loadConfig({ configPath: p, silent: true });
}

function startUpstream(name) {
  const state = { count: 0, status: 200, lastModel: null, lastBodyLen: 0 };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.endsWith('/models') && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        state.count++;
        const raw = Buffer.concat(chunks);
        state.lastBodyLen = raw.length;
        try { state.lastModel = JSON.parse(raw.toString('utf-8')).model ?? null; }
        catch { state.lastModel = null; }
        res.writeHead(state.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ served: name, model: state.lastModel }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ base: `http://127.0.0.1:${port}/v1`, state, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const parseBody = (r) => JSON.parse(r.body.toString('utf-8'));

describe('generic bucket policy wired into routeAndSend', () => {
  let zai, deepseek, kimi;

  before(async () => {
    zai = await startUpstream('zai');
    deepseek = await startUpstream('deepseek');
    kimi = await startUpstream('kimi');
  });

  after(async () => {
    await zai.close();
    await deepseek.close();
    await kimi.close();
  });

  beforeEach(() => {
    _resetCacheForTests();
    writeFileSync(STORE_PATH, JSON.stringify({}), 'utf8');
    writeFileSync(REGISTRY_PATH, 'roles:\ndefaults:\n  role: sk-default\n', 'utf8');
    for (const up of [zai, deepseek, kimi]) { up.state.count = 0; up.state.lastModel = null; up.state.lastBodyLen = 0; }
  });

  const CATALOG = [
    { id: 'zai-model', provider: 'zai', free: false, card: { tier: 'paid-cloud', size_class: 'M' } },
    { id: 'deepseek-model', provider: 'deepseek', free: false, card: { tier: 'paid-cloud', size_class: 'M' } },
  ];

  function makeRouter() {
    return createRouter({
      backends: {
        zaiBackend: { url: zai.base, auth_type: 'none', models: ['zai-model'], priority: 1 },
        deepseekBackend: { url: deepseek.base, auth_type: 'none', models: ['deepseek-model'], priority: 1 },
      },
    });
  }

  test('bucket_excluded_models removes a model from generic membership and survives a simulated discovery refresh', async () => {
    writeFileSync(CATALOG_CACHE_PATH, JSON.stringify({ models: CATALOG }), 'utf8');
    applyConfig({ bucket_excluded_models: ['deepseek-model'] });
    const router = makeRouter();

    for (let counter = 0; counter < 6; counter++) {
      const r = await routeAndSend(router, { model: 'sk-m', agentId: `excl-${counter}` },
        '/chat/completions', 'POST', HEADERS, bodyFor('sk-m'), false);
      assert.equal(r.status, 200);
      assert.notEqual(r.bucketMember, 'deepseek-model', 'the excluded model must never be selected');
    }
    assert.equal(deepseek.state.count, 0, 'the excluded model must never even receive a request');

    // Simulate a discovery refresh: the catalog cache is rewritten from
    // scratch with the excluded model present again (as a real re-fetch
    // would), and the config is untouched. The exclusion must still hold,
    // proving it is re-applied from config on every resolve, not a one-time
    // lifecycle flag that discovery could silently clear.
    _resetCacheForTests();
    writeFileSync(CATALOG_CACHE_PATH, JSON.stringify({ models: [...CATALOG] }), 'utf8');
    for (let counter = 0; counter < 6; counter++) {
      const r = await routeAndSend(router, { model: 'sk-m', agentId: `post-refresh-${counter}` },
        '/chat/completions', 'POST', HEADERS, bodyFor('sk-m'), false);
      assert.equal(r.status, 200);
      assert.notEqual(r.bucketMember, 'deepseek-model', 'the exclusion must survive the refresh');
    }
    assert.equal(deepseek.state.count, 0);
  });

  test('generic_participation weights are honored end to end: a disabled provider never serves a generic bucket', async () => {
    writeFileSync(CATALOG_CACHE_PATH, JSON.stringify({ models: CATALOG }), 'utf8');
    applyConfig({ generic_participation: { providers: { deepseek: { enabled: false } } } });
    const router = makeRouter();

    for (let counter = 0; counter < 8; counter++) {
      const r = await routeAndSend(router, { model: 'sk-m', agentId: `weight-${counter}` },
        '/chat/completions', 'POST', HEADERS, bodyFor('sk-m'), false);
      assert.equal(r.status, 200);
      assert.equal(r.bucketMember, 'zai-model', 'with deepseek policy-disabled, every request must land on zai');
    }
    assert.equal(zai.state.count, 8);
    assert.equal(deepseek.state.count, 0);
  });

  test('a focused provider bucket is unaffected by a generic policy disabling that same provider', async () => {
    writeFileSync(CATALOG_CACHE_PATH, JSON.stringify({ models: CATALOG }), 'utf8');
    applyConfig({ generic_participation: { providers: { deepseek: { enabled: false } } } });
    const router = makeRouter();
    const r = await routeAndSend(router, { model: 'sk-deepseek-m', agentId: 'focused-route' },
      '/chat/completions', 'POST', HEADERS, bodyFor('sk-deepseek-m'), false);
    assert.equal(r.status, 200, 'generic policy must not bleed into the focused provider route');
    assert.equal(r.bucketMember, 'deepseek-model');
  });

  test('per-candidate-model transport rejection: an oversized candidate is skipped, a fitting one still serves', async () => {
    writeFileSync(CATALOG_CACHE_PATH, JSON.stringify({ models: CATALOG }), 'utf8');
    applyConfig({
      generic_participation: { providers: { zai: { enabled: true, weight: 1 }, deepseek: { enabled: true, weight: 1 } } },
      model_limits: { 'deepseek-model': { max_body_bytes: 50 } },
    });
    const router = makeRouter();
    // A body well over deepseek-model's 50-byte configured ceiling but far
    // under the global default: whichever rotation picks deepseek-model
    // first must skip it (not 413 the whole request) and still reach zai.
    const bigBody = bodyFor('sk-m', { padding: 'x'.repeat(500) });
    let sawZai = false;
    for (let counter = 0; counter < 10 && !sawZai; counter++) {
      const r = await routeAndSend(router, { model: 'sk-m', agentId: `transport-${counter}` },
        '/chat/completions', 'POST', HEADERS, bigBody, false);
      if (r.status === 200 && r.bucketMember === 'zai-model') sawZai = true;
    }
    assert.ok(sawZai, 'at least one rotation must land on zai and succeed despite deepseek rejecting the oversized body');
    assert.equal(deepseek.state.count, 0, 'the oversized candidate must never actually reach the upstream');
  });

  test('per-candidate-model transport rejection: every candidate over limit yields 413 with history intact', async () => {
    writeFileSync(CATALOG_CACHE_PATH, JSON.stringify({ models: CATALOG }), 'utf8');
    applyConfig({
      model_limits: { 'zai-model': { max_body_bytes: 50 }, 'deepseek-model': { max_body_bytes: 50 } },
    });
    const router = makeRouter();
    const bigBody = bodyFor('sk-m', { padding: 'x'.repeat(500) });
    const r = await routeAndSend(router, { model: 'sk-m', agentId: 'transport-all-reject' },
      '/chat/completions', 'POST', HEADERS, bigBody, false);
    assert.equal(r.status, 413);
    const { error } = parseBody(r);
    assert.equal(error.code, 'request_too_large');
    assert.match(error.message, /history was not modified/);
    assert.equal(zai.state.count, 0);
    assert.equal(deepseek.state.count, 0);
  });
});
