/**
 * client-guard.mjs: per-client guard rails keyed on the x-app header, part of
 * the evidence_budget_monitoring feature (docs/EVIDENCE-BUDGET-MONITORING.md).
 * index.mjs creates it only with the feature on.
 *
 *   - client identity: x-app (pi sends SKGW_CLIENT there), "untagged" when absent
 *   - daily caps per client and provider family, in successful calls and tokens
 *     (input + output as the metrics collector counts them), days in the caps
 *     file's `timezone` (default UTC)
 *   - calls-per-minute rate limits per client and per session (x-session-id)
 *   - alerts to an outbox file (cap percent, hourly spike, Codex window,
 *     DeepSeek floor, stale snapshot), posted by scripts/post-alerts.py
 *   - estimated dollars from a price table
 *
 * Config: the feature's client_caps file, re-read when its mtime changes. A
 * missing or unreadable file leaves only the client logging on. Never sees or
 * logs prompt content: only headers, model ids and usage counts.
 */
import { readFileSync, statSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { load as yamlLoad } from "js-yaml";
// Dynamic so a broken better-sqlite3 build still degrades the way index.mjs
// expects (metrics off, gateway up) instead of failing this import.
let extractTokens = () => ({});
try { ({ extractTokens } = await import("../metrics/collector.mjs")); } catch { /* no token counts */ }

export const DEFAULT_CONFIG_PATH = process.env.SKGATEWAY_CLIENT_CAPS
  || fileURLToPath(new URL("../../config/client-caps.yaml", import.meta.url));

export const DEFAULT_TIMEZONE = "UTC";
const fmtCache = new Map();
function fmt(kind, tz) {
  const k = `${kind}\t${tz}`;
  let f = fmtCache.get(k);
  if (!f) {
    f = kind === "day"
      ? new Intl.DateTimeFormat("en-CA", { timeZone: tz })
      : new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(k, f);
  }
  return f;
}

/** A valid IANA zone name or the default. */
export function zoneOf(tz) {
  if (!tz) return DEFAULT_TIMEZONE;
  try { new Intl.DateTimeFormat("en-US", { timeZone: String(tz) }); return String(tz); }
  catch { return DEFAULT_TIMEZONE; }
}

/** The YYYY-MM-DD day of `ms` in zone `tz`. */
export const dayIn = (ms, tz = DEFAULT_TIMEZONE) => fmt("day", tz).format(new Date(ms));

/** Seconds until the next midnight in zone `tz` (off by an hour on DST change days). */
export function secondsToMidnight(ms, tz = DEFAULT_TIMEZONE) {
  const [h, m, s] = fmt("clock", tz).format(new Date(ms)).split(":").map(Number);
  return Math.max(1, 86400 - (h * 3600 + m * 60 + s));
}

const clean = (v) => String(v ?? "").trim().replace(/[^A-Za-z0-9._:@\-]/g, "_").slice(0, 64);
export const clientOf = (headers = {}) => clean(headers["x-app"]) || "untagged";
/**
 * The metering client for a request: with client_auth on, the client id the
 * gateway verified (x-app is ignored, so a caller cannot bill another client);
 * otherwise the x-app header, "untagged" when absent.
 */
export const meteringClient = (headers = {}, identity = null) =>
  (identity?.method === "client_auth" && identity.client_id ? String(identity.client_id) : clientOf(headers));
export const sessionOf = (headers = {}) => clean(headers["x-session-id"]) || null;

const globRe = (p) => new RegExp("^" + String(p).split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
const positive = (n) => (Number.isFinite(n) && n > 0 ? n : null);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const hhmm = (x) => { const [h, m] = String(x).trim().split(":").map(Number); return h * 60 + (m || 0); };

/** Peak pricing hour? UTC windows "HH:MM-HH:MM", UTC weekdays, holidays as UTC dates YYYY-MM-DD. */
export function isPeak(ms, { peak_windows_utc = [], peak_weekdays = [], holidays = [] } = {}) {
  if (!Number.isFinite(ms)) return false;
  const d = new Date(ms);
  if (!(peak_weekdays || []).includes(WEEKDAYS[d.getUTCDay()])) return false;
  if ((holidays || []).map(ymd).includes(d.toISOString().slice(0, 10))) return false;
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (peak_windows_utc || []).some((w) => { const [a, b] = String(w).split("-").map(hhmm); return min >= a && min < b; });
}

/**
 * Dollars for one call from a price table: served model, then requested model,
 * then backend. An entry is { input, output, cached } (input = cache miss,
 * cached = cache hit) or { peak: {...}, offpeak: {...} } picked by the call's
 * request time `at` against the schedule (peak_windows_utc, peak_weekdays, holidays).
 */
export function estimateDollars(prices = {}, { model, modelServed, backend, input = 0, output = 0, cached = 0, at = null }, schedule = {}) {
  let p = prices[modelServed] || prices[model] || prices[backend];
  if (!p) return null;
  if (p.peak || p.offpeak) p = (isPeak(at, schedule) ? p.peak : p.offpeak) || p.offpeak || p.peak;
  return ((input || 0) * (p.input || 0) + (output || 0) * (p.output || 0) + (cached || 0) * (p.cached || 0)) / 1e6;
}

export function createClientGuard({ configPath = DEFAULT_CONFIG_PATH, getDb = () => null, siem = () => {}, now = Date.now, log = console } = {}) {
  const bootAt = now();
  let cfg = {};
  let cfgMtime = -1;
  let cfgCheckedAt = -Infinity;
  let familyRes = [];

  function loadConfig(force = false) {
    const t = now();
    if (!force && t - cfgCheckedAt < 10_000) return;
    cfgCheckedAt = t;
    let mtime;
    try { mtime = statSync(configPath).mtimeMs; } catch { if (cfgMtime !== 0) log.warn?.(`[client-guard] no config at ${configPath}: caps, limits and alerts off`); cfg = {}; cfgMtime = 0; familyRes = []; return; }
    if (mtime === cfgMtime) return;
    try {
      cfg = yamlLoad(readFileSync(configPath, "utf8")) || {};
      cfgMtime = mtime;
      familyRes = Object.entries(cfg.families || {}).map(([f, pats]) => [f, (pats || []).map(globRe)]);
      log.log?.(`[client-guard] config loaded from ${configPath}`);
    } catch (e) {
      log.error?.(`[client-guard] config ${configPath} unreadable, keeping previous: ${e.message}`);
    }
  }

  const active = () => cfg.enabled === true;
  const tz = () => zoneOf(cfg.timezone);
  const dayOf = (ms) => dayIn(ms, tz());
  // Optional estate wording appended to an alert summary: alerts.notes.<kind>.
  const note = (kind) => { const v = cfg.alerts?.notes?.[kind]; return v ? ` ${String(v).trim()}` : ""; };
  const exempt = (backend) => (cfg.exempt_backends || []).includes(backend);
  const familiesFor = (model) => familyRes.filter(([, res]) => res.some((re) => re.test(String(model || "")))).map(([f]) => f);
  const isFamily = (backend) => !!backend && !exempt(backend) && familyRes.some(([f]) => f === backend);
  const capFor = (client, family) => ({ ...(cfg.caps?.default?.[family] || {}), ...(cfg.caps?.clients?.[client]?.[family] || {}) });
  const rateFor = (client) => ({ ...(cfg.rate_limits?.default || {}), ...(cfg.rate_limits?.clients?.[client] || {}) });

  // day -> Map("client\tfamily" -> { calls, tokens, dollars })
  let usageDay = null;
  let usage = new Map();
  const windows = new Map();          // "c\t<client>" | "s\t<session>" -> [ms...]
  const minutes = new Map();          // client -> Map(minuteIndex -> calls), last 25 h
  const spikeCheckedMin = new Map();  // client -> minuteIndex
  const fired = new Set();            // alert keys "day\t..." fired today (mirrors alert_fired)
  const lastUse = new Map();          // backend -> ms of the last successful paid call

  function usageFor(client, family, t) {
    const day = dayOf(t);
    if (day !== usageDay) { usageDay = day; usage = new Map(); }
    const k = `${client}\t${family}`;
    let u = usage.get(k);
    if (!u) { u = { calls: 0, tokens: 0, dollars: 0 }; usage.set(k, u); }
    return u;
  }

  function bumpMinute(client, t, n = 1) {
    let m = minutes.get(client);
    if (!m) { m = new Map(); minutes.set(client, m); }
    const idx = Math.floor(t / 60000);
    m.set(idx, (m.get(idx) || 0) + n);
  }

  // Fired state lives in metrics.db (alert_fired) so a restart never repeats
  // an alert; memory only when metrics are off.
  let firedTable = false;
  function firedDb() {
    const db = getDb();
    if (db && !firedTable) {
      try { db.exec("CREATE TABLE IF NOT EXISTS alert_fired (key TEXT PRIMARY KEY, day TEXT NOT NULL, fired_at TEXT NOT NULL)"); firedTable = true; }
      catch (e) { log.error?.(`[client-guard] alert_fired table: ${e.message}`); return null; }
    }
    return firedTable ? db : null;
  }

  /** Fire once per key per day: outbox line (posted by scripts/post-alerts.py) plus an audit event. */
  function alertOnce(kind, name, fields, t) {
    const day = dayOf(t);
    const key = `${day}\t${kind}\t${name}`;
    if (fired.has(key)) return false;
    const db = firedDb();
    if (db) {
      try {
        if (db.prepare("INSERT OR IGNORE INTO alert_fired (key, day, fired_at) VALUES (?, ?, ?)").run(key, day, new Date(t).toISOString()).changes === 0) { fired.add(key); return false; }
      } catch (e) { log.error?.(`[client-guard] alert_fired write: ${e.message}`); }
    }
    fired.add(key);
    const rec = { ts: new Date(t).toISOString(), day, kind, key, severity: "warning", ...(cfg.alerts?.room ? { room: String(cfg.alerts.room) } : {}), ...fields };
    try { appendFileSync(cfg.alerts?.outbox || "./logs/alerts.jsonl", JSON.stringify(rec) + "\n"); }
    catch (e) { log.error?.(`[client-guard] alert outbox write failed: ${e.message}`); }
    siem({ ts: rec.ts, event: "client.alert", kind, client: fields.client ?? null, backend: fields.backend ?? null, title: fields.title, summary: fields.summary });
    return true;
  }

  const n = (v) => Number(v).toLocaleString("en-US");
  const localTime = (iso) => {
    const d = Date.parse(iso || "");
    return Number.isFinite(d) ? new Intl.DateTimeFormat("en-US", { timeZone: tz(), month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(d)) + ` ${tz()}` : "an unknown time";
  };

  function checkCapAlert(client, family, u, t) {
    const pct = cfg.alerts?.cap_percent ?? 80;
    if (!(pct > 0)) return;
    const cap = capFor(client, family);
    for (const unit of ["calls", "tokens"]) {
      const limit = positive(cap[unit]);
      if (!limit || u[unit] < limit * pct / 100) continue;
      alertOnce("cap", `${client}\t${family}\t${unit}\t${pct}`, {
        client, family, unit, used: u[unit], limit,
        title: `skgateway: client ${client} at ${pct} percent of its ${family} daily cap`,
        summary: `Client ${client}: ${n(u[unit])} of ${n(limit)} ${unit} on ${family} today (${dayOf(t)}, ${tz()}). At ${n(limit)} the gateway answers 429 to ${client}'s ${family} calls until midnight ${tz()}; its other families and other clients are not held.${note("cap")}`,
      }, t);
    }
  }

  function checkSpike(client, t) {
    const a = cfg.alerts || {};
    const factor = positive(a.spike_factor);
    if (!factor) return;
    const nowMin = Math.floor(t / 60000);
    if (spikeCheckedMin.get(client) === nowMin) return;
    spikeCheckedMin.set(client, nowMin);
    const m = minutes.get(client);
    if (!m) return;
    let lastHour = 0, prior = 0;
    for (const [idx, c] of m) {
      if (idx <= nowMin - 1500) m.delete(idx);
      else if (idx > nowMin - 60) lastHour += c;
      else prior += c;
    }
    const avg = prior / 24;
    if (lastHour < (a.spike_min_calls ?? 200) || lastHour <= factor * avg) return;
    alertOnce("spike", client, {
      client, last_hour_calls: lastHour, trailing_hourly_avg: Math.round(avg * 10) / 10, factor,
      title: `skgateway: call rate jump from client ${client}`,
      summary: `Client ${client}: ${n(lastHour)} paid-provider calls in the last hour, over ${factor} times its trailing 24-hour average of ${avg.toFixed(1)} an hour. Nothing is held by this alert; its daily caps and per-minute limits still apply.${note("spike")}`,
    }, t);
  }

  /** Provider snapshot hook (metrics/provider-usage.mjs): Codex used percent, DeepSeek floor. */
  function providerObserved(backend, source, data, t = now()) {
    loadConfig();
    if (backend === "codex" && source === "headers") {
      const pct = cfg.alerts?.codex_used_percent ?? 80;
      if (!(pct > 0)) return;
      for (const w of data?.windows || []) {
        if (w.unit !== "percent" || !(w.used_percent >= pct)) continue;
        alertOnce("codex", `${w.name}\t${pct}`, {
          backend, window: w.name, used_percent: w.used_percent, reset_at: w.reset_at,
          title: `skgateway: Codex ${w.name} window at ${w.used_percent} percent used`,
          summary: `codex ${w.name} window ${w.used_percent}% used, resets ${localTime(w.reset_at)}. At 100% Codex answers 429 until the reset.${note("codex")}`,
        }, t);
      }
    }
    if (backend === "deepseek" && source === "balance") {
      const floor = cfg.deepseek_balance_floor;
      if (floor === null || floor === undefined || !Number.isFinite(Number(floor))) return;
      for (const b of data?.balances || []) {
        if (b.total_balance === null || b.total_balance >= Number(floor)) continue;
        alertOnce("deepseek_floor", `${b.currency}\t${floor}`, {
          backend, currency: b.currency, total_balance: b.total_balance, floor: Number(floor),
          title: `skgateway: DeepSeek balance ${b.total_balance} ${b.currency} is below the floor`,
          summary: `DeepSeek balance ${b.total_balance} ${b.currency}, floor ${floor}. At 0 DeepSeek answers 402.${note("deepseek_floor")}`,
        }, t);
      }
    }
  }

  /** Stale snapshot: a backend used in the last stale_hours with no fresh snapshot for that long. */
  function checkStale(status, t = now()) {
    loadConfig();
    const hours = cfg.alerts?.stale_hours ?? 2;
    // Boot grace: the snapshot table starts empty, so give real calls stale_hours to fill it.
    if (!(hours > 0) || t - bootAt < hours * 3600e3) return;
    for (const [backend, b] of Object.entries(status?.backends || {})) {
      if (!(t - (lastUse.get(backend) || 0) < hours * 3600e3)) continue;
      if (b.age_seconds !== null && b.age_seconds <= hours * 3600) continue;
      alertOnce("stale", backend, {
        backend, age_seconds: b.age_seconds,
        title: `skgateway: ${backend} provider status is stale`,
        summary: `${backend} is in use but its last provider snapshot is ${b.age_seconds === null ? "missing" : `${Math.round(b.age_seconds / 60)} minutes old`} (limit ${hours} h), so /status provider_usage is stale for it.${note("stale")}`,
      }, t);
    }
  }

  /** Seed today's counters and the 25 h minute history from request_log, once at boot. */
  function seed() {
    const db = getDb();
    if (!db) return;
    const t = now();
    try {
      const cached = new Map();
      for (const r of db.prepare("SELECT req_id, cache_read_tokens FROM token_usage WHERE ts >= ?").iterate(t - 26 * 3600e3)) {
        if (r.cache_read_tokens) cached.set(r.req_id, r.cache_read_tokens);
      }
      const today = dayOf(t);
      let n = 0;
      for (const r of db.prepare("SELECT id, started_at, client, backend, model, model_served, input_tokens, output_tokens, status_code FROM request_log WHERE started_at >= ?").iterate(t - 26 * 3600e3)) {
        if (!isFamily(r.backend)) continue;
        const client = r.client || "untagged";
        if (r.started_at > t - 1500 * 60000) bumpMinute(client, r.started_at);
        if (r.status_code >= 200 && r.status_code < 400 && r.started_at > (lastUse.get(r.backend) || 0)) lastUse.set(r.backend, r.started_at);
        if (dayOf(r.started_at) !== today || !(r.status_code >= 200 && r.status_code < 400)) continue;
        const u = usageFor(client, r.backend, t);
        const input = r.input_tokens || 0, output = r.output_tokens || 0;
        u.calls += 1;
        u.tokens += input + output;
        u.dollars += estimateDollars(cfg.prices, { model: r.model, modelServed: r.model_served, backend: r.backend, input, output, cached: cached.get(r.id) || 0, at: r.started_at }, cfg) || 0;
        n++;
      }
      log.log?.(`[client-guard] seeded ${n} successful calls for ${today} from request_log`);
    } catch (e) {
      log.error?.(`[client-guard] seed from request_log failed (counters start at zero): ${e.message}`);
    }
  }

  const deny = (status, code, message, extra = {}, retryAfter = null, type = "rate_limit_error") => ({
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...(retryAfter ? { "retry-after": String(retryAfter) } : {}) },
    body: JSON.stringify({ error: { message, code, status, type, ...extra } }),
  });

  /**
   * Pre-dispatch check. Returns { client, session, reject } where reject is
   * null or { status, headers, body } to send instead of routing.
   */
  function check({ headers = {}, model, remote = null, path = null, client: verified = null } = {}) {
    loadConfig();
    const t = now();
    const client = verified || clientOf(headers);
    const session = sessionOf(headers);

    if (client === "untagged") {
      const grace = cfg.untagged_grace_until;
      siem({
        ts: new Date(t).toISOString(), event: "client.untagged", client, remote, path, model: model ?? null,
        user_agent: headers["user-agent"] ?? null,
        ...(grace ? { warning: dayOf(t) <= String(grace)
          ? `untagged request: send x-app (SKGW_CLIENT); grace until ${grace}, after that reject_untagged may be switched on`
          : `untagged request after the grace date ${grace}` } : {}),
      });
      if (cfg.reject_untagged === true) {
        return { client, session, reject: deny(400, "client_untagged",
          "Client identity required: send the x-app header (pi: set SKGW_CLIENT).", {}, null, "invalid_request_error") };
      }
    }
    if (!active()) return { client, session, reject: null };

    // Daily caps. A model that can land on several families (generic buckets)
    // is refused only when every one of them is over the cap.
    // ponytail: the family is predicted from the model name, so a bucket can
    // still route one call to a family that is over; the router would need a
    // per-backend veto to close that, add it if the backstop proves leaky.
    const families = familiesFor(model);
    if (families.length) {
      let first = null;
      const over = families.every((family) => {
        const cap = capFor(client, family);
        const u = usageFor(client, family, t);
        for (const unit of ["calls", "tokens"]) {
          const limit = positive(cap[unit]);
          if (limit && u[unit] >= limit) { first ??= { client, family, unit, limit, used: u[unit], day: dayOf(t) }; return true; }
        }
        return false;
      });
      if (over) {
        siem({ ts: new Date(t).toISOString(), event: "client.cap_denied", ...first, model: model ?? null, session_id: session });
        return { client, session, reject: deny(429, "client_daily_cap",
          `Daily cap reached: client "${client}" used ${first.used} of ${first.limit} ${first.unit} on ${first.family} today (${first.day}, ${tz()}). Resets at midnight ${tz()}.`,
          { cap: first }, secondsToMidnight(t, tz())) };
      }
    }

    // Calls-per-minute limits, sliding 60 s window.
    const rate = rateFor(client);
    const keys = [[`c\t${client}`, positive(rate.client_per_minute), "client"]];
    if (session) keys.push([`s\t${session}`, positive(rate.session_per_minute), "session"]);
    for (const [key, limit, scope] of keys) {
      if (!limit) continue;
      const w = windows.get(key) || [];
      while (w.length && w[0] <= t - 60000) w.shift();
      windows.set(key, w);
      if (w.length >= limit) {
        const retry = Math.max(1, Math.ceil((w[0] + 60000 - t) / 1000));
        siem({ ts: new Date(t).toISOString(), event: "client.rate_limited", client, session_id: session, scope, limit, model: model ?? null });
        return { client, session, reject: deny(429, "client_rate_limited",
          `Rate limit: ${scope} ${scope === "client" ? client : session} is over ${limit} calls per minute. Retry after ${retry} s.`,
          { limit: { scope, per_minute: limit } }, retry) };
      }
    }
    for (const [key, limit] of keys) if (limit) windows.get(key).push(t);
    // ponytail: idle window keys are swept only when the map grows past 10k.
    if (windows.size > 10_000) for (const [k, w] of windows) if (!w.length || w[w.length - 1] <= t - 60000) windows.delete(k);

    if (families.length) { bumpMinute(client, t); checkSpike(client, t); }
    return { client, session, reject: null };
  }

  /** Post-response accounting: successful calls on a paid family only. */
  function record({ client, backend, statusCode, headers = {}, body = null, model, modelServed, at = null } = {}) {
    if (!active() || !isFamily(backend) || !(statusCode >= 200 && statusCode < 400)) return;
    const t = now();
    const tok = extractTokens({ headers, body: body ?? {} });
    const input = tok.input_tokens || 0, output = tok.output_tokens || 0, cached = tok.cache_read_tokens || 0;
    lastUse.set(backend, t);
    const u = usageFor(client || "untagged", backend, t);
    u.calls += 1;
    u.tokens += input + output;
    u.dollars += estimateDollars(cfg.prices, { model, modelServed, backend, input, output, cached, at: at ?? t }, cfg) || 0;
    checkCapAlert(client || "untagged", backend, u, t);
  }

  /** Today's in-memory counters against the caps. */
  function snapshot() {
    loadConfig();
    const t = now();
    usageFor("_", "_", t); usage.delete("_\t_");
    return {
      day: usageDay, enabled: active(), reject_untagged: cfg.reject_untagged === true,
      clients: [...usage].map(([k, u]) => {
        const [client, family] = k.split("\t");
        const cap = capFor(client, family);
        return { client, family, calls: u.calls, tokens: u.tokens, dollars: Math.round(u.dollars * 1e4) / 1e4,
          cap_calls: positive(cap.calls), cap_tokens: positive(cap.tokens) };
      }),
    };
  }

  /** Estimated dollars per day (caps file timezone), client and provider from request_log. */
  function spend({ days = 1 } = {}) {
    loadConfig();
    const db = getDb();
    if (!db) return { available: false, reason: "metrics_database_unavailable" };
    const t = now();
    const d = Math.min(31, Math.max(1, Math.floor(Number(days) || 1)));
    const since = t - d * 86400e3;
    const cached = new Map();
    for (const r of db.prepare("SELECT req_id, cache_read_tokens FROM token_usage WHERE ts >= ?").iterate(since)) {
      if (r.cache_read_tokens) cached.set(r.req_id, r.cache_read_tokens);
    }
    const agg = new Map();
    // ponytail: full scan of request_log (no started_at index), fine for a loopback admin call.
    for (const r of db.prepare("SELECT id, started_at, client, backend, model, model_served, input_tokens, output_tokens, status_code FROM request_log WHERE started_at >= ?").iterate(since)) {
      const day = dayOf(r.started_at);
      const k = `${day}\t${r.client || "untagged"}\t${r.backend || "none"}`;
      let a = agg.get(k);
      if (!a) { a = { day, client: r.client || "untagged", provider: r.backend || "none", calls: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, dollars: 0, unpriced_calls: 0 }; agg.set(k, a); }
      a.calls += 1;
      const input = r.input_tokens || 0, output = r.output_tokens || 0, c = cached.get(r.id) || 0;
      a.input_tokens += input; a.output_tokens += output; a.cached_tokens += c;
      const usd = estimateDollars(cfg.prices, { model: r.model, modelServed: r.model_served, backend: r.backend, input, output, cached: c, at: r.started_at }, cfg);
      if (usd === null) a.unpriced_calls += 1; else a.dollars += usd;
    }
    const rows = [...agg.values()].map((a) => ({ ...a, dollars: Math.round(a.dollars * 1e4) / 1e4 }))
      .sort((x, y) => (x.day < y.day ? 1 : x.day > y.day ? -1 : y.dollars - x.dollars));
    return { available: true, days: d, timezone: tz(), rows };
  }

  /**
   * Yesterday's (caps file timezone) first and last DeepSeek balance reading and the
   * estimated DeepSeek dollars between them, for the daily summary. Computed
   * once per day (yesterday is final), so /status polling stays cheap.
   */
  let dailyCache = null;
  function deepseekDaily() {
    loadConfig();
    const db = getDb();
    if (!db) return null;
    const [y, m, d] = dayOf(now()).split("-").map(Number);
    const day = new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
    if (dailyCache?.day === day) return dailyCache;
    let rows = [];
    try {
      rows = db.prepare("SELECT observed_at, currency, total_balance FROM deepseek_balance_log WHERE observed_at >= ? ORDER BY observed_at")
        .all(new Date(Date.UTC(y, m - 1, d - 3)).toISOString())
        .filter((r) => dayOf(Date.parse(r.observed_at)) === day);
    } catch { /* table not there yet */ }
    const usd = rows.filter((r) => r.currency === "USD");
    const list = usd.length ? usd : rows;
    if (list.length < 1) return (dailyCache = { day, readings: 0, first: null, last: null, balance_drop: null, estimated_dollars: null, drift_percent: null });
    const first = list[0], last = list[list.length - 1];
    const from = Date.parse(first.observed_at), to = Date.parse(last.observed_at);
    const cached = new Map();
    for (const r of db.prepare("SELECT req_id, cache_read_tokens FROM token_usage WHERE backend = 'deepseek' AND ts >= ? AND ts < ?").iterate(from, to + 3600e3)) {
      if (r.cache_read_tokens) cached.set(r.req_id, r.cache_read_tokens);
    }
    let est = 0;
    // ponytail: one request_log scan per day (no started_at index); cached for the day.
    for (const r of db.prepare("SELECT id, started_at, model, model_served, backend, input_tokens, output_tokens FROM request_log WHERE backend = 'deepseek' AND started_at >= ? AND started_at < ?").iterate(from, to)) {
      est += estimateDollars(cfg.prices, { model: r.model, modelServed: r.model_served, backend: r.backend, input: r.input_tokens || 0, output: r.output_tokens || 0, cached: cached.get(r.id) || 0, at: r.started_at }, cfg) || 0;
    }
    const drop = Math.round((first.total_balance - last.total_balance) * 1e4) / 1e4;
    est = Math.round(est * 1e4) / 1e4;
    return (dailyCache = {
      day, currency: first.currency, readings: list.length,
      first: { observed_at: first.observed_at, total_balance: first.total_balance },
      last: { observed_at: last.observed_at, total_balance: last.total_balance },
      balance_drop: drop, estimated_dollars: est,
      drift_percent: drop > 0 ? Math.round(((est - drop) / drop) * 1000) / 10 : null,
    });
  }

  loadConfig(true);
  seed();
  return { check, record, snapshot, spend, providerObserved, checkStale, deepseekDaily, _config: () => cfg };
}
