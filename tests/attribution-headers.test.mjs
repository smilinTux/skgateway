/**
 * attribution-headers.test.mjs: card 3351d25b / A6.2.
 *
 * The gateway records (id, agent_id, model, backend, session_id, ...) in
 * request_log and used to return NONE of it, so a caller holding a response
 * had no key to join its own request to the row describing it. This file
 * proves the three headers that close that gap are actually on the wire:
 *
 *   x-sk-req-id        request_log.id for THIS call
 *   x-sk-backend       the backend that served it
 *   x-sk-model-served  the model that backend actually served
 *
 * What is verified, and how:
 *
 *   1. Unit: attributionHeaders() omits what it does not know rather than
 *      emitting an empty string, the same discipline energyHeaders() follows.
 *   2. LIVE SERVER: the REAL gateway (src/index.mjs) is booted as a subprocess
 *      against a stub upstream, and real HTTP responses are inspected. Both a
 *      non-streaming and a streaming /v1/chat/completions response are checked,
 *      because a header written by the ordinary relay and a header written by
 *      SSEWriter are two different code paths.
 *   3. NEGATIVE CONTROL, live: a request no backend can serve must OMIT
 *      x-sk-backend and x-sk-model-served, not send them empty. Without this a
 *      header that is always present would prove nothing.
 *   4. The join actually works: the x-sk-req-id a client received is looked up
 *      in the metrics SQLite file the gateway wrote, and must be a real
 *      request_log row naming the same backend the header named.
 *   5. FAILOVER RULE (routeAndSend level): when a request fails over, the
 *      headers name the SERVING attempt and never the attempt that failed, and
 *      never a blend of the two. Same ruling as the energy headers, on purpose.
 *
 * The gateway is booted on ports discovered at runtime, never fixed ones: the
 * live fleet gateway owns :18780 and is not ours to disturb, and a hardcoded
 * test port collides with any parallel run and produces a fake red.
 *
 * Run with:  node --test --import ./tests/_setup.mjs tests/attribution-headers.test.mjs
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

import { attributionHeaders } from "../src/metrics/attribution.mjs";
import { createRouter, routeAndSend } from "../src/proxy/router.mjs";
import { loadConfig } from "../src/config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(__dirname, "..", "src", "index.mjs");

/** A concrete model id this suite tombstones in the lifecycle store. */
const DEAD_MODEL = "vendor/attrib-dead-model";

// ─── 1. unit: omission discipline ───────────────────────────────────────────

