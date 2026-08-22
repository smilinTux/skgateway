import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { syncPiModels, updatePiConfig } from '../scripts/sync-pi-models.mjs';

test('updatePiConfig replaces only skgateway and sorts/deduplicates models', () => {
  const original = { providers: { direct: { apiKey: 'preserve-me' }, skgateway: { models: [{ id: 'old' }] } }, setting: 7 };
  const updated = updatePiConfig(original, ['sk-default', 'ornith-1.5-9b', 'sk-default'], 'http://gateway/');
  assert.deepEqual(updated.providers.direct, original.providers.direct);
  assert.equal(updated.setting, 7);
  assert.deepEqual(updated.providers.skgateway.models.map((m) => m.id), ['ornith-1.5-9b', 'sk-default']);
  assert.equal(updated.providers.skgateway.baseUrl, 'http://gateway/v1');
});

test('syncPiModels writes atomically and reports buckets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skgateway-pi-'));
  const path = join(dir, 'models.json');
  await writeFile(path, JSON.stringify({ providers: { direct: { models: [] } } }));
  const fetchFn = async () => ({ ok: true, json: async () => ({ data: [{ id: 'sk-auto' }, { id: 'model-a' }] }) });
  const result = await syncPiModels({ path, gatewayUrl: 'http://gateway', fetchFn });
  assert.deepEqual(result, { modelCount: 2, bucketCount: 1, changed: true, dryRun: false });
  const saved = JSON.parse(await readFile(path));
  assert.ok(saved.providers.direct);
  assert.deepEqual(saved.providers.skgateway.models.map((m) => m.id), ['model-a', 'sk-auto']);
});

test('dry-run and empty catalogs never alter the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skgateway-pi-'));
  const path = join(dir, 'models.json');
  const source = JSON.stringify({ providers: { direct: {} } });
  await writeFile(path, source);
  const good = async () => ({ ok: true, json: async () => ({ data: [{ id: 'sk-default' }] }) });
  await syncPiModels({ path, dryRun: true, fetchFn: good });
  assert.equal(await readFile(path, 'utf8'), source);
  const empty = async () => ({ ok: true, json: async () => ({ data: [] }) });
  await assert.rejects(syncPiModels({ path, fetchFn: empty }), /empty model list/);
  assert.equal(await readFile(path, 'utf8'), source);
});
