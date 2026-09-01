/**
 * Policy-bounded failover after immediate local admission denial.
 *
 * Every upstream is a loopback fixture. The tests exercise only source and
 * in-memory pool state, with no fleet, provider, credential, or runtime use.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, test } from "node:test";

import { getPool, resetPool } from "../src/proxy/connection-pool.mjs";
import { createRouter, routeAndSend } from "../src/proxy/router.mjs";

const MODEL = "admission-test-model";
const HEADERS = { "content-type": "application/json" };
const openServers = new Set();

function startServer(label) {
  const state = { calls: 0 };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      state.calls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        model: MODEL,
        choices: [{ finish_reason: "stop", message: { content: label } }],
      }));
    });
    server.listen(0, "127.0.0.1", () => {
      openServers.add(server);
      resolve({
        state,
        url: `http://127.0.0.1:${server.address().port}/v1`,
      });
    });
  });
}

async function closeServers() {
  await Promise.all([...openServers].map((server) => new Promise((resolve) => {
    server.close(resolve);
  })));
  openServers.clear();
}

afterEach(async () => {
  resetPool();
  await closeServers();
});

function poolConfig(ids, shared = {}) {
  const capacityDomains = {};
  for (const id of ids) {
    if (Object.values(shared).some((members) => members.includes(id))) continue;
    capacityDomains[id] = {
      members: [id],
      max: 1,
      maxQueue: 4,
      queueTimeoutMs: 2500,
    };
  }
  for (const [domain, members] of Object.entries(shared)) {
    capacityDomains[domain] = {
      members,
      max: 1,
      maxQueue: 4,
      queueTimeoutMs: 2500,
    };
  }
  return { capacityDomains };
}

function makeRouter(entries) {
  const backends = {};
  entries.forEach(({ id, url }, index) => {
    backends[id] = {
      url,
      auth_type: "none",
      models: [MODEL],
      priority: index + 1,
    };
  });
  return createRouter({ backends });
}

function send(router, { siem = null, signal = null } = {}) {
  return routeAndSend(
    router,
    { model: MODEL, agentId: "admission-failover-test" },
    "/v1/chat/completions",
    "POST",
    HEADERS,
    Buffer.from(JSON.stringify({ model: MODEL, messages: [] })),
    true,
    siem,
    signal,
  );
}

describe("policy-bounded admission failover", () => {
  test("primary saturation continues to an eligible free replica without queueing", async () => {
    const primary = await startServer("chiap08");
    const replica = await startServer("chiap01");
    const ids = ["chiap08-qwen38", "chiap01-qwen38"];
    const pool = getPool(poolConfig(ids));
    const holder = pool.tryAcquire(ids[0]);

    const result = await send(makeRouter([
      { id: ids[0], url: primary.url },
      { id: ids[1], url: replica.url },
    ]));

    assert.equal(result.status, 200);
    assert.equal(result.backendId, ids[1]);
    assert.equal(result.failover, true);
    assert.equal(primary.state.calls, 0);
    assert.equal(replica.state.calls, 1);
    assert.equal(pool.getStats(ids[0]).queued, 0);
    assert.equal(pool.getStats(ids[0]).totalDropped, 0);
    assert.equal(pool.getStats(ids[1]).active, 0);
    pool.release(holder);
  });

  test("ordered continuation reaches GLM then Codex only when preceding doors are full", async () => {
    const fixtures = await Promise.all([
      startServer("chiap08"),
      startServer("chiap01"),
      startServer("glm"),
      startServer("codex"),
    ]);
    const ids = ["chiap08-qwen38", "chiap01-qwen38", "glm", "codex"];
    const pool = getPool(poolConfig(ids));
    const holders = ids.slice(0, 3).map((id) => pool.tryAcquire(id));
    const router = makeRouter(ids.map((id, index) => ({ id, url: fixtures[index].url })));

    const result = await send(router);

    assert.equal(result.status, 200);
    assert.equal(result.backendId, "codex");
    assert.deepEqual(fixtures.map((fixture) => fixture.state.calls), [0, 0, 0, 1]);
    assert.ok(ids.slice(0, 3).every((id) => pool.getStats(id).queued === 0));
    holders.forEach((ticket) => pool.release(ticket));
  });

  test("a policy-filtered chain never invents a forbidden cloud candidate", async () => {
    const local = await startServer("local");
    const cloud = await startServer("cloud");
    const backing = makeRouter([
      { id: "local-secret", url: local.url },
      { id: "cloud-forbidden", url: cloud.url },
    ]);
    const allowed = (await backing.route({ model: MODEL, agentId: "policy-test" }))
      .filter((candidate) => candidate.backendId === "local-secret");
    const policyRouter = { ...backing, route: async () => allowed };
    const pool = getPool(poolConfig(["local-secret", "cloud-forbidden"]));
    const holder = pool.tryAcquire("local-secret");

    const result = await send(policyRouter);

    assert.equal(result.status, 503);
    assert.equal(JSON.parse(result.body).error.type, "all_candidates_at_capacity");
    assert.equal(cloud.state.calls, 0);
    assert.deepEqual(result.admissionAttempts.map((attempt) => attempt.backend), ["local-secret"]);
    pool.release(holder);
  });

  test("shared capacity aliases cannot evade their common ceiling", async () => {
    const fixtures = await Promise.all([
      startServer("direct"),
      startServer("alias"),
      startServer("replica"),
    ]);
    const ids = ["qwen-direct", "reg:qwen", "qwen-replica"];
    const pool = getPool(poolConfig(ids, { "qwen-shared": ids.slice(0, 2) }));
    const holder = pool.tryAcquire("qwen-direct");

    const result = await send(makeRouter(ids.map((id, index) => ({
      id,
      url: fixtures[index].url,
    }))));

    assert.equal(result.status, 200);
    assert.equal(result.backendId, "qwen-replica");
    assert.deepEqual(fixtures.map((fixture) => fixture.state.calls), [0, 0, 1]);
    assert.equal(pool.getStats("qwen-direct").active, 1);
    assert.equal(pool.getStats("reg:qwen").active, 1);
    assert.equal(pool.getStats("qwen-shared").queued, 0);
    pool.release(holder);
  });

  test("cancellation between admission attempts is terminal 499 with no slot leak", async () => {
    const fixtures = await Promise.all([startServer("primary"), startServer("fallback")]);
    const ids = ["primary", "fallback"];
    const pool = getPool(poolConfig(ids));
    const holder = pool.tryAcquire("primary");
    const controller = new AbortController();
    const events = [];
    const siem = async (event) => {
      events.push(event);
      if (event.event_type === "error" && event.details.type === "pool_capacity_exceeded") {
        controller.abort();
      }
    };

    const result = await send(
      makeRouter(ids.map((id, index) => ({ id, url: fixtures[index].url }))),
      { siem, signal: controller.signal },
    );

    assert.equal(result.status, 499);
    assert.equal(result.cancelled, true);
    assert.equal(result.failover, false);
    assert.deepEqual(fixtures.map((fixture) => fixture.state.calls), [0, 0]);
    assert.equal(pool.getStats("primary").active, 1);
    assert.equal(pool.getStats("fallback").active, 0);
    assert.equal(pool.getStats("fallback").totalCancelled, 1);
    assert.equal(events.filter((event) => event.event_type === "failover").length, 0);
    assert.equal(events.filter((event) => event.event_type === "response").at(-1).details.status, 499);
    pool.release(holder);
  });

  test("external cancellation during delayed failover audit releases admission without committing failover", async () => {
    const fixtures = await Promise.all([startServer("primary"), startServer("fallback")]);
    const ids = ["primary", "fallback"];
    const pool = getPool(poolConfig(ids));
    const holder = pool.tryAcquire("primary");
    const controller = new AbortController();
    const events = [];
    let auditStarted;
    let finishAudit;
    const started = new Promise((resolve) => { auditStarted = resolve; });
    const finish = new Promise((resolve) => { finishAudit = resolve; });
    const siem = async (event) => {
      if (event.event_type === "failover") {
        auditStarted();
        await finish;
        if (controller.signal.aborted) return;
      }
      events.push(event);
    };

    const pending = send(
      makeRouter(ids.map((id, index) => ({ id, url: fixtures[index].url }))),
      { siem, signal: controller.signal },
    );
    await started;
    assert.equal(pool.getStats("fallback").active, 1, "fallback admission is reserved before audit");
    controller.abort();
    finishAudit();
    const result = await pending;

    assert.equal(result.status, 499);
    assert.equal(result.failover, false);
    assert.deepEqual(fixtures.map((fixture) => fixture.state.calls), [0, 0]);
    assert.equal(pool.getStats("fallback").active, 0);
    assert.equal(events.filter((event) => event.event_type === "failover").length, 0);
    assert.equal(events.filter((event) => event.event_type === "response").length, 1);
    pool.release(holder);
  });

  test("callback-caused abort preserves its observed event but releases admission before one 499", async () => {
    const fixtures = await Promise.all([startServer("primary"), startServer("fallback")]);
    const ids = ["primary", "fallback"];
    const pool = getPool(poolConfig(ids));
    const holder = pool.tryAcquire("primary");
    const controller = new AbortController();
    const events = [];
    const siem = async (event) => {
      events.push(event);
      if (event.event_type === "failover") controller.abort();
    };

    const result = await send(
      makeRouter(ids.map((id, index) => ({ id, url: fixtures[index].url }))),
      { siem, signal: controller.signal },
    );

    assert.equal(result.status, 499);
    assert.equal(result.failover, false);
    assert.deepEqual(fixtures.map((fixture) => fixture.state.calls), [0, 0]);
    assert.equal(pool.getStats("fallback").active, 0);
    assert.equal(events.filter((event) => event.event_type === "failover").length, 1);
    assert.equal(events.filter((event) => event.event_type === "response").length, 1);
    pool.release(holder);
  });

  test("all-saturated returns one attributed 503 without health or cooldown mutation", async () => {
    const fixtures = await Promise.all([
      startServer("chiap08"),
      startServer("chiap01"),
      startServer("glm"),
    ]);
    const ids = ["chiap08-qwen38", "chiap01-qwen38", "glm"];
    const router = makeRouter(ids.map((id, index) => ({ id, url: fixtures[index].url })));
    const pool = getPool(poolConfig(ids));
    const holders = ids.map((id) => pool.tryAcquire(id));
    const before = router.getHealth();
    const events = [];

    const result = await send(router, { siem: async (event) => events.push(event) });
    const payload = JSON.parse(result.body);

    assert.equal(result.status, 503);
    assert.equal(result.headers["retry-after"], "3");
    assert.equal(result.queueWaitMs, 0);
    assert.equal(result.admissionOutcome, "denied");
    assert.equal(result.backoffClassification, "local_admission_denial");
    assert.equal(result.failover, true);
    assert.equal(result.admissionAttemptCount, 3);
    assert.deepEqual(result.admissionAttempts.map((attempt) => attempt.backend), ids);
    assert.deepEqual(payload.attempted, result.admissionAttempts);
    assert.equal(payload.attempted_count, 3);
    assert.equal(payload.attribution_truncated, false);
    assert.ok(payload.attempted.every((attempt) => (
      attempt.queue_wait_ms === 0 &&
      attempt.inflight_concurrency === 1 &&
      attempt.queued === 0 &&
      attempt.max_concurrency === 1 &&
      attempt.admission_outcome === "denied"
    )));
    assert.deepEqual(fixtures.map((fixture) => fixture.state.calls), [0, 0, 0]);
    assert.deepEqual(router.getHealth(), before);
    assert.ok(ids.every((id) => pool.getStats(id).totalDropped === 0));
    assert.equal(events.filter((event) => event.event_type === "response").length, 1);

    holders.forEach((ticket) => pool.release(ticket));
    const retry = await send(router);
    assert.equal(retry.status, 200, "admission denial did not arm cooldown or quarantine");
  });

  test("all-saturated attribution stays bounded and names the final attempted candidate", async () => {
    const ids = Array.from({ length: 22 }, (_, index) => `saturated-${index + 1}`);
    const pool = getPool(poolConfig(ids));
    const holders = ids.map((id) => pool.tryAcquire(id));
    const router = makeRouter(ids.map((id) => ({
      id,
      url: "http://127.0.0.1:9/v1",
    })));
    const events = [];

    const result = await send(router, { siem: async (event) => events.push(event) });
    const payload = JSON.parse(result.body);

    assert.equal(result.status, 503);
    assert.equal(result.backendId, ids.at(-1));
    assert.equal(result.admissionAttemptCount, ids.length);
    assert.equal(result.admissionAttempts.length, 20);
    assert.equal(payload.attempted.length, 20);
    assert.equal(payload.attempted_count, ids.length);
    assert.equal(payload.attribution_truncated, true);
    assert.deepEqual(
      payload.attempted.map((attempt) => attempt.backend),
      ids.slice(0, 20),
    );
    assert.equal(events.filter((event) => event.event_type === "response").length, 1);

    holders.forEach((ticket) => pool.release(ticket));
  });
});
