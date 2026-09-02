/**
 * Qwen direct + registry routing share one bounded admission domain (8b64febc).
 * All upstreams are local fixtures; no model or fleet service is contacted.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";

const registryDir = mkdtempSync(join(tmpdir(), "skgw-qwen-capacity-"));
const registryPath = join(registryDir, "registry.yaml");
const previousRegistryPath = process.env.SKMODELS_REGISTRY;
const previousCatalogStorePath = process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH;
after(() => {
  if (previousRegistryPath === undefined) delete process.env.SKMODELS_REGISTRY;
  else process.env.SKMODELS_REGISTRY = previousRegistryPath;
  if (previousCatalogStorePath === undefined) delete process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH;
  else process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = previousCatalogStorePath;
  rmSync(registryDir, { recursive: true, force: true });
});
writeFileSync(registryPath, "backends: {}\nroles: {}\n", "utf8");
process.env.SKMODELS_REGISTRY = registryPath;
process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = join(registryDir, "model-catalog.json");

const { ConnectionPool, getPool, resetPool } = await import(
  "../src/proxy/connection-pool.mjs"
);
const { createRouter, routeAndSend } = await import("../src/proxy/router.mjs");

const HEADERS = { "content-type": "application/json" };
const DOMAIN = {
  "chiap08-qwen38": {
    members: ["chiap08-qwen38", "reg:qwen38"],
    max: 4,
    maxQueue: 4,
    queueTimeoutMs: 30_000,
  },
};

function request(model) {
  return routeAndSend(
    router,
    { model, agentId: "capacity-test" },
    "/v1/chat/completions",
    "POST",
    HEADERS,
    Buffer.from(JSON.stringify({ model, messages: [{ role: "user", content: "bounded" }] })),
    true,
  );
}

function writeRegistry(url) {
  writeFileSync(
    registryPath,
    [
      "backends:",
      "  qwen38:",
      `    url: ${url}`,
      "    model: served-qwen38",
      "    no_failover: true",
      "roles:",
      "  sk-creative: qwen38",
      "defaults:",
      "  role: sk-creative",
      "",
    ].join("\n"),
    "utf8",
  );
  const fresh = new Date(Date.now() + 1000);
  utimesSync(registryPath, fresh, fresh);
}

function createSingleDoorRouter() {
  return createRouter({
    backends: {
      "chiap08-qwen38": {
        url: upstream.url,
        auth_type: "none",
        models: ["qwen3.8-27b"],
        priority: 1,
      },
    },
  });
}

function startHoldingServer() {
  const state = {
    active: 0,
    maxActive: 0,
    totalCalls: 0,
    pending: [],
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      state.active += 1;
      state.totalCalls += 1;
      state.maxActive = Math.max(state.maxActive, state.active);
      let closed = false;
      res.once("close", () => {
        if (closed) return;
        closed = true;
        state.active -= 1;
      });
      state.pending.push(() => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          model: "served-qwen38",
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        state,
        url: `http://127.0.0.1:${port}/v1`,
        releaseOne() {
          const release = state.pending.shift();
          if (release) release();
        },
        releaseAll() {
          for (const release of state.pending.splice(0)) release();
        },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${label}`);
}

let upstream;
let router;

beforeEach(async () => {
  resetPool();
  upstream = await startHoldingServer();
  writeRegistry(upstream.url);
  router = createRouter({
    backends: {
      "chiap08-qwen38": {
        url: upstream.url,
        auth_type: "none",
        models: ["qwen3.8-27b"],
        priority: 1,
      },
      fallback: {
        url: upstream.url,
        auth_type: "none",
        models: ["qwen3.8-27b"],
        priority: 9,
      },
    },
  });
});

afterEach(async () => {
  if (upstream) {
    upstream.releaseAll();
    await upstream.close();
    upstream = null;
  }
  resetPool();
});


describe("chiap08 Qwen shared capacity domain", () => {
  test("mixed direct and registry traffic never exceeds four combined upstream calls", async () => {
    getPool({ capacityDomains: DOMAIN });
    const firstFour = [
      request("qwen3.8-27b"),
      request("sk-creative"),
      request("qwen3.8-27b"),
      request("sk-creative"),
    ];
    await waitFor(() => upstream.state.totalCalls === 4, "four admitted upstream calls");

    const fifth = request("sk-creative");
    const pool = getPool();
    await waitFor(() => pool.getStats("reg:qwen38").queued === 1, "one queued request");
    assert.equal(upstream.state.totalCalls, 4, "the fifth request stays at the gateway");
    assert.equal(upstream.state.maxActive, 4);
    assert.equal(pool.getStats("chiap08-qwen38").active, 4);
    assert.equal(pool.getStats("reg:qwen38").active, 4);

    upstream.releaseOne();
    await waitFor(() => upstream.state.totalCalls === 5, "queued request promotion");
    upstream.releaseAll();
    const results = await Promise.all([...firstFour, fifth]);
    assert.ok(results.every((result) => result.status === 200));
    assert.ok(results.every((result) => result.admissionOutcome === "admitted"));
    assert.ok(results.every((result) => result.backoffClassification === "nonterminal"));
    assert.ok(results.every((result) => result.inflightConcurrency >= 1 && result.inflightConcurrency <= 4));
    assert.ok(results.every((result) => result.queueWaitMs >= 0 && result.queueWaitMs <= 30_000));
    assert.equal(upstream.state.maxActive, 4);
    assert.equal(pool.getStats("chiap08-qwen38").active, 0);
    assert.equal(pool.getStats("chiap08-qwen38").queued, 0);
  });

  test("queue-full and queue-timeout return distinct retryable 503 responses", async () => {
    // This test exercises terminal admission on one physical door. The suite's
    // default fallback is intentionally excluded here: after PR94, a distinct
    // idle capacity domain must receive failover instead of returning 503.
    router = createSingleDoorRouter();
    getPool({
      capacityDomains: {
        "chiap08-qwen38": {
          members: ["chiap08-qwen38", "reg:qwen38"],
          max: 1,
          maxQueue: 1,
          queueTimeoutMs: 30,
        },
      },
    });
    const holder = request("qwen3.8-27b");
    await waitFor(() => upstream.state.totalCalls === 1, "active holder");
    const queued = request("sk-creative");
    await waitFor(() => getPool().getStats("reg:qwen38").queued === 1, "queued request");

    const full = await request("qwen3.8-27b");
    assert.equal(full.status, 503);
    assert.equal(full.headers["retry-after"], "1");
    assert.equal(full.queueWaitMs, 0);
    assert.equal(full.inflightConcurrency, 1);
    assert.equal(full.admissionOutcome, "denied");
    assert.equal(full.backoffClassification, "local_admission_denial");
    assert.equal(full.retryAfterSeconds, 1);
    assert.deepEqual(JSON.parse(full.body).error, {
      message: "Capacity domain chiap08-qwen38 queue is full.",
      code: "capacity_exceeded",
      backend: "chiap08-qwen38",
      capacity_domain: "chiap08-qwen38",
      retryable: true,
      retry_after_seconds: 1,
    });

    const timedOut = await queued;
    assert.equal(timedOut.status, 503);
    assert.equal(timedOut.headers["retry-after"], "1");
    assert.equal(JSON.parse(timedOut.body).error.code, "queue_timeout");
    assert.equal(JSON.parse(timedOut.body).error.capacity_domain, "chiap08-qwen38");
    assert.equal(timedOut.queueWaitMs, 30);
    assert.equal(timedOut.inflightConcurrency, 1);
    assert.equal(timedOut.admissionOutcome, "timeout");
    assert.equal(timedOut.backoffClassification, "timeout");
    assert.equal(getPool().getStats("chiap08-qwen38").totalDropped, 1);
    assert.equal(getPool().getStats("chiap08-qwen38").totalTimedOut, 1);

    upstream.releaseAll();
    assert.equal((await holder).status, 200);
    assert.equal(getPool().getStats("chiap08-qwen38").active, 0);
    assert.equal(getPool().getStats("chiap08-qwen38").queued, 0);
  });

  test("queued client cancellation remains 499 and never reaches fallback or upstream", async () => {
    router = createSingleDoorRouter();
    getPool({
      capacityDomains: {
        "chiap08-qwen38": {
          members: ["chiap08-qwen38", "reg:qwen38"],
          max: 1,
          maxQueue: 1,
          queueTimeoutMs: 1000,
        },
      },
    });
    const holder = request("qwen3.8-27b");
    await waitFor(() => upstream.state.totalCalls === 1, "active holder");
    const controller = new AbortController();
    const cancelled = routeAndSend(
      router,
      { model: "qwen3.8-27b", agentId: "capacity-test" },
      "/v1/chat/completions",
      "POST",
      HEADERS,
      Buffer.from(JSON.stringify({ model: "qwen3.8-27b", messages: [] })),
      true,
      null,
      controller.signal,
    );
    await waitFor(() => getPool().getStats("chiap08-qwen38").queued === 1, "queued request");
    controller.abort();

    const result = await cancelled;
    assert.equal(result.status, 499);
    assert.equal(result.cancelled, true);
    assert.equal(result.failover, false);
    assert.ok(result.queueWaitMs >= 0 && result.queueWaitMs <= 1000);
    assert.equal(result.inflightConcurrency, 1);
    assert.equal(result.admissionOutcome, "cancelled");
    assert.equal(result.backoffClassification, "cancellation");
    assert.equal(upstream.state.totalCalls, 1, "cancelled waiter never reaches any upstream");
    assert.equal(getPool().getStats("chiap08-qwen38").totalCancelled, 1);
    assert.equal(getPool().getStats("chiap08-qwen38").queued, 0);

    upstream.releaseAll();
    assert.equal((await holder).status, 200);
    assert.equal(getPool().getStats("chiap08-qwen38").active, 0);
  });
});


test("source config pins two independent Qwen replica capacity domains", async () => {
  const { load: yamlLoad } = await import("js-yaml");
  const { readFileSync } = await import("node:fs");
  const config = yamlLoad(readFileSync(new URL("../config/skgateway.yaml", import.meta.url), "utf8"));
  assert.deepEqual(config.pooling.capacity_domains["chiap08-qwen38"], {
    members: ["chiap08-qwen38", "reg:qwen38"],
    max: 3,
    maxQueue: 8,
    queueTimeoutMs: 30_000,
  });
  assert.deepEqual(config.pooling.capacity_domains["chiap01-qwen38"], {
    members: ["chiap01-qwen38"],
    max: 2,
    maxQueue: 4,
    queueTimeoutMs: 30_000,
  });
});
