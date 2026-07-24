/**
 * anthropic-spof.test.mjs — claude-code-api :18782 SPOF mitigation (card 2b5bcedd).
 *
 * The gateway routes all claude-* traffic through a single local claude-code-api
 * wrapper (127.0.0.1:18782). If that wrapper dies or wedges, claude-* requests
 * used to hard-fail (or hang) with no fallback. The mitigation:
 *
 *   1. config defines a lower-priority `anthropic-direct` fallback backend for
 *      the same claude-* models, so the router's existing failover machinery
 *      covers the wrapper (wrapper primary → direct fallback on 5xx).
 *   2. sendUpstream() gains an optional idle timeout so a wedged wrapper (accepts
 *      the socket but never replies) fails fast with 504 instead of hanging,
 *      which in turn triggers failover.
 *
 * These tests verify the config wiring, the timeout, and end-to-end failover
 * through routeAndSend() using local mock upstreams (no network, no real creds).
 *
 * Run with:  node --test tests/anthropic-spof.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { URL } from "node:url";

import { loadConfig } from "../src/config.mjs";
import { createRouter, routeAndSend } from "../src/proxy/router.mjs";
import { sendUpstream } from "../src/proxy/upstream.mjs";

// ── mock upstream helpers ──────────────────────────────────────────────────

/** Start an HTTP server with a given request handler. Resolves to {url, base, close}. */
function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      resolve({
        port,
        base: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

/** Handler that always replies with the given status + JSON body. */
const respond = (status, obj) => (req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};

/** Handler that accepts the socket and NEVER replies (a wedged upstream). */
const wedge = () => (_req, _res) => { /* intentionally never respond */ };

const BODY = Buffer.from(JSON.stringify({ model: "claude-test", messages: [] }));
const HEADERS = { "content-type": "application/json" };

// ── 1. config wiring: fallback backend exists and orders after the wrapper ──

describe("config: anthropic-direct fallback backend", () => {
  test("claude-* models resolve to [wrapper, direct] in priority order", async () => {
    const cfg = (await loadConfig({ silent: true })).current();
    const rb = {};
    for (const [id, b] of Object.entries(cfg.backends || {})) {
      rb[id] = { ...b };
      if (b.credentials_path && !b.credentials_file) rb[id].credentials_file = b.credentials_path;
    }
    const router = createRouter({ backends: rb });

    const candidates = await router.route({ model: "claude-opus-4-8" });
    const ids = candidates.map((c) => c.backendId);

    // The wrapper is primary; the direct backend is a strictly lower-priority
    // fallback for the SAME model → the SPOF now has a failover path.
    assert.ok(ids.includes("anthropic"), "wrapper backend must serve claude-*");
    assert.ok(ids.includes("anthropic-direct"), "direct fallback must serve claude-*");
    assert.equal(ids[0], "anthropic", "wrapper must be tried first");
    assert.ok(ids.indexOf("anthropic-direct") > ids.indexOf("anthropic"),
      "direct fallback must come after the wrapper");

    const wrap = router.getBackend("anthropic");
    const direct = router.getBackend("anthropic-direct");
    assert.ok(direct.priority > wrap.priority, "direct must be lower priority (higher number)");
    assert.equal(direct.auth_type, "oauth", "direct fallback uses OAuth to api.anthropic.com");
    assert.ok(wrap.timeout_ms > 0, "wrapper must have a fail-fast idle timeout");
  });
});

// ── 2. sendUpstream idle timeout: wedged upstream fails fast, not forever ────

describe("sendUpstream idle timeout", () => {
  let server;
  afterEach(async () => { if (server) { await server.close(); server = null; } });

  test("wedged upstream resolves with 504 within the timeout window", async () => {
    server = await startServer(wedge());
    const t0 = Date.now();
    const res = await sendUpstream("/v1/chat/completions", "POST", HEADERS, BODY,
      new URL(server.base), 200);
    const elapsed = Date.now() - t0;

    assert.equal(res.status, 504, "wedged upstream must fail fast with 504");
    const err = JSON.parse(res.body.toString("utf-8")).error;
    assert.equal(err.code, "upstream_timeout");
    assert.ok(elapsed < 2000, `must not hang (elapsed=${elapsed}ms)`);
  });

  test("healthy upstream is unaffected by the timeout", async () => {
    server = await startServer(respond(200, { ok: true }));
    const res = await sendUpstream("/v1/chat/completions", "POST", HEADERS, BODY,
      new URL(server.base), 5000);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body.toString("utf-8")).ok, true);
  });

  test("timeoutMs=0 (default) preserves original no-timeout behavior on a healthy call", async () => {
    server = await startServer(respond(200, { ok: 1 }));
    const res = await sendUpstream("/v1/chat/completions", "POST", HEADERS, BODY,
      new URL(server.base));
    assert.equal(res.status, 200);
  });
});

