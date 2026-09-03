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

function startUpstream(status = 200) {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
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

  test("a terminal upstream error does not spray to another provider", async () => {
    const terminal = await startUpstream(400);
    try {
      const modelId = `admission-terminal-upstream-${Date.now()}`;
      const router = createRouter({
        backends: {
          terminal: { url: terminal.base, auth_type: "none", models: [modelId], priority: 1 },
          idle: { url: idle.base, auth_type: "none", models: [modelId], priority: 2 },
        },
      });
      const idleBefore = idle.requestCount;

      const r = await routeAndSend(
        router, { model: modelId, agentId: "test" },
        "/chat/completions", "POST", HEADERS, bodyFor(modelId), true,
      );

      assert.equal(r.status, 400);
      assert.equal(r.backendId, "terminal");
      assert.equal(r.failover, false);
      assert.equal(idle.requestCount, idleBefore, "terminal errors must not reach another provider");
    } finally {
      await terminal.close();
    }
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
      (err) => {
        assert.equal(err.code, "capacity_exceeded");
        assert.equal(err.inflightConcurrency, 1,
          "the rejection reports the saturated one-slot domain as active=1");
        return true;
      },
      "a full door under non-blocking admission rejects rather than queueing",
    );
    assert.ok(Date.now() - started < 500, "the rejection is immediate");

    const stats = pool.getStats("b");
    assert.equal(stats.queued, 0);
    assert.equal(stats.totalDeferred, 1);
    assert.equal(stats.totalDropped, 0);
  });

  test("admissionAttempts preserves exact bounded concurrency for every refused door", async () => {
    const modelId = `admission-attempt-concurrency-${Date.now()}`;
    const pool = getPool({
      capacityDomains: {
        firstDomain: { members: ["first"], max: 1, maxQueue: 24, queueTimeoutMs: 3000 },
        lastDomain: { members: ["last"], max: 1, maxQueue: 0, queueTimeoutMs: 3000 },
      },
    });
    assert.ok(await pool.acquire("first"));
    assert.ok(await pool.acquire("last"));
    const router = createRouter({
      backends: {
        first: { url: full.base, auth_type: "none", models: [modelId], priority: 1 },
        last: { url: full.base, auth_type: "none", models: [modelId], priority: 2 },
      },
    });

    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" },
      "/chat/completions", "POST", HEADERS, bodyFor(modelId), true,
    );

    assert.equal(r.status, 503);
    assert.deepEqual(
      r.admissionAttempts.map((attempt) => attempt.inflightConcurrency),
      [1, 1],
      "both the nonblocking first door and terminal last door report active=1",
    );
  });

  test("same-domain aliases produce one terminal rejection, not a retry on the same door", async () => {
    const modelId = `admission-same-domain-terminal-${Date.now()}`;
    const pool = getPool({
      capacityDomains: {
        shared: { members: ["alias-a", "alias-b"], max: 1, maxQueue: 0, queueTimeoutMs: 1000 },
      },
    });
    assert.ok(await pool.acquire("alias-a"));

    const router = createRouter({
      backends: {
        "alias-a": { url: full.base, auth_type: "none", models: [modelId], priority: 1 },
        "alias-b": { url: full.base, auth_type: "none", models: [modelId], priority: 2 },
      },
    });
    const events = [];
    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" },
      "/chat/completions", "POST", HEADERS, bodyFor(modelId), true,
      async (event) => events.push(event),
    );

    assert.equal(r.status, 503);
    assert.equal(r.backendId, "alias-a");
    assert.equal(r.admissionAttempts.length, 1);
    assert.equal(pool.getStats("alias-a").totalDropped, 1);
    assert.equal(
      events.filter((event) => (event.event_type || event.type) === "response").length,
      1,
    );
  });

  test("same-domain aliases are skipped before failing over to a different door", async () => {
    const modelId = `admission-same-domain-skip-${Date.now()}`;
    const pool = getPool({
      capacityDomains: {
        shared: { members: ["alias-a", "alias-b"], max: 1, maxQueue: 24, queueTimeoutMs: 3000 },
      },
    });
    assert.ok(await pool.acquire("alias-a"));

    const router = createRouter({
      backends: {
        "alias-a": { url: full.base, auth_type: "none", models: [modelId], priority: 1 },
        "alias-b": { url: full.base, auth_type: "none", models: [modelId], priority: 2 },
        idle: { url: idle.base, auth_type: "none", models: [modelId], priority: 3 },
      },
    });
    const events = [];
    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" },
      "/chat/completions", "POST", HEADERS, bodyFor(modelId), true,
      async (event) => events.push(event),
    );

    assert.equal(r.status, 200);
    assert.equal(r.backendId, "idle");
    assert.equal(pool.getStats("alias-a").totalDeferred, 1);
    const failovers = events.filter((event) => (event.event_type || event.type) === "failover");
    assert.equal(failovers.length, 1);
    assert.equal((failovers[0].details || failovers[0]).from_backend, "alias-a");
    assert.equal((failovers[0].details || failovers[0]).to_backend, "idle");
  });
});

