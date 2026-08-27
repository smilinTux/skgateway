/**
 * provider-posture.test.mjs (card N2, coordination id f942d93b):
 * src/discovery/provider-posture.mjs, the loader for the overlay's
 * `providers:` block.
 *
 * Run with: node --test tests/provider-posture.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadProviderPostures, PROVIDER_POSTURE_PATH } from '../src/discovery/provider-posture.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'skgw-provider-posture-'));
let _seq = 0;
function freshPath() {
  return join(DIR, `overrides-${_seq++}.yaml`);
}

describe('loadProviderPostures', () => {
  test('reads the providers: block, keyed by provider name', () => {
    const path = freshPath();
    writeFileSync(path, `
overrides:
  some-model: { context_length: 1000 }
providers:
  anthropic: { data_retention: contractual-zero, verified: "2026-08-15", ref: "commercial terms" }
  nvidia: { data_retention: trains, verified: "2026-08-15" }
`);
    const providers = loadProviderPostures(path);
    assert.equal(providers.anthropic.data_retention, 'contractual-zero');
    assert.equal(providers.anthropic.verified, '2026-08-15');
    assert.equal(providers.nvidia.data_retention, 'trains');
  });

  test('yields {} when the file has no providers: key at all', () => {
    const path = freshPath();
    writeFileSync(path, 'overrides:\n  some-model: { context_length: 1000 }\n');
    assert.deepEqual(loadProviderPostures(path), {});
  });

  test('fail-soft: a missing file yields {} rather than throwing', () => {
    assert.deepEqual(loadProviderPostures(join(DIR, 'does-not-exist.yaml')), {});
  });

  test('fail-soft: malformed YAML yields {} rather than throwing', () => {
    const path = freshPath();
    writeFileSync(path, 'providers: [this, is, not, a, map\n');
    assert.deepEqual(loadProviderPostures(path), {});
  });

  test('fail-soft: a providers: value that is an array, not a map, yields {}', () => {
    const path = freshPath();
    writeFileSync(path, 'providers:\n  - nope\n');
    assert.deepEqual(loadProviderPostures(path), {});
  });

  test('the real committed overlay carries local/anthropic/nvidia/openrouter/opencode, all dated except local', () => {
    const providers = loadProviderPostures(PROVIDER_POSTURE_PATH);
    assert.equal(providers.local.data_retention, 'local-only');
    for (const name of ['anthropic', 'nvidia', 'openrouter', 'opencode', 'codex', 'zai']) {
      assert.ok(providers[name], `providers.${name} present`);
      assert.ok(providers[name].data_retention, `providers.${name}.data_retention set`);
      assert.ok(providers[name].verified, `providers.${name}.verified set (dated)`);
    }
  });
});
