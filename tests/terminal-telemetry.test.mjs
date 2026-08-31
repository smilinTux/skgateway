import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createMetricsCollector } from "../src/metrics/collector.mjs";
import { loadConfig } from "../src/config.mjs";

await loadConfig({ configPath: "/nonexistent/skgw-terminal-telemetry.yaml", silent: true });

function cfg(dir) {
  return {
    enabled: true,
    db_path: join(dir, "metrics.db"),
    retention_days: 90,
    token_tracking: true,
    cost_tracking: true,
  };
}

function withCollector(fn) {
  const dir = mkdtempSync(join(tmpdir(), "skgw-terminal-"));
  let collector;
  try {
    collector = createMetricsCollector(cfg(dir));
    fn(collector, join(dir, "metrics.db"));
  } finally {
    collector?.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("terminal row persists observed status, outcome, timings, tokens, and estimated cost truth", () => {
  withCollector((collector) => {
    const reqId = collector.recordRequest({ model: "claude-sonnet-4-6", backend: "cloud" });
    collector.recordResponse({
      reqId,
      statusCode: 201,
      firstByteMs: 250,
      totalMs: 1250,
      responseBody: { usage: { prompt_tokens: 1000, completion_tokens: 20 } },
    });

    const row = collector.getTerminalRequests().find((candidate) => candidate.id === reqId);
    assert.equal(row.status_code, 201);
    assert.equal(row.status_class, "2xx");
    assert.equal(row.terminal_state, "succeeded");
    assert.equal(row.first_byte_ms, 250);
    assert.equal(row.total_ms, 1250);
    assert.equal(row.input_tokens, 1000);
    assert.equal(row.output_tokens, 20);
    assert.equal(row.cost_truth, "estimated");
    assert.equal(typeof row.cost_usd, "number");
    assert.equal(row.generation_tps, 20);
  });
});

test("missing usage, status, first byte, and pricing stay unknown rather than zero", () => {
  withCollector((collector) => {
    const pendingId = collector.recordRequest({ model: "not-in-price-table" });
    collector.recordResponse({ reqId: pendingId, model: "not-in-price-table" });
    const row = collector.getTerminalRequests().find((candidate) => candidate.id === pendingId);
    assert.equal(row.status_code, null);
    assert.equal(row.status_class, null);
    assert.equal(row.terminal_state, "unknown");
    assert.ok(row.total_ms >= 0, "request timer supplies a measured total");
    assert.equal(row.first_byte_ms, null);
    assert.equal(row.input_tokens, null);
    assert.equal(row.output_tokens, null);
    assert.equal(row.cost_usd, null);
    assert.equal(row.cost_truth, "unknown");
    assert.equal(row.generation_tps, null);
  });
});

test("generation throughput requires output tokens and a positive generation interval", () => {
  withCollector((collector) => {
    const cases = [
      ["no-output", { firstByteMs: 10, totalMs: 20, responseBody: { usage: { prompt_tokens: 3 } } }],
      ["no-first-byte", { totalMs: 20, responseBody: { usage: { completion_tokens: 4 } } }],
      ["zero-interval", { firstByteMs: 20, totalMs: 20, responseBody: { usage: { completion_tokens: 4 } } }],
    ];
    const ids = [];
    for (const [name, values] of cases) {
      const reqId = collector.recordRequest({ model: name });
      ids.push([name, reqId]);
      collector.recordResponse({ reqId, statusCode: 200, ...values });
    }
    const rows = new Map(collector.getTerminalRequests().map((row) => [row.id, row]));
    for (const [name, reqId] of ids) assert.equal(rows.get(reqId).generation_tps, null, name);
  });
});

test("additive migration leaves legacy values null and reader reports unknown truth", () => {
  const dir = mkdtempSync(join(tmpdir(), "skgw-terminal-legacy-"));
  const path = join(dir, "metrics.db");
  let collector;
  try {
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE request_log (
        id TEXT PRIMARY KEY, agent_id TEXT, model TEXT, backend TEXT,
        session_id TEXT, started_at INTEGER NOT NULL, status_code INTEGER,
        first_byte_ms INTEGER, total_ms INTEGER, error_msg TEXT, model_served TEXT
      );
      INSERT INTO request_log (id, started_at) VALUES ('legacy', 1);
    `);
    legacy.close();

    collector = createMetricsCollector(cfg(dir));
    const row = collector.getTerminalRequests().find((candidate) => candidate.id === "legacy");
    assert.equal(row.terminal_state, "unknown");
    assert.equal(row.cost_truth, "unknown");
    for (const field of ["status_class", "total_ms", "first_byte_ms", "input_tokens", "output_tokens", "cost_usd", "generation_tps"]) {
      assert.equal(row[field], null, `${field} remains unknown`);
    }
  } finally {
    collector?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
