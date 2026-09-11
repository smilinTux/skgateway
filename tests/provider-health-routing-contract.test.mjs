import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import { createRouter, routeAndSend, _resetThrottleCooldownsForTests } from "../src/proxy/router.mjs";
import { configureProviderHealthPersistence, _resetProviderUsageForTests } from "../src/metrics/provider-usage.mjs";
import { clearCapacity, recordProviderUnavailable } from "../src/discovery/capacity_store.mjs";

const servers = [];
afterEach(async () => {
  _resetProviderUsageForTests();
  _resetThrottleCooldownsForTests();
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function upstream(status, body = null, headers = {}) {
  let count = 0;
  const server = http.createServer((request, response) => {
    count++;
    request.resume();
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(body || JSON.stringify(status < 300
      ? { model: "contract-model", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }
      : { error: { message: "failed" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}/v1`, get count() { return count; } };
}

function body(model = "contract-model", stream = false) {
  return Buffer.from(JSON.stringify({ model, stream, messages: [{ role: "user", content: "test" }] }));
}

function exactSnapshot(filter, overrides = {}) {
  return { ...filter, circuit_state: "closed", evidence_expires_at: Date.now() + 60_000,
    evidence_stale: false, half_open_lease: null, ...overrides };
}

test("durable admission fails closed and binds the opaque account reference", async () => {
  const target = await upstream(200);
  const backend = { url: target.url, auth_type: "none", models: ["contract-model"],
    discovery: "kimi", require_observed_health: true, account_ref: "opaque-a" };
  const router = createRouter({ backends: { "kimi-contract": backend }, failover: false, siem_log: false });
  router.getBackend("kimi-contract").recordOutcome(true, 1);

  let result = await routeAndSend(router, { model: "contract-model" }, "/chat/completions", "POST", {}, body(), false);
  assert.equal(result.status, 503);
  assert.equal(target.count, 0);

  configureProviderHealthPersistence({ append() {}, snapshot() { throw new Error("unreadable"); } });
  result = await routeAndSend(router, { model: "contract-model" }, "/chat/completions", "POST", {}, body(), false);
  assert.equal(result.status, 503);
  assert.equal(target.count, 0);

  configureProviderHealthPersistence({ append() {}, snapshot(filter) {
    return [exactSnapshot({ ...filter, account_ref: "opaque-b" })];
  } });
  result = await routeAndSend(router, { model: "contract-model" }, "/chat/completions", "POST", {}, body(), false);
  assert.equal(result.status, 503);
  assert.equal(target.count, 0);

  configureProviderHealthPersistence({ append() {}, snapshot(filter) { return [exactSnapshot(filter)]; } });
  result = await routeAndSend(router, { model: "contract-model" }, "/chat/completions", "POST", {}, body(), false);
  assert.equal(result.status, 200);
  assert.equal(target.count, 1);
});

test("adapter-proven 403 quota exhaustion reaches the client as quota 429", async () => {
  const target = await upstream(403, JSON.stringify({ error: { code: "quota_exhausted" } }));
  const router = createRouter({ backends: { provider: {
    url: target.url, auth_type: "none", models: ["contract-model"],
  } }, failover: false, siem_log: false });
  const result = await routeAndSend(router, { model: "contract-model" },
    "/chat/completions", "POST", {}, body(), false);
  assert.equal(result.status, 429);
  assert.equal(result.failureReason, "quota_exhausted");
  assert.equal(result.upstreamStatus, 403);
});

test("local skips do not consume the three actual upstream attempt budget", async () => {
  const doors = await Promise.all([503, 503, 503, 200].map((status) => upstream(status)));
  const backends = {
    skipped: { url: doors[0].url, auth_type: "none", models: ["contract-model"], priority: 0, context_limit: 1 },
  };
  doors.forEach((door, index) => {
    backends[`door-${index}`] = { url: door.url, auth_type: "none", models: ["contract-model"],
      priority: index + 1, capacity_domain: `domain-${index}` };
  });
  const result = await routeAndSend(createRouter({ backends, failover: true, siem_log: false }),
    { model: "contract-model" }, "/chat/completions", "POST", {}, body(), false);
  assert.equal(result.status, 503);
  assert.equal(result.attemptCount, 3);
  assert.equal(doors[0].count, 1);
  assert.equal(doors[1].count, 1);
  assert.equal(doors[2].count, 1);
  assert.equal(doors[3].count, 0);
});

test("partial SSE emits one terminal error, records failure, and never reroutes", async () => {
  const partial = await upstream(200,
    'data: {"id":"x","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n',
    { "content-type": "text/event-stream" });
  const fallback = await upstream(200);
  const events = [];
  const router = createRouter({ backends: {
    primary: { url: partial.url, auth_type: "none", models: ["contract-model"], priority: 1 },
    secondary: { url: fallback.url, auth_type: "none", models: ["contract-model"], priority: 2 },
  }, failover: true, siem_log: false });
  const result = await routeAndSend(router, { model: "contract-model" }, "/chat/completions", "POST", {},
    body("contract-model", true), false, (event) => events.push(event));
  const wire = result.body.toString("utf8");
  assert.equal(result.status, 200);
  assert.match(wire, /partial/);
  assert.equal((wire.match(/event: error/g) || []).length, 1);
  assert.match(wire, /partial_stream_failed/);
  assert.match(wire, /"origin":"upstream"/);
  assert.match(wire, /"retryable":false/);
  assert.match(wire, /"attempt_count":1/);
  assert.equal(wire.includes("[DONE]"), false);
  assert.equal(partial.count, 1);
  assert.equal(fallback.count, 0);
  assert.ok(events.some((event) => event.details?.failure_reason === "partial_stream_failed"));
});

test("legacy capacity state cannot override exact durable admission", async () => {
  const target = await upstream(200);
  const router = createRouter({ backends: { codex: { url: target.url, auth_type: "none",
    models: ["contract-model"], require_observed_health: true, account_ref: "opaque-codex" } }, siem_log: false });
  router.getBackend("codex").recordOutcome(true, 1);
  recordProviderUnavailable("codex", { reason: "subscription_exhausted" });
  configureProviderHealthPersistence({ append() {}, snapshot(filter) { return [exactSnapshot(filter)]; } });
  let result = await routeAndSend(router, { model: "contract-model" }, "/chat/completions", "POST", {}, body(), false);
  assert.equal(result.status, 200);
  assert.equal(target.count, 1);

  clearCapacity("codex", "contract-model");
  configureProviderHealthPersistence({ append() {}, snapshot(filter) {
    return [exactSnapshot(filter, { circuit_state: "open" })];
  } });
  result = await routeAndSend(router, { model: "contract-model" }, "/chat/completions", "POST", {}, body(), false);
  assert.equal(result.status, 503);
  assert.equal(target.count, 1);
});
