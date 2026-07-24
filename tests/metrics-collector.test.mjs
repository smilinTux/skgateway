/**
 * metrics-collector.test.mjs — regression tests for the metrics collector
 * config wiring (card 7e739811).
 *
 * Regression: `index.mjs` initialises the collector with
 * `createMetricsCollector(config.metrics || {})` (the already-extracted metrics
 * slice), but the factory used to dereference `config.metrics` a *second* time,
 * so `cfg` was `undefined` and `cfg.enabled` threw. The error was swallowed as
 * "optional", metrics silently never recorded, and `/status` reported
 * `metrics: null`. These tests construct the collector through the exact call
 * shapes used in production so this class of wiring bug cannot recur silently.
 *
 * Run with:  node --test tests/metrics-collector.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMetricsCollector } from "../src/metrics/collector.mjs";

/** Build a valid metrics-config slice pointing at a throwaway db file. */
function metricsCfg(dir, overrides = {}) {
  return {
    enabled: true,
    db_path: join(dir, "metrics.db"),
    retention_days: 90,
    token_tracking: true,
    cost_tracking: true,
    ...overrides,
  };
}

describe("createMetricsCollector — index.mjs call shape (card 7e739811)", () => {
  test("accepts the already-extracted metrics config and enables the db", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-metrics-"));
    let collector;
    try {
      // EXACT shape index.mjs uses: createMetricsCollector(config.metrics || {})
      // Pre-fix this threw a TypeError on `cfg.enabled` and was swallowed.
      collector = createMetricsCollector(metricsCfg(dir));

      assert.ok(collector, "collector should be created");
      assert.ok(collector.db, "db handle should be live when metrics enabled");
      assert.ok(existsSync(join(dir, "metrics.db")), "SQLite db file must exist");

      // getStats() must return a live object (not throw / not null).
      const stats = collector.getStats();
      assert.equal(typeof stats, "object");
      assert.equal(stats.totalRequests, 0);
    } finally {
      collector?.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("records a request through the enabled collector", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-metrics-"));
    let collector;
    try {
      collector = createMetricsCollector(metricsCfg(dir));
      const reqId = collector.recordRequest({
        agentId: "test",
        model: "sk-default",
        backend: "ornith",
        sessionId: "s1",
      });
      assert.ok(reqId, "recordRequest should return an id");
      assert.equal(collector.getStats().totalRequests, 1);
    } finally {
      collector?.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("empty config ({}) disables metrics without throwing", () => {
    // index.mjs falls back to `{}` when metrics config is absent.
    const collector = createMetricsCollector({});
    assert.ok(collector, "collector should still be created");
    assert.equal(collector.db, null, "db should be null when disabled");
    // getStats() must not throw even with metrics disabled.
    assert.doesNotThrow(() => collector.getStats());
    collector.close?.();
  });

  test("also accepts the full gateway config shape ({ metrics: {...} })", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-metrics-"));
    let collector;
    try {
      // Backward-compatible shape matching the factory's own docstring example.
      collector = createMetricsCollector({ metrics: metricsCfg(dir) });
      assert.ok(collector.db, "db should be live for full-config shape too");
    } finally {
      collector?.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
