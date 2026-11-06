import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createRouter, routeAndSend, _resetThrottleCooldownsForTests } from "../src/proxy/router.mjs";
import {
  CAPACITY_STORE_PATH,
  SUBSCRIPTION_PROBE_INTERVAL_MS,
  _resetCapacityProbesForTests,
  admitCapacity,
  capacityStatus,
  clearCapacity,
  finishCapacityProbe,
  recordSubscriptionExhausted,
  runDueCapacityProbes,
} from "../src/discovery/capacity_store.mjs";

function store(name) {
  const path = join(mkdtempSync(join(tmpdir(), "skgw-subscription-probe-")), `${name}.json`);
  rmSync(path, { force: true });
  return path;
}

function providerRecord(path, provider = "zai") {
  return JSON.parse(readFileSync(path, "utf8"))[`provider:${provider}`];
}

const HOUR_MS = 60 * 60 * 1000;

test("stored 6h subscription deadline admits a bounded probe slot instead", () => {
  const path = store("cadence");
  const T = 1_000_000;
  const record = recordSubscriptionExhausted("zai", { now: T, path });
  assert.equal(record.retry_at, T + 6 * HOUR_MS);
  const status = capacityStatus("zai", "glm-5", { now: T + 1, path });
  assert.equal(status.state, "throttled");
  assert.equal(status.reason, "subscription_exhausted");
  assert.equal(status.retry_at, T + SUBSCRIPTION_PROBE_INTERVAL_MS);
  // the stored provider evidence keeps the full declared deadline
  assert.equal(providerRecord(path).retry_at, T + 6 * HOUR_MS);
});

test("an explicit short reset deadline is honoured, not stretched to the cadence", () => {
  const path = store("explicit-reset");
  const T = 2_000_000;
  recordSubscriptionExhausted("zai", { now: T, retryAt: T + 90_000, path });
  assert.equal(capacityStatus("zai", "glm-5", { now: T + 1, path }).retry_at, T + 90_000);
});

test("genuine exhaustion holds: probes are single-flight, bounded, and re-arm the next slot", () => {
  _resetCapacityProbesForTests();
  const path = store("genuine");
  const T = 3_000_000;
  recordSubscriptionExhausted("zai", { now: T, path });
  const owner = {};
  // before the slot opens: fail closed, no probing, no hammering
  assert.equal(admitCapacity("zai", "glm-5", {
    now: T + 60_000, publicSynthetic: true, probeOwner: owner, path,
  }).admitted, false);
  // at the slot: exactly one bounded probe, single-flight per provider
  assert.equal(admitCapacity("zai", "glm-5", {
    now: T + SUBSCRIPTION_PROBE_INTERVAL_MS, publicSynthetic: true, probeOwner: owner, path,
  }).probe, true);
  assert.equal(admitCapacity("zai", "glm-5.3", {
    now: T + SUBSCRIPTION_PROBE_INTERVAL_MS, publicSynthetic: true, probeOwner: {}, path,
  }).admitted, false);
  // the provider is still genuinely exhausted: the probe fails
  const rearmAt = T + SUBSCRIPTION_PROBE_INTERVAL_MS + 1000;
  finishCapacityProbe("zai", false, {
    probeOwner: owner, providerWide: true, retryAt: rearmAt + 6 * HOUR_MS, now: rearmAt, path,
  });
  const rearmed = capacityStatus("zai", "glm-5", { now: rearmAt + 1, path });
  assert.equal(rearmed.state, "throttled");
  assert.equal(rearmed.reason, "subscription_exhausted");
  assert.equal(rearmed.probe_state, "pending");
  // the next slot is one cadence away, never immediate and never 6h of silence
  assert.equal(rearmed.retry_at, rearmAt + SUBSCRIPTION_PROBE_INTERVAL_MS);
  assert.equal(admitCapacity("zai", "glm-5", {
    now: rearmAt + 60_000, publicSynthetic: true, probeOwner: {}, path,
  }).admitted, false);
  assert.equal(admitCapacity("zai", "glm-5", {
    now: rearmAt + SUBSCRIPTION_PROBE_INTERVAL_MS, publicSynthetic: true, probeOwner: {}, path,
  }).probe, true);
});

