/**
 * rail-attribution.test.mjs: card e19f88db / SKGW-ATTRIBUTION-01
 *
 * Provider-neutral rail attribution tests for request_log fields:
 * - client, application, logical_route, rail, provider, backend_node,
 *   requested_model, served_model, runtime_revision
 *
 * These fields allow grouping chiap08 Qwen3.8 traffic by logical rail,
 * backend node, requested model, and served model without exposing
 * private endpoint, credential, or protected prompt data.
 *
 * Run with: node --test --import ./tests/_setup.mjs tests/rail-attribution.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createMetricsCollector } from "../src/metrics/collector.mjs";
import { loadConfig } from "../src/config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(__dirname, "..", "src", "index.mjs");

// Load config silently for tests
await loadConfig({ configPath: '/nonexistent/skgw-rail-attrib-test.yaml', silent: true });

// ─── helpers ──────────────────────────────────────────────────────────────

/** Ask the OS for a free loopback port, then release it. */
function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/** Stub upstream that returns a simple JSON response.
 * serveModel: string forces the served model (differs from the request to
 * catch requested-versus-served substitution); null OMITS the model field
 * so the gateway must record served_model as NULL. Default echoes. */
function startUpstream(serveModel) {
  return new Promise((res) => {
    const server = http.createServer((req, r) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let body = "";
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const served = serveModel === undefined ? (parsed.model || "test-model") : serveModel;
          body = JSON.stringify({
            id: "cmpl-test",
            ...(served ? { model: served } : {}),
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        } catch {
          body = JSON.stringify({
            id: "cmpl-test",
            model: "test-model",
            choices: [{ message: { role: "assistant", content: "ok" } }],
          });
        }
        r.writeHead(200, { "content-type": "application/json" });
        r.end(body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      res({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Boot the gateway with a test config. */
function bootGateway({ port, dashPort, upstreamUrl, dbPath }) {
  const dir = mkdtempSync(join(tmpdir(), "skgw-rail-attrib-"));
  const cfgPath = join(dir, "gw.yaml");
  writeFileSync(cfgPath, [
    "server:",
    "  bind: 127.0.0.1",
    `  port: ${port}`,
    `  dashboard_port: ${dashPort}`,
    "discovery:",
    "  enabled: false",
    "dashboard:",
    `  port: ${dashPort}`,
    "identity:",
    "  enabled: false",
    "metrics:",
    "  enabled: true",
    `  db_path: ${dbPath}`,
    "backends:",
    "  test-local:",
    `    url: ${upstreamUrl}`,
    "    auth_type: none",
    "    priority: 1",
    "    models:",
    "      - test-model",
    "  test-cloud:",
    `    url: ${upstreamUrl}`,
    "    auth_type: none",
    "    priority: 2",
    "    discovery: nvidia",
    "    models:",
    "      - test-cloud-model",
    "",
  ].join("\n"));

  const child = spawn(process.execPath, [INDEX, "--config", cfgPath, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolveBoot, rejectBoot) => {
    let out = "";
    const onData = (buf) => {
      out += buf.toString();
      if (/\[skgateway\] listening/.test(out)) resolveBoot({ child, dir, cfgPath });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => rejectBoot(new Error(`gateway exited early (${code}):\n${out}`)));
    setTimeout(() => rejectBoot(new Error(`gateway did not start in time:\n${out}`)), 20000);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── schema tests ──────────────────────────────────────────────────────────

describe("rail attribution schema", () => {
  let dbDir, dbPath, metrics;

  before(() => {
    dbDir = mkdtempSync(join(tmpdir(), "skgw-rail-attrib-db-"));
    dbPath = join(dbDir, "metrics.db");
    // Initialize collector to create schema
    metrics = createMetricsCollector({ enabled: true, db_path: dbPath });
  });

  after(() => {
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  test("request_log has all attribution columns", () => {
    const db = new Database(dbPath);
    const cols = db.prepare("PRAGMA table_info(request_log)").all();
    const colNames = new Set(cols.map((c) => c.name));

    // Required fields from card e19f88db
    assert.ok(colNames.has("client"), "missing client column");
    assert.ok(colNames.has("application"), "missing application column");
    assert.ok(colNames.has("logical_route"), "missing logical_route column");
    assert.ok(colNames.has("rail"), "missing rail column");
    assert.ok(colNames.has("provider"), "missing provider column");
    assert.ok(colNames.has("backend_node"), "missing backend_node column");
    assert.ok(colNames.has("requested_model"), "missing requested_model column");
    assert.ok(colNames.has("served_model"), "missing served_model column");
    assert.ok(colNames.has("runtime_revision"), "missing runtime_revision column");

    db.close();
  });

  test("new columns accept NULL (unknown values)", () => {
    const db = new Database(dbPath);
    // This should not throw
    db.prepare(`
      INSERT INTO request_log (id, agent_id, model, started_at)
      VALUES ('test-null-attr', NULL, 'test', ${Date.now()})
    `).run();

    const row = db.prepare("SELECT * FROM request_log WHERE id = 'test-null-attr'").get();
    assert.equal(row.client, null);
    assert.equal(row.application, null);
    assert.equal(row.logical_route, null);
    assert.equal(row.rail, null);
    assert.equal(row.provider, null);
    assert.equal(row.backend_node, null);
    assert.equal(row.requested_model, null);
    assert.equal(row.served_model, null);
    assert.equal(row.runtime_revision, null);

    db.close();
  });
});

// ─── live server tests ─────────────────────────────────────────────────────

describe("rail attribution on live gateway", () => {
  let up, gw, port, dbPath, dbDir;

  before(async () => {
    // Serve a model that DIFFERS from the request so requested-versus-served
    // substitution is detectable (review b62e19f8 finding 3).
    up = await startUpstream("test-served-distinct");
    port = await freePort();
    const dashPort = await freePort();
    dbDir = mkdtempSync(join(tmpdir(), "skgw-rail-attrib-live-"));
    dbPath = join(dbDir, "metrics.db");
    gw = await bootGateway({ port, dashPort, upstreamUrl: up.url, dbPath });
  });

  after(async () => {
    if (gw) { try { gw.child.kill("SIGKILL"); } catch {} rmSync(gw.dir, { recursive: true, force: true }); }
    if (up) await up.close();
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  test("client header is recorded in request_log", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-app": "test-client",
      },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    const reqId = r.headers.get("x-sk-req-id");
    assert.ok(reqId, "no req id returned");

    // Wait for flush
    await sleep(6000);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT * FROM request_log WHERE id = ?").get(reqId);
    db.close();

    assert.ok(row, `no row found for req id ${reqId}`);
    assert.equal(row.client, "test-client");
  });

  test("application (user-agent) is recorded", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "test-app/1.0",
      },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    const reqId = r.headers.get("x-sk-req-id");
    await sleep(6000);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT * FROM request_log WHERE id = ?").get(reqId);
    db.close();

    assert.ok(row);
    assert.equal(row.application, "test-app/1.0");
  });

  test("provider is inferred from backend", async () => {
    // test-cloud backend has discovery: nvidia, so provider should be nvidia
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-cloud-model", messages: [{ role: "user", content: "hi" }] }),
    });
    const reqId = r.headers.get("x-sk-req-id");
    await sleep(6000);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT * FROM request_log WHERE id = ?").get(reqId);
    db.close();

    assert.ok(row);
    assert.equal(row.provider, "nvidia", `expected provider=nvidia, got ${row.provider}`);
  });

  test("rail is inferred from backend", async () => {
    // test-cloud should be cloud rail
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-cloud-model", messages: [{ role: "user", content: "hi" }] }),
    });
    const reqId = r.headers.get("x-sk-req-id");
    await sleep(6000);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT * FROM request_log WHERE id = ?").get(reqId);
    db.close();

    assert.ok(row);
    assert.equal(row.rail, "cloud", `expected rail=cloud, got ${row.rail}`);
  });

  test("backend_node records the backend id", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    const reqId = r.headers.get("x-sk-req-id");
    await sleep(6000);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT * FROM request_log WHERE id = ?").get(reqId);
    db.close();

    assert.ok(row);
    assert.equal(row.backend_node, "test-local", `expected backend_node=test-local, got ${row.backend_node}`);
  });

  test("requested_model and served_model record different facts", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    const reqId = r.headers.get("x-sk-req-id");
    await sleep(6000);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT * FROM request_log WHERE id = ?").get(reqId);
    db.close();

    assert.ok(row);
    assert.equal(row.requested_model, "test-model");
    // The upstream served a different id; recording the requested alias here
    // is exactly the substitution review b62e19f8 finding 1 prohibits.
    assert.equal(row.served_model, "test-served-distinct",
      `served_model must be the upstream-observed model, got ${row.served_model}`);
  });

  test("chiap08 grouping query works over attribution columns", async () => {
    // The acceptance criterion is that traffic can be grouped by logical
    // rail, backend node, requested model, and served model. Run the real
    // query instead of asserting the schema exists (replaces vacuous test).
    await sleep(1000);
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(`
      SELECT logical_route, backend_node, requested_model, served_model, COUNT(*) AS n
      FROM request_log
      WHERE requested_model IS NOT NULL
      GROUP BY logical_route, backend_node, requested_model, served_model
    `).all();
    db.close();

    assert.ok(rows.length >= 1, "grouping query returned no rows");
    const mine = rows.filter((row) => row.requested_model === "test-model");
    assert.ok(mine.length >= 1, "no grouped rows for test-model requests");
    for (const row of mine) {
      assert.equal(row.served_model, "test-served-distinct");
      assert.ok(row.backend_node, "backend_node must group");
    }
  });

  test("runtime_revision is recorded", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    const reqId = r.headers.get("x-sk-req-id");
    await sleep(6000);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT * FROM request_log WHERE id = ?").get(reqId);
    db.close();

    assert.ok(row);
    assert.ok(row.runtime_revision, "runtime_revision should be set");
    // Format should be "readiness:discovery"
    assert.match(row.runtime_revision, /^\d+:\d+$/);
  });

  test("x-sk-provider header is returned to caller", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-cloud-model", messages: [{ role: "user", content: "hi" }] }),
    });

    assert.equal(r.headers.get("x-sk-provider"), "nvidia");
  });

  test("x-sk-rail header is returned to caller", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-cloud-model", messages: [{ role: "user", content: "hi" }] }),
    });

    assert.equal(r.headers.get("x-sk-rail"), "cloud");
  });
});

