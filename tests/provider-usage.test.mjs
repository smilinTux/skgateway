import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createRouter, routeAndSend } from "../src/proxy/router.mjs";
import {
  _resetProviderUsageForTests,
  configureProviderHealthPersistence,
  observeProviderUsage,
  parseProviderQuota,
  providerUsageSnapshot,
  providerHealthAdmissionSnapshot,
} from "../src/metrics/provider-usage.mjs";

test.beforeEach(() => _resetProviderUsageForTests());

test("parses only provider-specific authoritative formats", () => {
  assert.deepEqual(parseProviderQuota("codex", {
    "x-ratelimit-limit-tokens": "1000", "x-ratelimit-remaining-tokens": "250",
    "x-ratelimit-reset-tokens": "60s", authorization: "Bearer secret",
  }, { now: 1_000 }), [{ name: "tokens", limit: 1000, remaining: 250, reset_at: "1970-01-01T00:01:01.000Z" }]);
  assert.deepEqual(parseProviderQuota("zai", {
    "x-ratelimit-limit-requests": "20", "x-ratelimit-remaining-requests": "8",
    "x-ratelimit-reset-requests": "2000",
  }, { now: 1_000 }), [{ name: "requests", limit: 20, remaining: 8, reset_at: "1970-01-01T00:33:20.000Z" }]);
  assert.deepEqual(parseProviderQuota("kimi", {
    "x-ratelimit-limit": "10", "x-ratelimit-remaining": "9", "x-ratelimit-reset": "2m",
  }, { now: 1_000 }), [{ name: "requests", limit: 10, remaining: 9, reset_at: "1970-01-01T00:02:01.000Z" }]);
  assert.deepEqual(parseProviderQuota("cursor", { "x-ratelimit-limit": "10", "x-api-key": "secret" }), []);
  assert.deepEqual(parseProviderQuota("codex", {
    "x-codex-primary-used-percent": "75", "x-codex-primary-reset-at": "2000",
  }, { now: 1_000 }), [{
    name: "primary", limit: 100, remaining: 25,
    reset_at: "1970-01-01T00:33:20.000Z", unit: "percent",
  }]);
});

test("reports unknown, unavailable, fresh and stale explicitly", () => {
  assert.equal(providerUsageSnapshot({ now: 1_000 }).codex.provider_reported.state, "unknown");
  observeProviderUsage("cursor", { status: 200, headers: { authorization: "secret" } }, { now: 1_000 });
  assert.equal(providerUsageSnapshot({ now: 1_000 }).cursor.provider_reported.state, "unavailable");
  observeProviderUsage("codex", { status: 200, headers: {
    "x-ratelimit-limit-tokens": "100", "x-ratelimit-remaining-tokens": "99",
  } }, { now: 1_000 });
  assert.equal(providerUsageSnapshot({ now: 1_001 }).codex.provider_reported.state, "fresh");
  observeProviderUsage("codex", { status: 200, headers: {} }, { now: 1_002 });
  assert.equal(providerUsageSnapshot({ now: 1_002 }).codex.provider_reported.state, "fresh");
  assert.equal(providerUsageSnapshot({ now: 2_001, maxAgeMs: 1_000 }).codex.provider_reported.state, "stale");
  assert.equal(JSON.stringify(providerUsageSnapshot({ now: 1_001 })).includes("secret"), false);
});

test("429 exhaustion and later success recover gateway observation without inventing quota", () => {
  observeProviderUsage("kimi", { status: 429, headers: { "retry-after": "60" } }, { now: 1_000 });
  let usage = providerUsageSnapshot({ now: 1_000 }).kimi;
  assert.equal(usage.gateway_observed.state, "exhausted");
  assert.equal(usage.gateway_observed.cooldown_until, "1970-01-01T00:01:01.000Z");
  assert.equal(usage.provider_reported.state, "unavailable");

  observeProviderUsage("kimi", { status: 200, headers: {} }, { now: 2_000 });
  usage = providerUsageSnapshot({ now: 2_000 }).kimi;
  assert.equal(usage.gateway_observed.state, "available");
  assert.equal(usage.gateway_observed.cooldown_until, null);
  assert.equal(usage.gateway_observed.error_count, 1);
});

