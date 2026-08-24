/**
 * Tests for skgateway's self-served operator-plane HTTP facet (/operator/v1/*,
 * epic c880017b Phase 3 item 4, src/operator/http.mjs).
 *
 * Everything here is hermetic: no live gateway, no network beyond a loopback
 * server this test itself starts (same pattern as operator-manifest.test.mjs),
 * and every data source (router health, pool stats, catalog status) is
 * injected, same testability discipline as operator-cli.test.mjs's injected
 * probe/runner/actuator.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  SCHEMA,
  APP,
  CONDITIONS,
  summarizeUpstream,
  summarizePool,
  summarizeCatalog,
  buildObservation,
  explain,
  handleHealthz,
  handleReadyz,
  handleExplain,
  handleObserve,
  handleAct,
} from "../src/operator/http.mjs";
import { KINDS, ACTIONS } from "../src/operator/operator.mjs";

const T = "2026-08-23T00:00:00.000Z";

/** Map an envelope's conditions to {type: status}. */
function statusMap(envelope) {
  return Object.fromEntries(envelope.conditions.map((c) => [c.type, c.status]));
}

/** Map an envelope's conditions to {type: reason}. */
function reasonMap(envelope) {
  return Object.fromEntries(envelope.conditions.map((c) => [c.type, c.reason ?? null]));
}

// --- explain -----------------------------------------------------------------

describe("explain()", () => {
  test("conditions exactly match what observe() can report", () => {
    const spec = explain();
    assert.deepEqual(spec.conditions, CONDITIONS);
    assert.deepEqual(spec.conditions, ["UpstreamServing", "PoolHealthy", "CatalogFresh"]);
  });

  test("kinds/actions mirror the CLI adapter contract (operator.mjs)", () => {
    const spec = explain();
    assert.deepEqual(spec.kinds, [...KINDS, "catalog"]);
    assert.deepEqual(spec.actions, ACTIONS);
  });

  test("act is explicitly reserved, not silently absent", () => {
    const spec = explain();
    assert.equal(spec.act.implemented, false);
    assert.equal(spec.act.reserved, true);
    assert.match(spec.act.reason, /501|reserved/);
  });
});

// --- summarizeUpstream ---------------------------------------------------------

describe("summarizeUpstream() — fail closed, never healthy without evidence", () => {
  test("no backends configured -> Unknown, never True", () => {
    const c = summarizeUpstream({}, T);
    assert.equal(c.status, "Unknown");
    assert.equal(c.reason, "NoBackendsConfigured");
  });

  test("all backends unobserved (cold start) -> Unknown, never True", () => {
    const c = summarizeUpstream({ a: { status: "unknown" }, b: { status: "unknown" } }, T);
    assert.equal(c.status, "Unknown");
    assert.equal(c.reason, "NoObservedTraffic");
  });

  test("one observed backend down -> False, names it", () => {
    const c = summarizeUpstream({ a: { status: "up" }, b: { status: "down" } }, T);
    assert.equal(c.status, "False");
    assert.equal(c.reason, "BackendDown");
    assert.match(c.message, /\bb\b/);
  });

  test("a degraded (cooldown re-probe) backend is NOT counted as serving -> False", () => {
    const c = summarizeUpstream({ a: { status: "degraded" } }, T);
    assert.equal(c.status, "False");
    assert.equal(c.reason, "BackendDegraded");
  });

  test("all observed backends up, none down/degraded -> True", () => {
    const c = summarizeUpstream({ a: { status: "up" }, b: { status: "up" } }, T);
    assert.equal(c.status, "True");
    assert.equal(c.reason, undefined);
  });

  test("mixed observed-up + unobserved -> True (unobserved contributes no counter-evidence)", () => {
    const c = summarizeUpstream({ a: { status: "up" }, b: { status: "unknown" } }, T);
    assert.equal(c.status, "True");
  });

  test("carries the object/app/schema-shape fields", () => {
    const c = summarizeUpstream({ a: { status: "up" } }, T);
    assert.equal(c.object, "upstreams");
    assert.equal(c.app, APP);
    assert.equal(c.observed_at, T);
    assert.equal(c.polarity, "problem_when_false");
    assert.equal(c.scope, "local");
  });
});

// --- summarizePool ---------------------------------------------------------------