test("incident 2026-11-02: one-off 429 exhaustion recovers via the bounded probe once z.ai is healthy", async (t) => {
  _resetCapacityProbesForTests();
  const sharedStore = CAPACITY_STORE_PATH;
  clearCapacity("zai", null, { path: sharedStore });
  t.after(() => clearCapacity("zai", null, { path: sharedStore }));
  let healthy = false;
  const upstream = http.createServer((_req, res) => {
    if (!healthy) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "subscription usage limit reached" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "glm-5", choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const router = createRouter({ backends: { zai: {
    url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_type: "none",
    discovery: "zai", models: ["glm-5"],
  } } });

  // T: one-off 429 with quota language and no Retry-After
  const first = await routeAndSend(router, { model: "glm-5" }, "/v1/chat/completions", "POST", {},
    Buffer.from(JSON.stringify({ model: "glm-5", messages: [], max_tokens: 512 })), false);
  assert.equal(first.status, 429);
  const stored = providerRecord(sharedStore);
  assert.equal(stored.scope, "provider");
  assert.equal(stored.reason, "subscription_exhausted");
  assert.equal(stored.probe_state, "pending");
  // the incident: with no Retry-After the stored deadline was the 6h default
  assert.ok(stored.retry_at - stored.observed_at > 5 * HOUR_MS);
  // the fix: the effective probe slot is bounded to the short cadence
  const throttled = capacityStatus("zai", "glm-5", { path: sharedStore });
  assert.ok(throttled.retry_at - stored.observed_at <= SUBSCRIPTION_PROBE_INTERVAL_MS);

  // T+15min: z.ai is healthy again, so a probe slot must be open
  healthy = true;
  const fifteenMin = 15 * 60 * 1000;
  const aged = { ...JSON.parse(readFileSync(sharedStore, "utf8")) };
  aged["provider:zai"] = { ...stored, observed_at: stored.observed_at - fifteenMin };
  writeFileSync(sharedStore, JSON.stringify(aged, null, 2));

  const results = await runDueCapacityProbes(
    [{ provider: "zai", model: "glm-5" }],
    (_target, { signal, probeOwner }) => routeAndSend(
      router, { model: "glm-5", context: "public", capacityProbeOwner: probeOwner },
      "/v1/chat/completions", "POST",
      { "x-sk-context": "public", "x-sk-probe": "synthetic" },
      Buffer.from(JSON.stringify({
        model: "glm-5", messages: [{ role: "user", content: "Reply with ok." }],
        max_tokens: 512, stream: false,
      })), false, null, signal,
    ),
    { deadlineMs: 2000 },
  );
  assert.equal(results[0].result.status, 200);
  assert.equal(capacityStatus("zai", "glm-5", { path: sharedStore }).state, "available");

  // the next real request is routed again instead of failing closed
  const next = await routeAndSend(router, { model: "glm-5" }, "/v1/chat/completions", "POST", {},
    Buffer.from(JSON.stringify({ model: "glm-5", messages: [], max_tokens: 512 })), false);
  assert.equal(next.status, 200);
  assert.equal(next.backendId, "zai");
});

test("a z.ai reset header bounds the subscription deadline instead of the 6h default", async (t) => {
  _resetCapacityProbesForTests();
  const sharedStore = CAPACITY_STORE_PATH;
  clearCapacity("zai", null, { path: sharedStore });
  t.after(() => clearCapacity("zai", null, { path: sharedStore }));
  const upstream = http.createServer((_req, res) => {
    res.writeHead(429, {
      "content-type": "application/json",
      "x-ratelimit-limit-requests": "20",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": "120",
    });
    res.end(JSON.stringify({ error: "subscription usage limit reached" }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const router = createRouter({ backends: { zai: {
    url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_type: "none",
    discovery: "zai", models: ["glm-5"],
  } } });
  const result = await routeAndSend(router, { model: "glm-5" }, "/v1/chat/completions", "POST", {},
    Buffer.from(JSON.stringify({ model: "glm-5", messages: [], max_tokens: 512 })), false);
  assert.equal(result.status, 429);
  const stored = providerRecord(sharedStore);
  const declared = stored.retry_at - stored.observed_at;
  assert.ok(declared > 100_000 && declared < 140_000, `declared reset honoured, got ${declared}ms`);
  assert.equal(capacityStatus("zai", "glm-5", { path: sharedStore }).retry_at, stored.retry_at);
});

// The codex cases below use auth_type "none", so they exercise the generic
// router path rather than the codex adapter body/header reshaping in
// fromCodexResponse. That reshaping is pinned separately in codex-adapter.test.mjs.
test("a codex reset header bounds the subscription deadline instead of the 6h default", async (t) => {
  _resetCapacityProbesForTests();
  const sharedStore = CAPACITY_STORE_PATH;
  clearCapacity("codex", null, { path: sharedStore });
  t.after(() => clearCapacity("codex", null, { path: sharedStore }));
  const upstream = http.createServer((_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "x-codex-primary-reset-at": "300" });
    res.end(JSON.stringify({ error: "subscription usage limit reached" }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const router = createRouter({ backends: { codex: {
    url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_type: "none",
    discovery: "codex", models: ["gpt-5"],
  } } });
  const result = await routeAndSend(router, { model: "gpt-5" }, "/v1/chat/completions", "POST", {},
    Buffer.from(JSON.stringify({ model: "gpt-5", messages: [], max_tokens: 512 })), false);
  assert.equal(result.status, 429);
  const stored = providerRecord(sharedStore, "codex");
  const declared = stored.retry_at - stored.observed_at;
  assert.ok(declared > 280_000 && declared < 320_000, `declared reset honoured, got ${declared}ms`);
});

test("a z.ai duration reset header (60s) bounds the subscription deadline instead of the 6h default", async (t) => {
  _resetCapacityProbesForTests();
  _resetThrottleCooldownsForTests();
  const sharedStore = CAPACITY_STORE_PATH;
  clearCapacity("zai", null, { path: sharedStore });
  t.after(() => clearCapacity("zai", null, { path: sharedStore }));
  const upstream = http.createServer((_req, res) => {
    res.writeHead(429, {
      "content-type": "application/json",
      "x-ratelimit-limit-requests": "20",
      "x-ratelimit-remaining-requests": "0",
      "x-ratelimit-reset-requests": "60s",
    });
    res.end(JSON.stringify({ error: "subscription usage limit reached" }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const router = createRouter({ backends: { zai: {
    url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_type: "none",
    discovery: "zai", models: ["glm-5"],
  } } });
  const result = await routeAndSend(router, { model: "glm-5" }, "/v1/chat/completions", "POST", {},
    Buffer.from(JSON.stringify({ model: "glm-5", messages: [], max_tokens: 512 })), false);
  assert.equal(result.status, 429);
  const stored = providerRecord(sharedStore);
  const declared = stored.retry_at - stored.observed_at;
  assert.ok(declared > 50_000 && declared < 70_000, `duration reset honoured, got ${declared}ms`);
  assert.equal(capacityStatus("zai", "glm-5", { path: sharedStore }).retry_at, stored.retry_at);
});

test("a codex epoch reset header bounds the subscription deadline instead of the 6h default", async (t) => {
  _resetCapacityProbesForTests();
  _resetThrottleCooldownsForTests();
  const sharedStore = CAPACITY_STORE_PATH;
  clearCapacity("codex", null, { path: sharedStore });
  t.after(() => clearCapacity("codex", null, { path: sharedStore }));
  const epochSeconds = String(Math.floor(Date.now() / 1000) + 90);
  const upstream = http.createServer((_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "x-codex-primary-reset-at": epochSeconds });
    res.end(JSON.stringify({ error: "subscription usage limit reached" }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const router = createRouter({ backends: { codex: {
    url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_type: "none",
    discovery: "codex", models: ["gpt-5"],
  } } });
  const result = await routeAndSend(router, { model: "gpt-5" }, "/v1/chat/completions", "POST", {},
    Buffer.from(JSON.stringify({ model: "gpt-5", messages: [], max_tokens: 512 })), false);
  assert.equal(result.status, 429);
  const stored = providerRecord(sharedStore, "codex");
  const declared = stored.retry_at - stored.observed_at;
  assert.ok(declared > 80_000 && declared < 100_000, `epoch reset honoured, got ${declared}ms`);
});
