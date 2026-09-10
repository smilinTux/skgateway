import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import { createRouter, routeAndSend } from "../src/proxy/router.mjs";
import { getPool, resetPool } from "../src/proxy/connection-pool.mjs";

const store = join(mkdtempSync(join(tmpdir(), "skgw-capacity-test-")), "capacity.json");
const capacity = await import("../src/discovery/capacity_store.mjs");
const { applyCapacityView, availabilityState } = await import("../src/proxy/advertise.mjs");

test("provider exhaustion fails closed, admits one bounded recovery probe, and clears on success", () => {
  capacity._resetCapacityProbesForTests();
  const owner = {};
  capacity.recordSubscriptionExhausted("codex", { now: 1000, retryAt: 2000, path: store });
  assert.equal(capacity.admitCapacity("codex", "gpt-5", { now: 1500, path: store }).admitted, false);
  assert.equal(capacity.admitCapacity("codex", "gpt-5", {
    now: 2000, publicSynthetic: true, probeOwner: owner, path: store,
  }).probe, true);
  assert.equal(capacity.admitCapacity("codex", "gpt-5.1", {
    now: 2000, publicSynthetic: true, probeOwner: {}, path: store,
  }).admitted, false);
  capacity.finishCapacityProbe("codex", true, { probeOwner: owner, now: 2001, path: store });
  assert.equal(capacity.admitCapacity("codex", "gpt-5.1", { now: 2002, path: store }).admitted, true);
});

