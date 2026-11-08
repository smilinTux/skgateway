import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRouter, routeAndSend, _resetThrottleCooldownsForTests } from "../src/proxy/router.mjs";
import * as capacity from "../src/discovery/capacity_store.mjs";

const FLOOR = 180_000;
const LONG = 229 * 60_000;
const targets = ["glm-5", "glm-5.3", "glm-4.7"].map((model) => ({ provider: "zai", model }));
function fixture(t) {
  capacity._resetCapacityProbesForTests();
  const dir = mkdtempSync(join(tmpdir(), "skgw-model-probe-"));
  t.after(() => { capacity._resetCapacityProbesForTests(); rmSync(dir, { recursive: true, force: true }); });
  return join(dir, "capacity.json");
}
function raw(path, model = "glm-5") {
  return JSON.parse(readFileSync(path, "utf8"))[`model:zai:${model}`];
}
function throttle(path, now, model = "glm-5", extra = {}) {
  capacity.clearCapacity("zai", model, { now, path });
  capacity.recordModelThrottled("zai", model, { now, retryAt: now + LONG, path, ...extra });
}

test("legacy long model cooldown exposes a bounded slot without altering stored evidence", (t) => {
  const path = fixture(t);
  writeFileSync(path, JSON.stringify({
    "provider:zai": { state: "available", scope: "provider", observed_at: 1000 },
    "model:zai:glm-5": { state: "throttled", scope: "model", reason: "rate_limited",
      retry_at: 1000 + LONG, observed_at: 1000, probe_state: "none" },
  }));
  assert.equal(capacity.capacityStatus("zai", "glm-5", { now: 1001, path }).retry_at, 181_000);
  assert.equal(raw(path).retry_at, 1000 + LONG);
  assert.equal(capacity.admitCapacity("zai", "glm-5", {
    now: 180_999, path, publicSynthetic: true, probeOwner: {},
  }).admitted, false);
});

test("failed model probes back off and retain the original cooldown deadline", (t) => {
  const path = fixture(t);
  const T = 1_000_000;
  throttle(path, T);
  for (const [now, next] of [[T + FLOOR, T + 3 * FLOOR], [T + 3 * FLOOR, T + 7 * FLOOR]]) {
    const owner = {};
    assert.equal(capacity.admitCapacity("zai", "glm-5", {
      now, path, publicSynthetic: true, probeOwner: owner,
    }).probe, true);
    capacity.finishCapacityProbe("zai", false, { probeOwner: owner, model: "glm-5", now, path });
    assert.equal(raw(path).retry_at, T + LONG);
    const status = capacity.capacityStatus("zai", "glm-5", { now, path });
    assert.equal(status.state, "throttled");
    assert.equal(status.probe_state, "pending");
    assert.equal(status.retry_at, next);
    for (let i = 0; i < 50; i++) assert.equal(capacity.admitCapacity("zai", "glm-5", {
      now: next - 1, path, publicSynthetic: true, probeOwner: {},
    }).admitted, false);
  }
});

test("model failure backoff is capped by the original retry deadline", (t) => {
  const path = fixture(t);
  throttle(path, 1000, "glm-5", { retryAt: 241_000 });
  const owner = {};
  assert.equal(capacity.admitCapacity("zai", "glm-5", {
    now: 181_000, path, publicSynthetic: true, probeOwner: owner,
  }).probe, true);
  capacity.finishCapacityProbe("zai", false, {
    probeOwner: owner, model: "glm-5", now: 181_000, path,
  });
  assert.equal(capacity.capacityStatus("zai", "glm-5", { now: 181_001, path }).retry_at, 241_000);
});

test("scheduler model recovery skips healthy and not-yet-due siblings and is single-flight per provider", async (t) => {
  const path = fixture(t);
  const T = 2_000_000;
  throttle(path, T);
  throttle(path, T + FLOOR, "glm-5.3");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const first = capacity.runDueCapacityProbes(targets, async ({ model }, { probeOwner }) => {
    calls.push(model);
    await held;
    capacity.finishCapacityProbe("zai", true, { probeOwner, model, now: T + FLOOR, path });
  }, { now: T + FLOOR, path });
  assert.deepEqual(await capacity.runDueCapacityProbes(targets, async () => assert.fail("duplicate probe"), {
    now: T + FLOOR, path,
  }), []);
  release();
  await first;
  assert.deepEqual(calls, ["glm-5"]);
  assert.equal(capacity.capacityStatus("zai", "glm-5.3", { now: T + FLOOR, path }).state, "throttled");
});

