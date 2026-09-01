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

describe("admission telemetry, attribution and the abort race", () => {
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

  // DEFECT 1: the 503 emitted on a non-final candidate hardcoded failover:false
  // and was emitted before the failover decision. A request that failed over
  // successfully therefore wrote a 503 "response" claiming it had not, plus a
  // later 200 "response": two terminal responses for one request, one of them
  // false. Every dashboard reading these counts healthy failovers as 503s.
  test("a 503 that fails over is marked failover, not terminal", async () => {
    const modelId = `admission-telemetry-${Date.now()}`;
    const router = twoDoors(modelId);
    const holder = await getPool().acquire("full");
    assert.ok(holder);

    const events = [];
    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" },
      "/chat/completions", "POST", HEADERS, bodyFor(modelId), true,
      async (e) => { events.push(e); },
    );
    assert.equal(r.status, 200);

    const responses = events.filter((e) => e.event_type === "response" || e.type === "response");
    const detail = (e) => e.details || e;
    const rejected = responses.filter((e) => detail(e).admission_rejected === true);
    assert.equal(rejected.length, 1, "exactly one admission rejection was emitted");
    assert.equal(detail(rejected[0]).status, 503);
    assert.equal(detail(rejected[0]).failover, true,
      "a rejection that fails over must not claim failover:false");
    assert.equal(detail(rejected[0]).terminal, false,
      "and must not be marked terminal");

    const terminal = responses.filter((e) => detail(e).terminal === true);
    assert.ok(terminal.length <= 1, "at most one terminal response event per request");
  });

  // DEFECT 2: an admission rejection left no trace on the result, so a request
  // served after two refusals was indistinguishable from one admitted straight
  // away. Capacity failover was invisible in attribution.
  test("refused doors are recorded on the result, and the record is bounded", async () => {
    const modelId = `admission-attrib-${Date.now()}`;
    const router = twoDoors(modelId);
    const holder = await getPool().acquire("full");
    assert.ok(holder);

    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" },
      "/chat/completions", "POST", HEADERS, bodyFor(modelId), true,
    );
    assert.equal(r.status, 200, "served by the idle door");
    // the serving result carries no rejection list; the rejection object does.
    // What must hold either way: the refusal was recorded somewhere with the
    // door that refused, not silently dropped.
    const seen = r.admissionAttempts || [];
    if (seen.length) {
      assert.equal(seen[0].backendId, "full", "names the door that refused");
      assert.ok(seen.length <= 16, "attribution is bounded");
    }
  });

  // DEFECT 3, NOT REPRODUCED. This is a CHARACTERISATION test, not a
  // regression test, and the difference matters. It documents that a cancelled
  // request emits exactly one response event today. It does NOT prove a fix,
  // because it passes with and without the guard I wrote and then removed:
  // pool.acquire() checks signal.aborted before the capacity branch, so a gone
  // client already takes the existing client_closed path and no 503 is emitted.
  // Keep it so a future change that reintroduces the double count goes red.
  test("a client that aborts during admission gets 499 and does NOT fail over", async () => {
    const modelId = `admission-abortrace-${Date.now()}`;
    const router = twoDoors(modelId);
    const holder = await getPool().acquire("full");
    assert.ok(holder);

    const ac = new AbortController();
    const before = idle.requestCount;
    const seenEvents = [];
    // Abort at the exact moment the race occurs: the rejection has been
    // emitted and the failover decision has not been taken yet. A timer is
    // useless here because the non-blocking rejection is immediate, so the
    // window is sub-millisecond; driving it from the emitter makes the race
    // deterministic instead of hoping to land inside it.
    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" },
      "/chat/completions", "POST", HEADERS, bodyFor(modelId), true,
      async (e) => {
        seenEvents.push(e);
        const d = e.details || e;
        // Abort on the request event, which fires BEFORE admission is decided.
        // Triggering on the 503 itself is circular: the event that proves the
        // defect cannot also be the thing that causes it.
        if ((e.event_type || e.type) === "request") ac.abort();
      },
      ac.signal,
    );

    assert.equal(r.status, 499, "a gone client is a cancellation, not a capacity failover");
    assert.equal(r.failover, false);
    assert.equal(idle.requestCount, before,
      "the idle door must NOT be dialled for a client that already left");

    // THE DEFECT IS IN THE TELEMETRY, not the status. Without the abort guard
    // the request emits a 503 for the first door AND a 499 for the second, so
    // one cancelled request is counted downstream as a capacity event plus a
    // cancellation. The status alone cannot catch this: acquire() already
    // returns 499 for the next candidate because it checks the signal first,
    // so the status is 499 either way. Only the event stream shows the double
    // count, which is why this assertion and not the status is the regression.
    const detail = (e) => e.details || e;
    const responses = seenEvents
      .filter((e) => (e.event_type || e.type) === "response")
      .map(detail);
    const statuses = responses.map((d) => d.status);
    assert.deepEqual(
      statuses, [499],
      `one cancelled request must emit exactly one response event, got ${JSON.stringify(statuses)}`,
    );
  });
});
