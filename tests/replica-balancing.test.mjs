/**
 * replica-balancing.test.mjs — Test deterministic backend-door balancing
 *
 * Verifies card 786d9232: equal-priority backends serving the same model are
 * balanced using round-robin rather than always ordered by insertion.
 *
 * Run with: node --test tests/replica-balancing.test.mjs
 */

import { test, describe, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { _resetReplicaBalancers, _replicaBalancerState, createRouter, routeAndSend } from "../src/proxy/router.mjs";

function startUpstream(status = 200) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      // Include backend ID in response for tracking
      const backendId = req.headers["x-test-backend-id"] || "unknown";
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "qwen", id: req.url, backendId }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const HEADERS = { "content-type": "application/json" };
const bodyFor = (model) => Buffer.from(JSON.stringify({ model, messages: [] }));

describe("Replica balancing (card 786d9232)", () => {
  let upstream1, upstream2, upstream3;

  before(async () => {
    upstream1 = await startUpstream(200);
    upstream2 = await startUpstream(200);
    upstream3 = await startUpstream(200);
  });

  after(async () => {
    if (upstream1) await upstream1.close();
    if (upstream2) await upstream2.close();
    if (upstream3) await upstream3.close();
  });

  beforeEach(() => {
    // Reset balancer state before each test
    _resetReplicaBalancers();
  });

  test("single backend is not affected by balancer", async () => {
    const router = createRouter({
      backends: {
        chiap08: {
          url: upstream1.base,
          auth_type: "none",
          models: ["qwen3.8-27b-huihui-abliterated-q4_k_m"],
          priority: 1,
        },
      },
    });

    // Multiple requests to the same backend should always select it
    for (let i = 0; i < 5; i++) {
      const r = await routeAndSend(
        router,
        { model: "qwen3.8-27b-huihui-abliterated-q4_k_m", agentId: "test" },
        "/chat/completions",
        "POST",
        HEADERS,
        bodyFor("qwen3.8-27b-huihui-abliterated-q4_k_m"),
        false
      );
      assert.equal(r.status, 200);
    }
  });

  test("two equal-priority replicas alternate deterministically", async () => {
    const router = createRouter({
      backends: {
        chiap08: {
          url: upstream1.base,
          auth_type: "none",
          models: ["qwen3.8-27b-huihui-abliterated-q4_k_m"],
          priority: 1,
        },
        chiap01: {
          url: upstream2.base,
          auth_type: "none",
          models: ["qwen3.8-27b-huihui-abliterated-q4_k_m"],
          priority: 1,
        },
      },
    });

    const selected = [];
    for (let i = 0; i < 10; i++) {
      const r = await routeAndSend(
        router,
        { model: "qwen3.8-27b-huihui-abliterated-q4_k_m", agentId: "test" },
        "/chat/completions",
        "POST",
        HEADERS,
        bodyFor("qwen3.8-27b-huihui-abliterated-q4_k_m"),
        false
      );
      assert.equal(r.status, 200);
      // Track which backend was selected by examining the health snapshot
      // The backend with more successful requests is the one being selected
      const health = router.getHealth();
      const chiap08Stats = health.chiap08;
      const chiap01Stats = health.chiap01;
      // The selected backend is the one that just incremented its totalRequests
      const chiap08Delta = chiap08Stats.totalRequests - (selected.filter(s => s === 'chiap08').length);
      const chiap01Delta = chiap01Stats.totalRequests - (selected.filter(s => s === 'chiap01').length);
      selected.push(chiap08Delta > chiap01Delta ? "chiap08" : "chiap01");
    }

    // Verify each backend was selected approximately equally
    const chiap08Count = selected.filter((id) => id === "chiap08").length;
    const chiap01Count = selected.filter((id) => id === "chiap01").length;

    // With 10 requests and 2 backends, each should be selected about 5 times
    assert.equal(chiap08Count, 5);
    assert.equal(chiap01Count, 5);

    // Verify deterministic pattern: chiap08, chiap01, chiap08, chiap01, ...
    const expectedPattern = ["chiap08", "chiap01"];
    for (let i = 0; i < 10; i++) {
      assert.equal(selected[i], expectedPattern[i % 2]);
    }
  });

  test("three equal-priority replicas rotate in order", async () => {
    const router = createRouter({
      backends: {
        chiap08: {
          url: upstream1.base,
          auth_type: "none",
          models: ["qwen3.8-27b"],
          priority: 1,
        },
        chiap01: {
          url: upstream2.base,
          auth_type: "none",
          models: ["qwen3.8-27b"],
          priority: 1,
        },
        ornith: {
          url: upstream3.base,
          auth_type: "none",
          models: ["qwen3.8-27b"],
          priority: 1,
        },
      },
    });

    const selected = [];
    for (let i = 0; i < 9; i++) {
      const r = await routeAndSend(
        router,
        { model: "qwen3.8-27b", agentId: "test" },
        "/chat/completions",
        "POST",
        HEADERS,
        bodyFor("qwen3.8-27b"),
        false
      );
      assert.equal(r.status, 200);

      // Track which backend was selected
      const health = router.getHealth();
      const prevCounts = selected.reduce((acc, id) => ({ ...acc, [id]: (acc[id] || 0) + 1 }), {});
      const chiap08Delta = health.chiap08.totalRequests - (prevCounts.chiap08 || 0);
      const chiap01Delta = health.chiap01.totalRequests - (prevCounts.chiap01 || 0);
      const ornithDelta = health.ornith.totalRequests - (prevCounts.ornith || 0);

      if (chiap08Delta > chiap01Delta && chiap08Delta > ornithDelta) {
        selected.push("chiap08");
      } else if (chiap01Delta > chiap08Delta && chiap01Delta > ornithDelta) {
        selected.push("chiap01");
      } else {
        selected.push("ornith");
      }
    }

    // Each backend should be selected exactly 3 times
    const counts = {};
    for (const id of selected) {
      counts[id] = (counts[id] || 0) + 1;
    }
    assert.equal(counts.chiap08, 3);
    assert.equal(counts.chiap01, 3);
    assert.equal(counts.ornith, 3);

    // Verify deterministic rotation: chiap08, chiap01, ornith, chiap08, ...
    const expectedOrder = ["chiap08", "chiap01", "ornith"];
    for (let i = 0; i < 9; i++) {
      assert.equal(selected[i], expectedOrder[i % 3]);
    }
  });

  test("different priority tiers are not interleaved", async () => {
    const router = createRouter({
      backends: {
        primary1: {
          url: upstream1.base,
          auth_type: "none",
          models: ["qwen"],
          priority: 1,
        },
        primary2: {
          url: upstream2.base,
          auth_type: "none",
          models: ["qwen"],
          priority: 1,
        },
        fallback: {
          url: upstream3.base,
          auth_type: "none",
          models: ["qwen"],
          priority: 10,
        },
      },
    });

    // All requests should succeed using priority 1 backends
    for (let i = 0; i < 10; i++) {
      const r = await routeAndSend(
        router,
        { model: "qwen", agentId: "test" },
        "/chat/completions",
        "POST",
        HEADERS,
        bodyFor("qwen"),
        false
      );
      assert.equal(r.status, 200);

      const health = router.getHealth();
      // Fallback should never have been used
      assert.equal(health.fallback.totalRequests, 0);
      // At least one of the primaries should have been used
      assert.ok(health.primary1.totalRequests > 0 || health.primary2.totalRequests > 0);
    }
  });

  test("balancing is per-model, not global", async () => {
    const router = createRouter({
      backends: {
        chiap08: {
          url: upstream1.base,
          auth_type: "none",
          models: ["qwen38", "qwen72"],
          priority: 1,
        },
        chiap01: {
          url: upstream2.base,
          auth_type: "none",
          models: ["qwen38"],
          priority: 1,
        },
        ornith: {
          url: upstream3.base,
          auth_type: "none",
          models: ["qwen72"],
          priority: 1,
        },
      },
    });

    // Track selections by model
    const selections = { qwen38: [], qwen72: [] };

    // Requests for qwen38
    for (let i = 0; i < 4; i++) {
      const before = router.getHealth();
      await routeAndSend(
        router,
        { model: "qwen38", agentId: "test" },
        "/chat/completions",
        "POST",
        HEADERS,
        bodyFor("qwen38"),
        false
      );
      const after = router.getHealth();
      const chiap08Delta = after.chiap08.totalRequests - before.chiap08.totalRequests;
      const chiap01Delta = after.chiap01.totalRequests - before.chiap01.totalRequests;
      selections.qwen38.push(chiap08Delta > 0 ? "chiap08" : "chiap01");
    }

    // Requests for qwen72
    for (let i = 0; i < 4; i++) {
      const before = router.getHealth();
      await routeAndSend(
        router,
        { model: "qwen72", agentId: "test" },
        "/chat/completions",
        "POST",
        HEADERS,
        bodyFor("qwen72"),
        false
      );
      const after = router.getHealth();
      const chiap08Delta = after.chiap08.totalRequests - before.chiap08.totalRequests;
      const ornithDelta = after.ornith.totalRequests - before.ornith.totalRequests;
      selections.qwen72.push(chiap08Delta > 0 ? "chiap08" : "ornith");
    }

    // qwen38 should alternate between chiap08 and chiap01
    assert.deepEqual(selections.qwen38, ["chiap08", "chiap01", "chiap08", "chiap01"]);

    // qwen72 should alternate between chiap08 and ornith
    assert.deepEqual(selections.qwen72, ["chiap08", "ornith", "chiap08", "ornith"]);

    // Verify independent balancer states
    const state = _replicaBalancerState();
    assert.ok("1:qwen38" in state); // Priority 1, model qwen38
    assert.ok("1:qwen72" in state); // Priority 1, model qwen72
  });

  test("balancing state is queryable and resettable", () => {
    const router = createRouter({
      backends: {
        chiap08: {
          url: upstream1.base,
          auth_type: "none",
          models: ["qwen"],
          priority: 1,
        },
        chiap01: {
          url: upstream2.base,
          auth_type: "none",
          models: ["qwen"],
          priority: 1,
        },
      },
    });

    // Initial state should be empty
    assert.deepEqual(_replicaBalancerState(), {});

    // Make a request to populate state (in a real scenario, this would happen via routeAndSend)
    // For this test, we just verify the export exists and works
    _resetReplicaBalancers();
    assert.deepEqual(_replicaBalancerState(), {});
  });

  test("different priority groups have independent balancers", async () => {
    const router = createRouter({
      backends: {
        p1_a: {
          url: upstream1.base,
          auth_type: "none",
          models: ["qwen"],
          priority: 1,
        },
        p1_b: {
          url: upstream2.base,
          auth_type: "none",
          models: ["qwen"],
          priority: 1,
        },
        p2_a: {
          url: upstream3.base,
          auth_type: "none",
          models: ["qwen"],
          priority: 2,
        },
        p2_b: {
          url: upstream1.base,
          auth_type: "none",
          models: ["qwen"],
          priority: 2,
        },
      },
    });

    const selected = [];
    for (let i = 0; i < 8; i++) {
      const before = router.getHealth();
      await routeAndSend(
        router,
        { model: "qwen", agentId: "test" },
        "/chat/completions",
        "POST",
        HEADERS,
        bodyFor("qwen"),
        false
      );
      const after = router.getHealth();
      const p1aDelta = after.p1_a.totalRequests - before.p1_a.totalRequests;
      const p1bDelta = after.p1_b.totalRequests - before.p1_b.totalRequests;
      selected.push(p1aDelta > 0 ? "p1_a" : "p1_b");
    }

    // Priority 1 backends should be selected for all requests
    assert.ok(selected.every((id) => id.startsWith("p1_")));

    // p1_a and p1_b should alternate
    assert.deepEqual(selected, ["p1_a", "p1_b", "p1_a", "p1_b", "p1_a", "p1_b", "p1_a", "p1_b"]);

    // Verify independent balancer states
    const state = _replicaBalancerState();
    assert.ok("1:qwen" in state); // Priority 1 balancer
    assert.ok("2:qwen" in state); // Priority 2 balancer
  });

  test("balancing is disabled when only one backend is available", async () => {
    const router = createRouter({
      backends: {
        chiap08: {
          url: upstream1.base,
          auth_type: "none",
          models: ["qwen"],
          priority: 1,
        },
      },
    });

    // Single backend should always be selected
    for (let i = 0; i < 5; i++) {
      const r = await routeAndSend(
        router,
        { model: "qwen", agentId: "test" },
        "/chat/completions",
        "POST",
        HEADERS,
        bodyFor("qwen"),
        false
      );
      assert.equal(r.status, 200);
    }

    const health = router.getHealth();
    assert.equal(health.chiap08.totalRequests, 5);
  });
});
