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

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";
import { tmpdir } from "node:os";
import { createMetricsCollector } from "../src/metrics/collector.mjs";
import { loadConfig, getPricing } from "../src/config.mjs";

// Cost tests depend on the default price table via getConfig(). Load pure
// DEFAULTS (bogus path → no YAML overlay) so pricing is deterministic and
// independent of any local config/skgateway.yaml. Safe for the other suites.
await loadConfig({ configPath: "/nonexistent/skgw-cost-test.yaml", silent: true });

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

// ─────────────────────────────────────────────────────────────────────────────
// Cost tracking: $/request + per-agent/per-model aggregation (card 9bbcd420)
// ─────────────────────────────────────────────────────────────────────────────

/** Feed one completed request carrying an OpenAI-style usage body. */
function feedCost(collector, { agentId, model, backend = "b", usage, statusCode = 200 }) {
  return collector.recordResponse({
    reqId: `c-${Math.random().toString(16).slice(2)}`,
    agentId,
    model,
    backend,
    statusCode,
    responseBody: { usage },
  });
}

describe("cost tracking — price table (card 9bbcd420)", () => {
  test("getPricing: exact, prefix, priced-at-zero, and unpriced fallback", () => {
    // Exact match — flagged priced.
    const opus = getPricing("claude-opus-4-7");
    assert.equal(opus.input, 15.0);
    assert.equal(opus.output, 75.0);
    assert.equal(opus.unpriced, false);

    // Prefix match (e.g. a dated suffix not in the table verbatim).
    const sonnetPrefixed = getPricing("claude-sonnet-4-6-20260101");
    assert.equal(sonnetPrefixed.input, 3.0);
    assert.equal(sonnetPrefixed.unpriced, false);

    // A local backend deliberately priced at $0 is PRICED, not unpriced.
    const local = getPricing("moonshotai/kimi-k2.6");
    assert.equal(local.input, 0);
    assert.equal(local.unpriced, false);

    // A model absent from the table falls back to default_local AND is flagged.
    const unknown = getPricing("some-brand-new-model-xyz");
    assert.equal(unknown.input, 0);
    assert.equal(unknown.output, 0);
    assert.equal(unknown.unpriced, true);
  });
});