describe("summarizePool() — quarantine and real backpressure only, never inferred", () => {
  test("a quarantined backend -> False regardless of pool stats", () => {
    const c = summarizePool({ nvidia: { quarantined: true } }, { totalActive: 0, totalQueued: 0, totalCapacity: 20 }, T);
    assert.equal(c.status, "False");
    assert.equal(c.reason, "AliasQuarantined");
    assert.match(c.message, /nvidia/);
  });

  test("missing/malformed pool stats -> Unknown, never True", () => {
    const c = summarizePool({}, null, T);
    assert.equal(c.status, "Unknown");
    assert.equal(c.reason, "ProbeFailed");
  });

  test("capacity configured and something genuinely queued -> False", () => {
    const c = summarizePool({}, { totalActive: 20, totalQueued: 3, totalCapacity: 20 }, T);
    assert.equal(c.status, "False");
    assert.equal(c.reason, "PoolSaturated");
  });

  test("active but nothing queued -> True", () => {
    const c = summarizePool({}, { totalActive: 5, totalQueued: 0, totalCapacity: 20 }, T);
    assert.equal(c.status, "True");
  });

  test("zero capacity configured (no pools yet) is not treated as saturated", () => {
    const c = summarizePool({}, { totalActive: 0, totalQueued: 0, totalCapacity: 0 }, T);
    assert.equal(c.status, "True");
  });
});

// --- summarizeCatalog -------------------------------------------------------------

describe("summarizeCatalog() — Unknown when there is genuinely nothing to report", () => {
  test("discovery disabled -> Unknown, not True", () => {
    const c = summarizeCatalog({ stale: false }, false, T);
    assert.equal(c.status, "Unknown");
    assert.equal(c.reason, "DiscoveryDisabled");
  });

  test("missing catalog status -> Unknown", () => {
    const c = summarizeCatalog(null, true, T);
    assert.equal(c.status, "Unknown");
    assert.equal(c.reason, "ProbeFailed");
  });

  test("stale with a down provider -> False, names the provider", () => {
    const c = summarizeCatalog(
      { stale: true, ageSeconds: 30, providers: { nvidia: { ok: false }, openrouter: { ok: true } } },
      true,
      T,
    );
    assert.equal(c.status, "False");
    assert.equal(c.reason, "ProviderUnreachable");
    assert.match(c.message, /nvidia/);
  });

  test("stale with no down provider (overdue poller) -> False, different reason", () => {
    const c = summarizeCatalog({ stale: true, ageSeconds: 9999, providers: {} }, true, T);
    assert.equal(c.status, "False");
    assert.equal(c.reason, "CatalogOverdue");
  });

  test("not stale -> True", () => {
    const c = summarizeCatalog({ stale: false, providers: {} }, true, T);
    assert.equal(c.status, "True");
  });
});

// --- buildObservation --------------------------------------------------------------

describe("buildObservation() — the full envelope, never throws", () => {
  test("all-healthy sources -> all-True envelope, unsigned explicitly", async () => {
    const env = await buildObservation({
      getHealth: () => ({ a: { status: "up" } }),
      getPoolStats: () => ({ totalActive: 1, totalQueued: 0, totalCapacity: 20 }),
      getCatalogStatus: () => ({ stale: false, providers: {} }),
      discoveryEnabled: true,
      now: () => new Date(T).getTime(),
    });
    assert.equal(env.schema, SCHEMA);
    assert.equal(env.app, APP);
    assert.equal(env.observed_at, T);
    assert.equal(env.signature, null);
    assert.equal(env.signer_fpr, null);
    assert.deepEqual(statusMap(env), { UpstreamServing: "True", PoolHealthy: "True", CatalogFresh: "True" });
  });

  test("a throwing getHealth degrades UpstreamServing AND PoolHealthy to Unknown, not 500/throw", async () => {
    const env = await buildObservation({
      getHealth: () => {
        throw new Error("router exploded");
      },
      getPoolStats: () => ({ totalActive: 0, totalQueued: 0, totalCapacity: 20 }),
      getCatalogStatus: () => ({ stale: false, providers: {} }),
      discoveryEnabled: true,
    });
    const statuses = statusMap(env);
    assert.equal(statuses.UpstreamServing, "Unknown");
    assert.equal(statuses.PoolHealthy, "Unknown");
    assert.equal(reasonMap(env).UpstreamServing, "ProbeFailed");
  });

  test("no sources injected at all -> every condition Unknown, still a valid envelope", async () => {
    const env = await buildObservation({});
    for (const c of env.conditions) {
      assert.equal(c.status, "Unknown", `${c.type} should be Unknown with nothing wired`);
    }
    assert.equal(env.conditions.length, CONDITIONS.length);
  });

  test("an async getCatalogStatus that rejects degrades only CatalogFresh", async () => {
    const env = await buildObservation({
      getHealth: () => ({ a: { status: "up" } }),
      getPoolStats: () => ({ totalActive: 0, totalQueued: 0, totalCapacity: 20 }),
      getCatalogStatus: async () => {
        throw new Error("fetch failed");
      },
      discoveryEnabled: true,
    });
    const statuses = statusMap(env);
    assert.equal(statuses.UpstreamServing, "True");
    assert.equal(statuses.PoolHealthy, "True");
    assert.equal(statuses.CatalogFresh, "Unknown");
  });
});