// The chiap08 grouping acceptance is now covered by the real GROUP BY query
// in the live-gateway describe above. (Replaces the former vacuous
// assert.ok(true) documentation test flagged by review b62e19f8 finding 3.)

// ─── acceptance criteria: no private data ───────────────────────────────────

describe("acceptance: no private endpoint or credential data", () => {
  let up, gw, port, dbPath, dbDir;

  before(async () => {
    up = await startUpstream();
    port = await freePort();
    const dashPort = await freePort();
    dbDir = mkdtempSync(join(tmpdir(), "skgw-rail-attrib-privacy-"));
    dbPath = join(dbDir, "metrics.db");
    gw = await bootGateway({ port, dashPort, upstreamUrl: up.url, dbPath });
  });

  after(async () => {
    if (gw) { try { gw.child.kill("SIGKILL"); } catch {} rmSync(gw.dir, { recursive: true, force: true }); }
    if (up) await up.close();
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  test("attribution fields contain only observable metadata", async () => {
    // Verify that the attribution fields don't contain:
    // - API keys or tokens
    // - Private endpoint URLs with credentials
    // - Protected prompt data
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": "Bearer secret-token-12345",
        "x-app": "test-client",
      },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "secret-password-xyz" }],
      }),
    });
    const reqId = r.headers.get("x-sk-req-id");
    await sleep(6000);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT * FROM request_log WHERE id = ?").get(reqId);
    db.close();

    assert.ok(row);
    // Authorization header should NOT be in any attribution field
    assert.equal(row.client, "test-client");
    assert.ok(!row.application?.includes("secret"));
    assert.ok(!row.provider?.includes("token"));
    assert.ok(!row.backend_node?.includes("secret"));
    assert.ok(!row.requested_model?.includes("password"));
    assert.ok(!row.served_model?.includes("password"));
  });
});

