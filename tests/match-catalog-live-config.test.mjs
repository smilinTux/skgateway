/**
 * match-catalog-live-config.test.mjs: the END-TO-END control for the serving
 * config union, through the REAL router entry point with a REAL loaded config.
 *
 * WHY THIS IS A SEPARATE FILE. loadConfig() is a process-wide singleton and
 * router.mjs binds MATCH_CATALOG_CACHE_PATH at import time, so a suite that
 * both loads a config and asserts the no-config-loaded fail-closed branch would
 * depend on test declaration order to be correct. node:test runs each file in
 * its own process, so splitting removes the ordering hazard entirely. The
 * no-config branch is asserted in
 * tests/match-catalog-serving-config-union.test.mjs; this file is the loaded
 * one.
 *
 * WHY IT MATTERS AS A CONTROL. The sibling suite builds catalogs by passing
 * `backends` in, which is precise but is still an injection. This file injects
 * nothing: it writes a skgateway.yaml, calls the production loadConfig(), and
 * asks _buildMatchCatalogForTests() (the exact function the live @match and
 * bucket paths call) what it sees. On the unfixed code that answer is the
 * discovery cache and only the discovery cache, so ornith-1.5-9b and every
 * claude-* id are simply missing and every assertion below fails.
 *
 * Run with:  node --test --import ./tests/_setup.mjs tests/match-catalog-live-config.test.mjs
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIX_DIR = mkdtempSync(join(tmpdir(), 'skgw-match-live-cfg-'));
const CATALOG_CACHE_PATH = join(FIX_DIR, 'model_catalog_cache.json');
const CONFIG_PATH = join(FIX_DIR, 'skgateway.yaml');
process.env.SKGATEWAY_MODEL_CATALOG_CACHE_PATH = CATALOG_CACHE_PATH;

const { loadConfig } = await import('../src/config.mjs');
const { resolveBucket } = await import('../src/policy/buckets.mjs');
const { TRUST_ZONES } = await import('../src/policy/sensitivity.mjs');
const { _buildMatchCatalogForTests } = await import('../src/proxy/router.mjs');

// The serving backends this node actually declares, verbatim in YAML rather
// than as an injected object, so loadConfig()'s own parse/merge/validate path
// is the thing under test alongside the union.
const CONFIG_YAML = [
  'server:',
  '  port: 18780',
  'backends:',
  '  local:',
  '    url: http://192.168.0.100:8082/v1',
  '    auth_type: none',
  '    priority: 1',
  '    models: [ornith-1.5-9b]',
  '  chiap08-qwen38:',
  '    url: http://100.81.238.58:11439/v1',
  '    auth_type: none',
  '    priority: 2',
  '    models: [qwen3.8-27b-ud-q5_k_xl, qwen3.8-27b]',
  '  anthropic:',
  '    url: http://127.0.0.1:18782/v1',
  '    auth_type: none',
  '    priority: 3',
  '    models: [claude-opus-4-8, claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5]',
  '  nvidia:',
  '    url: https://integrate.api.nvidia.com/v1',
  '    auth_type: api_key',
  '    api_key_env: NVIDIA_API_KEY',
  '    priority: 4',
  '    models: [nvidia/llama-3.3-nemotron-super-49b-v1.5]',
  '',
].join('\n');

// What the cache really holds: cloud models, no sovereign id, no Claude id.
const DISCOVERY_CACHE = {
  models: [
    {
      id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
      provider: 'nvidia',
      free: true,
      stale: false,
      card: { source: 'heuristic', size_class: 'L' },
    },
    {
      id: 'deepseek/deepseek-r1:free',
      provider: 'openrouter',
      free: true,
      stale: false,
      card: { source: 'openrouter', size_class: 'XL' },
    },
  ],
};

before(async () => {
  writeFileSync(CATALOG_CACHE_PATH, JSON.stringify(DISCOVERY_CACHE), 'utf8');
  writeFileSync(CONFIG_PATH, CONFIG_YAML, 'utf8');
  await loadConfig({ configPath: CONFIG_PATH, silent: true });
});

const byId = (catalog) => Object.fromEntries(catalog.map((e) => [e.id, e]));

describe('the live match catalog, built from the real loaded config', () => {
  test('serves-implies-matches: ornith at zone 0 and Claude at zone 1, both with a usable class', () => {
    const cat = byId(_buildMatchCatalogForTests());

    assert.ok(cat['ornith-1.5-9b'], 'the sovereign model the fleet uses must be matchable');
    assert.equal(cat['ornith-1.5-9b'].capabilities.trust_zone, TRUST_ZONES.SOVEREIGN_LOCAL);
    assert.equal(cat['ornith-1.5-9b'].capabilities.size_class, 'M');

    assert.ok(cat['claude-opus-4-8'], 'a served Claude model must be matchable');
    assert.equal(cat['claude-opus-4-8'].capabilities.trust_zone, TRUST_ZONES.PAID_CONTRACTUAL);
    assert.equal(
      cat['claude-opus-4-8'].capabilities.size_class, 'XL',
      'the curated class must survive the union, or the model is present and still unusable',
    );

    // The cache half is untouched and still zone 2.
    assert.equal(cat['deepseek/deepseek-r1:free'].capabilities.trust_zone, TRUST_ZONES.FREE_REMOTE);
  });

  test('the internal and secret tiers resolve through the live path', () => {
    const catalog = _buildMatchCatalogForTests();

    const xlInternal = resolveBucket({ bucket: { model_class: 'XL', sensitivity: 'internal' }, catalog });
    assert.deepEqual(xlInternal.members.map((m) => m.id).sort(), ['claude-opus-4-7', 'claude-opus-4-8']);

    const lSecret = resolveBucket({ bucket: { model_class: 'L', sensitivity: 'secret' }, catalog });
    assert.ok(lSecret.members.length > 0, 'sk-l-secret must have an eligible member');
    for (const m of lSecret.members) assert.equal(m.trust_zone, TRUST_ZONES.SOVEREIGN_LOCAL);

    // NEGATIVE CONTROL, over the WIDER pool: no training provider may serve a
    // secret bucket at any floor, and the reason must be the zone.
    const trainingIds = catalog
      .filter((e) => ['nvidia', 'openrouter', 'opencode'].includes(e.provider))
      .map((e) => e.id);
    assert.ok(trainingIds.length > 0);
    for (const floor of ['S', 'M', 'L', 'XL']) {
      const { members, rejected } = resolveBucket({
        bucket: { model_class: floor, sensitivity: 'secret' }, catalog,
      });
      for (const id of trainingIds) {
        assert.ok(!members.some((m) => m.id === id), `${id} must never serve secret (floor ${floor})`);
        assert.match(rejected.find((x) => x.id === id).reason, /trust_zone/);
      }
    }
  });

  test('one entry per id even though the config declares an id the cache also holds', () => {
    const ids = _buildMatchCatalogForTests().map((e) => e.id);
    assert.equal(ids.length, new Set(ids).size);
    assert.equal(ids.filter((i) => i === 'nvidia/llama-3.3-nemotron-super-49b-v1.5').length, 1);
  });
});