// --- HTTP handlers (hermetic loopback server, mirrors operator-manifest.test.mjs) --

/** Start a loopback server serving only the operator facet, and fetch a path. */
async function fetchOperator(path, { method = "GET", deps = {} } = {}) {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/operator/v1/healthz" && req.method === "GET") return handleHealthz(req, res);
    if (req.url === "/operator/v1/readyz" && req.method === "GET") return handleReadyz(req, res, deps);
    if (req.url === "/operator/v1/explain" && req.method === "GET") return handleExplain(req, res);
    if (req.url === "/operator/v1/observe" && req.method === "GET") return handleObserve(req, res, deps);
    if (req.url === "/operator/v1/act" && req.method === "POST") return handleAct(req, res);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, { method });
    const body = await resp.json();
    return { status: resp.status, body };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("served routes", () => {
  test("GET /operator/v1/healthz -> 200, process liveness only", async () => {
    const { status, body } = await fetchOperator("/operator/v1/healthz");
    assert.equal(status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.service, "skgateway");
  });

  test("GET /operator/v1/readyz -> 503 with named failing dependencies when nothing is wired", async () => {
    const { status, body } = await fetchOperator("/operator/v1/readyz", { deps: {} });
    assert.equal(status, 503);
    assert.equal(body.ready, false);
    assert.ok(body.failing.length >= 2);
  });

  test("GET /operator/v1/readyz -> 200 when required sources are wired and callable", async () => {
    const deps = {
      getHealth: () => ({}),
      getPoolStats: () => ({ totalActive: 0, totalQueued: 0, totalCapacity: 0 }),
    };
    const { status, body } = await fetchOperator("/operator/v1/readyz", { deps });
    assert.equal(status, 200);
    assert.deepEqual(body, { ready: true, failing: [] });
  });

  test("GET /operator/v1/readyz -> 503 when a wired source throws (fail closed, not silently ready)", async () => {
    const deps = {
      getHealth: () => {
        throw new Error("boom");
      },
      getPoolStats: () => ({ totalActive: 0, totalQueued: 0, totalCapacity: 0 }),
    };
    const { status, body } = await fetchOperator("/operator/v1/readyz", { deps });
    assert.equal(status, 503);
    assert.match(body.failing.join(" "), /boom/);
  });

  test("GET /operator/v1/explain -> 200 with the contract", async () => {
    const { status, body } = await fetchOperator("/operator/v1/explain");
    assert.equal(status, 200);
    assert.deepEqual(body.conditions, CONDITIONS);
    assert.equal(body.act.implemented, false);
  });

  test("GET /operator/v1/observe -> 200 with a real envelope from injected sources", async () => {
    const deps = {
      getHealth: () => ({ ornith: { status: "up" } }),
      getPoolStats: () => ({ totalActive: 0, totalQueued: 0, totalCapacity: 20 }),
      getCatalogStatus: () => ({ stale: false, providers: {} }),
      discoveryEnabled: true,
    };
    const { status, body } = await fetchOperator("/operator/v1/observe", { deps });
    assert.equal(status, 200);
    assert.equal(body.schema, "skoperator.observation/v1");
    assert.deepEqual(statusMap(body), { UpstreamServing: "True", PoolHealthy: "True", CatalogFresh: "True" });
  });

  test("GET /operator/v1/observe with a dead backend -> 200 envelope reporting False, never a fabricated True", async () => {
    const deps = {
      getHealth: () => ({ ornith: { status: "down" } }),
      getPoolStats: () => ({ totalActive: 0, totalQueued: 0, totalCapacity: 20 }),
      getCatalogStatus: () => ({ stale: false, providers: {} }),
      discoveryEnabled: true,
    };
    const { status, body } = await fetchOperator("/operator/v1/observe", { deps });
    assert.equal(status, 200);
    assert.equal(statusMap(body).UpstreamServing, "False");
  });

  test("POST /operator/v1/act -> 501, always reserved, never actuates", async () => {
    const { status, body } = await fetchOperator("/operator/v1/act", { method: "POST" });
    assert.equal(status, 501);
    assert.match(body.error, /reserved|not implemented/);
  });
});