describe("cost tracking — Claude 5.5 price table (SKRSI P0.3, card c1844964)", () => {
  // Source: Anthropic published model pricing page (USD per MTok), fetched
  // 2026-11-12 from https://platform.claude.com/docs/en/about-claude/pricing
  // (docs.claude.com redirects there). cache_write is the 5m write rate.
  // Haiku 5.5 is tiered by prompt size; the table is flat, so the up-to-100k
  // tier is recorded.
  const PUBLISHED = {
    "claude-fable-5-2":   { input: 8.0, output: 40.0, cache_read: 0.20, cache_write: 10.0 },
    "claude-opus-5-5":    { input: 4.0, output: 20.0, cache_read: 0.20, cache_write: 5.0 },
    "claude-sonnet-5-5":  { input: 2.0, output: 10.0, cache_read: 0.10, cache_write: 2.5 },
    "claude-haiku-5-5":   { input: 0.10, output: 0.50, cache_read: 0.01, cache_write: 0.125 },
  };

  test("getPricing: every Claude 5.5 id is priced at the published rate", () => {
    for (const [model, want] of Object.entries(PUBLISHED)) {
      const p = getPricing(model);
      assert.equal(p.unpriced, false, `${model} must not be unpriced`);
      for (const k of Object.keys(want)) assert.equal(p[k], want[k], `${model}.${k}`);
      // A dated suffix resolves through the prefix match to the same entry.
      assert.equal(getPricing(`${model}-20261112`).unpriced, false, `${model} dated`);
    }
  });

  test("YAML price tables carry the same Claude 5.5 entries as the defaults", () => {
    for (const file of ["config/skgateway.yaml", "config/skgateway.yaml.example"]) {
      const doc = yamlLoad(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
      const table = doc.metrics.pricing;
      for (const [model, want] of Object.entries(PUBLISHED)) {
        for (const k of Object.keys(want)) assert.equal(table[model]?.[k], want[k], `${file} ${model}.${k}`);
      }
    }
  });

  test("cost matches a hand-computed value for opus-5-5 and sonnet-5-5", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-cost55-"));
    let collector;
    try {
      collector = createMetricsCollector(metricsCfg(dir));
      // opus-5-5: 200k in * 4 + 100k out * 20 + 500k cache_read * 0.20 + 40k cache_write * 5
      //   = 0.80 + 2.00 + 0.10 + 0.20 = 3.10
      feedCost(collector, {
        agentId: "opus", model: "claude-opus-5-5",
        usage: {
          input_tokens: 200_000, output_tokens: 100_000,
          cache_read_input_tokens: 500_000, cache_creation_input_tokens: 40_000,
        },
      });
      assert.ok(Math.abs(collector.getStats().totalCostUsd - 3.10) < 1e-9);
      // sonnet-5-5: 1M in * 2 + 1M out * 10 = 12.00
      feedCost(collector, {
        agentId: "opus", model: "claude-sonnet-5-5",
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      });
      assert.ok(Math.abs(collector.getStats().totalCostUsd - 15.10) < 1e-9);
    } finally {
      collector?.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cost tracking — per-request cost from tokens × price (card 9bbcd420)", () => {
  test("cost matches manual calculation (tokens/1e6 × price)", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-cost-"));
    let collector;
    try {
      collector = createMetricsCollector(metricsCfg(dir));
      // 1M input + 1M output on sonnet ($3 in / $15 out per 1M) → $18.00 exactly.
      feedCost(collector, {
        agentId: "lumina", model: "claude-sonnet-4-6",
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
      });
      const s = collector.getStats();
      assert.ok(Math.abs(s.totalCostUsd - 18.0) < 1e-9, `expected $18.00, got ${s.totalCostUsd}`);

      // A second request with cache tokens too. opus: in 15, out 75, cache_read
      // 1.50, cache_write 3.75. 200k in / 100k out / 500k cache_read / 40k cache_write.
      feedCost(collector, {
        agentId: "opus", model: "claude-opus-4-7",
        usage: {
          input_tokens: 200_000, output_tokens: 100_000,
          cache_read_input_tokens: 500_000, cache_creation_input_tokens: 40_000,
        },
      });
      const expected2 =
        (200_000 / 1e6) * 15.0 +   // 3.00
        (100_000 / 1e6) * 75.0 +   // 7.50
        (500_000 / 1e6) * 1.5 +    // 0.75
        (40_000  / 1e6) * 3.75;    // 0.15  → 11.40
      const s2 = collector.getStats();
      assert.ok(Math.abs(s2.totalCostUsd - (18.0 + expected2)) < 1e-9,
        `expected ${18.0 + expected2}, got ${s2.totalCostUsd}`);
    } finally {
      collector?.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("OpenAI cached prompt tokens use the cache-read rate only", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-cache-cost-"));
    let collector;
    try {
      collector = createMetricsCollector(metricsCfg(dir));
      feedCost(collector, {
        agentId: "lumina", model: "claude-sonnet-4-6",
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 800_000 },
        },
      });
      const row = collector.getCosts({ agentId: "lumina" })[0];
      assert.ok(Math.abs(row.input_cost - 0.6) < 1e-9);
      assert.ok(Math.abs(row.cache_read_cost - 0.24) < 1e-9);
      assert.ok(Math.abs(row.total_cost - 0.84) < 1e-9);
    } finally {
      collector?.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("streamed OpenAI usage is retained for token and cost sensing", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-stream-cost-"));
    let collector;
    try {
      collector = createMetricsCollector(metricsCfg(dir));
      const reqId = collector.recordRequest({ agentId: "lumina", model: "claude-sonnet-4-6" });
      const sse = Buffer.from([
        'data: {"model":"served","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}',
        'data: {"model":"served","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
      collector.recordResponse({ reqId, statusCode: 200, responseBody: sse });
      collector.flush();
      const row = collector.db.prepare("SELECT * FROM token_usage WHERE req_id = ?").get(reqId);
      assert.equal(row.input_tokens, 10);
      assert.equal(row.output_tokens, 5);
    } finally {
      collector?.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cost tracking — per-agent / per-model aggregation (card 9bbcd420)", () => {
  test("in-memory breakdown groups spend by agent and by model", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-cost-"));
    let collector;
    try {
      collector = createMetricsCollector(metricsCfg(dir));
      // lumina: 2 sonnet calls, 1M+1M each → $18 each → $36.
      feedCost(collector, { agentId: "lumina", model: "claude-sonnet-4-6",
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } });
      feedCost(collector, { agentId: "lumina", model: "claude-sonnet-4-6",
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } });
      // opus: 1 opus call, 1M in only → $15.
      feedCost(collector, { agentId: "opus", model: "claude-opus-4-7",
        usage: { input_tokens: 1_000_000, output_tokens: 0 } });

      const s = collector.getStats();

      // Per-agent
      assert.ok(Math.abs(s.costByAgent.lumina.costUsd - 36.0) < 1e-9, `lumina $36, got ${s.costByAgent.lumina.costUsd}`);
      assert.equal(s.costByAgent.lumina.requests, 2);
      assert.ok(Math.abs(s.costByAgent.opus.costUsd - 15.0) < 1e-9, `opus $15, got ${s.costByAgent.opus.costUsd}`);
      assert.equal(s.costByAgent.opus.requests, 1);

      // Per-model
      assert.ok(Math.abs(s.costByModel["claude-sonnet-4-6"].costUsd - 36.0) < 1e-9);
      assert.equal(s.costByModel["claude-sonnet-4-6"].requests, 2);
      assert.ok(Math.abs(s.costByModel["claude-opus-4-7"].costUsd - 15.0) < 1e-9);

      // Grand total ties out.
      assert.ok(Math.abs(s.totalCostUsd - 51.0) < 1e-9, `total $51, got ${s.totalCostUsd}`);

      // SQLite aggregation (getCosts) agrees per agent.
      const rows = collector.getCosts({ agentId: "lumina" });
      const luminaTotal = rows.reduce((a, r) => a + r.total_cost, 0);
      assert.ok(Math.abs(luminaTotal - 36.0) < 1e-9, `getCosts lumina $36, got ${luminaTotal}`);
    } finally {
      collector?.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cost tracking — unknown model handling (card 9bbcd420)", () => {
  test("unknown model is priced at $0 and flagged unpriced", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-cost-"));
    let collector;
    try {
      collector = createMetricsCollector(metricsCfg(dir));
      feedCost(collector, { agentId: "lumina", model: "mystery-model-99",
        usage: { input_tokens: 500_000, output_tokens: 500_000 } });
      // Plus a priced call so we can prove the flag is per-key, not global.
      feedCost(collector, { agentId: "lumina", model: "claude-sonnet-4-6",
        usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 } });

      const s = collector.getStats();
      assert.equal(s.unpricedRequests, 1, "one unpriced request counted");
      // Unknown model contributes $0 to the total → total is just the sonnet $18.
      assert.ok(Math.abs(s.totalCostUsd - 18.0) < 1e-9, `total $18, got ${s.totalCostUsd}`);
      assert.equal(s.costByModel["mystery-model-99"].unpriced, true, "unknown model flagged unpriced");
      assert.equal(s.costByModel["mystery-model-99"].costUsd, 0);
      assert.equal(s.costByModel["claude-sonnet-4-6"].unpriced, false, "priced model not flagged");
    } finally {
      collector?.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cost tracking — bounded memory + /status exposure (card 9bbcd420)", () => {
  test("cost breakdown is exposed via getStats() (the /status surface)", () => {
    const collector = createMetricsCollector({ enabled: false, token_tracking: true, cost_tracking: true });
    feedCost(collector, { agentId: "a1", model: "claude-sonnet-4-6",
      usage: { input_tokens: 1_000_000, output_tokens: 0 } });
    const s = collector.getStats();
    // These are the fields /status (index.mjs) serializes from metrics.getStats().
    assert.ok("costByAgent" in s && "costByModel" in s && "unpricedRequests" in s,
      "getStats exposes cost breakdown fields");
    assert.ok(Math.abs(s.costByAgent.a1.costUsd - 3.0) < 1e-9);
    collector.close?.();
  });

  test("per-key breakdown stays bounded under high key cardinality", () => {
    const collector = createMetricsCollector({ enabled: false, token_tracking: true, cost_tracking: true });
    // 5000 distinct agents → far above MAX_COST_KEYS(200). Overflow folds to "_other".
    for (let i = 0; i < 5000; i++) {
      feedCost(collector, { agentId: `agent-${i}`, model: "claude-sonnet-4-6",
        usage: { input_tokens: 1_000, output_tokens: 0 } });
    }
    const s = collector.getStats();
    const keys = Object.keys(s.costByAgent);
    assert.ok(keys.length <= 201, `bounded key set (≤200 + _other), got ${keys.length}`);
    assert.ok(keys.includes("_other"), "overflow keys folded into _other bucket");
    // No spend is lost to the bound: total across the breakdown ties to grand total.
    const sumAgents = Object.values(s.costByAgent).reduce((a, v) => a + v.costUsd, 0);
    assert.ok(Math.abs(sumAgents - s.totalCostUsd) < 1e-6, "bounded breakdown conserves total spend");
    collector.close?.();
  });
});

// ─── error_msg on every failed terminal row (card 9fbca169 / SKRSI P0.2) ─────
//
// The live sk-default 502s could not be explained from metrics.db because every
// one of them had error_msg NULL: only the paths where routeAndSend THREW set
// it. A relayed upstream failure, an exhausted failover chain and a gateway-made
// 404 all close the row through the non-throwing branch, which passed no
// errorMsg. These tests boot the REAL gateway against a stub upstream and read
// the terminal request_log row for each failure path.
//
// error_msg carries an error CLASS and the UPSTREAM STATUS, never a response
// body: the stub's error body holds a marker string that must never reach the
// row.

const BODY_MARKER = "P02-UPSTREAM-BODY-MUST-NOT-BE-LOGGED";
const INDEX = new URL("../src/index.mjs", import.meta.url).pathname;

function p02FreePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/** Stub upstream: fails by model id, answers 200 otherwise. */
function p02StartUpstream() {
  return new Promise((res) => {
    const server = http.createServer((req, r) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        const fail = { "p02-fail502": 502, "p02-failover": 503 }[parsed.model];
        if (fail) {
          r.writeHead(fail, { "content-type": "application/json" });
          r.end(JSON.stringify({ error: { message: `${BODY_MARKER} upstream detail`, code: "boom" } }));
          return;
        }
        // p02-empty200: the upstream answers 200 with no visible content, which
        // the response contract rewrites to a client-facing 502.
        const content = parsed.model === "p02-empty200" ? "" : "ok";
        r.writeHead(200, { "content-type": "application/json" });
        r.end(JSON.stringify({
          id: "c1", model: parsed.model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      res({ url: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((d) => server.close(d)) });
    });
  });
}

function p02BootGateway({ port, dashPort, upstreamUrl, deadUrl, dbPath, dir }) {
  const cfgPath = join(dir, "gw.yaml");
  writeFileSync(cfgPath, [
    "server:",
    "  bind: 127.0.0.1",
    `  port: ${port}`,
    `  dashboard_port: ${dashPort}`,
    "discovery:",
    "  enabled: false",
    "dashboard:",
    `  port: ${dashPort}`,
    "identity:",
    "  enabled: false",
    "metrics:",
    "  enabled: true",
    `  db_path: ${dbPath}`,
    "backends:",
    "  stub:",
    `    url: ${upstreamUrl}`,
    "    auth_type: none",
    "    priority: 1",
    "    models:",
    "      - p02-ok",
    "      - p02-fail502",
    "      - p02-failover",
    "      - p02-empty200",
    "  dead:",
    `    url: ${deadUrl}`,
    "    auth_type: none",
    "    priority: 2",
    "    models:",
    "      - p02-failover",
    "",
  ].join("\n"));
  const child = spawn(process.execPath, [INDEX, "--config", cfgPath, "--port", String(port)], {
    env: { ...process.env, SKGATEWAY_MODEL_CATALOG_STORE_PATH: join(dir, "store.json") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolveBoot, rejectBoot) => {
    let out = "";
    const timer = setTimeout(() => rejectBoot(new Error(`gateway did not start:\n${out}`)), 20000);
    const onData = (buf) => {
      out += buf.toString();
      if (/\[skgateway\] listening/.test(out)) { clearTimeout(timer); resolveBoot(child); }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => { clearTimeout(timer); rejectBoot(new Error(`gateway exited (${code}):\n${out}`)); });
  });
}

describe("error_msg on failed terminal rows, live gateway (card 9fbca169)", () => {
  let up, child, dir, dbPath;
  const calls = {};

  async function rowFor(reqId) {
    for (let i = 0; i < 40; i++) {
      if (existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        let row = null;
        try { row = db.prepare("SELECT * FROM request_log WHERE id = ?").get(reqId) ?? null; } catch {}
        db.close();
        if (row && row.status_code !== null) return row;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    return null;
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "skgw-p02-"));
    writeFileSync(join(dir, "store.json"), "{}");
    dbPath = join(dir, "metrics.db");
    up = await p02StartUpstream();
    const port = await p02FreePort();
    const dashPort = await p02FreePort();
    const deadPort = await p02FreePort();   // released: nothing listens there
    child = await p02BootGateway({
      port, dashPort, upstreamUrl: up.url, deadUrl: `http://127.0.0.1:${deadPort}/v1`, dbPath, dir,
    });
    for (const model of ["p02-ok", "p02-fail502", "p02-failover", "p02-empty200", "p02-no-such-model"]) {
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
      });
      await r.text();
      calls[model] = { status: r.status, reqId: r.headers.get("x-sk-req-id") };
    }
  });

  after(async () => {
    try { child?.kill("SIGKILL"); } catch {}
    await up?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function assertReason(row, { cls, upstream }) {
    assert.ok(row, "no closed request_log row");
    assert.ok(row.error_msg, `error_msg is ${row.error_msg} on a ${row.status_code} row`);
    assert.match(row.error_msg, new RegExp(`(^| )class=${cls}( |$)`), row.error_msg);
    assert.match(row.error_msg, new RegExp(`(^| )upstream_status=${upstream}( |$)`), row.error_msg);
    assert.ok(!row.error_msg.includes(BODY_MARKER), "a response body leaked into error_msg");
    assert.ok(row.error_msg.length <= 120, `error_msg is metadata, not a body (${row.error_msg.length} chars)`);
  }

  test("NEGATIVE CONTROL: a 200 row keeps error_msg NULL", async () => {
    assert.equal(calls["p02-ok"].status, 200);
    const row = await rowFor(calls["p02-ok"].reqId);
    assert.ok(row);
    assert.equal(row.error_msg, null);
  });

  test("relayed upstream 502: class and upstream status, no body", async () => {
    assert.equal(calls["p02-fail502"].status, 502);
    const row = await rowFor(calls["p02-fail502"].reqId);
    assert.equal(row?.status_code, 502);
    assertReason(row, { cls: "upstream_error", upstream: "502" });
  });

  test("failover exhausted: every candidate failed, the row says so", async () => {
    assert.ok(calls["p02-failover"].status >= 500, `status ${calls["p02-failover"].status}`);
    const row = await rowFor(calls["p02-failover"].reqId);
    // Stub answers 503, then the dead port refuses: the LAST attempt is a
    // transport failure, so there is no upstream status to report.
    assert.equal(row.error_msg, "class=failover_exhausted upstream_status=none last=upstream_unreachable");
    assertReason(row, { cls: "failover_exhausted", upstream: "none" });
  });

  test("upstream 200 the response contract rejects: client 502, row keeps upstream 200", async () => {
    assert.equal(calls["p02-empty200"].status, 502);
    const row = await rowFor(calls["p02-empty200"].reqId);
    assert.equal(row?.status_code, 502);
    assert.equal(row.error_msg, "class=invalid_upstream_response upstream_status=200");
    assertReason(row, { cls: "invalid_upstream_response", upstream: "200" });
  });

  test("no model 404: gateway-made, no upstream status", async () => {
    assert.equal(calls["p02-no-such-model"].status, 404);
    const row = await rowFor(calls["p02-no-such-model"].reqId);
    assert.equal(row?.status_code, 404);
    assertReason(row, { cls: "unknown_model", upstream: "none" });
  });
});

describe("describeFailure / describeException units (card 9fbca169)", async () => {
  const { describeFailure, describeException } = await import("../src/metrics/failure-reason.mjs");
  const body = (o) => Buffer.from(JSON.stringify(o));

  test("2xx and 3xx rows get no reason", () => {
    assert.equal(describeFailure({ status: 200, upstreamStatus: 200 }, 200), undefined);
    assert.equal(describeFailure(null, 304), undefined);
  });

  test("no result at all", () => {
    assert.equal(describeFailure(null, 502), "class=no_backend_result upstream_status=none");
  });

  test("transport failure is never reported as an upstream status", () => {
    const r = { status: 504, upstreamStatus: null, transportError: "upstream_timeout",
      body: body({ error: { message: `${BODY_MARKER} 10.0.0.9`, code: "upstream_timeout" } }) };
    assert.equal(describeFailure(r, 504), "class=upstream_timeout upstream_status=none");
  });

  test("gateway-made body: code token only, free text and generic types ignored", () => {
    const quarantined = { status: 503, body: body({ error: { message: BODY_MARKER, code: 503, type: "model_claim_quarantined" } }) };
    assert.equal(describeFailure(quarantined, 503), "class=model_claim_quarantined upstream_status=none");
    const freeText = { status: 400, body: body({ error: { code: `${BODY_MARKER} spaces`, type: "invalid_request_error" } }) };
    assert.equal(describeFailure(freeText, 400), "class=gateway_400 upstream_status=none");
  });

  test("an upstream 2xx the response contract rejected names the contract", () => {
    const r = { status: 502, upstreamStatus: 200, body: body({ error: { code: "empty_upstream_response" } }) };
    assert.equal(describeFailure(r, 502), "class=invalid_upstream_response upstream_status=200");
    assert.equal(describeFailure({ ...r, failover: true, allFailed: true }, 502),
      "class=failover_exhausted upstream_status=200 last=invalid_upstream_response");
  });

  test("a relayed body is never read, even a token-shaped code", () => {
    const r = { status: 400, upstreamStatus: 400, body: body({ error: { code: "secret_token_shape" } }) };
    assert.equal(describeFailure(r, 400), "class=upstream_error upstream_status=400");
  });

  test("exceptions keep name or code, never the message", () => {
    const err = Object.assign(new Error(`${BODY_MARKER} host.internal`), { code: "ECONNRESET" });
    assert.equal(describeException(err), "class=dispatch_exception upstream_status=none err=econnreset");
    assert.equal(describeException(new TypeError(BODY_MARKER), "request_processing_failed"),
      "class=request_processing_failed upstream_status=none err=typeerror");
  });
});