describe("admission telemetry, attribution and the abort race", () => {
  let full, idle;

  before(async () => { full = await startUpstream(); idle = await startUpstream(); });
  after(async () => { await full.close(); await idle.close(); resetPool(); });
  beforeEach(() => { resetPool(); });

  function twoDoors(modelId) {
    getPool({
      capacityDomains: {
        fullDomain: { members: ["full"], max: 1, maxQueue: 24, queueTimeoutMs: 3000 },
      },
    });
    return createRouter({
      backends: {
        full: { url: full.base, auth_type: "none", models: [modelId], priority: 1 },
        idle: { url: idle.base, auth_type: "none", models: [modelId], priority: 2 },
      },
    });
  }

  const detail = (e) => e.details || e;
  const responses = (evts) =>
    evts.filter((e) => (e.event_type || e.type) === "response").map(detail);

  // DEFECT 1. The rejection used to emit its own "response" event on a
  // NON-final candidate, so a request that failed over successfully produced
  // TWO response events: a 503 and then the 200. Every dashboard counting
  // response events read healthy capacity failover as a 503 rate.
  test("a successful capacity failover emits exactly ONE response event", async () => {
    const modelId = `admission-telemetry-${Date.now()}`;
    const router = twoDoors(modelId);
    assert.ok(await getPool().acquire("full"));

    const events = [];
    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" },
      "/chat/completions", "POST", HEADERS, bodyFor(modelId), true,
      async (e) => { events.push(e); },
    );
    assert.equal(r.status, 200, "served by the idle door");

    const statuses = responses(events).map((d) => d.status);
    assert.deepEqual(statuses, [200],
      `one request, one response event, got ${JSON.stringify(statuses)}`);

    // The capacity detail must not be LOST by removing that event. It rides
    // on the failover event, which is where the step actually belongs.
    const fo = events.filter((e) => (e.event_type || e.type) === "failover").map(detail);
    assert.equal(fo.length, 1, "the failover itself is still recorded");
    assert.equal(fo[0].admission_rejected, true, "carrying the admission detail");
    assert.equal(fo[0].capacity_domain, "fullDomain");
    assert.ok(fo[0].queue_wait_ms !== undefined, "and the queue wait");
    assert.equal(fo[0].inflight_concurrency, 1,
      "and the saturated one-slot door's exact bounded concurrency");
  });

  // DEFECT 2. The previous version of this test allowed an EMPTY attribution
  // list, so deleting the attribution code entirely still passed. Review
  // 2927a814 caught that. It now requires a non-empty, bounded record naming
  // the door that actually refused.
  test("the refusing door is recorded, non-empty and bounded", async () => {
    const modelId = `admission-attrib-${Date.now()}`;
    const router = twoDoors(modelId);
    assert.ok(await getPool().acquire("full"));

    const events = [];
    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" },
      "/chat/completions", "POST", HEADERS, bodyFor(modelId), true,
      async (e) => { events.push(e); },
    );
    assert.equal(r.status, 200);

    const fo = events.filter((e) => (e.event_type || e.type) === "failover").map(detail);
    assert.equal(fo.length, 1);
    assert.equal(fo[0].code, "capacity_exceeded",
      "the reason the door refused is attributed, not merely that it did");
    assert.equal(fo[0].from_backend, "full", "and WHICH door refused");
    assert.ok(fo[0].queue_wait_ms >= 0 && fo[0].queue_wait_ms < 3000,
      "with a bounded queue wait, not an unbounded or absent one");
  });

  // DEFECT 3. Reproduced by review 2927a814: aborting during the admission
  // emission produced the terminal sequence [503, 499] for ONE cancelled
  // request, so a cancellation was counted downstream as a capacity event AND
  // a cancellation. No guard placement alone fixes it, because a guard before
  // the emit cannot see an abort landing inside it and a guard after cannot
  // unsend it. The emit itself was the defect.
  test("a cancelled request emits exactly ONE response event, and it is 499", async () => {
    const modelId = `admission-abortrace-${Date.now()}`;
    const router = twoDoors(modelId);
    assert.ok(await getPool().acquire("full"));

    const ac = new AbortController();
    const events = [];
    const before = idle.requestCount;
    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" },
      "/chat/completions", "POST", HEADERS, bodyFor(modelId), true,
      async (e) => {
        events.push(e);
        // Abort as soon as anything is emitted for this request. This is the
        // window review 2927a814 used; driving it from the emitter makes the
        // race deterministic rather than hoping a timer lands inside it.
        ac.abort();
      },
      ac.signal,
    );

    assert.equal(r.status, 499, "a gone client is a cancellation");
    assert.equal(r.failover, false);
    assert.equal(idle.requestCount, before,
      "the idle door must not be dialled for a client that already left");

    const statuses = responses(events).map((d) => d.status);
    assert.deepEqual(statuses, [499],
      `one cancelled request must emit exactly one response event, got ${JSON.stringify(statuses)}`);
  });
});