test("rejected capacity audit leaves provider state unchanged", async (t) => {
  capacity._resetCapacityProbesForTests();
  const sharedStore = capacity.CAPACITY_STORE_PATH;
  capacity.clearCapacity("codex", "gpt-5", { path: sharedStore });
  const upstream = http.createServer((_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
    res.end(JSON.stringify({ error: "subscription usage limit reached" }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const router = createRouter({ backends: { codex: {
    url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_type: "none",
    discovery: "codex", models: ["gpt-5"],
  } } });
  const rejectCapacityAudit = async (event) => {
    if (event.event_type === "capacity") throw new Error("capacity audit unavailable");
  };
  await assert.rejects(
    routeAndSend(router, { model: "gpt-5" }, "/v1/chat/completions", "POST", {},
      Buffer.from(JSON.stringify({ model: "gpt-5", messages: [] })), false, rejectCapacityAudit),
    /capacity audit unavailable/,
  );
  assert.equal(capacity.capacityStatus("codex", "gpt-5", { path: sharedStore }).state, "available");
});

test("rejected probe-attempt audit releases the half-open owner", async () => {
  capacity._resetCapacityProbesForTests();
  const due = Date.now();
  const sharedStore = capacity.CAPACITY_STORE_PATH;
  capacity.recordSubscriptionExhausted("codex", {
    now: due - 2000, retryAt: due - 1000, path: sharedStore,
  });
  const firstOwner = {};
  const router = createRouter({ backends: { codex: {
    url: "http://127.0.0.1:1/v1", auth_type: "none", discovery: "codex", models: ["gpt-5"],
  } } });
  await assert.rejects(
    routeAndSend(router, {
      model: "gpt-5", context: "public", capacityProbeOwner: firstOwner,
    }, "/v1/chat/completions", "POST",
    { "x-sk-context": "public", "x-sk-probe": "synthetic" },
    Buffer.from(JSON.stringify({ model: "gpt-5", messages: [] })), false,
    async (event) => {
      if (event.event_type === "capacity") throw new Error("capacity audit unavailable");
    }),
    /capacity audit unavailable/,
  );
  const nextOwner = {};
  assert.equal(capacity.admitCapacity("codex", "gpt-5", {
    now: due, publicSynthetic: true, probeOwner: nextOwner, path: sharedStore,
  }).probe, true);
  capacity.finishCapacityProbe("codex", false, {
    probeOwner: nextOwner, model: "gpt-5", now: due, path: sharedStore,
  });
});

test("stale and failed probe evidence stays fail closed", () => {
  capacity._resetCapacityProbesForTests();
  const owner = {};
  capacity.recordSubscriptionExhausted("codex", { now: 1000, retryAt: 2000, path: store });
  const stale = capacity.admitCapacity("codex", "gpt-5", {
    now: 1000 + 49 * 60 * 60 * 1000, publicSynthetic: true, path: store,
  });
  assert.equal(stale.admitted, false);
  capacity.recordSubscriptionExhausted("codex", { now: 3000, retryAt: 4000, path: store });
  assert.equal(capacity.admitCapacity("codex", "gpt-5", {
    now: 4000, publicSynthetic: true, probeOwner: owner, path: store,
  }).probe, true);
  capacity.finishCapacityProbe("codex", false, { probeOwner: owner, now: 4001, retryAt: 8000, path: store });
  assert.equal(capacity.admitCapacity("codex", "gpt-5", { now: 4002, path: store }).admitted, false);
});

test("catalog and monitoring share provider-wide capacity truth", () => {
  const getCapacity = (provider) => provider === "codex"
    ? { state: "throttled", reason: "subscription_exhausted", retry_at: 9, probe_state: "pending", current: true }
    : { state: "available", reason: null, retry_at: null, probe_state: "succeeded", current: true };
  const catalog = [{ id: "gpt-5", provider: "codex" }, { id: "qwen", provider: "local" }];
  assert.deepEqual(applyCapacityView(catalog, getCapacity).map((m) => m.id), ["qwen"]);
  assert.equal(getCapacity("codex").state, "throttled");
  assert.equal(getCapacity("local").state, "available");
});

test("only explicit quota language becomes provider-wide exhaustion", () => {
  assert.equal(capacity.isSubscriptionExhaustion(429, '{"error":"subscription usage limit reached"}'), true);
  assert.equal(capacity.isSubscriptionExhaustion(429, '{"error":"requests per minute"}'), false);
  assert.equal(capacity.isSubscriptionExhaustion(500, '{"error":"subscription usage limit reached"}'), false);
});

test("canonical monitoring distinguishes all availability states", () => {
  assert.equal(availabilityState({ enabled: false }), "disabled");
  assert.equal(availabilityState({ capacity: { state: "throttled" } }), "throttled");
  assert.equal(availabilityState({ health: { quarantined: true } }), "quarantined");
  assert.equal(availabilityState({ health: { observed: false, status: "unknown" } }), "unknown");
  assert.equal(availabilityState({ health: { observed: true, status: "up" } }), "available");
});

test("autonomous scheduler probes only after retry_at and stays single-flight", async () => {
  capacity._resetCapacityProbesForTests();
  capacity.recordSubscriptionExhausted("codex", { now: 1000, retryAt: 2000, path: store });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const probe = async () => { calls++; await blocked; return { status: 200 }; };

  assert.deepEqual(await capacity.runDueCapacityProbes(
    [{ provider: "codex", model: "gpt-5" }], probe, { now: 1999, path: store }), []);
  const first = capacity.runDueCapacityProbes(
    [{ provider: "codex", model: "gpt-5" }], probe, { now: 2000, path: store });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await capacity.runDueCapacityProbes(
    [{ provider: "codex", model: "gpt-5" }], probe, { now: 2000, path: store }), []);
  release();
  await first;
  assert.equal(calls, 1);
});

test("scheduled owner remains a probe after the first exact model recovers", async () => {
  capacity._resetCapacityProbesForTests();
  const path = join(mkdtempSync(join(tmpdir(), "skgw-multimodel-probe-")), "capacity.json");
  const models = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
  capacity.recordSubscriptionExhausted("codex", { now: 1000, retryAt: 2000, path });

  await capacity.runDueCapacityProbes(
    models.map((model) => ({ provider: "codex", model })),
    async ({ model }, { probeOwner }) => {
      const admission = capacity.admitCapacity("codex", model, {
        now: 2000, publicSynthetic: true, probeOwner, path,
      });
      assert.equal(admission.probe, true);
      capacity.finishCapacityProbe("codex", true, {
        probeOwner, model, now: 2000, path,
      });
      return { status: 200 };
    },
    { now: 2000, path },
  );

  assert.equal(capacity.capacityStatus("codex", models.at(-1), { now: 2000, path }).state, "available");
  assert.equal(capacity.capacityStatus("codex", models.at(-1), { now: 2000, path }).probe_state, "succeeded");
});

test("autonomous probe can clear provider capacity through the routed outcome contract", async () => {
  capacity._resetCapacityProbesForTests();
  capacity.recordSubscriptionExhausted("codex", { now: 2000, retryAt: 3000, path: store });
  await capacity.runDueCapacityProbes([{ provider: "codex", model: "gpt-5" }], async (target, { probeOwner }) => {
    const admission = capacity.admitCapacity(target.provider, target.model,
      { now: 3000, publicSynthetic: true, probeOwner, path: store });
    assert.equal(admission.probe, true);
    capacity.finishCapacityProbe(target.provider, true, { probeOwner, model: target.model, now: 3001, path: store });
    return { status: 200 };
  }, { now: 3000, path: store });
  assert.equal(capacity.capacityStatus("codex", "gpt-5", { now: 3002, path: store }).state, "available");
});

test("scheduler releases the provider probe lock when transport throws", async () => {
  capacity._resetCapacityProbesForTests();
  capacity.recordSubscriptionExhausted("codex", { now: 3000, retryAt: 4000, path: store });
  const target = [{ provider: "codex", model: "gpt-5" }];
  const thrown = await capacity.runDueCapacityProbes(target, async () => { throw new Error("transport"); },
    { now: 4000, path: store });
  assert.match(thrown[0].error.message, /transport/);
  assert.equal(capacity.capacityStatus("codex", "gpt-5", { now: 4001, path: store }).probe_state, "pending");
  let calls = 0;
  await capacity.runDueCapacityProbes(target, async () => { calls++; }, { now: 4000, path: store });
  assert.equal(calls, 0);
});

test("transport throw after half-open admission re-arms and releases the owned lock", async () => {
  capacity._resetCapacityProbesForTests();
  capacity.recordSubscriptionExhausted("codex", { now: 4000, retryAt: 5000, path: store });
  const target = [{ provider: "codex", model: "gpt-5" }];
  const thrown = await capacity.runDueCapacityProbes(target, async ({ provider, model }, { probeOwner }) => {
    assert.equal(capacity.admitCapacity(provider, model, {
      now: 5000, publicSynthetic: true, probeOwner, path: store,
    }).probe, true);
    throw new Error("transport after admission");
  }, { now: 5000, path: store });
  assert.match(thrown[0].error.message, /after admission/);
  const rearmed = capacity.capacityStatus("codex", "gpt-5", { now: 5001, path: store });
  assert.equal(rearmed.probe_state, "pending");
  assert.equal(capacity.admitCapacity("codex", "gpt-5", {
    now: rearmed.retry_at, publicSynthetic: true, probeOwner: {}, path: store,
  }).probe, true);
});

test("scheduler never releases a half-open lock owned by another caller", async () => {
  capacity._resetCapacityProbesForTests();
  const externalOwner = {};
  capacity.recordSubscriptionExhausted("codex", { now: 5000, retryAt: 6000, path: store });
  assert.equal(capacity.admitCapacity("codex", "gpt-5", {
    now: 6000, publicSynthetic: true, probeOwner: externalOwner, path: store,
  }).probe, true);
  await capacity.runDueCapacityProbes([{ provider: "codex", model: "gpt-5" }], async () => ({ status: 429 }),
    { now: 6000, path: store });
  capacity.finishCapacityProbe("codex", true, { probeOwner: {}, now: 6001, path: store });
  assert.equal(capacity.admitCapacity("codex", "gpt-5", {
    now: 6001, publicSynthetic: true, probeOwner: {}, path: store,
  }).admitted, false);
  capacity.finishCapacityProbe("codex", true, { probeOwner: externalOwner, now: 6002, path: store });
  assert.equal(capacity.capacityStatus("codex", "gpt-5", { now: 6003, path: store }).state, "available");
});

test("scheduler enforces an absolute deadline and aborts a heartbeat-style probe", async () => {
  capacity._resetCapacityProbesForTests();
  capacity.recordSubscriptionExhausted("codex", { now: 7000, retryAt: 8000, path: store });
  let aborted = false;
  const result = await capacity.runDueCapacityProbes(
    [{ provider: "codex", model: "gpt-5" }],
    async (_target, { signal }) => new Promise(() => signal.addEventListener("abort", () => { aborted = true; })),
    { now: 8000, path: store, deadlineMs: 10 },
  );
  assert.equal(aborted, true);
  assert.match(result[0].error.message, /deadline/);
});

test("model cooldown is visible without suppressing sibling Codex models", () => {
  capacity.clearCapacity("codex", null, { now: 8999, path: store });
  capacity.recordModelThrottled("codex", "gpt-5", { now: 9000, retryAt: 10000, path: store });
  const lookup = (provider, model) => capacity.capacityStatus(provider, model, { now: 9001, path: store });
  assert.equal(availabilityState({ capacity: lookup("codex", "gpt-5") }), "throttled");
  assert.notEqual(lookup("codex", "gpt-5.1").state, "throttled");
  assert.deepEqual(applyCapacityView([
    { id: "gpt-5", provider: "codex" }, { id: "gpt-5.1", provider: "codex" },
  ], lookup).map((entry) => entry.id), ["gpt-5.1"]);
});

test("a malformed model response does not suppress sibling GLM models", () => {
  capacity.clearCapacity("zai", null, { now: 9100, path: store });
  capacity.recordModelUnavailable("zai", "glm-5.3", {
    reason: "malformed_response", now: 9101, retryAt: 10101, path: store,
  });
  const failed = capacity.capacityStatus("zai", "glm-5.3", { now: 9102, path: store });
  const sibling = capacity.capacityStatus("zai", "glm-4.7", { now: 9102, path: store });
  assert.equal(failed.state, "throttled");
  assert.equal(failed.scope, "model");
  assert.equal(failed.reason, "malformed_response");
  assert.equal(sibling.state, "available");
});

test("provider exhaustion dominates an earlier model retry deadline", () => {
  capacity._resetCapacityProbesForTests();
  capacity.clearCapacity("codex", "gpt-5", { now: 9500, path: store });
  capacity.recordModelThrottled("codex", "gpt-5", { now: 9600, retryAt: 10000, path: store });
  capacity.recordSubscriptionExhausted("codex", { now: 9700, retryAt: 20000, path: store });
  const status = capacity.capacityStatus("codex", "gpt-5", { now: 10000, path: store });
  assert.equal(status.scope, "provider");
  assert.equal(status.retry_at, 20000);
  assert.equal(capacity.admitCapacity("codex", "gpt-5", {
    now: 10000, publicSynthetic: true, probeOwner: {}, path: store,
  }).admitted, false);
  assert.equal(capacity.admitCapacity("codex", "gpt-5", {
    now: 20000, publicSynthetic: true, probeOwner: {}, path: store,
  }).probe, true);
});

test("due model cooldown admits one bounded probe and clears only that model", () => {
  capacity._resetCapacityProbesForTests();
  capacity.clearCapacity("codex", null, { now: 10000, path: store });
  capacity.recordModelThrottled("codex", "gpt-5", { now: 10001, retryAt: 11001, path: store });
  capacity.recordModelThrottled("codex", "gpt-5.1", { now: 10001, retryAt: 12001, path: store });
  const owner = {};
  assert.equal(capacity.admitCapacity("codex", "gpt-5", {
    now: 11001, publicSynthetic: true, probeOwner: owner, path: store,
  }).probe, true);
  capacity.finishCapacityProbe("codex", true, {
    probeOwner: owner, model: "gpt-5", now: 11002, path: store,
  });
  assert.equal(capacity.capacityStatus("codex", "gpt-5", { now: 11003, path: store }).state, "available");
  assert.equal(capacity.capacityStatus("codex", "gpt-5.1", { now: 11003, path: store }).state, "throttled");
});

test("scheduler timer is bounded and unrefed", () => {
  let interval;
  let unrefed = false;
  const scheduled = capacity.startCapacityProbeScheduler({
    targets: [], probe: async () => {}, intervalMs: 1234,
    setIntervalFn(fn, ms) { interval = { fn, ms, unref() { unrefed = true; } }; return interval; },
  });
  assert.equal(interval.ms, 1234);
  assert.equal(scheduled.timer, interval);
  assert.equal(unrefed, true);
});

test("pool rejection cannot strand a half-open Codex probe lock", async () => {
  capacity._resetCapacityProbesForTests();
  const sharedStore = capacity.CAPACITY_STORE_PATH;
  const now = Date.now();
  capacity.recordSubscriptionExhausted("codex", {
    now: now - 2000, retryAt: now - 500, path: sharedStore,
  });
  const router = createRouter({ backends: { codex: {
    url: "http://127.0.0.1:1/v1", auth_type: "none", discovery: "codex", models: ["gpt-5"],
  } } });
  resetPool();
  const pool = getPool({ perBackend: { codex: { max: 1, maxQueue: 0 } } });
  const holder = await pool.acquire("codex");
  const body = Buffer.from(JSON.stringify({ model: "gpt-5", messages: [{ role: "user", content: "ok" }] }));
  const headers = { "x-sk-context": "public", "x-sk-probe": "synthetic" };
  const first = await routeAndSend(router, { model: "gpt-5" }, "/v1/chat/completions", "POST", headers, body);
  pool.release(holder);
  assert.equal(first.status, 503);
  const rearmed = capacity.capacityStatus("codex", "gpt-5", { path: sharedStore });
  assert.equal(rearmed.probe_state, "pending");
  const nextOwner = {};
  assert.equal(capacity.admitCapacity("codex", "gpt-5", {
    now: rearmed.retry_at, publicSynthetic: true, probeOwner: nextOwner, path: sharedStore,
  }).probe, true);
  capacity.finishCapacityProbe("codex", false, {
    probeOwner: nextOwner, model: "gpt-5", now: rearmed.retry_at, path: sharedStore,
  });
  resetPool();
});

test("autonomous routed probe clears one due model cooldown and preserves its sibling", async (t) => {
  capacity._resetCapacityProbesForTests();
  const sharedStore = capacity.CAPACITY_STORE_PATH;
  const now = Date.now();
  capacity.clearCapacity("codex", "gpt-5", { now: now - 3000, path: sharedStore });
  capacity.recordModelThrottled("codex", "gpt-5", {
    now: now - 2000, retryAt: now - 500, path: sharedStore,
  });
  capacity.recordModelThrottled("codex", "gpt-5.1", {
    now: now - 2000, retryAt: now + 60_000, path: sharedStore,
  });
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "gpt-5", choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const port = upstream.address().port;
  const router = createRouter({ backends: { codex: {
    url: `http://127.0.0.1:${port}/v1`, auth_type: "none", discovery: "codex", models: ["gpt-5"],
  } } });
  const results = await capacity.runDueCapacityProbes(
    [{ provider: "codex", model: "gpt-5" }],
    (_target, { signal, probeOwner }) => {
      const body = Buffer.from(JSON.stringify({
        model: "gpt-5", messages: [{ role: "user", content: "Reply with ok." }], stream: false,
      }));
      return routeAndSend(router, { model: "gpt-5", context: "public", capacityProbeOwner: probeOwner },
        "/v1/chat/completions", "POST",
        { "x-sk-context": "public", "x-sk-probe": "synthetic" }, body, false, null, signal);
    },
    { now, path: sharedStore, deadlineMs: 1000 },
  );
  assert.equal(results[0].result.status, 200);
  assert.equal(capacity.capacityStatus("codex", "gpt-5", { path: sharedStore }).state, "available");
  assert.equal(capacity.capacityStatus("codex", "gpt-5.1", { path: sharedStore }).state, "throttled");
});

test("subscription 429 during a model probe records provider-wide exhaustion", async (t) => {
  capacity._resetCapacityProbesForTests();
  const sharedStore = capacity.CAPACITY_STORE_PATH;
  const now = Date.now();
  capacity.clearCapacity("codex", "gpt-5", { now: now - 3000, path: sharedStore });
  capacity.recordModelThrottled("codex", "gpt-5", {
    now: now - 2000, retryAt: now - 500, path: sharedStore,
  });
  const upstream = http.createServer((_req, res) => {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
    res.end(JSON.stringify({ error: "subscription usage limit reached" }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const router = createRouter({ backends: { codex: {
    url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_type: "none",
    discovery: "codex", models: ["gpt-5"],
  } } });
  const results = await capacity.runDueCapacityProbes(
    [{ provider: "codex", model: "gpt-5" }],
    (_target, { signal, probeOwner }) => routeAndSend(
      router, { model: "gpt-5", context: "public", capacityProbeOwner: probeOwner },
      "/v1/chat/completions", "POST",
      { "x-sk-context": "public", "x-sk-probe": "synthetic" },
      Buffer.from(JSON.stringify({
        model: "gpt-5", messages: [{ role: "user", content: "Reply with ok." }], stream: false,
      })), false, null, signal,
    ),
    { now, path: sharedStore, deadlineMs: 1000 },
  );
  assert.equal(results[0].result.status, 429);
  const rearmed = capacity.capacityStatus("codex", "gpt-5", { path: sharedStore });
  assert.equal(rearmed.probe_state, "pending");
  assert.equal(rearmed.scope, "provider");
  assert.equal(rearmed.reason, "subscription_exhausted");
  assert.equal(capacity.admitCapacity("codex", "gpt-5", {
    now: rearmed.retry_at, publicSynthetic: true, probeOwner: {}, path: sharedStore,
  }).probe, true);
});

test("capacity audit records exhaustion, bounded probe, and recovery without sensitive data", async (t) => {
  capacity._resetCapacityProbesForTests();
  const sharedStore = capacity.CAPACITY_STORE_PATH;
  const model = "gpt-5-capacity-audit";
  capacity.clearCapacity("codex", model, { path: sharedStore });
  let responseCount = 0;
  const upstream = http.createServer((_req, res) => {
    responseCount += 1;
    if (responseCount === 1) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify({ error: "subscription usage limit reached", credential: "response-secret" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model, choices: [{ message: { role: "assistant", content: "ok" } }] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const router = createRouter({ backends: { codex: {
    url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_type: "none",
    discovery: "codex", models: [model],
  } } });
  const events = [];
  const siem = async (event) => { events.push(event); };
  const sensitiveBody = Buffer.from(JSON.stringify({
    model, messages: [{ role: "user", content: "body-secret" }],
  }));
  await routeAndSend(router, { model, agentId: "capacity-test" },
    "/v1/chat/completions", "POST", { authorization: "Bearer credential-secret" },
    sensitiveBody, false, siem);

  const due = Date.now();
  capacity.recordSubscriptionExhausted("codex", {
    now: due - 2000, retryAt: due - 1000, path: sharedStore,
  });
  await capacity.runDueCapacityProbes(
    [{ provider: "codex", model }],
    (_target, { signal, probeOwner }) => routeAndSend(
      router, {
        model, agentId: "skgateway-capacity-probe",
        context: "public", capacityProbeOwner: probeOwner,
      },
      "/v1/chat/completions", "POST",
      { "x-sk-context": "public", "x-sk-probe": "synthetic" }, sensitiveBody,
      false, siem, signal,
    ),
    { now: due, path: sharedStore, deadlineMs: 1000 },
  );

  const audit = events.filter((event) => event.event_type === "capacity");
  assert.deepEqual(audit.map((event) => event.details.action), [
    "subscription_exhausted", "probe_attempt", "probe_recovered",
  ]);
  assert.deepEqual(audit.map((event) => event.details.probe_state), [
    "pending", "in_progress", "succeeded",
  ]);
  assert.equal(audit[0].details.reason, "subscription_exhausted");
  assert.ok(Number.isFinite(audit[0].details.retry_at));
  assert.equal(audit[1].details.deadline_ms, 8000);
  assert.equal(audit[2].details.state, "available");
  assert.match(audit[1].request_id, /^[0-9a-f-]{36}$/);
  assert.equal(audit[1].correlation_id, audit[1].request_id);
  assert.equal(audit[2].correlation_id, audit[1].correlation_id);
  const serialized = JSON.stringify(audit);
  for (const secret of ["body-secret", "credential-secret", "response-secret", "authorization", "Bearer"]) {
    assert.equal(serialized.includes(secret), false, `capacity audit leaked ${secret}`);
  }
});
