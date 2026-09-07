/**
 * Runtime coverage for the qualification startup contract. Every network peer
 * is a synthetic loopback fixture. No provider credentials or fleet services
 * are used.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(__dirname, "..", "src", "index.mjs");
const PROTECTED_MARKER = "synthetic-protected-payload";

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
  });
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(resolveClose));
}

function startJsonServer(handler) {
  const server = http.createServer(handler);
  return listen(server).then((port) => ({ server, port }));
}

function writeConfig(dir, values) {
  const path = join(dir, "qualification.yaml");
  writeFileSync(path, values.join("\n") + "\n");
  return path;
}

function bootGateway({ configPath, env = {} }) {
  const child = spawn(process.execPath, [INDEX, "--config", configPath], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolveBoot, rejectBoot) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) rejectBoot(new Error(`gateway did not start:\n${output}`));
    }, 15_000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (!settled && output.includes("[skgateway] listening")) {
        settled = true;
        clearTimeout(timer);
        resolveBoot({ child, output: () => output });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectBoot(new Error(`gateway exited early (${code}):\n${output}`));
      }
    });
  });
}

async function stopGateway(handle) {
  if (!handle || handle.child.exitCode !== null) return;
  handle.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => handle.child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (handle.child.exitCode === null) handle.child.kill("SIGKILL");
}

async function request(port, path, options = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, options);
}

test("qualification control fields reject contradictory types", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skgw-invalid-startup-"));
  try {
    const configPath = writeConfig(dir, [
      "dashboard:",
      "  enabled: disabled",
      "discovery:",
      "  enabled: disabled",
      "authz:",
      "  enforce: enabled",
      "  trust_internal: strict",
      "  cache_ttl_ms: -1",
      "siem:",
      "  enabled: disabled",
    ]);
    await assert.rejects(
      () => loadConfig({ configPath, silent: true }),
      (error) => {
        assert.equal(error.name, "ConfigError");
        assert.match(error.message, /dashboard\.enabled must be a boolean/);
        assert.match(error.message, /discovery\.enabled must be a boolean/);
        assert.match(error.message, /authz\.enforce must be a boolean/);
        assert.match(error.message, /authz\.trust_internal must be a boolean/);
        assert.match(error.message, /authz\.cache_ttl_ms must be a non-negative number/);
        assert.match(error.message, /siem\.enabled must be a boolean/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("disabled qualification startup", () => {
  let dir;
  let gateway;
  let upstream;
  let discovery;
  let pdp;
  let dashboardGuard;
  let port;
  let dashboardPort;
  let dbPath;
  let discoveryRequests = 0;
  let pdpRequests = 0;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "skgw-disabled-startup-"));
    dbPath = join(dir, "metrics", "qualification.db");

    upstream = await startJsonServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "synthetic-response",
        model: "synthetic-model",
        choices: [{ message: { role: "assistant", content: PROTECTED_MARKER } }],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      }));
    });
    discovery = await startJsonServer((_req, res) => {
      discoveryRequests++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    pdp = await startJsonServer(async (req, res) => {
      pdpRequests++;
      for await (const _chunk of req) { /* drain request */ }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ allow: true, reason: "synthetic allow", obligations: [] }));
    });

    port = await freePort();
    dashboardGuard = http.createServer((_req, res) => res.end("guard-listener"));
    dashboardPort = await listen(dashboardGuard);

    const configPath = writeConfig(dir, [
      "server:",
      "  bind: 127.0.0.1",
      `  port: ${port}`,
      `  dashboard_port: ${dashboardPort}`,
      "dashboard:",
      "  enabled: false",
      "metrics:",
      "  enabled: false",
      `  db_path: ${dbPath}`,
      "pooling:",
      "  default_max_concurrent: 20",
      "  per_backend:",
      "    synthetic:",
      "      max: 7",
      "      maxQueue: 3",
      "      queueTimeoutMs: 12000",
      "discovery:",
      "  enabled: false",
      "authz:",
      "  enforce: true",
      "  trust_internal: false",
      "  cache_ttl_ms: 0",
      `  url: http://127.0.0.1:${pdp.port}`,
      "identity:",
      "  enabled: false",
      "classification:",
      "  enabled: false",
      "siem:",
      "  enabled: false",
      "  outputs:",
      "    - type: file",
      `      path: ${join(dir, "audit.jsonl")}`,
      "backends:",
      "  nvidia:",
      `    url: http://127.0.0.1:${discovery.port}/v1`,
      "    auth_type: none",
      "    models: [synthetic-model]",
      "    priority: 2",
      "  synthetic:",
      `    url: http://127.0.0.1:${upstream.port}/v1`,
      "    auth_type: none",
      "    models: [synthetic-model]",
      "    priority: 1",
    ]);

    gateway = await bootGateway({
      configPath,
      env: { CAPAUTH_AUTHZ_TOKEN: "synthetic-test-token" },
    });
  });

  after(async () => {
    await stopGateway(gateway);
    await Promise.all([
      closeServer(dashboardGuard),
      closeServer(upstream?.server),
      closeServer(discovery?.server),
      closeServer(pdp?.server),
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("only the loopback gateway listener starts and the dashboard port remains untouched", async () => {
    assert.match(gateway.output(), /metrics collector disabled by configuration/);
    assert.match(gateway.output(), /dashboard server disabled by configuration/);
    assert.equal((await request(dashboardPort, "/api/stats")).status, 200);
    assert.equal(await (await request(dashboardPort, "/api/stats")).text(), "guard-listener");
    assert.equal((await request(port, "/dashboard", { redirect: "manual" })).status, 404);
  });

  test("queue reports a configured per-backend pool before its first request", async () => {
    const response = await request(port, "/queue");
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.deepEqual(body.pool, {
      totalActive: 0,
      totalQueued: 0,
      totalCapacity: 7,
      utilization: 0,
    });
    assert.deepEqual(body.backends.synthetic, {
      capacityDomain: "synthetic",
      members: ["synthetic"],
      active: 0,
      queued: 0,
      max: 7,
      maxQueue: 3,
      queueTimeoutMs: 12_000,
      totalProcessed: 0,
      totalDropped: 0,
      totalTimedOut: 0,
      totalCancelled: 0,
      peakActive: 0,
      peakQueue: 0,
    });
  });

  // SKW-AUTONOMY-E1 / card 1911481e: identity is disabled in this fixture
  // (no identityRegistry, so extractIdentity()'s cryptographic capauth path
  // never runs), which means the caller can never be verified here no matter
  // what X-Agent-Id claims. Under strict authz that now denies with 403
  // instead of the pre-fix 200, which used to trust the bare header as the
  // policy-decision subject. The metrics/audit assertions below are the
  // actual point of this test and hold regardless: a fail-closed 403 creates
  // no database and no audit line either.
  test("metrics create no database and expose no request correlation data", async () => {
    const response = await request(port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-id": "qualification-agent" },
      body: JSON.stringify({ model: "synthetic-model", messages: [{ role: "user", content: "synthetic input" }] }),
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /Forbidden by authorization policy/);
    assert.equal(response.headers.has("x-sk-req-id"), false);
    assert.equal(existsSync(dbPath), false);
    assert.equal(existsSync(join(dir, "audit.jsonl")), false);
    const status = await (await request(port, "/status")).json();
    assert.equal(status.metrics, null);
  });

  // SKW-AUTONOMY-E1 / card 1911481e: with identity disabled the caller is
  // never verified, so authz_decide.decide() now fails closed on an empty
  // subject before it ever reaches the network (authz_decide.mjs's own
  // "empty subject or capability" guard), so the PDP fixture is not hit at
  // all. That is a stronger property than the pre-fix behavior this test used
  // to assert (PDP hit twice, no caching): now there is nothing to cache
  // because there is no real subject to ask about.
  test("strict authz fails closed on an unverified caller without ever reaching the PDP", async () => {
    const beforeCount = pdpRequests;
    for (let i = 0; i < 2; i++) {
      const response = await request(port, "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-id": "qualification-agent" },
        body: JSON.stringify({ model: "synthetic-model", messages: [] }),
      });
      assert.equal(response.status, 403);
      await response.arrayBuffer();
    }
    assert.equal(pdpRequests - beforeCount, 0);
  });

  // SKW-AUTONOMY-E1 / card 1911481e: /admin/* is CAP_ADMIN-gated, so it goes
  // through the same unverified-caller fail-closed path as /v1/* above; 403
  // (authz denial) now arrives before the route ever reaches the
  // discovery-disabled 409 it used to return. discoveryRequests staying at 0
  // is still the right assertion either way.
  test("disabled discovery neither polls at startup nor permits forced refresh", async () => {
    assert.equal(discoveryRequests, 0);
    const response = await request(port, "/admin/models/refresh", {
      method: "POST",
      headers: { "x-agent-id": "qualification-agent" },
    });
    assert.equal(response.status, 403);
    assert.equal(discoveryRequests, 0);
  });
});

