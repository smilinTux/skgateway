import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createMetricsCollector } from '../src/metrics/collector.mjs';
import { loadConfig } from '../src/config.mjs';

// Cost tracking reads the price table via getConfig()/getPricing(), which throws
// "Config not loaded" until loadConfig() has run at least once in this process.
// Load pure DEFAULTS (bogus path -> no YAML overlay) so pricing stays
// deterministic and independent of any local config/skgateway.yaml. Same
// pattern as tests/metrics-collector.test.mjs.
await loadConfig({ configPath: '/nonexistent/skgw-wiring-test.yaml', silent: true });

// Characterisation test: proves recordRequest + recordResponse, called with the
// shapes the collector actually declares, populate token_usage and cost_log.
// The live path in index.mjs did neither, which is the bug this task fixes.
test('recordRequest then recordResponse populates token_usage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skgw-wiring-'));
  const dbPath = join(dir, 'metrics.db');
  // token_tracking must be explicit here: recordResponse only writes token_usage
  // when cfg.token_tracking is truthy. Production always sets it (src/config.mjs
  // defaults and config/skgateway.yaml both hardcode token_tracking: true), so this
  // mirrors the real call shape rather than adding a special case for the test.
  const c = createMetricsCollector({
    enabled: true, db_path: dbPath, token_tracking: true, cost_tracking: true,
  });

  const reqId = c.recordRequest({
    agentId: 'lumina', model: 'ornith-1.0-9b', backend: 'local', sessionId: 's1',
  });
  assert.ok(reqId, 'recordRequest must return a reqId');

  c.recordResponse({
    reqId,
    statusCode: 200,
    totalMs: 8370,
    responseHeaders: {},
    responseBody: { usage: { prompt_tokens: 51, completion_tokens: 600 } },
  });
  c.flush?.();

  const db = new Database(dbPath, { readonly: true });
  const tok = db.prepare('SELECT * FROM token_usage WHERE req_id = ?').get(reqId);
  const req = db.prepare('SELECT * FROM request_log WHERE id = ?').get(reqId);
  const cost = db.prepare('SELECT * FROM cost_log WHERE req_id = ?').get(reqId);
  db.close();
  c.close?.();
  rmSync(dir, { recursive: true, force: true });

  assert.ok(tok, 'token_usage must have a row');
  assert.equal(tok.output_tokens, 600);
  assert.equal(tok.agent_id, 'lumina');
  assert.equal(req.status_code, 200);
  assert.ok(cost, 'cost_log must have a row');
});
