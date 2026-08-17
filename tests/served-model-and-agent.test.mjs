/**
 * served-model-and-agent.test.mjs: card 316dd167 / A8.
 *
 * Two facts the metrics database could not answer before this file existed.
 *
 * 1. WHICH MODEL ANSWERED. No table in metrics.db carried a served-model
 *    column. `token_usage.model` and `request_log.model` are BOTH the model the
 *    caller asked for, and across 1,445 joined rows on the live database they
 *    never once disagreed, because they cannot: they are copies of the same
 *    value. So a backend that silently substituted a different model produced a
 *    row indistinguishable from one that served exactly what was requested.
 *    `request_log.model_served` closes that, sourced from the upstream response
 *    body the gateway is already parsing at the metrics call site.
 *
 *    Note this is NOT the same fact as the `x-sk-model-served` response header
 *    from card 3351d25b. That header carries `result.servedModel`, which is the
 *    model id the ROUTER dispatched, so it echoes the request whenever no
 *    rewrite happened. Measured against a stub that answers with a different
 *    id: the header said `probe-model` (what we asked for) while the body said
 *    `UPSTREAM-SERVED-9b` (what answered). The column records the second one,
 *    which is the only one that can expose a substitution.
 *
 *    HARD RULE, and the reason the negative controls below exist: model_served
 *    must NEVER fall back to the requested model. "Unknown" and "matched" are
 *    different facts, and collapsing them would make every request look like it
 *    got what it asked for, which is worse than having no column at all. When
 *    the response is SSE or otherwise unparseable, the value is NULL.
 *
 * 2. WHO ASKED. `request_log.agent_id` was NULL on all 8,199 rows on the live
 *    database and had never once been populated. There was no test asserting it
 *    ever lands, which is how it stayed empty through a call-site rewrite. The
 *    live-server section below pins the whole write path: a caller that names
 *    itself gets attributed, and a caller that does not stays NULL rather than
 *    being handed an invented or defaulted identity.
 *
 * Structure mirrors tests/attribution-headers.test.mjs: unit-level assertions
 * against the collector, then the REAL gateway booted as a subprocess against a
 * stub upstream on ports discovered at runtime. Never fixed ports: the live
 * fleet gateway owns :18780 and is not ours to disturb, and a hardcoded test
 * port collides with any parallel run and produces a fake red.
 *
 * Run with:
 *   node --test --import ./tests/_setup.mjs tests/served-model-and-agent.test.mjs
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
import { normalizeAgentId, extractIdentity } from "../src/identity/capauth.mjs";
import { loadConfig } from "../src/config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(__dirname, "..", "src", "index.mjs");

// Deterministic pricing, independent of any local config/skgateway.yaml.
await loadConfig({ configPath: "/nonexistent/skgw-a8-test.yaml", silent: true });

/** Metrics-config slice pointing at a throwaway db file. */
function metricsCfg(dir, overrides = {}) {
  return {
    enabled: true,
    db_path: join(dir, "metrics.db"),
    retention_days: 90,
    token_tracking: true,
    cost_tracking: true,
    ...overrides,
  };
}

// ─── 1. unit: the column exists, and only records what was observed ─────────

