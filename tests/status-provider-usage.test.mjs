/**
 * status-provider-usage.test.mjs (pck3): provider snapshot persistence, the
 * DeepSeek balance read, and GET /status keeping every old field while adding
 * provider_usage and clients. Also the end-to-end client identity: the x-app
 * client lands on audit request/response events and in request_log.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  attachProviderStore, observeProviderUsage, pollDeepseekBalance, providerUsageStatus,
  _resetProviderStoreForTests, _resetProviderUsageForTests,
} from "../src/metrics/provider-usage.mjs";

const INDEX = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.mjs");

test("header windows and the DeepSeek balance persist and show with age on every backend", async () => {
  _resetProviderStoreForTests(); _resetProviderUsageForTests();
  const db = new Database(":memory:");
  const seen = [];
  attachProviderStore({ db, onSnapshot: (b, s, d) => seen.push([b, s, d]) });
  const t0 = Date.parse("2026-11-14T18:00:00Z");
  observeProviderUsage("codex", { status: 200, headers: { "x-codex-primary-used-percent": "82", "x-codex-primary-reset-at": String(t0 / 1000 + 7200), authorization: "Bearer secret" } }, { now: t0 });
  const calls = [];
  const fake = async (url, opts) => { calls.push([url, opts.headers.authorization]); return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "41.20", granted_balance: "0.00", topped_up_balance: "41.20" }] }) }; };
  const r = await pollDeepseekBalance({ key: "sk-test-key", fetchFn: fake, now: () => t0 });
  assert.equal(r.ok, true);
  assert.equal(calls[0][0], "https://api.deepseek.com/user/balance");
  assert.equal(JSON.stringify(r).includes("sk-test-key"), false);
  assert.deepEqual(await pollDeepseekBalance({ key: "" }), { ok: false, reason: "no_key" });
  assert.deepEqual(await pollDeepseekBalance({ key: "k", fetchFn: async () => ({ ok: false, status: 401 }) }), { ok: false, reason: "http_401" });
  for (const empty of [{}, null, { balance_infos: [] }, { is_available: true }]) {
    assert.deepEqual(await pollDeepseekBalance({ key: "k", fetchFn: async () => ({ ok: true, json: async () => empty }) }), { ok: false, reason: "empty_balance" }, JSON.stringify(empty));
  }
  assert.equal(db.prepare("SELECT count(*) n FROM deepseek_balance_log").get().n, 1, "one history row per good poll only");

  _resetProviderStoreForTests(); // restart: memory gone, metrics.db keeps it
  attachProviderStore({ db });
  const st = providerUsageStatus({ now: t0 + 600e3 });
  assert.equal(st.schema, "skgw-provider-usage/1");
  assert.deepEqual(Object.keys(st.backends).sort(), ["codex", "deepseek", "zai"]);
  const w = st.backends.codex.sources.headers.windows[0];
  assert.deepEqual([w.name, w.unit, w.remaining, w.used_percent], ["primary", "percent", 18, 82]);
  assert.equal(st.backends.codex.age_seconds, 600);
  assert.equal(st.backends.deepseek.sources.balance.balances[0].total_balance, 41.2);
  assert.equal(st.backends.zai.observed_at, null);
  assert.equal(st.backends.zai.age_seconds, null);
  assert.equal(JSON.stringify(st).includes("secret"), false);
  assert.ok(seen.some(([b, s]) => b === "codex" && s === "headers") && seen.some(([b, s]) => b === "deepseek" && s === "balance"));
});

// ── live gateway: /status fields and client identity end to end ──
const listen = (server) => new Promise((ok, no) => { server.once("error", no); server.listen(0, "127.0.0.1", () => ok(server.address().port)); });
let upstream, gw, port, dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "skgw-status-"));
  upstream = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "synthetic-model", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }));
    });
  });
  const up = await listen(upstream);
  const s = net.createServer(); port = await listen(s); await new Promise((r) => s.close(r));
  writeFileSync(join(dir, "caps.yaml"), `enabled: true\nexempt_backends: [synthetic]\nfamilies: {}\nalerts: { outbox: ${join(dir, "alerts.jsonl")} }\ndeepseek_balance_poll_minutes: 0\n`);
  writeFileSync(join(dir, "gw.yaml"), [
    "server:", "  bind: 127.0.0.1", `  port: ${port}`,
    "dashboard:", "  enabled: false", "discovery:", "  enabled: false",
    "identity:", "  enabled: false", "classification:", "  enabled: false",
    "metrics:", "  enabled: true", `  db_path: ${join(dir, "metrics.db")}`,
    "siem:", "  enabled: true", "  outputs:", "    - type: file", `      path: ${join(dir, "audit.jsonl")}`,
    "backends:", "  synthetic:", `    url: http://127.0.0.1:${up}/v1`, "    auth_type: none", "    models: [synthetic-model]", "    priority: 1",
  ].join("\n") + "\n");
  const child = spawn(process.execPath, [INDEX, "--config", join(dir, "gw.yaml")], { env: { ...process.env, SKGATEWAY_CLIENT_CAPS: join(dir, "caps.yaml"), HOME: dir }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  gw = await new Promise((ok, no) => {
    const timer = setTimeout(() => no(new Error("no boot:\n" + out)), 15000);
    const on = (c) => { out += c; if (out.includes("[skgateway] listening")) { clearTimeout(timer); ok(child); } };
    child.stdout.on("data", on); child.stderr.on("data", on);
    child.once("exit", (code) => no(new Error(`exit ${code}:\n${out}`)));
  });
});

after(async () => {
  gw?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  upstream?.close();
});

const chat = (headers = {}) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ model: "synthetic-model", messages: [{ role: "user", content: "PROMPT-MARKER-77" }] }),
});

test("GET /status keeps every old field and adds provider_usage and clients", async () => {
  const st = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
  for (const k of ["status", "version", "uptime", "backends", "pool", "metrics"]) assert.ok(k in st, `old field ${k}`);
  assert.equal(st.status, "ok");
  assert.equal(st.provider_usage.schema, "skgw-provider-usage/1");
  for (const b of ["codex", "deepseek", "zai"]) assert.ok("age_seconds" in st.provider_usage.backends[b]);
  assert.equal(st.clients.enabled, true);
  assert.ok(Array.isArray(st.clients.clients));
});

test("x-app client and x-session-id reach audit request/response events and request_log; untagged is named", async () => {
  assert.equal((await chat({ "x-app": "test-lane", "x-session-id": "sess-1" })).status, 200);
  assert.equal((await chat()).status, 200);
  await new Promise((r) => setTimeout(r, 6500)); // metrics flush interval is 5 s
  const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  const typed = audit.filter((e) => e.event_type === "request" || e.event_type === "response");
  assert.ok(typed.some((e) => e.event_type === "request" && e.client === "test-lane" && e.session_id === "sess-1"));
  assert.ok(typed.some((e) => e.event_type === "response" && e.client === "test-lane" && e.session_id === "sess-1"));
  assert.ok(typed.some((e) => e.event_type === "response" && e.client === "untagged"));
  assert.ok(audit.some((e) => e.event === "client.untagged" && e.remote));
  assert.equal(readFileSync(join(dir, "audit.jsonl"), "utf8").includes("PROMPT-MARKER-77"), false, "no prompt content");
  const db = new Database(join(dir, "metrics.db"), { readonly: true });
  const rows = db.prepare("SELECT client, session_id FROM request_log ORDER BY started_at").all();
  db.close();
  assert.deepEqual(rows, [{ client: "test-lane", session_id: "sess-1" }, { client: "untagged", session_id: null }]);
});