test("a model probe token cannot bypass a sibling cooldown or settle its record", (t) => {
  const path = fixture(t);
  throttle(path, 1000);
  throttle(path, 1000, "glm-5.3");
  const owner = {};
  assert.equal(capacity.admitCapacity("zai", "glm-5", {
    now: 181_000, path, publicSynthetic: true, probeOwner: owner,
  }).probe, true);
  assert.equal(capacity.admitCapacity("zai", "glm-5.3", {
    now: 181_000, path, publicSynthetic: true, probeOwner: owner,
  }).admitted, false);
  capacity.finishCapacityProbe("zai", true, { probeOwner: owner, model: "glm-5.3", now: 181_000, path });
  assert.equal(raw(path, "glm-5.3").state, "throttled");
  assert.equal(capacity.admitCapacity("zai", "glm-5", {
    now: 181_000, path, publicSynthetic: true, probeOwner: {},
  }).admitted, false);
});

test("model probe floor is configurable with a safe default for invalid input", (t) => {
  const path = fixture(t);
  throttle(path, 1000);
  for (const [setting, expected] of [["120000", 121_000], ["invalid", 181_000], ["0", 181_000]]) {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { capacityStatus } from './src/discovery/capacity_store.mjs';
      console.log(capacityStatus('zai', 'glm-5', { now: 1001, path: process.argv[1] }).retry_at);
    `, path], { env: { ...process.env, SKGATEWAY_MODEL_PROBE_INTERVAL_MS: setting }, encoding: "utf8" });
    assert.equal(Number(output.trim()), expected);
  }
});

test("timed-out model probes re-arm the same bounded cooldown", async (t) => {
  const path = fixture(t);
  throttle(path, 1000);
  const result = await capacity.runDueCapacityProbes(targets, async () => new Promise(() => {}), {
    now: 181_000, path, deadlineMs: 10,
  });
  assert.equal(result.length, 1);
  assert.match(result[0].error.message, /deadline/);
  assert.equal(capacity.capacityStatus("zai", "glm-5", { now: 181_001, path }).retry_at, 541_000);
  assert.equal(raw(path).retry_at, 1000 + LONG);
});

test("explicit model Retry-After is a hard not-before deadline", (t) => {
  const path = fixture(t);
  throttle(path, 1000, "glm-5", { retryAfterAt: 1_801_000 });
  assert.equal(capacity.capacityStatus("zai", "glm-5", { now: 181_000, path }).retry_at, 1_801_000);
  assert.equal(capacity.admitCapacity("zai", "glm-5", {
    now: 1_800_999, path, publicSynthetic: true, probeOwner: {},
  }).admitted, false);
  assert.equal(capacity.admitCapacity("zai", "glm-5", {
    now: 1_801_000, path, publicSynthetic: true, probeOwner: {},
  }).probe, true);
});

async function upstreamFixture(t, response) {
  capacity._resetCapacityProbesForTests();
  _resetThrottleCooldownsForTests();
  const path = capacity.CAPACITY_STORE_PATH;
  writeFileSync(path, "{}");
  let calls = 0;
  const server = http.createServer((req, res) => { calls++; response(req, res); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); writeFileSync(path, "{}"); });
  const router = createRouter({ backends: { zai: {
    url: `http://127.0.0.1:${server.address().port}/v1`, auth_type: "none",
    discovery: "zai", models: ["glm-5", "glm-5.3", "glm-4.7"],
  } } });
  const send = (model, opts = {}) => routeAndSend(router, {
    model, context: "public", capacityProbeOwner: opts.probeOwner,
  }, "/v1/chat/completions", "POST", opts.probeOwner ? {
    "x-sk-context": "public", "x-sk-probe": "synthetic",
  } : {}, Buffer.from(JSON.stringify({ model,
    messages: [{ role: "user", content: "Reply with ok." }], max_tokens: 512, stream: false,
  })), false, null, opts.signal);
  return { path, send, calls: () => calls };
}

