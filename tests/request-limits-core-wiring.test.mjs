/**
 * request-limits-core-wiring.test.mjs: handleRequest()'s explicit byte-limit
 * gate (src/proxy/core.mjs), wired on top of request-limits.mjs.
 *
 * Covers:
 *   1. happy path: a small request within every configured limit passes
 *      through to the upstream untouched.
 *   2. edge case: a tool-heavy request that is over the system-byte limit
 *      only because of its tool definitions is NOT rejected outright. The
 *      gateway reduces to the proactive tool budget and re-checks, the
 *      "reduced-tools retry" described in the chi port brief.
 *   3. failure case: a request still over limit after the reduction retry
 *      (because its conversation history itself is oversized, not its
 *      tools) gets a 413 with the original history intact (no upstream call).
 *   4. failure case: ingress-level rejection. A body that exceeds every
 *      configured model's ceiling is rejected while still streaming in,
 *      before it is ever parsed.
 *
 * Run with: node --test tests/request-limits-core-wiring.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createProxyServer } from "../src/proxy/core.mjs";

function listen(server) {
  return new Promise((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen(server.address().port)));
}

function startUpstream(handler) {
  return new Promise((resolveStart) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        requests.push({ url: req.url, body: Buffer.concat(chunks) });
        handler(req, res);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveStart({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function ok200(_req, res) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "cmpl-fixture", choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
}

function post(port, path, body, headers = {}) {
  return new Promise((resolveReq, rejectReq) => {
    const req = http.request({
      host: "127.0.0.1", port, path, method: "POST",
      headers: { "content-type": "application/json", ...headers },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolveReq({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", rejectReq);
    req.end(body);
  });
}

function fakeTool(n) {
  return { type: "function", function: { name: `tool_${n}`, description: "x".repeat(200), parameters: { type: "object", properties: {} } } };
}

describe("handleRequest explicit byte limits", () => {
  let up;
  let gw;
  let gwPort;

  before(async () => {
    up = await startUpstream(ok200);
    gw = createProxyServer({
      targetUrl: up.url,
      // Ingress must admit the largest body any configured model allows, so
      // the global default stays generous; the "m" test model below carries
      // its own tighter per-model ceiling, which only applies once the body
      // is parsed and the model is known. This gap between the two is
      // exactly where the reduced-tools retry has room to act.
      maxBodyBytes: 50000,
      maxSystemBytes: 2000,
      modelLimits: { m: { maxBodyBytes: 6000, maxSystemBytes: 2000 } },
      proactiveToolLimit: 3,
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });
    gwPort = await listen(gw.server);
  });

  after(async () => {
    await up.close();
    await new Promise((r) => gw.server.close(r));
  });

  test("happy path: a small request within limits reaches the upstream", async () => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }] });
    const res = await post(gwPort, "/chat/completions", body);
    assert.equal(res.status, 200);
    assert.equal(up.requests.length, 1);
  });

  test("edge case: an oversized tool-heavy request is reduced and retried instead of rejected", async () => {
    up.requests.length = 0;
    const tools = Array.from({ length: 20 }, (_, i) => fakeTool(i));
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }], tools });
    const res = await post(gwPort, "/chat/completions", body);
    assert.equal(res.status, 200, "the reduced-tools retry must let an otherwise-oversized request through");
    assert.equal(up.requests.length, 1);
    const upstreamBody = JSON.parse(up.requests[0].body.toString());
    assert.ok(upstreamBody.tools.length <= 3, `expected tools reduced to <=3, got ${upstreamBody.tools.length}`);
  });

  test("failure case: a request still over the system-byte limit after the retry is rejected, history intact", async () => {
    up.requests.length = 0;
    const body = JSON.stringify({
      model: "m",
      messages: [{ role: "system", content: "s".repeat(3000) }, { role: "user", content: "hello" }],
    });
    const res = await post(gwPort, "/chat/completions", body);
    assert.equal(res.status, 413);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error.code, "request_too_large");
    assert.equal(parsed.error.param, "system");
    assert.match(parsed.error.message, /history was not modified/);
    assert.equal(up.requests.length, 0, "an oversized request must never reach the upstream");
  });

  test("failure case: ingress rejects a body too large to admit before it is ever parsed", async () => {
    up.requests.length = 0;
    // Exceeds even the global ingress ceiling (50000, the max across every
    // configured model), so this must be rejected while still streaming in,
    // never reaching JSON.parse or the per-model retry logic at all.
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(60000) }] });
    const res = await post(gwPort, "/chat/completions", body);
    assert.equal(res.status, 413);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error.code, "request_too_large");
    assert.equal(parsed.error.param, "body");
    assert.equal(up.requests.length, 0);
  });
});