test("passive allowlisted quota evidence can be persisted without raw headers", () => {
  const appended = [];
  configureProviderHealthPersistence({ append: (value) => appended.push(value) }, {
    gateway_instance: "gateway-a", boot_id: "boot-a", runtime_revision: "runtime-a", config_revision: "config-a",
    backend_id: "codex-a", account_ref: "opaque-a", model_id: "gpt-5", bucket_id: "sk-l",
    logical_route: "coding", scope: "model", configured_mode: "active", circuit_state: "closed",
  });
  observeProviderUsage("codex", { status: 200, headers: {
    authorization: "Bearer must-not-persist",
    "x-ratelimit-limit-tokens": "100", "x-ratelimit-remaining-tokens": "9", "x-ratelimit-reset-tokens": "60s",
  } }, { now: 1_800_000_000_000 });
  assert.equal(appended.length, 1);
  assert.equal(appended[0].dimensions.quota, "low");
  assert.equal(appended[0].bucket_id, "sk-l");
  assert.equal(JSON.stringify(appended[0]).includes("must-not-persist"), false);
});

test("admission distinguishes unavailable, unreadable, stale, and exact account state", () => {
  assert.equal(providerHealthAdmissionSnapshot({}).state, "unavailable");
  configureProviderHealthPersistence({ append() {}, snapshot() { throw new Error("broken"); } });
  assert.equal(providerHealthAdmissionSnapshot({}).state, "unreadable");
  const base = { provider: "zai", backend_id: "glm", account_ref: "opaque-a", model_id: "glm-4.7",
    circuit_state: "closed", evidence_expires_at: 2000, evidence_stale: false };
  configureProviderHealthPersistence({ append() {}, snapshot() { return [{ ...base, account_ref: "opaque-b" }]; } });
  assert.equal(providerHealthAdmissionSnapshot(base, { now: 1000 }).state, "missing");
  configureProviderHealthPersistence({ append() {}, snapshot() { return [{ ...base, evidence_expires_at: 999 }]; } });
  assert.equal(providerHealthAdmissionSnapshot(base, { now: 1000 }).state, "stale");
  configureProviderHealthPersistence({ append() {}, snapshot() { return [base]; } });
  assert.equal(providerHealthAdmissionSnapshot(base, { now: 1000 }).state, "ready");
});

test("production Kimi backend id routes authoritative response quota into snapshot", async () => {
  const upstream = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, {
      "content-type": "application/json",
      "x-ratelimit-limit": "100",
      "x-ratelimit-remaining": "41",
      "x-ratelimit-reset": "60s",
      "x-api-key": "must-not-appear",
    });
    response.end(JSON.stringify({
      id: "kimi-usage", object: "chat.completion", model: "kimi-for-coding",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  try {
    const router = createRouter({ backends: { "kimi-for-coding": {
      url: `http://127.0.0.1:${upstream.address().port}/v1`,
      auth_type: "none", models: ["kimi-for-coding"],
    } }, failover: false, siem_log: false });
    const result = await routeAndSend(
      router, { model: "kimi-for-coding", agentId: "telemetry-test" },
      "/chat/completions", "POST", { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ model: "kimi-for-coding", messages: [] })), false,
    );
    assert.equal(result.status, 200);
    const usage = router.getProviderUsage().kimi;
    assert.equal(usage.provider_reported.state, "fresh");
    assert.deepEqual(usage.provider_reported.windows.map(({ name, limit, remaining }) => ({ name, limit, remaining })), [
      { name: "requests", limit: 100, remaining: 41 },
    ]);
    assert.equal(usage.gateway_observed.state, "available");
    assert.equal(JSON.stringify(usage).includes("must-not-appear"), false);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});
