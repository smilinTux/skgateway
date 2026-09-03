/**
 * Context preflight tests (card 9ed4a9f7).
 *
 * A backend may declare context_limit: the true serving-engine token
 * ceiling. The router estimates the request size and skips doors that
 * cannot hold it, failing over to a capable replica, and fails with an
 * explicit 400 naming every limit when no door fits. It never silently
 * truncates and never sends a request to an engine that would truncate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRouter, routeAndSend } from "../src/proxy/router.mjs";

const HEADERS = { "content-type": "application/json" };

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      resolve({ base: `http://127.0.0.1:${srv.address().port}/v1`, close: () => new Promise((r) => srv.close(r)) });
    });
  });
}

const reply = (model) => (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    model, choices: [{ finish_reason: "stop", message: { content: "ok" } }],
  }));
};

test.after(() => {});

test("preflight skips the small-context replica and serves from the capable one", async () => {
  const small = await startServer(reply("served"));
  const big = await startServer(reply("served"));
  const router = createRouter({ backends: {
    "chiap01-qwen38": { url: small.base, auth_type: "none", models: ["qwen3.8-27b"], priority: 1, context_limit: 32768 },
    "chiap08-qwen38": { url: big.base, auth_type: "none", models: ["qwen3.8-27b"], priority: 3, context_limit: 131072 },
  } });
  // ~200KB body: about 51200 estimated tokens, far over 32768, inside 131072.
  const bigPrompt = "x".repeat(200 * 1024);
  const r = await routeAndSend(
    router, { model: "qwen3.8-27b", agentId: "t" }, "/v1/chat/completions", "POST", HEADERS,
    Buffer.from(JSON.stringify({ model: "qwen3.8-27b", messages: [{ role: "user", content: bigPrompt }] })),
    true,
  );
  assert.equal(r.status, 200, `expected the capable replica to serve, got ${r.status}`);
  assert.equal(r.backendId, "chiap08-qwen38", "the small replica must be skipped");
  await small.close(); await big.close();
});

test("all doors too small fails with an explicit 400 naming every limit", async () => {
  const srv = await startServer(reply("served"));
  const router = createRouter({ backends: {
    only: { url: srv.base, auth_type: "none", models: ["qwen3.8-27b"], priority: 1, context_limit: 32768 },
  } });
  const bigPrompt = "x".repeat(200 * 1024);
  const r = await routeAndSend(
    router, { model: "qwen3.8-27b", agentId: "t" }, "/v1/chat/completions", "POST", HEADERS,
    Buffer.from(JSON.stringify({ model: "qwen3.8-27b", messages: [{ role: "user", content: bigPrompt }] })),
    true,
  );
  assert.equal(r.status, 400);
  const err = JSON.parse(r.body.toString("utf-8")).error;
  assert.equal(err.code, "context_exceeded");
  assert.equal(err.retryable, false);
  assert.deepEqual(err.backends, [{ backend: "only", context_limit: 32768 }]);
  await srv.close();
});

test("backends without context_limit keep today's passthrough behavior", async () => {
  const srv = await startServer(reply("served"));
  const router = createRouter({ backends: {
    open: { url: srv.base, auth_type: "none", models: ["qwen3.8-27b"], priority: 1 },
  } });
  const bigPrompt = "x".repeat(400 * 1024);
  const r = await routeAndSend(
    router, { model: "qwen3.8-27b", agentId: "t" }, "/v1/chat/completions", "POST", HEADERS,
    Buffer.from(JSON.stringify({ model: "qwen3.8-27b", messages: [{ role: "user", content: bigPrompt }] })),
    true,
  );
  assert.equal(r.status, 200, "no limit configured means no preflight");
  await srv.close();
});

test("small requests are never preflighted away", async () => {
  const srv = await startServer(reply("served"));
  const router = createRouter({ backends: {
    small: { url: srv.base, auth_type: "none", models: ["qwen3.8-27b"], priority: 1, context_limit: 32768 },
  } });
  const r = await routeAndSend(
    router, { model: "qwen3.8-27b", agentId: "t" }, "/v1/chat/completions", "POST", HEADERS,
    Buffer.from(JSON.stringify({ model: "qwen3.8-27b", messages: [{ role: "user", content: "hi" }] })),
    true,
  );
  assert.equal(r.status, 200);
  await srv.close();
});

test("engine exceed_context_size_error 400 fails over to a larger same-model door, no health penalty", async () => {
  const overflow = (_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "exceed_context_size_error", code: 400 } }));
  };
  const small = await startServer(overflow);
  const big = await startServer(reply("served"));
  const router = createRouter({ backends: {
    "chiap01-qwen38": { url: small.base, auth_type: "none", models: ["qwen3.8-27b"], priority: 1, context_limit: 32768 },
    "chiap08-qwen38": { url: big.base, auth_type: "none", models: ["qwen3.8-27b"], priority: 3, context_limit: 131072 },
  } });
  // Prefilter passes (small prompt), engine still rejects: narrow failover path.
  const r = await routeAndSend(
    router, { model: "qwen3.8-27b", agentId: "t" }, "/v1/chat/completions", "POST", HEADERS,
    Buffer.from(JSON.stringify({ model: "qwen3.8-27b", messages: [{ role: "user", content: "hi" }] })),
    true,
  );
  assert.equal(r.status, 200, `larger door must serve, got ${r.status}`);
  assert.equal(r.backendId, "chiap08-qwen38");
  assert.equal(router.getBackend("chiap01-qwen38").isAvailable(), true,
    "context overflow must not penalize backend health");
  await small.close(); await big.close();
});

test("ordinary 400 stays terminal, no failover", async () => {
  const bad = (_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "bad param" } }));
  };
  const other = await startServer(reply("served"));
  const srv = await startServer(bad);
  const router = createRouter({ backends: {
    a: { url: srv.base, auth_type: "none", models: ["qwen3.8-27b"], priority: 1 },
    b: { url: other.base, auth_type: "none", models: ["qwen3.8-27b"], priority: 3 },
  } });
  const r = await routeAndSend(
    router, { model: "qwen3.8-27b", agentId: "t" }, "/v1/chat/completions", "POST", HEADERS,
    Buffer.from(JSON.stringify({ model: "qwen3.8-27b", messages: [{ role: "user", content: "hi" }] })),
    true,
  );
  assert.equal(r.status, 400, "non-context 400 must stay terminal");
  await srv.close(); await other.close();
});
