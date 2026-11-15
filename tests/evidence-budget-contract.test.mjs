/**
 * evidence-budget-contract.test.mjs: pins the skgw-provider-usage/1 contract
 * (docs/specs/skgw-provider-usage-1.json, docs/EVIDENCE-BUDGET-MONITORING.md).
 *
 * Budget guards and collectors read these fields. This test fails when a
 * field is removed, renamed or changes type, and when the spec file itself is
 * edited without a new contract version. Adding a field is allowed.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  attachProviderStore, observeProviderUsage, pollDeepseekBalance, providerUsageStatus,
  PROVIDER_USAGE_SCHEMA, _resetProviderStoreForTests, _resetProviderUsageForTests,
} from "../src/metrics/provider-usage.mjs";
import { createClientGuard } from "../src/policy/client-guard.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = JSON.parse(readFileSync(join(ROOT, "docs", "specs", "skgw-provider-usage-1.json"), "utf8"));
const T0 = Date.parse("2026-11-14T18:00:00Z");

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function typeOk(v, spec) {
  return String(spec).split(" ")[0].split("|").some((t) => {
    if (t === "null") return v === null;
    if (t === "string") return typeof v === "string";
    if (t === "number") return typeof v === "number" && Number.isFinite(v);
    if (t === "integer") return Number.isInteger(v);
    if (t === "boolean") return typeof v === "boolean";
    if (t === "object") return v !== null && typeof v === "object" && !Array.isArray(v);
    if (t === "array") return Array.isArray(v);
    if (t === "iso8601") return typeof v === "string" && ISO.test(v);
    if (t === "yyyy-mm-dd") return typeof v === "string" && DAY.test(v);
    return typeof v === "string" && v === t; // enum member
  });
}
/** Every spec field present with its type. Extra fields are allowed. */
function conforms(obj, fields, where) {
  for (const [k, spec] of Object.entries(fields)) {
    assert.ok(Object.hasOwn(obj, k), `${where}.${k} missing`);
    assert.ok(typeOk(obj[k], spec), `${where}.${k} = ${JSON.stringify(obj[k])} is not ${spec}`);
  }
}

beforeEach(() => { _resetProviderStoreForTests(); _resetProviderUsageForTests(); });

test("the spec file is the version-1 contract, field for field", () => {
  // Changing any of these lists is a breaking change: bump the contract
  // version (skgw-provider-usage/2) and keep /1 until consumers have moved.
  assert.equal(SPEC.contract, "skgw-provider-usage/1");
  assert.equal(PROVIDER_USAGE_SCHEMA, SPEC.contract);
  const pu = SPEC.provider_usage;
  assert.deepEqual(Object.keys(pu.keys), ["schema", "generated_at", "backends"]);
  assert.deepEqual(Object.keys(pu.backend), ["backend", "observed_at", "age_seconds", "sources"]);
  assert.deepEqual(Object.keys(pu.source_common), ["observed_at", "age_seconds"]);
  assert.deepEqual(Object.keys(pu.sources.headers), ["windows"]);
  assert.deepEqual(Object.keys(pu.sources.balance), ["is_available", "balances"]);
  assert.deepEqual(Object.keys(pu.window), ["name", "unit", "limit", "remaining", "used_percent", "reset_at"]);
  assert.deepEqual(Object.keys(pu.balance), ["currency", "total_balance", "granted_balance", "topped_up_balance"]);
  assert.deepEqual(Object.keys(pu.daily), ["day", "readings", "first", "last", "balance_drop", "estimated_dollars", "drift_percent"]);
  assert.deepEqual(Object.keys(SPEC.clients.keys), ["day", "enabled", "reject_untagged", "clients"]);
  assert.deepEqual(Object.keys(SPEC.clients.row), ["client", "family", "calls", "tokens", "dollars", "cap_calls", "cap_tokens"]);
  assert.deepEqual(Object.keys(SPEC.alert_record.keys), ["ts", "day", "kind", "key", "severity", "title", "summary"]);
  assert.equal(SPEC.router_log_lines.success_regex, "\\[router\\] 200 OK backend=([A-Za-z0-9_.-]+)");
  assert.equal(SPEC.router_log_lines.throttled_regex, "\\[router\\] (402|429) THROTTLED backend=([A-Za-z0-9_.-]+)");
});