// ── 3. routeAndSend failover: wrapper down → fall over to the fallback ───────

describe("routeAndSend failover for claude-* (wrapper down → fallback)", () => {
  let primary, fallback;
  afterEach(async () => {
    if (primary) { await primary.close(); primary = null; }
    if (fallback) { await fallback.close(); fallback = null; }
  });

  test("wrapper UP → served by primary, no failover", async () => {
    primary = await startServer(respond(200, { from: "wrapper" }));
    fallback = await startServer(respond(200, { from: "direct" }));
    const router = createRouter({ backends: {
      wrapper: { url: primary.base, auth_type: "none", models: ["claude-test"], priority: 2 },
      direct:  { url: fallback.base, auth_type: "none", models: ["claude-test"], priority: 8 },
    }});

    const res = await routeAndSend(router, { model: "claude-test" },
      "/v1/chat/completions", "POST", HEADERS, BODY, false);

    assert.equal(res.status, 200);
    assert.equal(res.backendId, "wrapper");
    assert.equal(res.failover, false);
    assert.equal(JSON.parse(res.body.toString("utf-8")).from, "wrapper");
  });

  test("wrapper returns 5xx → fails over to the direct fallback", async () => {
    primary = await startServer(respond(502, { error: "wrapper down" }));
    fallback = await startServer(respond(200, { from: "direct" }));
    const router = createRouter({ backends: {
      wrapper: { url: primary.base, auth_type: "none", models: ["claude-test"], priority: 2 },
      direct:  { url: fallback.base, auth_type: "none", models: ["claude-test"], priority: 8 },
    }});

    const res = await routeAndSend(router, { model: "claude-test" },
      "/v1/chat/completions", "POST", HEADERS, BODY, false);

    assert.equal(res.status, 200, "request must succeed via fallback, not hard-fail");
    assert.equal(res.backendId, "direct");
    assert.equal(res.failover, true);
    assert.equal(JSON.parse(res.body.toString("utf-8")).from, "direct");
  });

  test("wrapper unreachable (connection refused) → fails over to the fallback", async () => {
    // Bind then immediately close the primary so its port refuses connections.
    const dead = await startServer(respond(200, {}));
    const deadBase = dead.base;
    await dead.close();
    fallback = await startServer(respond(200, { from: "direct" }));

    const router = createRouter({ backends: {
      wrapper: { url: deadBase, auth_type: "none", models: ["claude-test"], priority: 2 },
      direct:  { url: fallback.base, auth_type: "none", models: ["claude-test"], priority: 8 },
    }});

    const res = await routeAndSend(router, { model: "claude-test" },
      "/v1/chat/completions", "POST", HEADERS, BODY, false);

    assert.equal(res.status, 200);
    assert.equal(res.backendId, "direct");
    assert.equal(res.failover, true);
  });

  test("wrapper WEDGED (idle timeout) → fails fast over to the fallback, no hang", async () => {
    primary = await startServer(wedge());
    fallback = await startServer(respond(200, { from: "direct" }));
    const router = createRouter({ backends: {
      // Short idle timeout so a stalled wrapper trips quickly in the test.
      wrapper: { url: primary.base, auth_type: "none", models: ["claude-test"], priority: 2, timeout_ms: 300 },
      direct:  { url: fallback.base, auth_type: "none", models: ["claude-test"], priority: 8 },
    }});

    const t0 = Date.now();
    const res = await routeAndSend(router, { model: "claude-test" },
      "/v1/chat/completions", "POST", HEADERS, BODY, false);
    const elapsed = Date.now() - t0;

    assert.equal(res.status, 200, "must recover via fallback rather than hang");
    assert.equal(res.backendId, "direct");
    assert.equal(res.failover, true);
    assert.ok(elapsed < 3000, `must fail fast, not hang (elapsed=${elapsed}ms)`);
  });
});
