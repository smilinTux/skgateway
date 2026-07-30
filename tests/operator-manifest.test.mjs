/**
 * Tests for skgateway's served SKWorld module manifest (operator-facet).
 *
 * Two layers, both hermetic (no live gateway, no network beyond a loopback
 * server this test itself starts):
 *   1. The pure builder skgatewayModuleManifest(baseUrl) returns the right shape:
 *      a UI-less service whose operator block mirrors the adapter exactly.
 *   2. The served route GET /.well-known/skworld-module.json returns 200
 *      unauthenticated with the operator block, via the same handler the live
 *      gateway wires into src/index.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  skgatewayModuleManifest,
  handleModuleManifest,
  SCHEMA_VERSION,
} from "../src/operator/manifest.mjs";
import { CONDITIONS, ACTIONS } from "../src/operator/operator.mjs";

// --- 1. pure builder ---------------------------------------------------------

test("manifest identifies skgateway with the v1.1 schema", () => {
  const m = skgatewayModuleManifest("http://localhost:18780");
  assert.equal(m.schemaVersion, "1.1");
  assert.equal(m.schemaVersion, SCHEMA_VERSION);
  assert.equal(m.id, "skgateway");
  assert.equal(m.name, "Gateway");
});

test("manifest is a UI-less service (no fake Flutter package / entry / nav)", () => {
  const m = skgatewayModuleManifest("http://localhost:18780");
  assert.equal(m.grade, "service");
  assert.equal(m.service, true);
  // A backend service declares no UI facet at all.
  assert.ok(!("entry" in m), "service manifest must not carry a UI entry");
  assert.ok(!("nav" in m), "service manifest must not carry a nav pane");
  assert.ok(!("flutter_package" in m), "service manifest must not invent a package");
  assert.deepEqual(m.memory, { opt_in: false });
});

test("health is origin-relative to the serving base", () => {
  assert.equal(
    skgatewayModuleManifest("http://localhost:18780").health,
    "http://localhost:18780/health",
  );
  // Trailing slashes are normalized; a tailnet origin resolves the same way.
  assert.equal(
    skgatewayModuleManifest("http://100.86.156.5:18780/").health,
    "http://100.86.156.5:18780/health",
  );
});

test("operator block mirrors the skgateway adapter exactly", () => {
  const op = skgatewayModuleManifest("http://localhost:18780").operator;
  assert.equal(op.contractVersion, 1);
  assert.equal(op.cli, "skgateway operator");
  assert.deepEqual(op.repos, ["skgateway"]);
  // Conditions match the adapter's CONDITIONS ([UpstreamServing, PoolHealthy]),
  // order-significant.
  assert.deepEqual(op.conditions, ["UpstreamServing", "PoolHealthy"]);
  assert.deepEqual(op.conditions, [...CONDITIONS]);
  // proposedStandardActions == the adapter's standard && reversible action names.
  const expected = ACTIONS.filter((a) => a.standard && a.reversible).map((a) => a.name);
  assert.deepEqual(op.proposedStandardActions, expected);
  assert.deepEqual(op.proposedStandardActions, ["restart_service", "quarantine_dead_alias"]);
  // The non-standard action (raise_pool_limit) is NOT proposed.
  assert.ok(!op.proposedStandardActions.includes("raise_pool_limit"));
});

// --- 2. served route (unauthenticated, 200) ---------------------------------

/** Start a loopback server that serves ONLY the manifest handler, and fetch it. */
async function fetchManifest(path = "/.well-known/skworld-module.json", headers = {}) {
  const server = http.createServer((req, res) => {
    if (req.url === "/.well-known/skworld-module.json" && req.method === "GET") {
      handleModuleManifest(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
    const body = await resp.json();
    return { status: resp.status, body };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("served route returns 200 unauthenticated with the operator block", async () => {
  const { status, body } = await fetchManifest();
  assert.equal(status, 200);
  assert.equal(body.id, "skgateway");
  assert.equal(body.grade, "service");
  assert.ok(body.operator, "served manifest must carry the operator facet");
  assert.equal(body.operator.cli, "skgateway operator");
  assert.deepEqual(body.operator.conditions, ["UpstreamServing", "PoolHealthy"]);
  assert.deepEqual(body.operator.proposedStandardActions, [
    "restart_service",
    "quarantine_dead_alias",
  ]);
});

test("served health URL is relative to the request origin (proxy headers)", async () => {
  // The gateway can sit behind a Cloudflare tunnel / reverse proxy; the handler
  // honors X-Forwarded-* so the served URLs point at the public origin.
  const { body } = await fetchManifest("/.well-known/skworld-module.json", {
    "x-forwarded-proto": "https",
    "x-forwarded-host": "gw.example",
  });
  assert.equal(body.health, "https://gw.example/health");
});
