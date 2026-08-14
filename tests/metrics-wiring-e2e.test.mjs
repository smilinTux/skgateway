import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createMetricsCollector } from '../src/metrics/collector.mjs';
import { loadConfig } from '../src/config.mjs';
import { ANONYMOUS_AGENT_ID } from '../src/identity/capauth.mjs';

// End-to-end-shaped verification for the src/index.mjs proxy-branch fix.
//
// The brief's Step 4 wants proof against a live gateway on :18780, but that
// port is owned by a different checkout's running process and is not ours to
// restart. This test instead reproduces, line for line, the exact call shapes
// the new index.mjs code uses:
//   1. recordRequest() BEFORE dispatch, agentId from the same verified-identity
//      expression as routeRequest.agentId (identity.agent_id unless it's the
//      anonymous sentinel, else the raw X-Agent-Id header).
//   2. recordResponse() AFTER dispatch, with a `result` shaped exactly like
//      routeAndSend()'s return value: { status, headers, backendId,
//      body: Buffer }, JSON-parsed the same way index.mjs parses it.
// and asserts token_usage and cost_log actually receive rows keyed by the
// reqId recordRequest returned, which is the thing that was broken.
await loadConfig({ configPath: '/nonexistent/skgw-wiring-e2e-test.yaml', silent: true });

test('proxy-branch call shape: recordRequest before dispatch, recordResponse after, populates token_usage and cost_log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skgw-wiring-e2e-'));
  const dbPath = join(dir, 'metrics.db');
  const metrics = createMetricsCollector({
    enabled: true, db_path: dbPath, token_tracking: true, cost_tracking: true,
  });

  // ── stand-ins for the request-handler locals index.mjs closes over ──
  const identity = { agent_id: 'lumina' };          // verified CapAuth identity
  const req = { headers: { 'x-session-id': 'sess-42' } };
  const parsedModel = 'ornith-1.0-9b';

  // ── same expression as routeRequest.agentId / the new recordRequest call ──
  const agentIdExpr = () =>
    identity.agent_id !== ANONYMOUS_AGENT_ID ? identity.agent_id : (req.headers['x-agent-id'] || undefined);

  // 1. Open the record BEFORE dispatch (mirrors the new pre-routeRequest block).
  let metricsReqId = null;
  if (metrics) {
    metricsReqId = metrics.recordRequest({
      agentId: agentIdExpr(),
      model: parsedModel || 'unknown',
      backend: undefined,
      sessionId: req.headers['x-session-id'] || undefined,
    });
  }
  assert.ok(metricsReqId, 'recordRequest must return a reqId before dispatch');

  // ── stand-in for routeAndSend()'s return value ──
  const responsePayload = { usage: { prompt_tokens: 12, completion_tokens: 340 } };
  const result = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    backendId: 'nvidia',
    body: Buffer.from(JSON.stringify(responsePayload), 'utf8'),
  };
  const startTime = Date.now() - 250; // pretend the round trip took 250ms

  // 2. Close the record AFTER the client response is sent (mirrors the
  //    replaced :1411-1422 block).
  if (metrics && metricsReqId) {
    let parsedBody = null;
    try {
      parsedBody = result?.body ? JSON.parse(result.body.toString('utf8')) : null;
    } catch {
      parsedBody = null;
    }
    metrics.recordResponse({
      reqId: metricsReqId,
      statusCode: result?.status ?? 500,
      totalMs: Date.now() - startTime,
      responseHeaders: result?.headers ?? {},
      responseBody: parsedBody,
      agentId: agentIdExpr(),
      model: parsedModel || 'unknown',
      backend: result?.backendId,
    });
  }
  metrics.flush?.();

  const db = new Database(dbPath, { readonly: true });
  const req_row  = db.prepare('SELECT * FROM request_log WHERE id = ?').get(metricsReqId);
  const tok_row  = db.prepare('SELECT * FROM token_usage WHERE req_id = ?').get(metricsReqId);
  const cost_row = db.prepare('SELECT * FROM cost_log    WHERE req_id = ?').get(metricsReqId);
  db.close();
  metrics.close?.();
  rmSync(dir, { recursive: true, force: true });

  assert.ok(req_row, 'request_log must have a row for the reqId opened before dispatch');
  assert.equal(req_row.status_code, 200);
  assert.equal(req_row.agent_id, 'lumina');

  assert.ok(tok_row, 'token_usage must have a row (this was empty before the fix)');
  assert.equal(tok_row.input_tokens, 12);
  assert.equal(tok_row.output_tokens, 340);
  assert.equal(tok_row.agent_id, 'lumina');
  assert.equal(tok_row.model, 'ornith-1.0-9b');
  assert.equal(tok_row.backend, 'nvidia');

  assert.ok(cost_row, 'cost_log must have a row (this was empty before the fix)');
  assert.equal(cost_row.agent_id, 'lumina');
});

test('proxy-branch call shape: anonymous identity falls back to X-Agent-Id header, not left unattributed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skgw-wiring-e2e-anon-'));
  const dbPath = join(dir, 'metrics.db');
  const metrics = createMetricsCollector({
    enabled: true, db_path: dbPath, token_tracking: true, cost_tracking: true,
  });

  const identity = { agent_id: ANONYMOUS_AGENT_ID };
  const req = { headers: { 'x-agent-id': 'jarvis' } };
  const agentIdExpr = () =>
    identity.agent_id !== ANONYMOUS_AGENT_ID ? identity.agent_id : (req.headers['x-agent-id'] || undefined);

  const reqId = metrics.recordRequest({
    agentId: agentIdExpr(),
    model: 'ornith-1.0-9b',
    backend: undefined,
    sessionId: undefined,
  });
  metrics.recordResponse({
    reqId,
    statusCode: 200,
    totalMs: 100,
    responseHeaders: {},
    responseBody: { usage: { prompt_tokens: 1, completion_tokens: 1 } },
    agentId: agentIdExpr(),
    model: 'ornith-1.0-9b',
    backend: 'local',
  });
  metrics.flush?.();

  const db = new Database(dbPath, { readonly: true });
  const tok_row = db.prepare('SELECT * FROM token_usage WHERE req_id = ?').get(reqId);
  db.close();
  metrics.close?.();
  rmSync(dir, { recursive: true, force: true });

  assert.equal(tok_row.agent_id, 'jarvis');
});
