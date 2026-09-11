import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { load as loadYaml } from "js-yaml";

const fixtureDir = mkdtempSync(join(tmpdir(), "skgw-health-routing-"));
process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = join(fixtureDir, "catalog.json");
process.env.SKGATEWAY_CAPACITY_STORE_PATH = join(fixtureDir, "capacity.json");
const { createRouter, routeAndSend, _resetThrottleCooldownsForTests } = await import("../src/proxy/router.mjs");
const { configureProviderHealthPersistence, _resetProviderUsageForTests } = await import("../src/metrics/provider-usage.mjs");
const { clearCapacity, recordProviderUnavailable } = await import("../src/discovery/capacity_store.mjs");

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

  configureProviderHealthPersistence({ append() {}, snapshot() { return {}; } });
  result = await routeAndSend(router, { model: "contract-model" }, "/chat/completions", "POST", {}, body(), false);
  assert.equal(result.status, 503);
  assert.equal(target.count, 0);

  configureProviderHealthPersistence({ append() {}, snapshot(filter) {
    return [exactSnapshot(filter, { evidence_expires_at: Date.now() - 1 })];
  } });
  result = await routeAndSend(router, { model: "contract-model" }, "/chat/completions", "POST", {}, body(), false);
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

test("every configured active inference backend has exact durable identity", () => {
  const config = loadYaml(readFileSync(new URL("../config/skgateway-codex.yaml", import.meta.url), "utf8"));
  const active = ["chiap01-qwen38", "chiap08-qwen38", "codex", "kimi-for-coding", "kimi-k3", "zai"];
  for (const id of active) {
    assert.equal(config.backends[id].require_observed_health, true, id);
    assert.match(config.backends[id].account_ref, /^[a-z0-9][a-z0-9-]+$/, id);
  }
  assert.equal(config.discovery.providers.openrouter.enabled, false);
  assert.deepEqual(config.backends.openrouter.models, []);
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

test("proven 402 quota remains a quota 429 after a later local skip", async () => {
  const target = await upstream(402, JSON.stringify({ error: { code: "quota_exhausted" } }));
  const router = createRouter({ backends: {
    quota: { url: target.url, auth_type: "none", models: ["contract-model"], priority: 1 },
    skipped: { url: target.url, auth_type: "none", models: ["contract-model"], priority: 2, context_limit: 1 },
  }, failover: true, siem_log: false });
  const result = await routeAndSend(router, { model: "contract-model" },
    "/chat/completions", "POST", {}, body(), false);
  assert.equal(result.status, 429);
  assert.equal(result.clientStatus, 429);
  assert.equal(result.failureReason, "quota_exhausted");
  assert.equal(result.upstreamStatus, 402);
  assert.equal(target.count, 1);
});

test("half-open recovery requires the exact lease owner and ordinary inference stays closed", async () => {
  const target = await upstream(200);
  const owner = "lease-owner";
  const router = createRouter({ backends: { codex: {
    url: target.url, auth_type: "none", models: ["contract-model"], discovery: "codex",
    require_observed_health: true, account_ref: "opaque-codex",
  } }, siem_log: false });
  router.getBackend("codex").recordOutcome(true, 1);
  configureProviderHealthPersistence({ append() {}, snapshot(filter) { return [exactSnapshot(filter, {
    circuit_state: "half_open", half_open_lease: { owner, expires_at: Date.now() + 60_000 },
  })]; } });

  let result = await routeAndSend(router, { model: "contract-model" },
    "/chat/completions", "POST", {}, body(), false);
  assert.equal(result.status, 503);
  result = await routeAndSend(router, { model: "contract-model", capacityProbeOwner: "wrong" },
    "/chat/completions", "POST", { "x-sk-context": "public", "x-sk-probe": "synthetic" }, body(), false);
  assert.equal(result.status, 503);
  result = await routeAndSend(router, { model: "contract-model", capacityProbeOwner: owner },
    "/chat/completions", "POST", { "x-sk-context": "public", "x-sk-probe": "synthetic" }, body(), false);
  assert.equal(result.status, 200);
  assert.equal(target.count, 1);
});

test("durable malformed and transport observations fail closed at exact scope", async () => {
  const target = await upstream(200);
  const router = createRouter({ backends: { zai: {
    url: target.url, auth_type: "none", models: ["contract-model"], discovery: "zai",
    require_observed_health: true, account_ref: "opaque-zai",
  } }, siem_log: false });
  router.getBackend("zai").recordOutcome(true, 1);
  for (const reason of ["malformed_response", "transport_error"]) {
    configureProviderHealthPersistence({ append() {}, snapshot(filter) { return [exactSnapshot(filter, {
      circuit_state: "open", last_error_reason: reason,
    })]; } });
    const result = await routeAndSend(router, { model: "contract-model" },
      "/chat/completions", "POST", {}, body(), false);
    assert.equal(result.status, 503, reason);
  }
  assert.equal(target.count, 0);
});

test("audit failure is visible and routed failures never mutate legacy capacity", async () => {
  const target = await upstream(429, JSON.stringify({ error: { code: "rate_limited" } }));
  const capacityPath = process.env.SKGATEWAY_CAPACITY_STORE_PATH;
  clearCapacity("codex", "contract-model", { path: capacityPath });
  const before = readFileSync(capacityPath, "utf8");
  const router = createRouter({ backends: { codex: {
    url: target.url, auth_type: "none", models: ["contract-model"], discovery: "codex",
    require_observed_health: true, account_ref: "opaque-codex",
  } }, siem_log: false });
  router.getBackend("codex").recordOutcome(true, 1);
  configureProviderHealthPersistence({ append() {}, snapshot(filter) { return [exactSnapshot(filter)]; } });
  await assert.rejects(
    routeAndSend(router, { model: "contract-model" }, "/chat/completions", "POST", {}, body(), false,
      async (event) => { if (event.event_type === "anomaly") throw new Error("audit unavailable"); }),
    /audit unavailable/,
  );
  assert.equal(readFileSync(capacityPath, "utf8"), before);
  assert.equal(target.count, 1);
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
