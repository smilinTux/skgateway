/**
 * siem-live-hook.test.mjs — SIEM hook on the LIVE request path (routeAndSend).
 *
 * The production entrypoint (src/index.mjs) buffers the body and calls
 * `routeAndSend(...)` — it does NOT use core.mjs/handleRequest. Before this
 * wiring the SIEM hook was only reachable from the unused handleRequest path,
 * so logs/audit.jsonl went dead. These tests prove the hook now fires with
 * fully-structured GatewayEvents at each lifecycle point, and that an invalid
 * event or broken configured sink fails closed rather than disappearing.
 *
 * Coverage:
 *   1. A driven request emits auth + request + response events (correct shape).
 *   2. The response event carries status, latency, and best-effort token usage.
 *   3. Unknown event types and failed sinks are surfaced (fail closed).
 *   4. Failover across backends emits failover + error + response events.
 *
 * Run with:  node --test tests/siem-live-hook.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createRouteSiemEmitter, createRouter, routeAndSend } from "../src/proxy/router.mjs";
import { EventType } from "../src/siem/events.mjs";

// ─── fake upstream helpers ────────────────────────────────────────────────────

/**
 * Start a throwaway HTTP server that replies with a fixed status + JSON body.
 * Returns { url, close, requests } where `url` is a full base incl. /v1.
 */
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

/** Reply 200 with a valid OpenAI-shaped completion incl. usage. */
function ok200(_req, res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "cmpl-test",
    choices: [{ message: { role: "assistant", content: "hi" } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  }));
}

/** Reply 500 (retryable upstream error). */
function err500(_req, res) {
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "boom" } }));
}

// ─── 1 + 2. happy path emits auth/request/response ────────────────────────────

describe("SIEM live hook — happy path", () => {
  let up;
  before(async () => { up = await startUpstream(ok200); });
  after(async () => { await up.close(); });

  test("routeAndSend invokes the hook with auth + request + response events", async () => {
    const router = createRouter({
      backends: { fake: { url: up.url, auth_type: "none", models: ["*"], priority: 1 } },
      siem_log: false,
    });

    const events = [];
    const siem = (e) => events.push(e);

    const body = Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: "x" }] }));
    const result = await routeAndSend(
      router,
      { model: "m", agentId: "lumina" },
      "/v1/chat/completions", "POST",
      { "content-type": "application/json" },
      body,
      false,          // usePool=false — exercise the pure routing path
      siem,
    );

    assert.equal(result.status, 200);

    const types = events.map((e) => e.event_type);
    assert.ok(types.includes(EventType.AUTH),     `missing auth event; got ${types}`);
    assert.ok(types.includes(EventType.REQUEST),  `missing request event; got ${types}`);
    assert.ok(types.includes(EventType.RESPONSE), `missing response event; got ${types}`);

    // Every event is a fully-structured GatewayEvent sharing one request_id.
    for (const e of events) {
      assert.equal(e.source, "skgateway");
      assert.ok(e.event_id && e.timestamp && e.severity, "event missing base fields");
      assert.ok(e.request_id, "event missing request_id");
    }
    const reqIds = new Set(events.map((e) => e.request_id));
    assert.equal(reqIds.size, 1, "all lifecycle events must share one request_id");

    // Identity + routing propagate onto the events.
    const authEv = events.find((e) => e.event_type === EventType.AUTH);
    assert.equal(authEv.agent_id, "lumina");
    assert.equal(authEv.backend, "fake");
    assert.equal(authEv.details.method, "none");
    assert.equal(authEv.details.success, true);

    // Response carries status + latency + best-effort token usage.
    const respEv = events.find((e) => e.event_type === EventType.RESPONSE);
    assert.equal(respEv.details.status, 200);
    assert.equal(typeof respEv.details.latency_ms, "number");
    assert.equal(respEv.details.tokens_in, 11);
    assert.equal(respEv.details.tokens_out, 7);
  });
});

// ─── 3. invalid evidence cannot pass silently ────────────────────────────────

describe("SIEM live hook — fail-closed evidence boundary", () => {
  let up;
  before(async () => { up = await startUpstream(ok200); });
  after(async () => { await up.close(); });

  test("an unknown type is rejected before the sink and cannot pass silently", async () => {
    let calls = 0;
    const emit = createRouteSiemEmitter(
      () => { calls++; },
      { model: "m", agentId: "lumina", sessionId: "sess-negative" },
      "request-negative",
    );

    await assert.rejects(
      () => emit("not_in_frozen_enum", { outcome: "must-not-write" }),
      /Unknown event type: "not_in_frozen_enum"/,
    );
    assert.equal(calls, 0, "type validation must happen before sink invocation");
  });

  test("a rejected sink prevents route success instead of being swallowed", async () => {
    const router = createRouter({
      backends: { fake: { url: up.url, auth_type: "none", models: ["*"], priority: 1 } },
      siem_log: false,
    });
    let calls = 0;
    const before = up.requests.length;
    const failedSink = async () => { calls++; throw new Error("siem sink down"); };

    await assert.rejects(
      () => routeAndSend(
        router,
        { model: "m", agentId: "lumina", sessionId: "sess-sink-fail" },
        "/v1/chat/completions", "POST",
        { "content-type": "application/json" },
        Buffer.from(JSON.stringify({ model: "m" })),
        false,
        failedSink,
      ),
      /siem sink down/,
    );
    assert.equal(calls, 1, "the first required sink failure must surface");
    assert.equal(up.requests.length, before, "failure occurs at pre-dispatch auth evidence");
  });

  test("a non-function hook is a safe no-op", async () => {
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
      null,          // no hook at all
    );
    assert.equal(result.status, 200);
  });
});

// ─── 4. failover emits failover + error + response ────────────────────────────

describe("SIEM live hook — failover", () => {
  let bad, good;
  before(async () => {
    bad = await startUpstream(err500);
    good = await startUpstream(ok200);
  });
  after(async () => { await bad.close(); await good.close(); });

  test("failover across backends emits failover + error + response", async () => {
    const router = createRouter({
      backends: {
        primary:  { url: bad.url,  auth_type: "none", models: ["*"], priority: 1 },
        fallback: { url: good.url, auth_type: "none", models: ["*"], priority: 2 },
      },
      failover: true,
      siem_log: false,
    });

    const events = [];
    const result = await routeAndSend(
      router,
      { model: "m" },
      "/v1/chat/completions", "POST",
      { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ model: "m" })),
      false,
      (e) => events.push(e),
    );

    assert.equal(result.status, 200, "should recover via the healthy backend");
    assert.equal(result.failover, true);

    const types = events.map((e) => e.event_type);
    assert.ok(types.includes(EventType.ERROR),    `missing error event; got ${types}`);
    assert.ok(types.includes(EventType.FAILOVER), `missing failover event; got ${types}`);
    assert.ok(types.includes(EventType.RESPONSE), `missing response event; got ${types}`);

    const failEv = events.find((e) => e.event_type === EventType.FAILOVER);
    assert.equal(failEv.details.from_backend, "primary");
    assert.equal(failEv.details.to_backend, "fallback");

    const errEv = events.find((e) => e.event_type === EventType.ERROR);
    assert.equal(errEv.details.status_code, 500);
    assert.equal(errEv.details.backend, "primary");

    const respEv = events.find((e) => e.event_type === EventType.RESPONSE);
    assert.equal(respEv.details.status, 200);
    assert.equal(respEv.details.failover, true);
  });
});