describe("request_log.model_served (collector level)", () => {
  test("the served model is persisted, and is NOT the requested model", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-a8-"));
    let c;
    try {
      c = createMetricsCollector(metricsCfg(dir));
      const id = c.recordRequest({ agentId: "lumina", model: "sk-default", sessionId: "s1" });
      c.recordResponse({
        reqId: id,
        statusCode: 200,
        backend: "ornith",
        modelServed: "ornith-1.0-9b",
        responseBody: { model: "ornith-1.0-9b", usage: { prompt_tokens: 1, completion_tokens: 1 } },
      });
      c.flush();

      const row = c.db.prepare("SELECT * FROM request_log WHERE id = ?").get(id);
      assert.equal(row.model, "sk-default", "the requested id must stay in .model");
      assert.equal(row.model_served, "ornith-1.0-9b", "the served id must land in .model_served");
      assert.notEqual(
        row.model_served, row.model,
        "the whole point of the column is that it can disagree with the request",
      );
    } finally {
      c?.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("NEGATIVE CONTROL: an unobserved served model is NULL, never the requested one", () => {
    // This is the assertion that a column which always mirrored the request
    // would fail. Without it, a mirrored column passes every happy-path test.
    const dir = mkdtempSync(join(tmpdir(), "skgw-a8-"));
    let c;
    try {
      c = createMetricsCollector(metricsCfg(dir));
      const id = c.recordRequest({ model: "sk-default" });
      c.recordResponse({ reqId: id, statusCode: 200, backend: "ornith" });  // no modelServed
      c.flush();

      const row = c.db.prepare("SELECT * FROM request_log WHERE id = ?").get(id);
      assert.equal(row.model_served, null, "unobserved must be NULL, not a guess");
      assert.notEqual(row.model_served, "sk-default", "must not fall back to the request");
    } finally {
      c?.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty-string served model is treated as unknown, not as a model named ''", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-a8-"));
    let c;
    try {
      c = createMetricsCollector(metricsCfg(dir));
      const id = c.recordRequest({ model: "sk-default" });
      c.recordResponse({ reqId: id, statusCode: 200, modelServed: "" });
      c.flush();
      const row = c.db.prepare("SELECT * FROM request_log WHERE id = ?").get(id);
      assert.equal(row.model_served, null);
    } finally {
      c?.close?.();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── 2. unit: the migration is safe on an existing database ────────────────

describe("model_served migration against a pre-existing database", () => {
  test("adds the column to an old request_log without touching existing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-a8-mig-"));
    const dbPath = join(dir, "metrics.db");
    try {
      // Build the PRE-A8 table exactly as it shipped, and seed a historic row.
      const old = new Database(dbPath);
      old.exec(`
        CREATE TABLE request_log (
          id            TEXT PRIMARY KEY,
          agent_id      TEXT,
          model         TEXT,
          backend       TEXT,
          session_id    TEXT,
          started_at    INTEGER NOT NULL,
          status_code   INTEGER,
          first_byte_ms INTEGER,
          total_ms      INTEGER,
          error_msg     TEXT
        );
      `);
      old.prepare(
        "INSERT INTO request_log (id, model, backend, started_at, status_code) VALUES (?,?,?,?,?)",
      ).run("historic-1", "sk-default", "ornith", 1_700_000_000_000, 200);
      old.close();

      let c;
      try {
        c = createMetricsCollector(metricsCfg(dir));

        const cols = c.db.prepare("PRAGMA table_info(request_log)").all().map((x) => x.name);
        assert.ok(cols.includes("model_served"), "the migration must add the column");

        // NO BACKFILL. History is not retroactively attributed on this fleet:
        // the row was written before the gateway observed served models, and
        // stamping the requested id onto it would manufacture a fact.
        const historic = c.db.prepare("SELECT * FROM request_log WHERE id = 'historic-1'").get();
        assert.equal(historic.model, "sk-default", "existing values must survive untouched");
        assert.equal(historic.backend, "ornith");
        assert.equal(historic.model_served, null, "history must NOT be backfilled");

        // And the migrated table still accepts new writes.
        const id = c.recordRequest({ model: "sk-default" });
        c.recordResponse({ reqId: id, statusCode: 200, modelServed: "claude-sonnet-5" });
        c.flush();
        assert.equal(
          c.db.prepare("SELECT model_served FROM request_log WHERE id = ?").get(id).model_served,
          "claude-sonnet-5",
        );
      } finally {
        c?.close?.();
      }

      // Idempotent: opening the same file again must not throw "duplicate column".
      const again = createMetricsCollector(metricsCfg(dir));
      try {
        assert.ok(
          again.db.prepare("PRAGMA table_info(request_log)").all().some((x) => x.name === "model_served"),
        );
      } finally {
        again.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── 2b. unit: one canonical form for a caller-supplied agent id ───────────

describe("normalizeAgentId", () => {
  test("trims and lower-cases, so one caller is one agent in the rollups", () => {
    // getTokenUsage()/getCosts() filter with `agent_id = @agentId`, an exact
    // match. "Lumina" and "lumina" landing in different rows splits one agent's
    // spend across two keys that no query joins back together.
    assert.equal(normalizeAgentId("  LUMINA  "), "lumina");
    assert.equal(normalizeAgentId("lumina"), "lumina");
  });

  test("absent, blank and non-string all mean UNKNOWN, which is null", () => {
    assert.equal(normalizeAgentId(undefined), null);
    assert.equal(normalizeAgentId(null), null);
    assert.equal(normalizeAgentId(""), null);
    assert.equal(normalizeAgentId("   "), null);
    assert.equal(normalizeAgentId(123), null);
  });

  test("the anonymous SENTINEL is not an agent and never becomes one", () => {
    // ANONYMOUS_AGENT_ID is the value the resolver returns to say "nobody
    // identified themselves". A caller that literally sends
    // `X-Agent-Id: anonymous` must not be recorded as an agent named
    // "anonymous", because that row would be indistinguishable from a real
    // agent and would aggregate with every unattributed request.
    assert.equal(normalizeAgentId("anonymous"), null);
    assert.equal(normalizeAgentId("Anonymous"), null);
  });

  test("extractIdentity uses the SAME canonicaliser, so there is one answer", async () => {
    const registry = { byName: new Map(), byToken: new Map(), defaultAgent: null };
    const resolved = await extractIdentity(
      { method: "POST", url: "/v1/chat/completions", headers: { "x-agent-id": "  LUMINA  " } },
      registry,
    );
    assert.equal(resolved.agent_id, "lumina");
    assert.equal(resolved.method, "header");

    // And the sentinel is not an identity here either. This also closes a gate
    // bypass: `require_agent_id` rejects on `method === 'anonymous'`, so before
    // this a caller could satisfy the gate by sending the literal word that
    // means "I am not identified". The gate is OFF by default and OFF on this
    // fleet, so nothing live changes.
    const sentinel = await extractIdentity(
      { method: "POST", url: "/v1/chat/completions", headers: { "x-agent-id": "anonymous" } },
      registry,
    );
    assert.equal(sentinel.method, "anonymous");
  });
});

// ─── live-server harness ────────────────────────────────────────────────────

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

/** The id the stub upstream claims it served. Deliberately unlike any requested id. */
const SERVED_ID = "stub-substituted-9b";

/**
 * Stub upstream that behaves like a backend performing a SILENT SUBSTITUTION:
 * it answers with a `model` field that is nothing like what was asked for.
 * That is the only shape in which the new column can be distinguished from one
 * that merely mirrors the request.
 *
 * Three response shapes, selected by the requested model id:
 *   stream:true          → SSE, so the gateway's body parse fails (NULL case)
 *   model "a8-nomodel"   → valid JSON with NO `model` key at all (NULL case)
 *   otherwise            → valid JSON naming SERVED_ID
 */
function startUpstream() {
  return new Promise((res) => {
    const server = http.createServer((req, r) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let parsed = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        if (parsed.stream) {
          r.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
          r.write(`data: {"id":"c1","model":"${SERVED_ID}","choices":[{"delta":{"content":"hi"}}]}\n\n`);
          r.write('data: {"id":"c1","choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n');
          r.write("data: [DONE]\n\n");
          r.end();
          return;
        }
        const body = {
          id: "cmpl-a8",
          choices: [{ message: { role: "assistant", content: "hi" } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        };
        if (parsed.model !== "a8-nomodel") body.model = SERVED_ID;
        r.writeHead(200, { "content-type": "application/json" });
        r.end(JSON.stringify(body));
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

/** Boot the REAL gateway as a subprocess; resolve once it logs "listening". */
function bootGateway({ port, dashPort, upstreamUrl, dbPath, storePath, identity = true }) {
  const dir = mkdtempSync(join(tmpdir(), "skgw-a8-gw-"));
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
    // Identity ON by default: this suite is about the agent_id write path, and
    // the registry-backed resolver is the path production actually runs. One
    // section below flips it OFF, because the two configurations used to
    // attribute the SAME caller under two different ids.
    "identity:",
    `  enabled: ${identity}`,
    "metrics:",
    "  enabled: true",
    `  db_path: ${dbPath}`,
    "backends:",
    "  stub:",
    `    url: ${upstreamUrl}`,
    "    auth_type: none",
    "    priority: 1",
    "    models:",
    "      - a8-model",
    "      - a8-nomodel",
    "",
  ].join("\n"));

  const child = spawn(process.execPath, [INDEX, "--config", cfgPath, "--port", String(port)], {
    // The child does not run tests/_setup.mjs, so it inherits the parent's
    // already-isolated store/cache/registry paths rather than reaching for the
    // real per-node files.
    env: { ...process.env, SKGATEWAY_MODEL_CATALOG_STORE_PATH: storePath },
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

// ─── 3. live server ─────────────────────────────────────────────────────────

describe("model_served and agent_id on the live gateway", () => {
  let up, gw, port, dbPath, dbDir;
  /** @type {Record<string, {status:number, headers:Record<string,string>}>} */
  const calls = {};

  /** Poll the metrics file (the collector batch-flushes) for one request_log row. */
  async function rowFor(reqId) {
    for (let i = 0; i < 40; i++) {
      if (existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        let row = null;
        try { row = db.prepare("SELECT * FROM request_log WHERE id = ?").get(reqId) ?? null; } catch {}
        db.close();
        // status_code is only written by the response UPDATE, so a row with one
        // is a CLOSED row. Without this check we could read the insert half.
        if (row && row.status_code !== null) return row;
      }
      await sleep(300);
    }
    return null;
  }

  before(async () => {
    up = await startUpstream();
    port = await freePort();
    const dashPort = await freePort();
    dbDir = mkdtempSync(join(tmpdir(), "skgw-a8-db-"));
    dbPath = join(dbDir, "metrics.db");
    const storePath = join(dbDir, "lifecycle-store.json");
    writeFileSync(storePath, "{}");
    gw = await bootGateway({ port, dashPort, upstreamUrl: up.url, dbPath, storePath });

    const post = async (name, body, headers = {}) => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      await r.text();                       // drain so the connection closes
      calls[name] = { status: r.status, headers: Object.fromEntries(r.headers.entries()) };
    };

    const msgs = [{ role: "user", content: "hi" }];
    await post("plain", { model: "a8-model", messages: msgs }, { "x-agent-id": "lumina", "x-session-id": "a8-sess" });
    await post("anon", { model: "a8-model", messages: msgs });
    await post("stream", { model: "a8-model", stream: true, messages: msgs });
    await post("nomodel", { model: "a8-nomodel", messages: msgs });
    await post("shouty", { model: "a8-model", messages: msgs }, { "x-agent-id": "  LUMINA  " });
    await post("sentinel", { model: "a8-model", messages: msgs }, { "x-agent-id": "anonymous" });
    // What skcode and the Anthropic frontend actually put on the wire: a shared
    // literal bearer token and a client user-agent, and no identity at all.
    await post("skcodeish", { model: "a8-model", messages: msgs }, {
      authorization: "Bearer sk-local",
      "user-agent": "claude-cli/1.0.0 (external, cli)",
      "x-app": "cli",
    });
  });

  after(async () => {
    if (gw) { try { gw.child.kill("SIGKILL"); } catch {} rmSync(gw.dir, { recursive: true, force: true }); }
    if (up) await up.close();
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  test("the row records the model the UPSTREAM served, not the one the caller asked for", async () => {
    const row = await rowFor(calls.plain.headers["x-sk-req-id"]);
    assert.ok(row, "no closed request_log row for the plain call");
    assert.equal(row.model, "a8-model", "the requested id belongs in .model");
    assert.equal(row.model_served, SERVED_ID, "the served id belongs in .model_served");
    // The header from card 3351d25b carries the DISPATCHED model, which here
    // still echoes the request. Asserting they differ is what proves the column
    // is reading the response body and not that header's value.
    assert.equal(calls.plain.headers["x-sk-model-served"], "a8-model");
    assert.notEqual(row.model_served, calls.plain.headers["x-sk-model-served"]);
  });

  test("NEGATIVE CONTROL: an SSE response leaves model_served NULL, never the requested id", async () => {
    const row = await rowFor(calls.stream.headers["x-sk-req-id"]);
    assert.ok(row, "no closed request_log row for the streamed call");
    assert.match(
      calls.stream.headers["content-type"] ?? "", /event-stream/,
      "this must really be the streaming path, not a JSON response in disguise",
    );
    assert.equal(row.model_served, null, "an unparseable body means UNOBSERVED, which is NULL");
    assert.notEqual(row.model_served, "a8-model", "must not fall back to the requested model");
    // The SSE frames DID name SERVED_ID, and we still do not claim it: the
    // gateway parses the buffered body as JSON and that is what fails here. A
    // stream-aware extraction is a separate change with its own evidence.
    assert.notEqual(row.model_served, SERVED_ID);
  });

  test("NEGATIVE CONTROL: a JSON body with no model field leaves model_served NULL", async () => {
    const row = await rowFor(calls.nomodel.headers["x-sk-req-id"]);
    assert.ok(row, "no closed request_log row for the no-model call");
    assert.equal(row.status_code, 200, "the call itself succeeded");
    assert.equal(row.model_served, null);
    assert.notEqual(row.model_served, "a8-nomodel");
  });

  test("agent_id is written for a caller that names itself", async () => {
    const row = await rowFor(calls.plain.headers["x-sk-req-id"]);
    assert.equal(row.agent_id, "lumina", "request_log.agent_id must carry the resolved agent");
    assert.equal(row.session_id, "a8-sess");
  });

  test("agent_id survives into token_usage and cost_log, so spend is attributable", async () => {
    const id = calls.plain.headers["x-sk-req-id"];
    await rowFor(id);
    const db = new Database(dbPath, { readonly: true });
    try {
      const t = db.prepare("SELECT agent_id FROM token_usage WHERE req_id = ?").get(id);
      assert.ok(t, "no token_usage row to attribute");
      assert.equal(t.agent_id, "lumina");
    } finally {
      db.close();
    }
  });

  test("NEGATIVE CONTROL: an unidentified caller stays NULL, and is not given a default identity", async () => {
    const row = await rowFor(calls.anon.headers["x-sk-req-id"]);
    assert.ok(row, "no closed request_log row for the anonymous call");
    assert.equal(row.agent_id, null, "no agent is knowable here, so record none");
    assert.notEqual(row.agent_id, "anonymous", "the sentinel is not an agent and must not be stored");
  });

  test("a caller-supplied agent id is canonicalised, so one agent is one key", async () => {
    const row = await rowFor(calls.shouty.headers["x-sk-req-id"]);
    assert.equal(row.agent_id, "lumina", "'  LUMINA  ' and 'lumina' are the same agent");
  });

  test("NEGATIVE CONTROL: X-Agent-Id: anonymous is the sentinel, not an agent named anonymous", async () => {
    const row = await rowFor(calls.sentinel.headers["x-sk-req-id"]);
    assert.equal(
      row.agent_id, null,
      "storing the sentinel would make unattributed traffic aggregate as a real agent",
    );
  });

  test("NEGATIVE CONTROL: the real skcode/Claude-Code header set carries NO knowable agent", async () => {
    // This is what those callers genuinely send: `Authorization: Bearer
    // sk-local` (a shared literal used by skcode, the pi adapter AND the
    // opencode adapter, so it names a class of caller and not an agent),
    // `user-agent: claude-cli/...` and `x-app: cli` (client software, not an
    // agent). None of it identifies WHO is asking. Deriving an agent from any
    // of it would be inventing one, so the row stays NULL and says so.
    const row = await rowFor(calls.skcodeish.headers["x-sk-req-id"]);
    assert.ok(row, "no closed request_log row for the skcode-shaped call");
    assert.equal(row.agent_id, null);
    assert.notEqual(row.agent_id, "claude-cli", "the client binary is not an agent");
    assert.notEqual(row.agent_id, "sk-local", "a shared literal token is not an agent");
  });
});

// ─── 4. the identity flag must not change WHO a request is attributed to ────

describe("agent_id is the same with identity resolution disabled", () => {
  let up, gw, port, dbPath, dbDir;
  let reqId = null;

  before(async () => {
    up = await startUpstream();
    port = await freePort();
    const dashPort = await freePort();
    dbDir = mkdtempSync(join(tmpdir(), "skgw-a8-db2-"));
    dbPath = join(dbDir, "metrics.db");
    const storePath = join(dbDir, "lifecycle-store.json");
    writeFileSync(storePath, "{}");
    // identity.enabled: false takes a SEPARATE branch in index.mjs that builds
    // the identity object inline from the raw header instead of calling
    // extractIdentity(). Those two branches used to disagree about casing, so
    // the same caller was attributed under two different ids depending on a
    // config flag, and per-agent spend silently split in half.
    gw = await bootGateway({ port, dashPort, upstreamUrl: up.url, dbPath, storePath, identity: false });

    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-id": "  LUMINA  " },
      body: JSON.stringify({ model: "a8-model", messages: [{ role: "user", content: "hi" }] }),
    });
    await r.text();
    reqId = r.headers.get("x-sk-req-id");
  });

  after(async () => {
    if (gw) { try { gw.child.kill("SIGKILL"); } catch {} rmSync(gw.dir, { recursive: true, force: true }); }
    if (up) await up.close();
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  test("the same header yields the same canonical agent_id as with identity ON", async () => {
    assert.ok(reqId, "no req id returned");
    let row = null;
    for (let i = 0; i < 40 && !row; i++) {
      if (existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        try {
          const r = db.prepare("SELECT * FROM request_log WHERE id = ?").get(reqId) ?? null;
          if (r && r.status_code !== null) row = r;
        } catch {}
        db.close();
      }
      if (!row) await sleep(300);
    }
    assert.ok(row, "no closed request_log row");
    assert.equal(row.agent_id, "lumina", "the identity flag must not change WHO this is");
  });

  test("model_served still lands with identity resolution off", async () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      assert.equal(db.prepare("SELECT model_served FROM request_log WHERE id = ?").get(reqId).model_served, SERVED_ID);
    } finally {
      db.close();
    }
  });
});