describe("enabled startup compatibility", () => {
  let dir;
  let gateway;
  let upstream;
  let port;
  let dashboardPort;
  let dbPath;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "skgw-enabled-startup-"));
    dbPath = join(dir, "metrics.db");
    upstream = await startJsonServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        model: "enabled-model",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
    port = await freePort();
    dashboardPort = await freePort();
    const configPath = writeConfig(dir, [
      "server:",
      "  bind: 127.0.0.1",
      `  port: ${port}`,
      `  dashboard_port: ${dashboardPort}`,
      "dashboard:",
      "  enabled: true",
      "metrics:",
      "  enabled: true",
      `  db_path: ${dbPath}`,
      "discovery:",
      "  enabled: false",
      "identity:",
      "  enabled: false",
      "siem:",
      "  enabled: false",
      "  outputs: []",
      "backends:",
      "  synthetic:",
      `    url: http://127.0.0.1:${upstream.port}/v1`,
      "    auth_type: none",
      "    models: [enabled-model]",
      "    priority: 1",
    ]);
    gateway = await bootGateway({ configPath });
  });

  after(async () => {
    await stopGateway(gateway);
    await closeServer(upstream?.server);
    rmSync(dir, { recursive: true, force: true });
  });

  test("dashboard listener and metrics database retain their enabled behavior", async () => {
    assert.equal((await request(dashboardPort, "/api/health")).status, 200);
    assert.equal(existsSync(dbPath), true);
    const response = await request(port, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "enabled-model", messages: [] }),
    });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get("x-sk-req-id"));
    await response.arrayBuffer();
  });
});
