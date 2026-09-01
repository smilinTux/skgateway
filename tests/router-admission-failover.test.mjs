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

describe("non-blocking admission on every candidate but the last", () => {
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

  // THE REGRESSION THIS FILE ORIGINALLY MISSED.
  //
  // Both earlier tests used maxQueue: 0, the single configuration in which the
  // defect cannot appear. Every production capacity domain on the estate runs
  // maxQueue > 0 (chiap08-qwen38 sits at 24), and there the primary ENQUEUES
  // rather than rejecting, so the failover path below it never executes and the
  // request waits out queueTimeoutMs on a door that is already saturated.
  //
  // The wall-clock assertion is the point of the test. Asserting only that the
  // idle door served it would pass even if the request first sat in the primary
  // queue for the full timeout.
  test("a full door with a REAL queue fails over immediately, without queueing", async () => {
    const modelId = `admission-nonblocking-${Date.now()}`;
    const QUEUE_TIMEOUT_MS = 3000;
    const pool = getPool({
      capacityDomains: {
        fullDomain: {
          members: ["full"],
          max: 1,
          maxQueue: 24,               // production shape, not the 0 that hid this
          queueTimeoutMs: QUEUE_TIMEOUT_MS,
        },
      },
    });
    const holder = await pool.acquire("full");
    assert.ok(holder, "the single slot is held");

    const router = createRouter({
      backends: {
        full: { url: full.base, auth_type: "none", models: [modelId], priority: 1 },
        idle: { url: idle.base, auth_type: "none", models: [modelId], priority: 2 },
      },
    });

    const started = Date.now();
    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" },
      "/chat/completions", "POST", HEADERS, bodyFor(modelId), true,
    );
    const elapsed = Date.now() - started;

    assert.equal(r.status, 200, "served by the idle door");
    assert.equal(r.backendId, "idle");
    assert.ok(
      elapsed < QUEUE_TIMEOUT_MS / 2,
      `must not queue on the full door: took ${elapsed}ms of a ${QUEUE_TIMEOUT_MS}ms timeout`,
    );

    // A deferral that fails over successfully is a SERVED request. Counting it
    // as a drop would make the drop metric report healthy failovers as losses.
    const stats = pool.getStats("full");
    assert.equal(stats.totalDeferred, 1, "the deferral is counted as a deferral");
    assert.equal(stats.totalDropped, 0, "and is NOT counted as a drop");
    assert.equal(stats.queued, 0, "nothing was left sitting in the queue");
  });

  test("the LAST candidate still queues and is served when a slot frees", async () => {
    const modelId = `admission-lastqueues-${Date.now()}`;
    const pool = getPool({
      capacityDomains: {
        onlyDomain: { members: ["only"], max: 1, maxQueue: 24, queueTimeoutMs: 5000 },
      },
    });
    const holder = await pool.acquire("only");

    const router = createRouter({
      backends: {
        only: { url: full.base, auth_type: "none", models: [modelId], priority: 1 },
      },
    });

    // Release the slot shortly after the request starts. If the final candidate
    // were also non-blocking this would 503 instead of waiting, which would be
    // a REGRESSION: queueing is correct behaviour when there is nowhere to go.
    const pending = routeAndSend(
      router, { model: modelId, agentId: "test" },
      "/chat/completions", "POST", HEADERS, bodyFor(modelId), true,
    );
    setTimeout(() => pool.release(holder), 150);
    const r = await pending;

    assert.equal(r.status, 200, "the final candidate waited for a slot rather than failing fast");
    assert.equal(pool.getStats("only").totalDeferred, 0, "the final candidate never defers");
  });

  test("nonBlocking acquire rejects at once and leaves the queue empty", async () => {
    const pool = getPool({
      capacityDomains: {
        d: { members: ["b"], max: 1, maxQueue: 24, queueTimeoutMs: 10000 },
      },
    });
    await pool.acquire("b");

    const started = Date.now();
    await assert.rejects(
      () => pool.acquire("b", { nonBlocking: true }),
      (err) => err.code === "capacity_exceeded",
      "a full door under non-blocking admission rejects rather than queueing",
    );
    assert.ok(Date.now() - started < 500, "the rejection is immediate");

    const stats = pool.getStats("b");
    assert.equal(stats.queued, 0);
    assert.equal(stats.totalDeferred, 1);
    assert.equal(stats.totalDropped, 0);
  });
});
