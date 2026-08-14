/**
 * energy-metering-integration.test.mjs - energy metering on the LIVE request
 * path (routeAndSend), driven end to end through createRouter + a stub
 * upstream + a stub skmeter, the same way tests/siem-live-hook.test.mjs
 * drives the SIEM hook.
 *
 * Everything about the enabled path, and the guarantee that the disabled
 * path is byte-identical, previously rested on a code trace rather than a
 * test. This file drives both paths for real:
 *
 *   1. energy.enabled=false: no meter request is ever issued.
 *   2. energy.enabled=true: result.energy has the {joules, basis, node} shape.
 *   3. Failover attribution: when the first backend fails over to a second,
 *      the energy on the returned result is attributed to the backend that
 *      actually served the request, not the one tried first.
 *   4. A slow meter read (energy.enabled=true) does not contaminate the
 *      backend latency recorded by backend.recordOutcome() / getHealth()
 *      .latencyP50 (the queueStart..latencyMs window bug fixed alongside
 *      these tests).
 *
 * Run with:  node --test tests/energy-metering-integration.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRouter, routeAndSend } from "../src/proxy/router.mjs";
import { loadConfig } from "../src/config.mjs";

// ─── fake upstream helpers (same shape as siem-live-hook.test.mjs) ───────────

function startUpstream(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        requests.push({ url: req.url, method: req.method, body: Buffer.concat(chunks) });
        handler(req, res);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function ok200(_req, res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "cmpl-test",
    choices: [{ message: { role: "assistant", content: "hi" } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  }));
}

function err500(_req, res) {
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "boom" } }));
}

// ─── fake skmeter helper ───────────────────────────────────────────────────

/**
 * Start a throwaway HTTP server that answers /energy with an incrementing
 * counter_j payload. Returns { url, port, requests, close }.
 */