describe("attributionHeaders", () => {
  test("a fully known request returns all three headers", () => {
    assert.deepEqual(
      attributionHeaders("req-abc", { backendId: "ornith", servedModel: "qwen3-38b" }),
      {
        "x-sk-req-id": "req-abc",
        "x-sk-backend": "ornith",
        "x-sk-model-served": "qwen3-38b",
      },
    );
  });

  test("no result at all still returns the req id, because the row exists", () => {
    // A request that never reached a backend is still written to request_log,
    // so the id is exactly the join key a caller needs to find out what
    // happened to it.
    assert.deepEqual(attributionHeaders("req-abc", null), { "x-sk-req-id": "req-abc" });
    assert.deepEqual(attributionHeaders("req-abc", undefined), { "x-sk-req-id": "req-abc" });
  });

  test("an unknown backend OMITS the header rather than sending an empty one", () => {
    // "unknown" and "empty" are different facts. An always-present header
    // proves nothing about the call in hand.
    const h = attributionHeaders("req-abc", { backendId: null, servedModel: undefined });
    assert.equal("x-sk-backend" in h, false);
    assert.equal("x-sk-model-served" in h, false);
    assert.equal(h["x-sk-req-id"], "req-abc");
  });

  test("an empty-string backend is treated as unknown, not as a backend named ''", () => {
    const h = attributionHeaders("", { backendId: "", servedModel: "" });
    assert.deepEqual(h, {});
  });

  test("metrics disabled means no req id to hand out, and none is invented", () => {
    // recordRequest returning null (metrics off, or it failed) leaves nothing
    // to join to. The other two facts are still real and still shipped.
    const h = attributionHeaders(null, { backendId: "stub", servedModel: "m" });
    assert.equal("x-sk-req-id" in h, false);
    assert.equal(h["x-sk-backend"], "stub");
  });

  test("bucket attribution names the requested pool and the serving member", () => {
    const h = attributionHeaders("req-bucket", {
      backendId: "local",
      servedModel: "ornith-1.0-9b",
      bucket: "sk-m-secret",
      bucketMember: "ornith-1.0-9b",
    });
    assert.equal(h["x-sk-bucket"], "sk-m-secret");
    assert.equal(h["x-sk-bucket-member"], "ornith-1.0-9b");
  });

  test("non-bucket responses do not grow empty bucket headers", () => {
    const h = attributionHeaders("req-plain", { backendId: "local", servedModel: "m" });
    assert.equal("x-sk-bucket" in h, false);
    assert.equal("x-sk-bucket-member" in h, false);
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

/**
 * Stub upstream. Answers /v1/chat/completions as JSON, or as an SSE stream
 * when the request body asked for stream:true.
 */
function startUpstream() {
  return new Promise((res) => {
    const server = http.createServer((req, r) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let wantStream = false;
        try { wantStream = !!JSON.parse(Buffer.concat(chunks).toString("utf8")).stream; } catch {}
        if (wantStream) {
          r.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
          r.write('data: {"id":"c1","choices":[{"delta":{"content":"hi"}}]}\n\n');
          r.write('data: {"id":"c1","choices":[{"delta":{}}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n');
          r.write("data: [DONE]\n\n");
          r.end();
        } else {
          r.writeHead(200, { "content-type": "application/json" });
          r.end(JSON.stringify({
            id: "cmpl-test",
            choices: [{ message: { role: "assistant", content: "hi" } }],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          }));
        }
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

/**
 * Write a `dead` (tombstoned) lifecycle record into an isolated store file, so
 * the gateway's EOL gate answers 404 for that id with NO backend attempted.
 * That is what gives this suite a real negative control on the live wire: a
 * response written by the ordinary relay path whose serving backend genuinely
 * does not exist. Same file-level seeding tests/router-eol-gate.test.mjs uses
 * (model_catalog_store.mjs has no public "set" API by design).
 */
function seedDeadModel(storePath, modelId) {
  writeFileSync(storePath, JSON.stringify({
    [modelId]: {
      state: "dead",
      last_verified_at: null,
      consecutive_permanent_errors: 3,
      absent_cycles: 3,
      eol_reason: "dropped_from_catalog",
      eol_at: Date.now() - 40 * 24 * 60 * 60 * 1000,
    },
  }, null, 2));
}

/** Boot the REAL gateway as a subprocess; resolve once it logs "listening". */
function bootGateway({ port, dashPort, upstreamUrl, dbPath, storePath }) {
  const dir = mkdtempSync(join(tmpdir(), "skgw-attrib-"));
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
    "  stub:",
    `    url: ${upstreamUrl}`,
    "    auth_type: none",
    "    priority: 1",
    "    models:",
    "      - attrib-model",
    "",
  ].join("\n"));

  const child = spawn(process.execPath, [INDEX, "--config", cfgPath, "--port", String(port)], {
    // The child does not run tests/_setup.mjs, so it inherits the parent's
    // already-isolated store/cache/registry paths rather than reaching for the
    // real per-node files, and we pin the lifecycle store to this suite's own
    // seeded copy on top of that.
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

// ─── 2/3/4. live server ─────────────────────────────────────────────────────

describe("attribution headers on the live gateway", () => {
  let up, gw, port, dbPath, dbDir;
  /** @type {Record<string,string>} */
  let plainHeaders = {}, streamHeaders = {};
  /** @type {{status:number, headers:Record<string,string>}} */
  let unroutable = { status: 0, headers: {} };

  before(async () => {
    up = await startUpstream();
    port = await freePort();
    const dashPort = await freePort();
    dbDir = mkdtempSync(join(tmpdir(), "skgw-attrib-db-"));
    dbPath = join(dbDir, "metrics.db");
    const storePath = join(dbDir, "lifecycle-store.json");
    seedDeadModel(storePath, DEAD_MODEL);
    gw = await bootGateway({ port, dashPort, upstreamUrl: up.url, dbPath, storePath });

    const post = async (body) => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await r.text();                       // drain so the connection closes
      return { status: r.status, headers: Object.fromEntries(r.headers.entries()) };
    };

    plainHeaders = (await post({ model: "attrib-model", messages: [{ role: "user", content: "hi" }] })).headers;
    streamHeaders = (await post({ model: "attrib-model", stream: true, messages: [{ role: "user", content: "hi" }] })).headers;
    // NEGATIVE CONTROL. A backend that claims no models at all still gets
    // handed every unmatched request by candidatesFor()'s fall-back-to-all
    // branch, so "a model nobody serves" is NOT a request without a backend:
    // one really does serve it, and x-sk-backend correctly names it. A model
    // the lifecycle store has tombstoned is the real thing, gated before any
    // backend is attempted.
    unroutable = await post({ model: DEAD_MODEL, messages: [{ role: "user", content: "hi" }] });
  });

  after(async () => {
    if (gw) { try { gw.child.kill("SIGKILL"); } catch {} rmSync(gw.dir, { recursive: true, force: true }); }
    if (up) await up.close();
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
  });

  test("a non-streaming /v1/chat/completions response carries all three headers", () => {
    assert.match(plainHeaders["x-sk-req-id"] ?? "", /\S/, "x-sk-req-id must be on the wire");
    assert.equal(plainHeaders["x-sk-backend"], "stub");
    assert.equal(plainHeaders["x-sk-model-served"], "attrib-model");
  });

  test("a streaming response carries them too (SSEWriter/relay path, not just the JSON one)", () => {
    assert.match(streamHeaders["x-sk-req-id"] ?? "", /\S/);
    assert.equal(streamHeaders["x-sk-backend"], "stub");
    assert.equal(streamHeaders["x-sk-model-served"], "attrib-model");
    assert.match(
      streamHeaders["content-type"] ?? "", /event-stream/,
      "this must really be the streaming path, not a JSON response in disguise",
    );
  });

  test("streaming and non-streaming get DIFFERENT req ids (the header is per call, not a constant)", () => {
    assert.notEqual(plainHeaders["x-sk-req-id"], streamHeaders["x-sk-req-id"]);
  });

  test("NEGATIVE CONTROL: a request no backend served OMITS backend and model, and sends no empty ones", () => {
    const h = unroutable.headers;
    assert.equal(unroutable.status, 404, "the EOL gate answered, so no backend was attempted");
    // Nothing served this, so there is nothing to name. Absent, not blank:
    // "unknown" and "empty" are different facts, and a header that is always
    // present proves nothing about the call in hand.
    assert.equal("x-sk-backend" in h, false, "must be ABSENT, not empty");
    assert.equal("x-sk-model-served" in h, false, "must be ABSENT, not empty");
    // The req id survives, because request_log still holds the row: a caller
    // can still look up what happened to a request that never reached a door.
    assert.match(h["x-sk-req-id"] ?? "", /\S/);
  });

  test("the x-sk-req-id a caller received IS the request_log row id for that call", async () => {
    // The collector batch-flushes every 5s, so poll rather than assume.
    const id = plainHeaders["x-sk-req-id"];
    assert.ok(id, "no req id to join on");
    let row = null;
    for (let i = 0; i < 40 && !row; i++) {
      if (existsSync(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        try {
          row = db.prepare("SELECT * FROM request_log WHERE id = ?").get(id) ?? null;
        } catch { row = null; }
        db.close();
      }
      if (!row) await sleep(300);
    }
    assert.ok(row, `request_log has no row for the id the gateway returned (${id})`);
    assert.equal(row.backend, plainHeaders["x-sk-backend"], "the header and the row must name the same backend");
    assert.equal(row.status_code, 200);
  });
});

// ─── 5. the failover rule ───────────────────────────────────────────────────

function startNamedUpstream(status) {
  return new Promise((res) => {
    const server = http.createServer((req, r) => {
      req.resume();
      req.on("end", () => {
        r.writeHead(status, { "content-type": "application/json" });
        r.end(JSON.stringify(
          status === 200
            ? { id: "c", choices: [{ message: { role: "assistant", content: "hi" } }] }
            : { error: { message: "boom" } },
        ));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      res({ url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

describe("attribution headers name the SERVING attempt on a failover", () => {
  let bad, good;
  before(async () => {
    bad = await startNamedUpstream(500);
    good = await startNamedUpstream(200);
    await loadConfig({ configPath: "/nonexistent/skgw-attribution-test.yaml", silent: true });
  });
  after(async () => { await bad.close(); await good.close(); });

  test("a failover reports the backend that answered, not the one that failed", async () => {
    // THE RULE, written down: these headers describe the serving attempt only,
    // never a blend across attempts, exactly as the energy headers do. One
    // header value has to mean one backend and one model, so it means the one
    // that produced the bytes the client is holding. Per-attempt detail lives
    // in the logs. There is no mid-stream window to worry about either: the
    // gateway buffers whole responses including streamed ones, so the serving
    // backend is already settled before a single header byte is written.
    const router = createRouter({
      backends: {
        primary:  { url: bad.url,  auth_type: "none", models: ["m"], priority: 1 },
        fallback: { url: good.url, auth_type: "none", models: ["m"], priority: 2 },
      },
      siem_log: false,
    });
    const result = await routeAndSend(
      router, { model: "m" }, "/v1/chat/completions", "POST",
      { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ model: "m" })), false, null,
    );

    assert.equal(result.status, 200);
    assert.equal(result.failover, true, "this test is only meaningful if a failover really happened");

    const h = attributionHeaders("req-failover", result);
    assert.equal(h["x-sk-backend"], "fallback", "the SERVING attempt, not the failed one");
    assert.equal(h["x-sk-model-served"], "m");
    assert.equal(
      h["x-sk-backend"].includes("primary"), false,
      "never a blend: one value means one backend",
    );
  });

  test("the served model is the model the door actually serves, not always the one asked for", async () => {
    const result = await routeAndSend(
      createRouter({
        backends: { only: { url: good.url, auth_type: "none", models: ["*"], priority: 1 } },
        siem_log: false,
      }),
      { model: "asked-for" }, "/v1/chat/completions", "POST",
      { "content-type": "application/json" },
      Buffer.from(JSON.stringify({ model: "asked-for" })), false, null,
    );
    // With no candidate-level rewrite in play the two coincide, which is the
    // ordinary case; the field is populated from the candidate rather than
    // from request.model so that a rewriting candidate (@match, cloud
    // fallback, registry) reports what it really served.
    assert.equal(result.servedModel, "asked-for");
    assert.equal(attributionHeaders("r", result)["x-sk-model-served"], "asked-for");
  });
});
