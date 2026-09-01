/**
 * router-admission-failover.test.mjs
 *
 * A pool admission rejection is a CAPACITY outcome on one door, not evidence
 * that the model or backend is unhealthy. It must therefore fail over to the
 * next candidate exactly the way an upstream 5xx does.
 *
 * Before this, routeAndSend returned 503 with failover:false the instant a
 * pool rejected admission, so a full door killed the request even when a
 * sibling door was completely idle.
 *
 * MEASURED on the chi cluster 2026-09-01: chiap08-qwen38 admitted against a
 * vLLM engine sustaining 2 to 3 concurrent while chiap01-qwen38 sat at
 * totalProcessed=0 for its entire lifetime. In the first hour after the
 * admission cap was corrected, 49 of 103 admitted requests timed out with an
 * idle door one position down the candidate list.
 *
 * Run with:  node --test tests/router-admission-failover.test.mjs
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX_DIR = mkdtempSync(join(tmpdir(), "skgw-admission-failover-"));
process.env.SKMODELS_REGISTRY = join(FIX_DIR, "registry.yaml");
process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = join(FIX_DIR, "store.json");
process.env.SKGATEWAY_MODEL_CATALOG_CACHE_PATH = join(FIX_DIR, "cache.json");

const { createRouter, routeAndSend } = await import("../src/proxy/router.mjs");
const { getPool, resetPool } = await import("../src/proxy/connection-pool.mjs");

function startUpstream() {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      done({
        base: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => new Promise((r) => server.close(r)),
        get requestCount() { return requestCount; },
      });
    });
  });
}

const HEADERS = { "content-type": "application/json" };
const bodyFor = (model) => Buffer.from(JSON.stringify({ model, messages: [] }));

describe("pool admission rejection is failover-eligible", () => {
  let full, idle;

  before(async () => {
    full = await startUpstream();
    idle = await startUpstream();
  });

  after(async () => {
    await full.close();
    await idle.close();
    resetPool();
  });

  beforeEach(() => {
    resetPool();
  });

  test("a full door fails over to an idle door instead of returning 503", async () => {
    const modelId = `admission-failover-${Date.now()}`;
    // "full" holds exactly one slot and refuses to queue, so the next request
    // is rejected immediately with capacity_exceeded. "idle" is unbounded.
    const pool = getPool({
      capacityDomains: {
        fullDomain: { members: ["full"], max: 1, maxQueue: 0, queueTimeoutMs: 1000 },
      },
    });
    const holder = await pool.acquire("full");   // occupy the only slot
    assert.ok(holder, "the single slot is held");

    const router = createRouter({
      backends: {
        full: { url: full.base, auth_type: "none", models: [modelId], priority: 1 },
        idle: { url: idle.base, auth_type: "none", models: [modelId], priority: 2 },
      },
    });

    const before = idle.requestCount;
    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" },
      "/chat/completions", "POST", HEADERS, bodyFor(modelId), true,
    );

    assert.equal(r.status, 200, "served by the idle door rather than 503");
    assert.equal(r.backendId, "idle");
    assert.equal(r.failover, true, "the result is marked as a failover");
    assert.equal(idle.requestCount, before + 1, "the idle upstream actually received the request");

    // The rejected door must NOT be marked unhealthy: admission is capacity,
    // not a fault. This is the same rule the 429 path already follows.
    const health = router.getHealth().full;
    assert.equal(health.quarantined, false, "admission rejection must not quarantine");
    assert.equal(health.consecutiveFailures, 0, "admission rejection is not a backend failure");
  });

  test("the LAST candidate still returns 503, unchanged", async () => {
    const modelId = `admission-terminal-${Date.now()}`;
    const pool = getPool({
      capacityDomains: {
        onlyDomain: { members: ["only"], max: 1, maxQueue: 0, queueTimeoutMs: 1000 },
      },
    });
    const holder = await pool.acquire("only");
    assert.ok(holder);

    const router = createRouter({
      backends: {
        only: { url: full.base, auth_type: "none", models: [modelId], priority: 1 },
      },
    });

    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" },
      "/chat/completions", "POST", HEADERS, bodyFor(modelId), true,
    );

    assert.equal(r.status, 503, "with nowhere to fail over to, the 503 stands");
    assert.equal(r.capacityDomain, "onlyDomain");
    const err = JSON.parse(r.body.toString()).error;
    assert.equal(err.retryable, true);
  });
});