// ─── unknown served model stays NULL ────────────────────────────────────────

describe("served_model is NULL when the upstream sends no model field", () => {
  let up, gw, port, dbPath, dbDir;

  before(async () => {
    // serveModel=null: the upstream response omits the model field entirely.
    up = await startUpstream(null);
    port = await freePort();
    const dashPort = await freePort();
    dbDir = mkdtempSync(join(tmpdir(), "skgw-rail-attrib-null-"));
    dbPath = join(dbDir, "metrics.db");
    gw = await bootGateway({ port, dashPort, upstreamUrl: up.url, dbPath });
  });

  after(async () => {
    if (gw) { try { gw.child.kill("SIGKILL"); } catch {} rmSync(gw.dir, { recursive: true, force: true }); }
    if (up) await up.close();
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  test("records requested but leaves served_model NULL, not the routing candidate", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    const reqId = r.headers.get("x-sk-req-id");
    await sleep(6000);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT * FROM request_log WHERE id = ?").get(reqId);
    db.close();

    assert.ok(row);
    assert.equal(row.requested_model, "test-model");
    // Review b62e19f8 finding 2: no model field upstream means the fact was
    // not observed, and unobserved must survive as NULL, never the candidate.
    assert.equal(row.served_model, null,
      `served_model must be NULL when unobserved, got ${row.served_model}`);
  });
});
