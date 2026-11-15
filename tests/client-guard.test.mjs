/**
 * client-guard.test.mjs (pck3): per-client guard rails.
 * Features: 1 client identity, 2 daily caps, 3 rate limits, 4 alerts,
 * 5 price table and spend, 6 untagged logging and reject switch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { createClientGuard, clientOf, sessionOf, chicagoDay, estimateDollars, secondsToChicagoMidnight, isPeak } from "../src/policy/client-guard.mjs";
import { createRouteSiemEmitter } from "../src/proxy/router.mjs";

// 2026-11-14 12:00 Chicago (CST, UTC-6)
const NOON = Date.parse("2026-11-14T18:00:00Z");

function setup(extra = "", { db = null, start = NOON } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "client-guard-"));
  const outbox = join(dir, "alerts.jsonl");
  const configPath = join(dir, "client-caps.yaml");
  writeFileSync(configPath, `
enabled: true
reject_untagged: false
untagged_grace_until: "2026-11-21"
exempt_backends: [chiap08-qwen38]
families:
  codex: ["gpt-*"]
  deepseek: ["deepseek-*", "sk-l"]
  zai: ["sk-glm-*", "sk-l"]
caps:
  default:
    codex: { calls: 5, tokens: 1000 }
    deepseek: { calls: 3 }
    zai: { calls: 3 }
  clients:
    big: { codex: { calls: 100 } }
rate_limits:
  default: { client_per_minute: 50, session_per_minute: 4 }
alerts:
  outbox: ${outbox}
  cap_percent: 80
  spike_factor: 3
  spike_min_calls: 10
  codex_used_percent: 80
  stale_hours: 2
prices:
  deepseek-v4-pro: { input: 1, output: 2, cached: 0.1 }
  zai: { input: 0, output: 0, cached: 0 }
${extra}
`);
  const clock = { t: start };
  const events = [];
  const make = () => createClientGuard({ configPath, getDb: () => db, siem: (e) => events.push(e), now: () => clock.t, log: {} });
  return { guard: make(), make, clock, events, outbox, configPath };
}

const ok = (g, client, backend, extra = {}) => g.record({ client, backend, statusCode: 200, model: extra.model, body: extra.body ?? {}, ...extra });

// ── 1. client identity ──
test("client is x-app, untagged when absent or blank, sanitized and bounded", () => {
  assert.equal(clientOf({ "x-app": "fwe-lane" }), "fwe-lane");
  assert.equal(clientOf({}), "untagged");
  assert.equal(clientOf({ "x-app": "   " }), "untagged");
  assert.equal(clientOf({ "x-app": "a b\n<x>" }), "a_b__x_");
  assert.equal(clientOf({ "x-app": "z".repeat(200) }).length, 64);
  assert.equal(sessionOf({ "x-session-id": "s-1" }), "s-1");
  assert.equal(sessionOf({}), null);
});

test("router audit events carry client and session", async () => {
  const seen = [];
  const emit = createRouteSiemEmitter((e) => seen.push(e), { client: "fwe-lane", sessionId: "s-9", model: "gpt-6.1-sol" });
  await emit("request", { method: "POST" });
  await emit("response", { status: 200 });
  for (const e of seen) {
    assert.equal(e.client, "fwe-lane");
    assert.equal(e.session_id, "s-9");
  }
  const none = [];
  await createRouteSiemEmitter((e) => none.push(e), { model: "m" })("request", {});
  assert.equal("client" in none[0], false);
});

// ── 2. daily caps ──
test("calls cap: 429 naming the cap, Retry-After to Chicago midnight", () => {
  const { guard } = setup();
  for (let i = 0; i < 5; i++) {
    assert.equal(guard.check({ headers: { "x-app": "a" }, model: "gpt-6.1-sol" }).reject, null);
    ok(guard, "a", "codex");
  }
  const r = guard.check({ headers: { "x-app": "a" }, model: "gpt-6.1-sol" }).reject;
  assert.equal(r.status, 429);
  const body = JSON.parse(r.body);
  assert.equal(body.error.code, "client_daily_cap");
  assert.deepEqual({ ...body.error.cap, day: undefined }, { client: "a", family: "codex", unit: "calls", limit: 5, used: 5, day: undefined });
  assert.match(body.error.message, /5 of 5 calls on codex/);
  assert.equal(r.headers["retry-after"], String(12 * 3600));
  // other client, other family and per-client override are not blocked
  assert.equal(guard.check({ headers: { "x-app": "b" }, model: "gpt-6.1-sol" }).reject, null);
  assert.equal(guard.check({ headers: { "x-app": "a" }, model: "deepseek-v4-pro" }).reject, null);
});

test("caps: per-client override, failed calls not counted, local exempt", () => {
  const { guard } = setup();
  for (let i = 0; i < 10; i++) ok(guard, "big", "codex");
  assert.equal(guard.check({ headers: { "x-app": "big" }, model: "gpt-x" }).reject, null);
  for (let i = 0; i < 10; i++) guard.record({ client: "c", backend: "codex", statusCode: 429 });
  for (let i = 0; i < 10; i++) ok(guard, "c", "chiap08-qwen38");
  assert.equal(guard.check({ headers: { "x-app": "c" }, model: "gpt-x" }).reject, null);
  assert.equal(guard.check({ headers: { "x-app": "c" }, model: "qwen3.8-27b" }).reject, null);
  assert.equal(guard.snapshot().clients.some((r) => r.family === "chiap08-qwen38"), false);
});

test("caps: tokens from usage; bucket refused only when every family is over", () => {
  const { guard } = setup();
  ok(guard, "t", "codex", { body: { usage: { prompt_tokens: 600, completion_tokens: 400 } } });
  const r = guard.check({ headers: { "x-app": "t" }, model: "gpt-6.1-sol" }).reject;
  assert.equal(JSON.parse(r.body).error.cap.unit, "tokens");
  for (let i = 0; i < 3; i++) ok(guard, "t", "deepseek");
  assert.equal(guard.check({ headers: { "x-app": "t" }, model: "sk-l" }).reject, null, "zai still free");
  for (let i = 0; i < 3; i++) ok(guard, "t", "zai");
  assert.equal(guard.check({ headers: { "x-app": "t" }, model: "sk-l" }).reject.status, 429);
});

test("caps reset on the Chicago day, not the UTC day", () => {
  const { guard, clock } = setup();
  clock.t = Date.parse("2026-11-15T03:00:00Z"); // 21:00 Chicago on 11-14, already 11-15 in UTC
  assert.equal(chicagoDay(clock.t), "2026-11-14");
  for (let i = 0; i < 3; i++) ok(guard, "d", "deepseek");
  assert.equal(guard.check({ headers: { "x-app": "d" }, model: "deepseek-v4-pro" }).reject.status, 429);
  clock.t = Date.parse("2026-11-15T06:00:01Z"); // 00:00:01 Chicago 11-15
  assert.equal(guard.check({ headers: { "x-app": "d" }, model: "deepseek-v4-pro" }).reject, null);
  assert.ok(secondsToChicagoMidnight(Date.parse("2026-11-15T05:59:00Z")) <= 60);
});

test("guard is off when the config file is missing or enabled is false", () => {
  const g = createClientGuard({ configPath: "/nonexistent/caps.yaml", log: {} });
  for (let i = 0; i < 20; i++) g.record({ client: "a", backend: "codex", statusCode: 200 });
  assert.equal(g.check({ headers: { "x-app": "a" }, model: "gpt-x" }).reject, null);
  const { configPath, make } = setup();
  writeFileSync(configPath, readFileSync(configPath, "utf8").replace("enabled: true", "enabled: false"));
  const off = make();
  for (let i = 0; i < 20; i++) off.record({ client: "a", backend: "codex", statusCode: 200 });
  assert.equal(off.check({ headers: { "x-app": "a" }, model: "gpt-x" }).reject, null);
});

// ── 3. rate limits ──
test("session and client per-minute limits answer 429 with Retry-After, window slides", () => {
  const { guard, clock } = setup();
  const h = { "x-app": "r", "x-session-id": "s1" };
  for (let i = 0; i < 4; i++) { assert.equal(guard.check({ headers: h, model: "qwen" }).reject, null); clock.t += 1000; }
  const r = guard.check({ headers: h, model: "qwen" }).reject;
  assert.equal(r.status, 429);
  assert.equal(JSON.parse(r.body).error.code, "client_rate_limited");
  assert.equal(r.headers["retry-after"], "56");
  assert.equal(guard.check({ headers: { ...h, "x-session-id": "s2" }, model: "qwen" }).reject, null, "other session free");
  clock.t += 57000;
  assert.equal(guard.check({ headers: h, model: "qwen" }).reject, null, "window slid");
  // client limit across sessions
  const { guard: g2 } = setup();
  for (let i = 0; i < 50; i++) assert.equal(g2.check({ headers: { "x-app": "q", "x-session-id": `s${i}` }, model: "m" }).reject, null);
  assert.match(JSON.parse(g2.check({ headers: { "x-app": "q" }, model: "m" }).reject.body).error.message, /client q is over 50/);
});

// ── 4. alerts ──
test("alerts fire once per threshold per Chicago day, kept in metrics.db across a restart; a new day can fire", () => {
  const db = new Database(":memory:");
  const { guard, make, outbox, clock } = setup("", { db });
  for (let i = 0; i < 4; i++) ok(guard, "chiap04-fwe-lane", "codex"); // 4 of 5 = 80 percent
  ok(guard, "chiap04-fwe-lane", "codex");                              // second pass, same day
  let lines = readFileSync(outbox, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "cap");
  assert.equal(lines[0].room, "NAM Admin");
  assert.match(lines[0].summary, /chiap04-fwe-lane: 4 of 5 calls on codex/);
  assert.match(lines[0].summary, /answers 429 to chiap04-fwe-lane's codex calls until midnight Central/);
  assert.equal(db.prepare("SELECT count(*) n FROM alert_fired").get().n, 1);
  const again = make(); // restart: counters start at zero here (no request_log), fired state comes from alert_fired
  for (let i = 0; i < 4; i++) ok(again, "chiap04-fwe-lane", "codex");
  again.providerObserved("codex", "headers", { windows: [{ name: "primary", unit: "percent", used_percent: 82, reset_at: "2026-11-14T20:00:00Z" }] });
  again.providerObserved("codex", "headers", { windows: [{ name: "primary", unit: "percent", used_percent: 85, reset_at: "2026-11-14T20:00:00Z" }] });
  lines = readFileSync(outbox, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((l) => l.kind), ["cap", "codex"]);
  assert.match(lines[1].summary, /codex primary window 82% used, resets Nov 14, 14:00 Central/);
  clock.t += 86400e3; // new Chicago day: both may fire again
  for (let i = 0; i < 4; i++) ok(again, "chiap04-fwe-lane", "codex");
  again.providerObserved("codex", "headers", { windows: [{ name: "primary", unit: "percent", used_percent: 90 }] });
  assert.deepEqual(readFileSync(outbox, "utf8").trim().split("\n").map((l) => JSON.parse(l).kind), ["cap", "codex", "cap", "codex"]);
});

test("DeepSeek floor: null never alerts; a set floor alerts once below it", () => {
  const { guard, outbox, configPath, make } = setup();
  const low = { is_available: true, balances: [{ currency: "USD", total_balance: 9.5 }] };
  guard.providerObserved("deepseek", "balance", low);
  assert.equal(existsSync(outbox), false);
  writeFileSync(configPath, readFileSync(configPath, "utf8") + "\ndeepseek_balance_floor: 15\n");
  const g = make();
  g.providerObserved("deepseek", "balance", { balances: [{ currency: "USD", total_balance: 20 }] });
  assert.equal(existsSync(outbox), false);
  g.providerObserved("deepseek", "balance", low);
  g.providerObserved("deepseek", "balance", low);
  const lines = readFileSync(outbox, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 1);
  assert.match(lines[0].summary, /DeepSeek balance 9.5 USD, floor 15/);
});

test("stale snapshot alert only for a backend in use", () => {
  const { guard, outbox, clock } = setup();
  const status = { backends: { codex: { age_seconds: 3 * 3600 }, zai: { age_seconds: null }, deepseek: { age_seconds: 60 } } };
  guard.checkStale(status);
  assert.equal(existsSync(outbox), false, "nothing in use yet");
  ok(guard, "a", "codex");
  guard.checkStale(status);
  assert.equal(existsSync(outbox), false, "boot grace: the snapshot table needs stale_hours to fill");
  clock.t += 2 * 3600e3 + 1000;
  ok(guard, "a", "codex"); ok(guard, "a", "deepseek");
  guard.checkStale(status);
  guard.checkStale(status);
  const lines = readFileSync(outbox, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(lines.map((l) => [l.kind, l.backend]), [["stale", "codex"]]);
  assert.match(lines[0].summary, /180 minutes old/);
  clock.t += 3 * 3600e3; // codex no longer in use
  guard.checkStale(status);
  assert.equal(readFileSync(outbox, "utf8").trim().split("\n").length, 1);
});

test("spike alert: last hour over N x trailing hourly average, with a minimum count", () => {
  const { guard, clock, outbox } = setup("", { start: NOON - 25 * 3600e3 });
  // 2 calls an hour for 24 h: average 2
  for (let h = 0; h < 24; h++) {
    guard.check({ headers: { "x-app": "s" }, model: "gpt-x" }); guard.check({ headers: { "x-app": "s" }, model: "gpt-x" });
    for (let i = 0; i < 15; i++) guard.check({ headers: { "x-app": "steady", "x-session-id": `h${h}i${i}` }, model: "gpt-x" });
    clock.t += 3600e3;
  }
  // steady client: 15 calls in the last hour is over the minimum but not over 3x its average of 15
  for (let i = 0; i < 15; i++) { guard.check({ headers: { "x-app": "steady", "x-session-id": `n${i}` }, model: "gpt-x" }); clock.t += 61000; }
  // tiny client: 9 calls in an hour is under spike_min_calls 10
  for (let i = 0; i < 9; i++) { guard.check({ headers: { "x-app": "tiny" }, model: "gpt-x" }); clock.t += 61000; }
  assert.equal(existsSync(outbox), false);
  for (let i = 0; i < 12; i++) { guard.check({ headers: { "x-app": "s", "x-session-id": `x${i}` }, model: "gpt-x" }); clock.t += 61000; }
  const lines = readFileSync(outbox, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 1, "once per client per day");
  assert.equal(lines[0].kind, "spike");
  assert.equal(lines[0].client, "s");
});

test("post-alerts.py posts outbox lines once and resumes after a failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "post-alerts-"));
  const outbox = join(dir, "alerts.jsonl");
  const sent = join(dir, "sent.txt");
  writeFileSync(join(dir, "fake.py"), `import os\ndef notify(t, s):\n    if os.path.exists(${JSON.stringify(join(dir, "down"))}): return False\n    open(${JSON.stringify(sent)}, 'a').write(t + '\\n'); return True\n`);
  writeFileSync(outbox, JSON.stringify({ title: "one", summary: "x" }) + "\n" + JSON.stringify({ title: "two", summary: "y" }) + "\n");
  const run = () => execFileSync("python3", ["scripts/post-alerts.py", outbox], { env: { ...process.env, SKGW_NOTIFY_MODULE: join(dir, "fake.py") } }).toString();
  assert.match(run(), /posted 2/);
  assert.match(run(), /posted 0/);
  writeFileSync(join(dir, "down"), "");
  writeFileSync(outbox, readFileSync(outbox, "utf8") + JSON.stringify({ title: "three", summary: "z" }) + "\n");
  assert.match(run(), /posted 0/);
  execFileSync("rm", [join(dir, "down")]);
  assert.match(run(), /posted 1/);
  assert.deepEqual(readFileSync(sent, "utf8").trim().split("\n"), ["one", "two", "three"]);
});

// ── 5. prices and spend ──
test("estimateDollars: served model, then requested model, then backend; unknown is null", () => {
  const prices = { "deepseek-v4-pro": { input: 1, output: 2, cached: 0.1 }, zai: { input: 3, output: 0 } };
  assert.equal(estimateDollars(prices, { model: "deepseek-v4-pro", input: 1e6, output: 1e6, cached: 1e6 }), 3.1);
  assert.equal(estimateDollars(prices, { model: "sk-glm-l", backend: "zai", input: 1e6 }), 3);
  assert.equal(estimateDollars(prices, { model: "x", backend: "y", input: 5 }), null);
});

function metricsDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE request_log (id TEXT PRIMARY KEY, started_at INTEGER, client TEXT, backend TEXT, model TEXT, model_served TEXT, input_tokens INTEGER, output_tokens INTEGER, status_code INTEGER);
           CREATE TABLE token_usage (req_id TEXT, ts INTEGER, cache_read_tokens INTEGER);`);
  const ins = db.prepare("INSERT INTO request_log VALUES (?,?,?,?,?,?,?,?,?)");
  ins.run("r1", NOON - 3600e3, "fwe-lane", "deepseek", "deepseek-v4-pro", null, 1e6, 1e6, 200);
  ins.run("r2", NOON - 3600e3, null, "deepseek", "deepseek-v4-pro", null, 0, 0, 200);
  ins.run("r3", NOON - 13 * 3600e3, "fwe-lane", "deepseek", "deepseek-v4-pro", null, 1e6, 0, 200); // yesterday in Chicago
  ins.run("r4", NOON - 60e3, "fwe-lane", "chiap08-qwen38", "qwen", null, 9, 9, 200);
  db.prepare("INSERT INTO token_usage VALUES (?,?,?)").run("r1", NOON - 3600e3, 1e6);
  return db;
}

test("seed from request_log at boot, snapshot and spend per day, client and provider", () => {
  const db = metricsDb();
  const { guard } = setup("", { db });
  const snap = guard.snapshot();
  assert.equal(snap.day, "2026-11-14");
  const row = snap.clients.find((r) => r.client === "fwe-lane" && r.family === "deepseek");
  assert.deepEqual([row.calls, row.tokens, row.dollars], [1, 2e6, 3.1]);
  assert.ok(snap.clients.find((r) => r.client === "untagged"), "NULL client seeds as untagged");
  const s = guard.spend({ days: 2 });
  const key = (r) => `${r.day}|${r.client}|${r.provider}`;
  const byKey = Object.fromEntries(s.rows.map((r) => [key(r), r]));
  assert.equal(byKey["2026-11-14|fwe-lane|deepseek"].dollars, 3.1);
  assert.equal(byKey["2026-11-13|fwe-lane|deepseek"].dollars, 1);
  assert.equal(byKey["2026-11-14|fwe-lane|chiap08-qwen38"].unpriced_calls, 1);
  // two more successful deepseek calls hit the cap of 3 seeded with today's rows
  ok(guard, "fwe-lane", "deepseek");
  ok(guard, "fwe-lane", "deepseek");
  assert.equal(guard.check({ headers: { "x-app": "fwe-lane" }, model: "deepseek-v4-pro" }).reject.status, 429);
});

// ── 6. untagged ──
test("untagged: audit event with remote and grace warning, never rejected by default", () => {
  const { guard, events, clock } = setup();
  const r = guard.check({ headers: { "user-agent": "curl" }, model: "gpt-x", remote: "10.0.0.9", path: "/v1/chat/completions" });
  assert.equal(r.reject, null);
  assert.equal(r.client, "untagged");
  const e = events.find((x) => x.event === "client.untagged");
  assert.equal(e.remote, "10.0.0.9");
  assert.match(e.warning, /grace until 2026-11-21/);
  assert.equal(JSON.stringify(events).includes("messages"), false);
  clock.t = Date.parse("2026-11-23T18:00:00Z");
  guard.check({ headers: {}, model: "gpt-x" });
  assert.match(events.at(-1).warning, /after the grace date/);
  assert.equal(events.filter((x) => x.event === "client.untagged" && x.client).length, 2);
  guard.check({ headers: { "x-app": "tagged" }, model: "gpt-x" });
  assert.equal(events.filter((x) => x.event === "client.untagged").length, 2);
});

test("reject_untagged: true answers 400, tagged callers pass", () => {
  const { configPath, make } = setup();
  writeFileSync(configPath, readFileSync(configPath, "utf8").replace("reject_untagged: false", "reject_untagged: true"));
  const g = make();
  const r = g.check({ headers: {}, model: "qwen" }).reject;
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.body).error.code, "client_untagged");
  assert.equal(g.check({ headers: { "x-app": "x" }, model: "qwen" }).reject, null);
});

// ── pck4: peak and off-peak DeepSeek pricing, balance daily ──
const SCHEDULE = { peak_windows_utc: ["01:00-04:00", "06:00-10:00"], peak_weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri"], holidays: ["2026-10-01"] };
const V4PRO = { "deepseek-v4-pro": { peak: { input: 1.32, output: 3.96, cached: 0.044 }, offpeak: { input: 0.66, output: 1.98, cached: 0.022 } } };

test("Friday 2026-11-13 off-peak reproduces $195.9; the same tokens at peak cost double", () => {
  const friday = { model: "deepseek-v4-pro", cached: 2540e6, input: 106e6, output: 35.4e6 };
  const off = estimateDollars(V4PRO, { ...friday, at: Date.parse("2026-11-13T20:00:00Z") }, SCHEDULE);
  assert.equal(Math.round(off * 10) / 10, 195.9);
  const peak = estimateDollars(V4PRO, { ...friday, at: Date.parse("2026-11-13T02:00:00Z") }, SCHEDULE);
  assert.equal(Math.round(peak * 1000) / 1000, 391.864);
});

test("peak windows: UTC weekday and hours, end exclusive; weekends and holidays are off-peak", () => {
  const at = (iso) => isPeak(Date.parse(iso), SCHEDULE);
  assert.equal(at("2026-11-13T01:00:00Z"), true);
  assert.equal(at("2026-11-13T03:59:59Z"), true);
  assert.equal(at("2026-11-13T04:00:00Z"), false);
  assert.equal(at("2026-11-13T09:30:00Z"), true);
  assert.equal(at("2026-11-13T10:00:00Z"), false);
  assert.equal(at("2026-11-14T02:00:00Z"), false, "Saturday");
  assert.equal(at("2026-10-01T02:00:00Z"), false, "holiday");
  assert.equal(isPeak(Date.parse("2026-10-01T02:00:00Z"), { ...SCHEDULE, holidays: [new Date("2026-10-01")] }), false, "unquoted YAML date");
  assert.equal(isPeak(null, SCHEDULE), false);
  // flat entries ignore the schedule
  assert.equal(estimateDollars({ zai: { input: 3 } }, { backend: "zai", input: 1e6, at: Date.parse("2026-11-13T02:00:00Z") }, SCHEDULE), 3);
});

test("deepseekDaily: yesterday's first and last balance and the estimate between them", () => {
  const dir = mkdtempSync(join(tmpdir(), "client-guard-daily-"));
  const configPath = join(dir, "caps.yaml");
  writeFileSync(configPath, `enabled: true\nfamilies: { deepseek: ["deepseek-*"] }\npeak_windows_utc: ["01:00-04:00", "06:00-10:00"]\npeak_weekdays: [Mon, Tue, Wed, Thu, Fri]\nholidays: []\nprices:\n  deepseek-v4-pro:\n    peak: { input: 1.32, output: 3.96, cached: 0.044 }\n    offpeak: { input: 0.66, output: 1.98, cached: 0.022 }\nalerts: { outbox: ${join(dir, "a.jsonl")} }\n`);
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE request_log (id TEXT PRIMARY KEY, started_at INTEGER, client TEXT, backend TEXT, model TEXT, model_served TEXT, input_tokens INTEGER, output_tokens INTEGER, status_code INTEGER);
           CREATE TABLE token_usage (req_id TEXT, backend TEXT, ts INTEGER, cache_read_tokens INTEGER);
           CREATE TABLE deepseek_balance_log (observed_at TEXT, currency TEXT, total_balance REAL);`);
  const bal = db.prepare("INSERT INTO deepseek_balance_log VALUES (?, 'USD', ?)");
  bal.run("2026-11-13T05:30:00.000Z", 120);  // 23:30 Chicago on 11-12: not yesterday
  bal.run("2026-11-13T07:00:00.000Z", 100);  // 01:00 Chicago 11-13: first
  bal.run("2026-11-14T05:00:00.000Z", 90);   // 23:00 Chicago 11-13: last
  bal.run("2026-11-14T07:00:00.000Z", 80);   // today
  const ins = db.prepare("INSERT INTO request_log VALUES (?,?,?,?,?,?,?,?,?)");
  ins.run("q1", Date.parse("2026-11-13T20:00:00Z"), "x", "deepseek", "deepseek-v4-pro", null, 1e6, 1e6, 200);  // off-peak: 0.66 + 1.98 + 0.022
  ins.run("q2", Date.parse("2026-11-13T09:00:00Z"), "x", "deepseek", "deepseek-v4-pro", null, 1e6, 0, 200);    // peak: 1.32
  ins.run("q3", Date.parse("2026-11-14T06:00:00Z"), "x", "deepseek", "deepseek-v4-pro", null, 1e6, 0, 200);    // after last reading
  db.prepare("INSERT INTO token_usage VALUES (?,?,?,?)").run("q1", "deepseek", Date.parse("2026-11-13T20:00:05Z"), 1e6);
  const g = createClientGuard({ configPath, getDb: () => db, now: () => NOON, log: {} });
  const d = g.deepseekDaily();
  assert.equal(d.day, "2026-11-13");
  assert.equal(d.readings, 2);
  assert.deepEqual([d.first.total_balance, d.last.total_balance, d.balance_drop], [100, 90, 10]);
  assert.equal(d.estimated_dollars, 3.982);
  assert.equal(d.drift_percent, -60.2);
  assert.equal(g.deepseekDaily(), d, "cached for the day");
});
