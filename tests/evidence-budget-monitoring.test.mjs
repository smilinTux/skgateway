/**
 * evidence-budget-monitoring.test.mjs: the feature switch, on and off, against
 * live gateway processes. Off must leave the gateway as it was before the
 * feature existed: the same /status keys, no client guard, no provider
 * snapshot tables, no admin usage route, no client field on audit events.
 * On (from the config file, no environment) adds exactly the contract blocks.
 * docs/EVIDENCE-BUDGET-MONITORING.md, docs/specs/skgw-provider-usage-1.json.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { resolveEvidenceBudgetMonitoring } from "../src/config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(ROOT, "src", "index.mjs");
const SPEC = JSON.parse(readFileSync(join(ROOT, "docs", "specs", "skgw-provider-usage-1.json"), "utf8"));
const FEATURE_TABLES = ["alert_fired", "deepseek_balance_log", "provider_snapshot"];

// ── the switch itself ──
test("off by default; on with enabled: true; the caps env turns it on only when enabled is unset", () => {
  const cfg = "/srv/cluster/node1/skgateway.yaml";
  assert.equal(resolveEvidenceBudgetMonitoring({ enabled: null }, cfg, {}).enabled, false, "default off");
  assert.equal(resolveEvidenceBudgetMonitoring(undefined, cfg, {}).enabled, false);
  assert.equal(resolveEvidenceBudgetMonitoring({ enabled: true }, cfg, {}).enabled, true);
  assert.equal(resolveEvidenceBudgetMonitoring({ enabled: "yes" }, cfg, {}).enabled, false, "only a real true");
  const env = { SKGATEWAY_CLIENT_CAPS: "/etc/caps.yaml" };
  assert.equal(resolveEvidenceBudgetMonitoring({ enabled: null }, cfg, env).enabled, true, "deployer compatibility");
  assert.equal(resolveEvidenceBudgetMonitoring({ enabled: false }, cfg, env).enabled, false, "explicit false wins");
});

test("client_caps: explicit path, then the env path, then client-caps.yaml beside the config file", () => {
  const cfg = "/srv/cluster/node1/skgateway.yaml";
  assert.equal(resolveEvidenceBudgetMonitoring({}, cfg, {}).client_caps, "/srv/cluster/node1/client-caps.yaml");
  assert.equal(resolveEvidenceBudgetMonitoring({ client_caps: "caps/c.yaml" }, cfg, {}).client_caps, "/srv/cluster/node1/caps/c.yaml");
  assert.equal(resolveEvidenceBudgetMonitoring({}, cfg, { SKGATEWAY_CLIENT_CAPS: "/etc/caps.yaml" }).client_caps, "/etc/caps.yaml");
  assert.equal(resolveEvidenceBudgetMonitoring({ client_caps: "/abs.yaml" }, cfg, { SKGATEWAY_CLIENT_CAPS: "/etc/caps.yaml" }).client_caps, "/abs.yaml");
  assert.deepEqual(resolveEvidenceBudgetMonitoring({}, cfg, {}).provider_backends, ["codex", "deepseek", "zai"]);
  assert.deepEqual(resolveEvidenceBudgetMonitoring({ provider_backends: ["zai"] }, cfg, {}).provider_backends, ["zai"]);
});

// ── live gateways ──
const listen = (server) => new Promise((ok, no) => { server.once("error", no); server.listen(0, "127.0.0.1", () => ok(server.address().port)); });
const freePort = async () => { const s = net.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; };
let upstream, upPort;
const gws = {};

async function boot(name, featureYaml) {
  const dir = mkdtempSync(join(tmpdir(), `skgw-ebm-${name}-`));
  const port = await freePort();
  mkdirSync(join(dir, "cluster"));
  writeFileSync(join(dir, "cluster", "caps.yaml"), `enabled: true\nexempt_backends: [synthetic, throttle]\nfamilies: {}\nalerts: { outbox: ${join(dir, "alerts.jsonl")} }\ndeepseek_balance_poll_minutes: 0\n`);
  const cfgPath = join(dir, "cluster", "gw.yaml");
  writeFileSync(cfgPath, [
    "server:", "  bind: 127.0.0.1", `  port: ${port}`,
    "dashboard:", "  enabled: false", "discovery:", "  enabled: false",
    "identity:", "  enabled: false", "classification:", "  enabled: false",
    "metrics:", "  enabled: true", `  db_path: ${join(dir, "metrics.db")}`,
    "siem:", "  enabled: true", "  outputs:", "    - type: file", `      path: ${join(dir, "audit.jsonl")}`,
    "backends:",
    "  synthetic:", `    url: http://127.0.0.1:${upPort}/v1`, "    auth_type: none", "    models: [synthetic-model]", "    priority: 1",
    "  throttle:", `    url: http://127.0.0.1:${upPort}/v1`, "    auth_type: none", "    models: [throttle-model]", "    priority: 1",
    ...featureYaml,
  ].join("\n") + "\n");
  const env = {
    ...process.env, HOME: dir,
    SKGATEWAY_MODEL_CATALOG_STORE_PATH: join(dir, "model_catalog_store.json"),
    SKGATEWAY_CAPACITY_STORE_PATH: join(dir, "capacity_store.json"),
  };
  delete env.SKGATEWAY_CLIENT_CAPS;
  const child = spawn(process.execPath, [INDEX, "--config", cfgPath], { env, stdio: ["ignore", "pipe", "pipe"] });
  const g = { dir, port, child, out: "" };
  await new Promise((ok, no) => {
    const timer = setTimeout(() => no(new Error("no boot:\n" + g.out)), 15000);
    const on = (c) => { g.out += c; if (g.out.includes("[skgateway] listening")) { clearTimeout(timer); ok(); } };
    child.stdout.on("data", on); child.stderr.on("data", on);
    child.once("exit", (code) => no(new Error(`exit ${code}:\n${g.out}`)));
  });
  return g;
}

before(async () => {
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (body.includes("throttle-model")) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ error: { message: "slow down" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "synthetic-model", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }));
    });
  });
  upPort = await listen(upstream);
  gws.off = await boot("off", []);
  gws.on = await boot("on", ["evidence_budget_monitoring:", "  enabled: true", "  client_caps: caps.yaml", "  provider_backends: [codex, zai]"]);
});

after(async () => {
  for (const g of Object.values(gws)) g.child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  upstream?.close();
});

const chat = (g, headers = {}, model = "synthetic-model") => fetch(`http://127.0.0.1:${g.port}/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
});
const tables = (g) => {
  const db = new Database(join(g.dir, "metrics.db"), { readonly: true });
  try { return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name); }
  finally { db.close(); }
};

test("metrics.db request_log has every column the contract names for collectors", () => {
  for (const g of [gws.off, gws.on]) {
    const db = new Database(join(g.dir, "metrics.db"), { readonly: true });
    const cols = new Map(db.prepare("PRAGMA table_info(request_log)").all().map((c) => [c.name, c.type]));
    db.close();
    for (const [name, spec] of Object.entries(SPEC.metrics_db.request_log)) {
      assert.ok(cols.has(name), `request_log.${name} missing`);
      assert.equal(cols.get(name), spec.startsWith("integer") ? "INTEGER" : "TEXT", `request_log.${name} type`);
    }
  }
});

test("off: /status has exactly the keys it had before the feature", async () => {
  const st = await (await fetch(`http://127.0.0.1:${gws.off.port}/status`)).json();
  assert.deepEqual(Object.keys(st).sort(), SPEC.status_keys_without_feature);
  assert.equal(st.status, "ok");
});

test("off: no client guard, no snapshot store, no admin usage route", async () => {
  assert.doesNotMatch(gws.off.out, /\[client-guard\]|evidence and budget monitoring on/);
  assert.notEqual((await fetch(`http://127.0.0.1:${gws.off.port}/admin/clients/usage`)).status, 200);
  const t = tables(gws.off);
  for (const name of FEATURE_TABLES) assert.equal(t.includes(name), false, `no ${name} table`);
});

test("off: audit events carry no client field; request_log keeps the raw x-app value", async () => {
  assert.equal((await chat(gws.off, { "x-app": "tool-a", "x-session-id": "s-1" })).status, 200);
  assert.equal((await chat(gws.off)).status, 200);
  await new Promise((r) => setTimeout(r, 6500)); // metrics flush interval is 5 s
  const audit = readFileSync(join(gws.off.dir, "audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(audit.some((e) => e.event_type === "request"), "router audit events were written");
  for (const e of audit) assert.equal("client" in e, false, `no client on ${e.event_type || e.event}`);
  assert.equal(audit.some((e) => String(e.event || "").startsWith("client.")), false);
  const db = new Database(join(gws.off.dir, "metrics.db"), { readonly: true });
  const rows = db.prepare("SELECT client FROM request_log ORDER BY started_at").all();
  db.close();
  assert.deepEqual(rows.map((r) => r.client), ["tool-a", null]);
});

test("on (from the config file): exactly the contract blocks, the configured backends, the tables", async () => {
  assert.match(gws.on.out, /evidence and budget monitoring on \(caps .*cluster\/caps\.yaml\)/);
  const st = await (await fetch(`http://127.0.0.1:${gws.on.port}/status`)).json();
  assert.deepEqual(Object.keys(st).sort(), SPEC.status_keys_with_feature);
  assert.equal(st.provider_usage.schema, SPEC.contract);
  assert.deepEqual(Object.keys(st.provider_usage.backends), ["codex", "zai"]);
  assert.equal(st.clients.enabled, true);
  const t = tables(gws.on);
  for (const name of ["deepseek_balance_log", "provider_snapshot"]) assert.ok(t.includes(name), `${name} table`);
  const usage = await fetch(`http://127.0.0.1:${gws.on.port}/admin/clients/usage`);
  assert.equal(usage.status, 200);
  assert.deepEqual(Object.keys(await usage.json()).sort(), ["spend", "today"]);
});

test("on: untagged and tagged clients are named on audit events", async () => {
  assert.equal((await chat(gws.on, { "x-app": "tool-a" })).status, 200);
  assert.equal((await chat(gws.on)).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  const audit = readFileSync(join(gws.on.dir, "audit.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(audit.some((e) => e.event_type === "request" && e.client === "tool-a"));
  assert.ok(audit.some((e) => e.event_type === "request" && e.client === "untagged"));
  assert.ok(audit.some((e) => e.event === "client.untagged"));
});

test("router log lines match the contract regexes, feature on or off", async () => {
  for (const g of [gws.off, gws.on]) {
    await chat(g, {}, "synthetic-model");
    await chat(g, {}, "throttle-model");
    await new Promise((r) => setTimeout(r, 200));
    const ok = [...g.out.matchAll(new RegExp(SPEC.router_log_lines.success_regex, "g"))].map((m) => m[1]);
    const thr = [...g.out.matchAll(new RegExp(SPEC.router_log_lines.throttled_regex, "g"))].map((m) => [m[1], m[2]]);
    assert.ok(ok.includes("synthetic"), "success line names the backend");
    assert.ok(thr.some(([s, b]) => s === "429" && b === "throttle"), "throttled line names status and backend");
  }
});