test("provider_usage conforms: every backend present, headers and balance sources typed", async () => {
  const db = new Database(":memory:");
  attachProviderStore({ db });
  observeProviderUsage("codex", { status: 200, headers: { "x-codex-primary-used-percent": "41", "x-codex-primary-reset-at": String(T0 / 1000 + 3600) } }, { now: T0 });
  observeProviderUsage("zai", { status: 200, headers: { "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "60", "x-ratelimit-reset-requests": "30s" } }, { now: T0 });
  const fetchFn = async () => ({ ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "12.5", granted_balance: "0", topped_up_balance: "12.5" }] }) });
  assert.equal((await pollDeepseekBalance({ key: "k", fetchFn, now: () => T0 })).ok, true);

  const st = providerUsageStatus({ now: T0 + 90e3 });
  conforms(st, SPEC.provider_usage.keys, "provider_usage");
  assert.equal(st.schema, SPEC.contract);
  assert.deepEqual(Object.keys(st.backends), ["codex", "deepseek", "zai"]);
  for (const [name, b] of Object.entries(st.backends)) {
    conforms(b, SPEC.provider_usage.backend, `backends.${name}`);
    assert.equal(b.backend, name);
    for (const [src, s] of Object.entries(b.sources)) {
      conforms(s, SPEC.provider_usage.source_common, `backends.${name}.sources.${src}`);
      conforms(s, SPEC.provider_usage.sources[src], `backends.${name}.sources.${src}`);
      for (const w of s.windows || []) conforms(w, SPEC.provider_usage.window, `${name}.${src}.windows[]`);
      for (const bal of s.balances || []) conforms(bal, SPEC.provider_usage.balance, `${name}.${src}.balances[]`);
    }
  }
  assert.equal(st.backends.codex.age_seconds, 90);
  assert.equal(st.backends.codex.sources.headers.windows[0].used_percent, 41);
  assert.equal(st.backends.zai.sources.headers.windows[0].used_percent, 40);
  assert.equal(st.backends.deepseek.sources.balance.balances[0].total_balance, 12.5);
});

test("a backend with no snapshot is still present, with null observed_at and age_seconds", () => {
  attachProviderStore({ db: null, backends: ["codex", "zai"] });
  const st = providerUsageStatus({ now: T0 });
  assert.deepEqual(Object.keys(st.backends), ["codex", "zai"]);
  for (const b of Object.values(st.backends)) {
    conforms(b, SPEC.provider_usage.backend, "empty backend");
    assert.equal(b.observed_at, null);
    assert.equal(b.age_seconds, null);
    assert.deepEqual(b.sources, {});
  }
});

test("without the store attached nothing is recorded (the feature-off path)", async () => {
  observeProviderUsage("codex", { status: 200, headers: { "x-codex-primary-used-percent": "41" } }, { now: T0 });
  const fetchFn = async () => ({ ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "1" }] }) });
  await pollDeepseekBalance({ key: "k", fetchFn, now: () => T0 });
  attachProviderStore({ db: null });
  const st = providerUsageStatus({ now: T0 });
  for (const b of Object.values(st.backends)) assert.deepEqual(b.sources, {}, `${b.backend} recorded while detached`);
});

function guardWith(db, extra = "") {
  const dir = mkdtempSync(join(tmpdir(), "ebm-contract-"));
  const configPath = join(dir, "caps.yaml");
  writeFileSync(configPath, `enabled: true\nfamilies: { deepseek: ["deepseek-*"] }\ncaps: { default: { deepseek: { calls: 5 } } }\nalerts: { outbox: ${join(dir, "a.jsonl")} }\nprices: { deepseek: { input: 1, output: 2, cached: 0 } }\n${extra}`);
  return { guard: createClientGuard({ configPath, getDb: () => db, siem: () => {}, now: () => T0, log: {} }), outbox: join(dir, "a.jsonl") };
}

test("clients block conforms", () => {
  const { guard } = guardWith(null);
  guard.record({ client: "tool-a", backend: "deepseek", statusCode: 200, body: { usage: { prompt_tokens: 10, completion_tokens: 5 } }, model: "deepseek-v4-pro" });
  const snap = guard.snapshot();
  conforms(snap, SPEC.clients.keys, "clients");
  assert.equal(snap.clients.length, 1);
  conforms(snap.clients[0], SPEC.clients.row, "clients.clients[]");
  assert.deepEqual([snap.clients[0].client, snap.clients[0].family, snap.clients[0].calls], ["tool-a", "deepseek", 1]);
});

test("deepseek daily block conforms, with and without readings", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE request_log (id TEXT PRIMARY KEY, started_at INTEGER, client TEXT, backend TEXT, model TEXT, model_served TEXT, input_tokens INTEGER, output_tokens INTEGER, status_code INTEGER);
           CREATE TABLE token_usage (req_id TEXT, backend TEXT, ts INTEGER, cache_read_tokens INTEGER);
           CREATE TABLE deepseek_balance_log (observed_at TEXT, currency TEXT, total_balance REAL);`);
  const none = guardWith(db).guard.deepseekDaily();
  conforms(none, SPEC.provider_usage.daily, "daily (no readings)");
  const ins = db.prepare("INSERT INTO deepseek_balance_log VALUES (?, 'USD', ?)");
  ins.run("2026-11-13T01:00:00.000Z", 30);
  ins.run("2026-11-13T20:00:00.000Z", 28);
  const d = guardWith(db).guard.deepseekDaily();
  conforms(d, SPEC.provider_usage.daily, "daily");
  assert.equal(d.day, "2026-11-13");
  assert.equal(d.balance_drop, 2);
});

test("alert outbox records conform", () => {
  const { guard, outbox } = guardWith(null);
  for (let i = 0; i < 4; i++) guard.record({ client: "tool-a", backend: "deepseek", statusCode: 200, body: {}, model: "deepseek-v4-pro" });
  const rec = JSON.parse(readFileSync(outbox, "utf8").trim());
  conforms(rec, SPEC.alert_record.keys, "alert");
  assert.equal(rec.kind, "cap");
});