function startMeter(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ url: req.url, method: req.method, ts: Date.now() });
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/energy`,
        port,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Meter that answers instantly with an incrementing counter and a fixed node id. */
function counterMeter(nodeName, startAt = 1000, incrementPerCall = 50) {
  let counter = startAt;
  return (_req, res) => {
    counter += incrementPerCall;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ counter_j: counter, node: nodeName }));
  };
}

/** Meter that answers after a fixed delay, otherwise identical to counterMeter. */
function slowCounterMeter(nodeName, delayMs, startAt = 1000, incrementPerCall = 10) {
  let counter = startAt;
  return (_req, res) => {
    setTimeout(() => {
      counter += incrementPerCall;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ counter_j: counter, node: nodeName }));
    }, delayMs);
  };
}

// ─── config helper ─────────────────────────────────────────────────────────

/**
 * Write a throwaway gateway YAML that overrides only the `energy` block.
 * loadConfig() deep-merges this over DEFAULTS, so backends/routing/etc. stay
 * exactly the same shape metrics-wiring-e2e.test.mjs already proves passes
 * validate() unmodified.
 */
function writeEnergyConfig({ enabled, readTimeoutMs = 500, meters = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "skgw-energy-test-"));
  const file = join(dir, "skgateway.yaml");
  const lines = [
    "energy:",
    `  enabled: ${enabled}`,
    `  read_timeout_ms: ${readTimeoutMs}`,
  ];
  const entries = Object.entries(meters);
  if (entries.length === 0) {
    lines.push("  meters: {}");
  } else {
    lines.push("  meters:");
    for (const [id, url] of entries) lines.push(`    ${id}: "${url}"`);
  }
  lines.push("  coefficients: {}");
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

// ─── 1. disabled path: zero meter contact ──────────────────────────────────

describe("energy metering - disabled path (default)", () => {
  let up, meter;
  before(async () => {
    up = await startUpstream(ok200);
    meter = await startMeter(counterMeter("dot100"));
    const cfgFile = writeEnergyConfig({ enabled: false, meters: { fake: meter.url } });
    await loadConfig({ configPath: cfgFile, silent: true });
  });
  after(async () => { await up.close(); await meter.close(); });

  test("no meter request is ever issued when energy.enabled is false", async () => {
    const router = createRouter({
      backends: { fake: { url: up.url, auth_type: "none", models: ["*"], priority: 1 } },
      siem_log: false,
    });
    const result = await routeAndSend(
      router,
      { model: "m" },
      "/v1/chat/completions", "POST",
      { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ model: "m" })),
      false,
      null,
    );
    assert.equal(result.status, 200);
    assert.equal(meter.requests.length, 0, "meter must not be contacted when energy.enabled is false");
    assert.equal(result.energy, undefined, "result.energy must not be set on the disabled path");
  });
});

// ─── 2. enabled path: result.energy shape ──────────────────────────────────

describe("energy metering - enabled path", () => {
  let up, meter;
  before(async () => {
    up = await startUpstream(ok200);
    meter = await startMeter(counterMeter("dot100"));
    const cfgFile = writeEnergyConfig({ enabled: true, meters: { fake: meter.url } });
    await loadConfig({ configPath: cfgFile, silent: true });
  });
  after(async () => { await up.close(); await meter.close(); });

  test("result.energy has the expected {joules, basis, node} shape", async () => {
    const router = createRouter({
      backends: { fake: { url: up.url, auth_type: "none", models: ["*"], priority: 1 } },
      siem_log: false,
    });
    const result = await routeAndSend(
      router,
      { model: "m" },
      "/v1/chat/completions", "POST",
      { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ model: "m" })),
      false,
      null,
    );
    assert.equal(result.status, 200);
    assert.equal(meter.requests.length, 2, "expected exactly one before-read and one after-read");
    assert.ok(result.energy, "result.energy must be set when energy.enabled is true");
    assert.equal(typeof result.energy.joules, "number");
    assert.equal(result.energy.basis, "measured_gpu");
    assert.equal(result.energy.node, "dot100");
  });
});

// ─── 3. failover attribution ────────────────────────────────────────────────

describe("energy metering - failover attribution", () => {
  let bad, good, meterPrimary, meterFallback;
  before(async () => {
    bad = await startUpstream(err500);
    good = await startUpstream(ok200);
    meterPrimary = await startMeter(counterMeter("primary-node"));
    meterFallback = await startMeter(counterMeter("fallback-node"));
    const cfgFile = writeEnergyConfig({
      enabled: true,
      meters: { primary: meterPrimary.url, fallback: meterFallback.url },
    });
    await loadConfig({ configPath: cfgFile, silent: true });
  });
  after(async () => {
    await bad.close();
    await good.close();
    await meterPrimary.close();
    await meterFallback.close();
  });

  test("energy is attributed to the backend that actually served the request, not the one that failed", async () => {
    const router = createRouter({
      backends: {
        primary:  { url: bad.url,  auth_type: "none", models: ["*"], priority: 1 },
        fallback: { url: good.url, auth_type: "none", models: ["*"], priority: 2 },
      },
      failover: true,
      siem_log: false,
    });
    const result = await routeAndSend(
      router,
      { model: "m" },
      "/v1/chat/completions", "POST",
      { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ model: "m" })),
      false,
      null,
    );

    assert.equal(result.status, 200, "should recover via the healthy backend");
    assert.equal(result.backendId, "fallback", "must fail over to the healthy backend");

    assert.ok(result.energy, "result.energy must be set on the returned (serving) attempt");
    assert.equal(
      result.energy.node, "fallback-node",
      "energy must be attributed to the backend that actually served the request, " +
      "not the primary backend that was tried first and failed",
    );

    // Each attempt takes its own before+after reading, proving the read is
    // per attempt, not per request - the failed primary attempt still read
    // its own meter, it just did not win the final lastResult.energy slot.
    assert.equal(meterPrimary.requests.length, 2, "the failed primary attempt still took its own meter reading");
    assert.equal(meterFallback.requests.length, 2, "the serving fallback attempt took its own meter reading");
  });
});

// ─── 4. latency isolation (Finding 1 fix) ──────────────────────────────────

describe("energy metering - latency isolation", () => {
  const METER_DELAY_MS = 200;
  let up, meter;
  before(async () => {
    up = await startUpstream(ok200); // responds essentially instantly
    meter = await startMeter(slowCounterMeter("dot100", METER_DELAY_MS));
    const cfgFile = writeEnergyConfig({
      enabled: true,
      readTimeoutMs: 2000, // generous: this test is about contamination, not timeout handling
      meters: { fake: meter.url },
    });
    await loadConfig({ configPath: cfgFile, silent: true });
  });
  after(async () => { await up.close(); await meter.close(); });

  test("a slow meter read is excluded from backend.recordOutcome()'s latency window", async () => {
    const router = createRouter({
      backends: { fake: { url: up.url, auth_type: "none", models: ["*"], priority: 1 } },
      siem_log: false,
    });

    const wallStart = Date.now();
    const result = await routeAndSend(
      router,
      { model: "m" },
      "/v1/chat/completions", "POST",
      { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ model: "m" })),
      false,
      null,
    );
    const wallElapsed = Date.now() - wallStart;

    assert.equal(result.status, 200);

    // Sanity check: the meter really was slow and really was read twice
    // (before + after), so this test is exercising the contaminating path,
    // not passing vacuously because the meter was never actually contacted.
    assert.ok(
      wallElapsed >= METER_DELAY_MS * 2,
      `expected >= ${METER_DELAY_MS * 2}ms wall time from two ${METER_DELAY_MS}ms meter reads, got ${wallElapsed}ms`,
    );

    const latencyP50 = router.getHealth().fake.latencyP50;
    // The latency recorded for this attempt must reflect only the (near
    // instant) upstream call, never either 200ms meter read. A regression
    // that lets meterBefore leak back into the queueStart..latencyMs window
    // would push this at or above METER_DELAY_MS.
    assert.ok(
      latencyP50 < METER_DELAY_MS,
      `latencyP50 (${latencyP50}ms) must stay under the meter delay (${METER_DELAY_MS}ms); ` +
      "a value at or above it means the meter read contaminated backend latency telemetry",
    );
  });
});