test("incident 2026-11-03: healthy provider and 229-minute model cooldown recover within the probe interval", async (t) => {
  const { path, send, calls } = await upstreamFixture(t, (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "glm-5", choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
  const now = Date.now();
  throttle(path, now - FLOOR - 1000);
  throttle(path, now, "glm-5.3");
  const results = await capacity.runDueCapacityProbes(targets, ({ model }, opts) => send(model, opts), {
    path, deadlineMs: 2000,
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].result.status, 200);
  assert.equal(raw(path), undefined);
  assert.equal(capacity.capacityStatus("zai", "glm-5.3", { path }).state, "throttled");
  assert.equal((await send("glm-5")).status, 200);
  assert.equal(calls(), 2);
});

for (const retryAfter of ["1800", new Date(Date.now() + 1_800_000).toUTCString()]) {
  test(`routed model 429 preserves Retry-After ${retryAfter === "1800" ? "seconds" : "HTTP-date"} without probing early`, async (t) => {
    const { path, send, calls } = await upstreamFixture(t, (_req, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": retryAfter });
      res.end(JSON.stringify({ error: "rate limit exceeded" }));
    });
    assert.equal((await send("glm-5")).status, 429);
    const record = raw(path);
    assert.ok(record.retry_after_at > Date.now() + 1_700_000);
    await capacity.runDueCapacityProbes(targets, ({ model }, opts) => send(model, opts), {
      now: record.observed_at + FLOOR, path,
    });
    assert.equal(calls(), 1);
  });
}

test("still-throttled routed model re-arms without a request storm and honors fresh Retry-After", async (t) => {
  const { path, send, calls } = await upstreamFixture(t, (_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "1800" });
    res.end(JSON.stringify({ error: "rate limit exceeded" }));
  });
  throttle(path, Date.now() - FLOOR - 1000);
  const deadline = raw(path).retry_at;
  const results = await capacity.runDueCapacityProbes(targets, ({ model }, opts) => send(model, opts), { path });
  assert.equal(results[0].result.status, 429);
  assert.equal(raw(path).retry_at, deadline);
  assert.ok(raw(path).retry_after_at > Date.now() + 1_700_000);
  for (let i = 0; i < 10; i++) await capacity.runDueCapacityProbes(targets,
    ({ model }, opts) => send(model, opts), { path });
  assert.equal(calls(), 1);
  assert.equal(capacity.capacityStatus("zai", "glm-5", { path }).state, "throttled");
});

test("Retry-After of one year is capped at 24h and a persisted uncapped record is clamped on load", async (t) => {
  const { path, send } = await upstreamFixture(t, (_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "31536000" });
    res.end(JSON.stringify({ error: "rate limit exceeded" }));
  });
  assert.equal((await send("glm-5")).status, 429);
  const record = raw(path);
  assert.ok(record.retry_after_at <= Date.now() + 24 * 3_600_000 + 5000);
  assert.ok(capacity.capacityStatus("zai", "glm-5", { path }).retry_at <= Date.now() + 24 * 3_600_000 + 5000);
  // Record written by the pre-cap build: a year-long retry_after_at on disk.
  const now = Date.now();
  writeFileSync(path, JSON.stringify({ "model:zai:glm-5": { state: "throttled", scope: "model",
    reason: "rate_limited", retry_at: now + LONG, observed_at: now, probe_state: "pending",
    retry_after_at: now + 31_536_000_000 } }));
  assert.ok(capacity.capacityStatus("zai", "glm-5", { now, path }).retry_at <= now + 24 * 3_600_000);
});

test("router has no reference to the removed parseRetryAfterMs helper (#204 and #205 clash guard)", () => {
  const src = readFileSync(new URL("../src/proxy/router.mjs", import.meta.url), "utf8");
  assert.equal(/parseRetryAfterMs/.test(src), false);
  assert.match(src, /parseResetDelayMs\(retryAfter\);\s*\n\s*const retryAfterAt/);
});
