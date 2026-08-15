/**
 * discovery-provider-routing.test.mjs
 *
 * A discovery provider whose models are ADVERTISED but not ROUTABLE is the
 * exact defect the 767adc4e epic exists to eliminate, and it was reintroduced
 * by adding a third provider.
 *
 * WHAT HAPPENED, 2026-08-15. OpenCode Zen (card 6cc8aac3 / C8) shipped a
 * complete adapter: it fetched, it filtered, it produced lifecycle records, and
 * its 7 free models appeared on GET /v1/models with correct cards. Every single
 * one returned 404 to a real completion, because `providerBackend()` hardcoded
 * "nvidia" and "openrouter" and returned null for anything else. So
 * `registerDiscoveredRoutes()` never wired those ids into any Backend.models,
 * and the router had nowhere to send them.
 *
 * Discovery, lifecycle and advertise were all correct. The catalog was still a
 * lie. That is the whole thesis of this epic in one bug: advertised is not the
 * same as reachable, and only an end-to-end assertion catches the difference.
 *
 * These tests pin the general rule (a discovery provider routes to the
 * configured backend of the same name) rather than the two names that happened
 * to be hardcoded, so provider number four needs no edit here.
 *
 * Run with:  node --test tests/discovery-provider-routing.test.mjs
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Importing src/index.mjs boots a server, so it needs an isolated config and
// an explicit close, matching tests/refresh-catalog-probe-wiring.test.mjs.
const INDEX = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.mjs');
const PORT = 18993, DASH = 18994;
let mod, tmpDir, registerDiscoveredRoutes;

/** A minimal stand-in for a router Backend. */
function fakeBackend() {
  return { models: [], supportsModel(id) { return this.models.includes(id); } };
}

/** Everything active, so lifecycle filtering never masks a routing failure. */
const allActive = () => ({ state: 'active' });

describe('a discovery provider routes to the configured backend of the same name', () => {
  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'skgw-provider-routing-'));
    const cfgPath = join(tmpDir, 'gw.yaml');
    const storePath = join(tmpDir, 'model_catalog_store.json');
    writeFileSync(storePath, '{}');
    writeFileSync(cfgPath, [
      'server:', '  bind: 127.0.0.1', `  port: ${PORT}`, `  dashboard_port: ${DASH}`,
      'dashboard:', `  port: ${DASH}`,
      'discovery:', '  enabled: false',
      'identity:', '  enabled: false',
      'backends:', '  local:', '    url: http://127.0.0.1:1/v1', '    auth_type: none',
      '    priority: 1', '    models: [routing-neutral]', '',
    ].join('\n'));
    process.env.SKGATEWAY_CONFIG = cfgPath;
    process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = storePath;
    mod = await import(pathToFileURL(INDEX).href);
    ({ registerDiscoveredRoutes } = mod);
  });

  after(() => {
    delete process.env.SKGATEWAY_CONFIG;
    delete process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH;
    try { mod.server.close(); } catch { /* best effort */ }
    try { mod.dashboard?.close?.(); } catch { /* best effort */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test('a THIRD provider is wired, not silently dropped (the C8 regression)', () => {
    const backends = { opencode: fakeBackend() };
    const cfg = { backends: { opencode: { url: 'https://opencode.ai/zen/v1', discovery: 'free' } } };
    const catalog = [
      { id: 'big-pickle', provider: 'opencode' },
      { id: 'nemotron-3-ultra-free', provider: 'opencode' },
    ];

    registerDiscoveredRoutes(cfg, catalog, {
      getBackend: (n) => backends[n],
      getLifecycleFn: allActive,
    });

    assert.deepEqual(
      backends.opencode.models.sort(),
      ['big-pickle', 'nemotron-3-ultra-free'],
      'an advertised model that no backend serves is a 404 waiting to happen',
    );
    assert.equal(backends.opencode.supportsModel('big-pickle'), true);
  });

  test('the two original providers are unchanged', () => {
    const backends = { nvidia: fakeBackend(), openrouter: fakeBackend() };
    const cfg = { backends: { nvidia: { models: ['openai/gpt-oss-20b'] }, openrouter: {} } };
    registerDiscoveredRoutes(
      cfg,
      [
        { id: 'meta/llama-3.1-8b-instruct', provider: 'nvidia' },
        { id: 'liquid/lfm-2.5-2.6b:free', provider: 'openrouter' },
      ],
      { getBackend: (n) => backends[n], getLifecycleFn: allActive },
    );
    // static config models union discovered ids, as before.
    assert.deepEqual(
      backends.nvidia.models.sort(),
      ['meta/llama-3.1-8b-instruct', 'openai/gpt-oss-20b'],
    );
    assert.deepEqual(backends.openrouter.models, ['liquid/lfm-2.5-2.6b:free']);
  });

  test('a provider with no configured backend routes nowhere, rather than inventing a destination', () => {
    const backends = { nvidia: fakeBackend() };
    const cfg = { backends: { nvidia: {} } };
    registerDiscoveredRoutes(
      cfg,
      [{ id: 'some/model', provider: 'not-configured-anywhere' }],
      { getBackend: (n) => backends[n], getLifecycleFn: allActive },
    );
    assert.deepEqual(backends.nvidia.models, [], 'must not leak into an unrelated backend');
  });

  test('NEGATIVE CONTROL: hardcoding only nvidia/openrouter would fail this', () => {
    // If providerBackend is reverted to the two-name ternary, `opencode` maps
    // to null, the ids are skipped, and models stays empty. This assertion is
    // the one that would have caught the live 404s.
    const backends = { opencode: fakeBackend() };
    const cfg = { backends: { opencode: {} } };
    registerDiscoveredRoutes(cfg, [{ id: 'big-pickle', provider: 'opencode' }], {
      getBackend: (n) => backends[n],
      getLifecycleFn: allActive,
    });
    assert.notDeepEqual(
      backends.opencode.models,
      [],
      'routing table is empty: providerBackend dropped a configured provider',
    );
  });

  test('lifecycle filtering still applies to a newly-wired provider', () => {
    const backends = { opencode: fakeBackend() };
    const cfg = { backends: { opencode: {} } };
    registerDiscoveredRoutes(
      cfg,
      [
        { id: 'big-pickle', provider: 'opencode' },
        { id: 'dead-one', provider: 'opencode' },
      ],
      {
        getBackend: (n) => backends[n],
        getLifecycleFn: (id) => ({ state: id === 'dead-one' ? 'eol' : 'active' }),
      },
    );
    assert.deepEqual(backends.opencode.models, ['big-pickle'], 'eol ids must not be routable');
  });
});
