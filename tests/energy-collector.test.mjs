import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createMetricsCollector } from '../src/metrics/collector.mjs';

function withCollector(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'skgw-energy-'));
  const dbPath = join(dir, 'metrics.db');
  const c = createMetricsCollector({ enabled: true, db_path: dbPath, cost_tracking: true });
  try { return fn(c, dbPath); } finally { c.close?.(); rmSync(dir, { recursive: true, force: true }); }
}

test('energy_log table is created on boot', () => {
  withCollector((c, dbPath) => {
    c.flush?.();
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='energy_log'"
    ).get();
    db.close();
    assert.ok(row, 'energy_log table should exist');
  });
});

test('recordEnergy writes a row with its basis', () => {
  withCollector((c, dbPath) => {
    c.recordEnergy({
      reqId: 'req-abc', agentId: 'lumina', model: 'ornith-1.0-9b',
      backend: 'local', cardId: 'a1b2c3d4', joules: 1713.2,
      basis: 'measured_gpu', node: 'dot100', concurrencyN: 1,
    });
    c.flush?.();
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT * FROM energy_log WHERE req_id = ?').get('req-abc');
    db.close();
    assert.equal(row.basis, 'measured_gpu');
    assert.equal(row.card_id, 'a1b2c3d4');
    assert.equal(row.backend, 'local');
    assert.ok(Math.abs(row.joules - 1713.2) < 0.01);
    assert.equal(row.concurrency_n, 1);
  });
});

test('recordEnergy accepts a null joules value without dropping the row', () => {
  // Unknown energy is a fact worth recording. A missing row would be
  // indistinguishable from a request that never happened.
  withCollector((c, dbPath) => {
    c.recordEnergy({
      reqId: 'req-unknown', model: 'mystery', backend: 'openrouter',
      joules: null, basis: 'imputed_cloud',
    });
    c.flush?.();
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT * FROM energy_log WHERE req_id = ?').get('req-unknown');
    db.close();
    assert.ok(row, 'row should exist even with null joules');
    assert.equal(row.joules, null);
    assert.equal(row.basis, 'imputed_cloud');
  });
});

test('recordEnergy never throws when metrics are disabled', () => {
  const c = createMetricsCollector({ enabled: false });
  assert.doesNotThrow(() => c.recordEnergy({ reqId: 'x', joules: 1, basis: 'measured_gpu' }));
});
