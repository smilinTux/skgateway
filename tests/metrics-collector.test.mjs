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

// ─────────────────────────────────────────────────────────────────────────────
// Latency percentiles + 3-sigma anomaly detection (card 27e00648)
// ─────────────────────────────────────────────────────────────────────────────

/** Feed one completed request with a known latency into the collector. */
function feed(collector, { backend, model, totalMs, statusCode = 200 }) {
  return collector.recordResponse({
    reqId: `r-${Math.random().toString(16).slice(2)}`,
    backend,
    model,
    totalMs,
    statusCode,
  });
}

/** Deterministic LCG PRNG so percentile tolerances never flake. */
function makeRng(seed = 0x2545f491) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

describe("latency percentiles (card 27e00648)", () => {
  test("P50/P95/P99 match a known uniform 1..1000 sample per backend/model", () => {
    // Metrics disabled → no db file; estimators still run in memory.
    const collector = createMetricsCollector({});
    // Feed a large uniform[1,1000] sample in random order — the P² algorithm is
    // designed for random-order streams (a monotonic feed is pathological).
    const rng = makeRng();
    const N = 20_000;
    for (let i = 0; i < N; i++) {
      const v = 1 + Math.floor(rng() * 1000); // uniform int in [1, 1000]
      feed(collector, { backend: "ornith", model: "sk-default", totalMs: v });
    }
    const { latency } = collector.getStats();
    const key = "ornith:sk-default";
    assert.ok(latency[key], "latency stats exposed under backend:model key");
    const { p50, p95, p99, count } = latency[key];

    assert.equal(count, N, "all samples counted");
    // P² is an approximation; allow a modest tolerance around the true quantiles
    // (true: p50≈500, p95≈950, p99≈990).
    assert.ok(Math.abs(p50 - 500) <= 30, `p50≈500 got ${p50}`);
    assert.ok(Math.abs(p95 - 950) <= 25, `p95≈950 got ${p95}`);
    assert.ok(Math.abs(p99 - 990) <= 20, `p99≈990 got ${p99}`);
    // Ordering invariant must always hold.
    assert.ok(p50 <= p95 && p95 <= p99, "p50 ≤ p95 ≤ p99");

    collector.close?.();
  });

  test("percentiles are tracked independently per backend/model key", () => {
    const collector = createMetricsCollector({});
    for (let i = 0; i < 200; i++) {
      feed(collector, { backend: "fast", model: "m", totalMs: 10 });
      feed(collector, { backend: "slow", model: "m", totalMs: 1000 });
    }
    const { latency } = collector.getStats();
    assert.ok(latency["fast:m"].p50 <= 20, "fast backend p50 low");
    assert.ok(latency["slow:m"].p50 >= 900, "slow backend p50 high");
    collector.close?.();
  });

  test("memory stays bounded: fixed key set + bounded anomaly ring under load", () => {
    const collector = createMetricsCollector({});
    // 60k samples: a jittery ~100ms baseline with a rare (1%) 10s spike. The
    // spikes stay a small enough fraction that the baseline mean/σ hold, so each
    // one trips 3-sigma — hundreds of anomalies, but the ring must never grow
    // past its bound.
    for (let i = 0; i < 60_000; i++) {
      const spike = i % 100 === 0 ? 10_000 : 100 + (i % 20);
      feed(collector, { backend: "b", model: "m", totalMs: spike });
    }
    const stats = collector.getStats();
    // Only ONE backend:model combo was ever used → exactly one latency key,
    // regardless of the 60k samples (O(1) state per key, not O(n)).
    assert.equal(Object.keys(stats.latency).length, 1, "key set bounded by cardinality, not sample count");
    // Anomaly ring is bounded (≤ 50) even though thousands of spikes occurred.
    assert.ok(stats.anomalies.length <= 50, `anomaly ring bounded, got ${stats.anomalies.length}`);
    assert.ok(collector.getAnomalies().length <= 50, "getAnomalies() bounded");
    // The per-key anomaly counter, by contrast, accumulates the true total.
    assert.ok(stats.latency["b:m"].anomalies > 50, "cumulative anomaly count exceeds ring size");
    collector.close?.();
  });
});

describe("3-sigma latency anomaly detection (card 27e00648)", () => {
  test("flags a single ≥3-sigma spike against a stable baseline", () => {
    const collector = createMetricsCollector({});
    // Stable baseline ~100ms (n ≥ ANOMALY_MIN_SAMPLES=30).
    for (let i = 0; i < 60; i++) {
      feed(collector, { backend: "ornith", model: "sk-default", totalMs: 100 + (i % 5) });
    }
    // One big spike → should be flagged and returned.
    const anomaly = feed(collector, { backend: "ornith", model: "sk-default", totalMs: 5_000 });

    assert.ok(anomaly, "recordResponse returns the anomaly record for a spike");
    assert.ok(anomaly.sigma >= 3, `sigma ≥ 3, got ${anomaly.sigma}`);
    assert.equal(anomaly.latencyMs, 5_000);
    assert.equal(anomaly.backend, "ornith");
    assert.equal(anomaly.model, "sk-default");

    const stats = collector.getStats();
    assert.ok(stats.latency["ornith:sk-default"].anomalies >= 1, "anomaly counted in stats");
    assert.ok(stats.anomalies.length >= 1, "anomaly surfaced in getStats().anomalies");
    assert.equal(collector.getAnomalies().at(-1).latencyMs, 5_000, "newest anomaly is the spike");
    collector.close?.();
  });

  test("does not flag before a baseline is established (< min samples)", () => {
    const collector = createMetricsCollector({});
    let flagged = 0;
    // Only 10 samples (< ANOMALY_MIN_SAMPLES) including a huge one — no baseline.
    for (let i = 0; i < 9; i++) {
      if (feed(collector, { backend: "b", model: "m", totalMs: 100 })) flagged++;
    }
    if (feed(collector, { backend: "b", model: "m", totalMs: 99_999 })) flagged++;
    assert.equal(flagged, 0, "no anomalies flagged before baseline is established");
    assert.equal(collector.getStats().anomalies.length, 0);
    collector.close?.();
  });

  test("does not flag normal in-distribution samples", () => {
    const collector = createMetricsCollector({});
    for (let i = 0; i < 40; i++) {
      feed(collector, { backend: "b", model: "m", totalMs: 100 + (i % 10) });
    }
    // Feed 40 more in-distribution samples — none should trip 3-sigma.
    let flagged = 0;
    for (let i = 0; i < 40; i++) {
      if (feed(collector, { backend: "b", model: "m", totalMs: 100 + (i % 10) })) flagged++;
    }
    assert.equal(flagged, 0, "steady-state traffic produces no anomalies");
    collector.close?.();
  });

  test("anomaly records are exposed through getStats() and getAnomalies()", () => {
    const collector = createMetricsCollector({});
    // Jittery baseline so the running σ is non-zero, then a clear spike.
    for (let i = 0; i < 40; i++) feed(collector, { backend: "b", model: "m", totalMs: 50 + (i % 7) });
    feed(collector, { backend: "b", model: "m", totalMs: 9_000 });

    const rec = collector.getAnomalies({ limit: 10 });
    assert.ok(rec.length >= 1);
    const a = rec.at(-1);
    for (const field of ["backend", "model", "key", "latencyMs", "mean", "stddev", "sigma", "ts"]) {
      assert.ok(field in a, `anomaly record exposes ${field}`);
    }
    assert.equal(a.key, "b:m");
    collector.close?.();
  });
});
