/**
 * collector.mjs — Metrics & Token Tracking for SKGateway
 *
 * Responsibilities
 * ────────────────
 * 1. Token Tracking  — parse token counts from every response, aggregate by
 *    agent_id / model / backend / session_id / hour / day.
 * 2. Cost Calculation — multiply token counts by per-model pricing from config.
 * 3. Latency Tracking — record request duration with streaming P50/P95/P99
 *    using the P²-algorithm (no unbounded history). Per backend/model a
 *    Welford running mean+variance drives 3-sigma anomaly detection, and a
 *    bounded ring buffers the most recent anomalies for the /status surface.
 * 4. SQLite Storage   — batch-write every 5 s or 100 events; auto-purge old rows.
 * 5. In-Memory Counters — rolling 5-minute window for the live dashboard.
 *
 * Usage
 * ─────
 *   import { createMetricsCollector } from './metrics/collector.mjs';
 *   // Pass either the already-extracted metrics config…
 *   const metrics = createMetricsCollector(config.metrics);
 *   // …or the full gateway config (both shapes are accepted).
 *   const metrics = createMetricsCollector(config);
 *
 *   const reqId = metrics.recordRequest({ agentId, model, backend, sessionId });
 *   // … proxy forwards request …
 *   metrics.recordResponse({ reqId, agentId, model, backend, sessionId,
 *                            tokens, firstByteMs, totalMs, statusCode });
 *
 *   const stats  = metrics.getStats();
 *   const usage  = metrics.getTokenUsage({ agentId: 'lumina', since: Date.now() - 3600_000 });
 *   const costs  = metrics.getCosts({ model: 'claude-sonnet-4-6' });
 *
 * @module metrics/collector
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getPricing } from '../config.mjs';

// ─── constants ────────────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS  = 5_000;   // max time between SQLite batch flushes
const FLUSH_BATCH_SIZE   = 100;     // flush early when the buffer reaches this
const WINDOW_MS          = 5 * 60 * 1000;  // 5-minute in-memory rolling window
const PURGE_INTERVAL_MS  = 6 * 60 * 60 * 1000; // purge old rows every 6 h

// Bound the in-memory cost breakdown so a churn of distinct agent/model keys
// can never grow memory without limit. Once the cap is hit, further keys fold
// into a single "_other" bucket. SQLite (cost_log) keeps full-fidelity history.
const MAX_COST_KEYS      = 200;

// ─── anomaly detection tunables ────────────────────────────────────────────────
const ANOMALY_SIGMA       = 3;   // flag samples ≥ this many σ from the running mean
const ANOMALY_MIN_SAMPLES = 30;  // require a stable baseline before flagging
const ANOMALY_RING_SIZE   = 50;  // bounded history of recent anomalies for /status

// ─── P² percentile estimator ─────────────────────────────────────────────────

/**
 * Streaming percentile estimator using the P² algorithm.
 * Tracks a single quantile without storing all samples.
 *
 * Reference: Jain & Chlamtac (1985), "The P² Algorithm for Dynamic
 * Calculation of Quantiles and Histograms Without Storing Observations".
 */
class P2Estimator {
  /**
   * @param {number} p  Target quantile in (0, 1), e.g. 0.95 for P95.
   */
  constructor(p) {
    this.p = p;
    this._n = 0;                    // total observations
    this._q  = [0, 0, 0, 0, 0];    // marker heights (quantile estimates)
    // Desired-position increments per observation: n'_i grows by _inc[i] each step.
    this._inc = [0, p / 2, p, (1 + p) / 2, 1];
    this._np  = [1, 2, 3, 4, 5];   // actual marker positions
    // Desired marker positions; seeded for n=5 as n'_i = 1 + 4·_inc[i].
    this._npd = [1, 1 + 2 * p, 1 + 4 * p, 3 + 2 * p, 5];
  }

  /** Add one sample. @param {number} x */
  update(x) {
    // Initialisation phase: buffer the first 5 samples, then sort into markers.
    if (this._n < 5) {
      this._q[this._n] = x;
      this._n++;
      if (this._n === 5) this._q.sort((a, b) => a - b);
      return;
    }

    // Step B.1 — find the cell k the new sample falls into, extending the
    // min/max markers if it lies outside the current range.
    let k;
    if (x < this._q[0]) {
      this._q[0] = x; k = 0;
    } else if (x < this._q[1]) {
      k = 0;
    } else if (x < this._q[2]) {
      k = 1;
    } else if (x < this._q[3]) {
      k = 2;
    } else if (x <= this._q[4]) {
      k = 3;
    } else {
      this._q[4] = x; k = 3;
    }

    // Step B.2 — increment actual positions of markers above the cell, and
    // advance every marker's desired position by its per-step increment.
    for (let i = k + 1; i < 5; i++) this._np[i]++;
    for (let i = 0; i < 5; i++) this._npd[i] += this._inc[i];

    // Step B.3 — adjust the three interior marker heights if they have drifted
    // a full position away from their desired location.
    for (let i = 1; i <= 3; i++) {
      const d0 = this._npd[i] - this._np[i];
      if ((d0 >= 1 && this._np[i + 1] - this._np[i] > 1) ||
          (d0 <= -1 && this._np[i - 1] - this._np[i] < -1)) {
        const d = d0 > 0 ? 1 : -1;
        const qp = this._parabolic(i, d);
        if (this._q[i - 1] < qp && qp < this._q[i + 1]) {
          this._q[i] = qp;
        } else {
          this._q[i] = this._linear(i, d);
        }
        this._np[i] += d;
      }
    }

    this._n++;
  }

  /** @param {number} i @param {number} d */
  _parabolic(i, d) {
    const { _q: q, _np: n } = this;
    return q[i] + d / (n[i+1] - n[i-1]) * (
      (n[i] - n[i-1] + d) * (q[i+1] - q[i]) / (n[i+1] - n[i]) +
      (n[i+1] - n[i] - d) * (q[i] - q[i-1]) / (n[i] - n[i-1])
    );
  }

  /** @param {number} i @param {number} d */
  _linear(i, d) {
    const { _q: q, _np: n } = this;
    return q[i] + d * (q[i + d] - q[i]) / (n[i + d] - n[i]);
  }

  /**
   * Current estimate of the tracked quantile.
   * Returns 0 if fewer than 5 samples have been seen.
   * @returns {number}
   */
  get value() {
    if (this._n < 5) return this._n > 0 ? Math.max(...this._q.slice(0, this._n)) : 0;
    return this._q[2];
  }
}

// ─── rolling-window counter ───────────────────────────────────────────────────

/**
 * Lightweight FIFO ring-buffer for counting events in a trailing time window.
 * Stores `{ ts, value }` tuples; `total()` returns the sum of values whose
 * timestamp is within the last `windowMs` milliseconds.
 */
class RollingCounter {
  /** @param {number} windowMs */
  constructor(windowMs) {
    this._window = windowMs;
    /** @type {Array<{ ts: number, value: number }>} */
    this._buf = [];
  }

  /** @param {number} [value=1] */
  add(value = 1) {
    this._buf.push({ ts: Date.now(), value });
  }

  /** @returns {number} */
  total() {
    const cutoff = Date.now() - this._window;
    this._buf = this._buf.filter(e => e.ts >= cutoff);
    return this._buf.reduce((s, e) => s + e.value, 0);
  }
}

// ─── schema ───────────────────────────────────────────────────────────────────

const DDL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;

CREATE TABLE IF NOT EXISTS request_log (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT,
  model         TEXT,               -- the model the CALLER ASKED FOR
  backend       TEXT,
  session_id    TEXT,
  started_at    INTEGER NOT NULL,   -- Unix ms
  status_code   INTEGER,
  first_byte_ms INTEGER,            -- ms to first byte
  total_ms      INTEGER,            -- total round-trip ms
  error_msg     TEXT,
  -- The model the UPSTREAM SAID it served, read from the response body. NULL
  -- means UNOBSERVED (SSE, non-JSON, or a body with no model field) and never
  -- "same as requested"; see recordResponse() for why that distinction is the
  -- entire value of the column. Declared LAST on purpose so a database created
  -- fresh and one migrated by ensureColumn() below have the same column order.
  model_served  TEXT,
  status_class  TEXT,               -- 1xx..5xx; NULL means no status observed
  terminal_state TEXT,              -- succeeded | failed | cancelled | unknown
  input_tokens  INTEGER,            -- NULL means unobserved, never zero by default
  output_tokens INTEGER,            -- NULL means unobserved, never zero by default
  cost_usd      REAL,               -- actual/estimated value; NULL when unknown
  cost_truth    TEXT,               -- actual | estimated | unknown
  generation_tps REAL,              -- output tokens / measured post-first-byte seconds
  -- Provider-neutral rail attribution (card e19f88db / SKGW-ATTRIBUTION-01).
  -- All fields are NULL when unknown; presence means we observed the value.
  client           TEXT,            -- from x-app header
  application      TEXT,            -- from user-agent header
  logical_route    TEXT,            -- registry routing (context/service/role)
  rail             TEXT,            -- local | cloud | hybrid
  provider         TEXT,            -- inferred from backend (nvidia, anthropic, local, etc.)
  backend_node     TEXT,            -- backend ID (e.g., chiap08-qwen38)
  requested_model  TEXT,            -- model the caller asked for (same as model)
  served_model     TEXT,            -- model the upstream actually served (same as model_served)
  runtime_revision TEXT             -- readiness:discovery revision tuple
);

CREATE TABLE IF NOT EXISTS token_usage (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id          TEXT NOT NULL,
  agent_id        TEXT,
  model           TEXT,
  backend         TEXT,
  session_id      TEXT,
  ts              INTEGER NOT NULL,  -- Unix ms
  hour_bucket     TEXT NOT NULL,     -- YYYY-MM-DDTHH (UTC)
  day_bucket      TEXT NOT NULL,     -- YYYY-MM-DD    (UTC)
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cache_read_tokens   INTEGER,
  cache_write_tokens  INTEGER
);

CREATE TABLE IF NOT EXISTS cost_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id        TEXT NOT NULL,
  agent_id      TEXT,
  model         TEXT,
  backend       TEXT,
  session_id    TEXT,
  ts            INTEGER NOT NULL,
  day_bucket    TEXT NOT NULL,
  input_cost    REAL DEFAULT 0,
  output_cost   REAL DEFAULT 0,
  cache_read_cost  REAL DEFAULT 0,
  cache_write_cost REAL DEFAULT 0,
  total_cost    REAL GENERATED ALWAYS AS
                  (input_cost + output_cost + cache_read_cost + cache_write_cost) VIRTUAL
);

CREATE TABLE IF NOT EXISTS latency_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id        TEXT NOT NULL,
  model         TEXT,
  backend       TEXT,
  ts            INTEGER NOT NULL,
  first_byte_ms INTEGER,
  total_ms      INTEGER
);

CREATE TABLE IF NOT EXISTS energy_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  req_id        TEXT NOT NULL,
  agent_id      TEXT,
  model         TEXT,
  backend       TEXT,
  card_id       TEXT,
  ts            INTEGER NOT NULL,
  day_bucket    TEXT NOT NULL,
  joules        REAL,              -- NULL means "unknown", which is a real answer
  basis         TEXT NOT NULL,     -- measured_gpu | imputed_local | imputed_cloud
  node          TEXT,
  concurrency_n INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_token_agent_day   ON token_usage (agent_id, day_bucket);
CREATE INDEX IF NOT EXISTS idx_token_model_hour  ON token_usage (model, hour_bucket);
CREATE INDEX IF NOT EXISTS idx_cost_day          ON cost_log (day_bucket);
CREATE INDEX IF NOT EXISTS idx_latency_backend   ON latency_log (backend, ts);
CREATE INDEX IF NOT EXISTS idx_request_agent     ON request_log (agent_id, started_at);
CREATE INDEX IF NOT EXISTS idx_energy_day        ON energy_log (day_bucket);
CREATE INDEX IF NOT EXISTS idx_energy_card       ON energy_log (card_id);
CREATE INDEX IF NOT EXISTS idx_energy_backend    ON energy_log (backend, ts);
`;

// ─── schema migration ────────────────────────────────────────────────────────

/**
 * Add a column to an existing table when it is absent, and do nothing when it
 * is already there.
 *
 * WHY THIS EXISTS AT ALL, flagged deliberately: before card 316dd167 this file
 * had NO migration mechanism. The whole schema was one `CREATE TABLE IF NOT
 * EXISTS` block, which is exactly the statement that does nothing to a table
 * that already exists. So every column added to the DDL after a node's first
 * boot appeared only on databases created fresh afterwards, and silently never
 * appeared on the live one. On this node that is an 8,199-row file that has
 * been open since long before this change. There is still no version counter
 * and no down-migration, and this helper is not a substitute for one; it is the
 * smallest thing that makes ONE additive column land on an existing file
 * without touching a byte of its data.
 *
 * Additive only, and that is not an accident: `ALTER TABLE ADD COLUMN` in
 * SQLite rewrites no rows, so it is safe against a live database and the new
 * column reads NULL on every pre-existing row. That NULL is the correct value.
 * History is not retroactively attributed on this fleet: rows written before
 * the gateway observed a fact do not get that fact invented for them.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} table   Table name (a literal from this module, never caller input).
 * @param {string} column  Column name (likewise).
 * @param {string} decl    Type/constraint text, e.g. 'TEXT'.
 * @returns {boolean} true if the column was added by this call.
 */
function ensureColumn(db, table, column, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  // No rows means the table does not exist, which is the DDL's job, not ours.
  // ALTERing it here would throw and take the whole collector down with it.
  if (cols.length === 0) return false;
  if (cols.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  return true;
}

/**
 * Bring an existing metrics database up to the current schema.
 *
 * Every entry must be idempotent and additive, because this runs on EVERY
 * collector construction, against a file that may be brand new or years old.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {void}
 */
function migrate(db) {
  // card 316dd167 / A8. request_log.model has always held the REQUESTED model,
  // and so has token_usage.model: across 1,445 joined rows on the live database
  // the two never once disagreed, because they are copies of one value. Nothing
  // recorded what actually answered, so a silent substitution and an ordinary
  // call produced identical rows.
  ensureColumn(db, 'request_log', 'model_served', 'TEXT');
  ensureColumn(db, 'request_log', 'status_class', 'TEXT');
  ensureColumn(db, 'request_log', 'terminal_state', 'TEXT');
  ensureColumn(db, 'request_log', 'input_tokens', 'INTEGER');
  ensureColumn(db, 'request_log', 'output_tokens', 'INTEGER');
  ensureColumn(db, 'request_log', 'cost_usd', 'REAL');
  ensureColumn(db, 'request_log', 'cost_truth', 'TEXT');
  ensureColumn(db, 'request_log', 'generation_tps', 'REAL');
  // Provider-neutral rail attribution (card e19f88db / SKGW-ATTRIBUTION-01).
  // All are NULL when unknown; presence means we observed the value.
  ensureColumn(db, 'request_log', 'client', 'TEXT');
  ensureColumn(db, 'request_log', 'application', 'TEXT');
  ensureColumn(db, 'request_log', 'logical_route', 'TEXT');
  ensureColumn(db, 'request_log', 'rail', 'TEXT');
  ensureColumn(db, 'request_log', 'provider', 'TEXT');
  ensureColumn(db, 'request_log', 'backend_node', 'TEXT');
  ensureColumn(db, 'request_log', 'requested_model', 'TEXT');
  ensureColumn(db, 'request_log', 'served_model', 'TEXT');
  ensureColumn(db, 'request_log', 'runtime_revision', 'TEXT');
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a short random request ID (hex, 12 chars).
 * @returns {string}
 */
function newReqId() {
  return Math.random().toString(16).slice(2, 14);
}

/**
 * Format a Unix-ms timestamp to `YYYY-MM-DDTHH` (UTC hour bucket).
 * @param {number} ts
 * @returns {string}
 */
function hourBucket(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}`;
}

/**
 * Format a Unix-ms timestamp to `YYYY-MM-DD` (UTC day bucket).
 * @param {number} ts
 * @returns {string}
 */
function dayBucket(ts) {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;
}

/** @param {number} n @returns {string} */
function pad(n) { return String(n).padStart(2, '0'); }

/**
 * Extract token usage from a response object (supports Anthropic header style
 * and OpenAI-compatible body style).
 *
 * @param {object} opts
 * @param {Record<string, string>} [opts.headers]  Response headers
 * @param {object}                 [opts.body]     Parsed response body
 * @returns {{ input_tokens: number|null, output_tokens: number|null,
 *             cache_read_tokens: number|null, cache_write_tokens: number|null }}
 */
function extractTokens({ headers = {}, body = {} } = {}) {
  const observedCount = (value) => Number.isInteger(value) && value >= 0 ? value : null;
  let input = null, output = null, cacheRead = null, cacheWrite = null;

  // ── Anthropic header format ──────────────────────────────────────────────
  // x-usage: {"input_tokens":100,"output_tokens":50}
  const hdr = headers['x-usage'] ?? headers['x_usage'];
  if (hdr) {
    try {
      const u = JSON.parse(hdr);
      input      = observedCount(u.input_tokens);
      output     = observedCount(u.output_tokens);
      cacheRead  = observedCount(u.cache_read_tokens);
      cacheWrite = observedCount(u.cache_write_tokens);
    } catch { /* malformed usage is unobserved */ }
  }

  // ── OpenAI-compatible body.usage ──────────────────────────────────────────
  const u = body?.usage;
  if (u && typeof u === 'object') {
    input      ??= observedCount(u.input_tokens ?? u.prompt_tokens);
    output     ??= observedCount(u.output_tokens ?? u.completion_tokens);
    cacheRead  ??= observedCount(u.cache_read_input_tokens);
    cacheWrite ??= observedCount(u.cache_creation_input_tokens);
  }

  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
  };
}

/**
 * Calculate cost in USD given token counts and pricing (per 1M).
 *
 * @param {{ input_tokens: number, output_tokens: number,
 *            cache_read_tokens: number, cache_write_tokens: number }} tokens
 * @param {{ input: number, output: number,
 *            cache_read?: number, cache_write?: number }} pricing
 * @returns {{ input_cost: number, output_cost: number,
 *             cache_read_cost: number, cache_write_cost: number }}
 */
function calcCost(tokens, pricing) {
  const M = 1_000_000;
  return {
    input_cost:       ((tokens.input_tokens ?? 0)       / M) * (pricing.input       ?? 0),
    output_cost:      ((tokens.output_tokens ?? 0)      / M) * (pricing.output      ?? 0),
    cache_read_cost:  ((tokens.cache_read_tokens ?? 0)  / M) * (pricing.cache_read  ?? 0),
    cache_write_cost: ((tokens.cache_write_tokens ?? 0) / M) * (pricing.cache_write ?? 0),
  };
}

// ─── factory ──────────────────────────────────────────────────────────────────

/**
 * Create and return a metrics collector bound to the given config.
 *
 * Accepts either shape:
 *   - the already-extracted metrics config, e.g. `config.metrics` (how
 *     `index.mjs` calls it), or
 *   - the full validated gateway config, in which case the `.metrics` slice
 *     is used.
 * Passing the full config and passing `config.metrics` both work, so a caller
 * that dereferences one level too many (or too few) can no longer silently
 * disable metrics.
 *
 * @param {object} config  The metrics config, or the full gateway config.
 * @returns {MetricsCollector}
 */
export function createMetricsCollector(config) {
  const cfg = config?.metrics ?? config ?? {};

  // ── open / initialise SQLite ─────────────────────────────────────────────
  let db = null;
  if (cfg.enabled) {
    const dbPath = cfg.db_path;
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.exec(DDL);
    // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
    // so the DDL above only ever reaches a fresh file. Everything additive that
    // has to reach the live 8,199-row database goes through migrate().
    migrate(db);
  }

  // ── prepared statements ──────────────────────────────────────────────────
  let stmts = null;
  if (db) {
    stmts = {
      insertRequest: db.prepare(`
        INSERT OR IGNORE INTO request_log
          (id, agent_id, model, backend, session_id, started_at)
        VALUES (@id, @agent_id, @model, @backend, @session_id, @started_at)
      `),
      updateRequest: db.prepare(`
        UPDATE request_log
        SET status_code = @status_code,
            status_class = @status_class,
            terminal_state = @terminal_state,
            first_byte_ms = @first_byte_ms,
            total_ms = @total_ms,
            input_tokens = @input_tokens,
            output_tokens = @output_tokens,
            cost_usd = @cost_usd,
            cost_truth = @cost_truth,
            generation_tps = @generation_tps,
            client = COALESCE(@client, client),
            application = COALESCE(@application, application),
            logical_route = COALESCE(@logical_route, logical_route),
            rail = COALESCE(@rail, rail),
            provider = COALESCE(@provider, provider),
            backend_node = COALESCE(@backend_node, backend_node),
            requested_model = COALESCE(@requested_model, requested_model),
            served_model = COALESCE(@served_model, served_model),
            runtime_revision = COALESCE(@runtime_revision, runtime_revision),
            error_msg = @error_msg,
            backend = COALESCE(@backend, backend),
            model_served = COALESCE(@model_served, model_served)
        WHERE id = @id
      `),
      insertTokenUsage: db.prepare(`
        INSERT INTO token_usage
          (req_id, agent_id, model, backend, session_id, ts, hour_bucket, day_bucket,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
        VALUES
          (@req_id, @agent_id, @model, @backend, @session_id, @ts, @hour_bucket, @day_bucket,
           @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens)
      `),
      insertCost: db.prepare(`
        INSERT INTO cost_log
          (req_id, agent_id, model, backend, session_id, ts, day_bucket,
           input_cost, output_cost, cache_read_cost, cache_write_cost)
        VALUES
          (@req_id, @agent_id, @model, @backend, @session_id, @ts, @day_bucket,
           @input_cost, @output_cost, @cache_read_cost, @cache_write_cost)
      `),
      insertLatency: db.prepare(`
        INSERT INTO latency_log (req_id, model, backend, ts, first_byte_ms, total_ms)
        VALUES (@req_id, @model, @backend, @ts, @first_byte_ms, @total_ms)
      `),
      insertEnergy: db.prepare(`
        INSERT INTO energy_log
          (req_id, agent_id, model, backend, card_id, ts, day_bucket, joules, basis, node, concurrency_n)
        VALUES
          (@req_id, @agent_id, @model, @backend, @card_id, @ts, @day_bucket, @joules, @basis, @node, @concurrency_n)
      `),
    };

    // Wrap all inserts in a single transaction for performance
    stmts.flushBatch = db.transaction((rows) => {
      for (const row of rows) {
        if (row._type === 'request') {
          stmts.insertRequest.run(row);
        } else if (row._type === 'response') {
          stmts.updateRequest.run(row);
          if (row._tokens) stmts.insertTokenUsage.run(row._tokens);
          if (row._cost)   stmts.insertCost.run(row._cost);
          stmts.insertLatency.run(row._latency);
        } else if (row._type === 'energy') {
          stmts.insertEnergy.run(row);
        }
      }
    });
  }

  // ── write buffer ─────────────────────────────────────────────────────────
  /** @type {object[]} */
  const writeBuffer = [];

  function maybeFlush(force = false) {
    if (!db || writeBuffer.length === 0) return;
    if (force || writeBuffer.length >= FLUSH_BATCH_SIZE) {
      const batch = writeBuffer.splice(0, writeBuffer.length);
      try {
        stmts.flushBatch(batch);
      } catch (err) {
        process.stderr.write(`[skgateway:metrics] Flush error: ${err.message}\n`);
      }
    }
  }

  const flushTimer = db
    ? setInterval(() => maybeFlush(true), FLUSH_INTERVAL_MS)
    : null;
  if (flushTimer) flushTimer.unref();

  // ── auto-purge ───────────────────────────────────────────────────────────
  function purgeOld() {
    if (!db) return;
    const cutoff = Date.now() - cfg.retention_days * 86_400_000;
    try {
      // Run each DELETE separately (better-sqlite3 doesn't support multi-statements in prepare)
      db.prepare('DELETE FROM token_usage WHERE ts < ?').run(cutoff);
      db.prepare('DELETE FROM cost_log     WHERE ts < ?').run(cutoff);
      db.prepare('DELETE FROM latency_log  WHERE ts < ?').run(cutoff);
      db.prepare('DELETE FROM request_log  WHERE started_at < ?').run(cutoff);
    } catch (err) {
      process.stderr.write(`[skgateway:metrics] Purge error: ${err.message}\n`);
    }
  }

  const purgeTimer = db
    ? setInterval(purgeOld, PURGE_INTERVAL_MS)
    : null;
  if (purgeTimer) purgeTimer.unref();

  // ── in-memory counters ───────────────────────────────────────────────────
  const counters = {
    totalRequests:   0,
    activeRequests:  0,
    errorCount:      0,
    totalInputTokens:  0,
    totalOutputTokens: 0,
    totalCostUsd:    0,
    // Count of requests whose model was absent from the price table (cost is a
    // lower-bound estimate — see getPricing `unpriced`).
    unpricedRequests: 0,

    // Rolling 5-min window
    recentRequests: new RollingCounter(WINDOW_MS),
    recentErrors:   new RollingCounter(WINDOW_MS),
    recentTokens:   new RollingCounter(WINDOW_MS),

    // Per-agent active session tracking: { agentId -> Set<sessionId> }
    /** @type {Map<string, Set<string>>} */
    activeSessions: new Map(),

    // Bounded in-memory cost breakdown for the /status surface (SQLite keeps
    // full history). Key -> { costUsd, requests, unpriced }. Capped at
    // MAX_COST_KEYS distinct keys; overflow folds into "_other".
    /** @type {Map<string, { costUsd: number, requests: number, unpriced: boolean }>} */
    costByAgent: new Map(),
    /** @type {Map<string, { costUsd: number, requests: number, unpriced: boolean }>} */
    costByModel: new Map(),
  };

  /**
   * Fold a request's cost into a bounded per-key breakdown map. New keys beyond
   * MAX_COST_KEYS collapse into a shared "_other" bucket so memory stays O(cap).
   *
   * @param {Map<string, { costUsd: number, requests: number, unpriced: boolean }>} map
   * @param {string} rawKey
   * @param {number} costUsd
   * @param {boolean} unpriced
   */
  function bumpCost(map, rawKey, costUsd, unpriced) {
    let key = rawKey ?? 'unknown';
    if (!map.has(key) && map.size >= MAX_COST_KEYS) key = '_other';
    let e = map.get(key);
    if (!e) { e = { costUsd: 0, requests: 0, unpriced: false }; map.set(key, e); }
    e.costUsd  += costUsd;
    e.requests += 1;
    if (unpriced) e.unpriced = true;
  }

  // Per-backend / per-model percentile estimators
  // Key: `${backend}:${model}` → { p50, p95, p99 }
  /** @type {Map<string, { p50: P2Estimator, p95: P2Estimator, p99: P2Estimator }>} */
  const latencyEstimators = new Map();

  function latencyKey(backend, model) {
    return `${backend ?? '_'}:${model ?? '_'}`;
  }

  function getEstimator(backend, model) {
    const key = latencyKey(backend, model);
    if (!latencyEstimators.has(key)) {
      latencyEstimators.set(key, {
        p50: new P2Estimator(0.50),
        p95: new P2Estimator(0.95),
        p99: new P2Estimator(0.99),
      });
    }
    return latencyEstimators.get(key);
  }

  // Per-backend/per-model Welford running mean+variance for 3-sigma anomaly
  // detection. O(1) state per key — no sample history is retained.
  // Key: `${backend}:${model}` → { n, mean, m2, anomalies }
  /** @type {Map<string, { n: number, mean: number, m2: number, anomalies: number }>} */
  const latencyStats = new Map();

  function getRunStat(key) {
    let s = latencyStats.get(key);
    if (!s) { s = { n: 0, mean: 0, m2: 0, anomalies: 0 }; latencyStats.set(key, s); }
    return s;
  }

  // Bounded ring of the most recent anomaly records (newest last).
  /** @type {Array<{ backend: string|null, model: string|null, key: string,
   *   latencyMs: number, mean: number, stddev: number, sigma: number, ts: number }>} */
  const recentAnomalies = [];

  /**
   * Fold a new latency sample into the per-key running stats and, if it deviates
   * ≥ ANOMALY_SIGMA from the established baseline, record an anomaly.
   *
   * The deviation is measured against the baseline *before* the new sample is
   * folded in, so a single spike is flagged even though it would otherwise
   * inflate the variance and mask itself.
   *
   * @param {string}      key      backend:model key
   * @param {string|null} backend
   * @param {string|null} model
   * @param {number}      x        latency sample (ms)
   * @param {number}      ts       Unix ms
   * @returns {object|null} the anomaly record if flagged, else null
   */
  function recordLatencyStat(key, backend, model, x, ts) {
    const rs = getRunStat(key);
    let anomaly = null;

    if (rs.n >= ANOMALY_MIN_SAMPLES) {
      const stddev = Math.sqrt(rs.m2 / (rs.n - 1));
      if (stddev > 0) {
        const sigma = Math.abs(x - rs.mean) / stddev;
        if (sigma >= ANOMALY_SIGMA) {
          rs.anomalies++;
          anomaly = {
            backend: backend ?? null, model: model ?? null, key,
            latencyMs: x, mean: rs.mean, stddev, sigma, ts,
          };
          recentAnomalies.push(anomaly);
          if (recentAnomalies.length > ANOMALY_RING_SIZE) recentAnomalies.shift();
        }
      }
    }

    // Welford online update.
    rs.n++;
    const delta = x - rs.mean;
    rs.mean += delta / rs.n;
    rs.m2   += delta * (x - rs.mean);

    return anomaly;
  }

  // ── pending requests map ─────────────────────────────────────────────────
  // reqId → { startedAt, agentId, model, backend, sessionId }
  /** @type {Map<string, object>} */
  const pending = new Map();

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Record the start of an incoming proxy request.
   *
   * @param {object} meta
   * @param {string} [meta.agentId]   Identifying agent (e.g. 'lumina')
   * @param {string} [meta.model]     Model name being targeted
   * @param {string} [meta.backend]   Backend name (e.g. 'nvidia', 'anthropic')
   * @param {string} [meta.sessionId] Conversation/session identifier
   * @returns {string} reqId — pass this to `recordResponse()`
   */
  function recordRequest({ agentId, model, backend, sessionId } = {}) {
    const id = newReqId();
    const startedAt = Date.now();

    pending.set(id, { startedAt, agentId, model, backend, sessionId });

    counters.totalRequests++;
    counters.activeRequests++;
    counters.recentRequests.add();

    // Track active session
    if (agentId) {
      if (!counters.activeSessions.has(agentId)) {
        counters.activeSessions.set(agentId, new Set());
      }
      if (sessionId) counters.activeSessions.get(agentId).add(sessionId);
    }

    if (db) {
      writeBuffer.push({
        _type: 'request',
        id, agent_id: agentId ?? null, model: model ?? null,
        backend: backend ?? null, session_id: sessionId ?? null,
        started_at: startedAt,
      });
      maybeFlush();
    }

    return id;
  }

  /**
   * Record the completion of a proxy request (including token usage).
   *
   * @param {object} meta
   * @param {string}  meta.reqId        ID returned by `recordRequest()`
   * @param {number}  [meta.statusCode] HTTP status code from upstream
   * @param {number}  [meta.firstByteMs] ms from request start to first upstream byte
   * @param {number}  [meta.generationMs] measured ms from first upstream byte to completion
   * @param {number}  [meta.totalMs]    Total round-trip ms (arrival → response complete)
   * @param {string}  [meta.errorMsg]   Error message if the request failed
   * @param {number}  [meta.actualCostUsd] Provider-reported charge for this request
   * @param {Record<string, string>} [meta.responseHeaders]  Raw upstream response headers
   * @param {object}  [meta.responseBody]  Parsed upstream response body
   * @param {string}  [meta.agentId]    Override agent (if not known at recordRequest time)
   * @param {string}  [meta.model]      Override model (the REQUESTED id)
   * @param {string}  [meta.modelServed] The model the UPSTREAM said it served,
   *   taken from the response body. Omit it when the body could not be read;
   *   the column then stays NULL, which is what "we did not observe it" means.
   *   It MUST NOT be defaulted to `model`.
   * @param {string}  [meta.backend]    Override backend
   * @param {string}  [meta.sessionId]  Override sessionId
   * @param {object}  [meta.attribution] Provider-neutral rail attribution (card e19f88db)
   * @param {string}  [meta.attribution.client]           from x-app header
   * @param {string}  [meta.attribution.application]      from user-agent header
   * @param {string}  [meta.attribution.logicalRoute]    registry routing (context/service/role)
   * @param {string}  [meta.attribution.rail]             local | cloud | hybrid
   * @param {string}  [meta.attribution.provider]         inferred from backend
   * @param {string}  [meta.attribution.backendNode]     backend ID
   * @param {string}  [meta.attribution.requestedModel]  model caller asked for
   * @param {string}  [meta.attribution.servedModel]     model upstream served
   * @param {string}  [meta.attribution.runtimeRevision] readiness:discovery revision
   * @returns {object|null} anomaly record if this request was a ≥3-sigma latency
   *   outlier for its backend/model, else null.
   */
  function recordResponse({
    reqId,
    statusCode,
    firstByteMs,
    generationMs,
    totalMs,
    errorMsg,
    actualCostUsd,
    responseHeaders,
    responseBody,
    agentId: agentOverride,
    model: modelOverride,
    modelServed,
    backend: backendOverride,
    sessionId: sessionOverride,
    attribution,
  } = {}) {
    const orig = pending.get(reqId) ?? {};
    pending.delete(reqId);

    const agentId   = agentOverride   ?? orig.agentId;
    const model     = modelOverride   ?? orig.model;
    const backend   = backendOverride ?? orig.backend;
    const sessionId = sessionOverride ?? orig.sessionId;
    const ts        = Date.now();
    const startedAt = orig.startedAt;
    const suppliedTotal = Number.isFinite(totalMs) && totalMs >= 0 ? totalMs : null;
    const total = suppliedTotal ?? (Number.isFinite(startedAt) ? ts - startedAt : null);
    const firstByte = Number.isFinite(firstByteMs) && firstByteMs >= 0 ? firstByteMs : null;
    const status = Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
      ? statusCode
      : null;
    const statusClass = status === null ? null : `${Math.floor(status / 100)}xx`;
    const terminalState = status === 499
      ? 'cancelled'
      : ((status !== null && status < 400 && !errorMsg)
          ? 'succeeded'
          : ((status !== null || errorMsg) ? 'failed' : 'unknown'));

    counters.activeRequests = Math.max(0, counters.activeRequests - 1);

    const isError = (status !== null && status >= 400) || !!errorMsg;
    if (isError) {
      counters.errorCount++;
      counters.recentErrors.add();
    }

    // Missing latency is not a zero-duration observation.
    let anomaly = null;
    if (total !== null) {
      const est = getEstimator(backend, model);
      est.p50.update(total);
      est.p95.update(total);
      est.p99.update(total);
      anomaly = recordLatencyStat(latencyKey(backend, model), backend ?? null, model ?? null, total, ts);
    }

    // Token extraction & cost
    let tokenRow = null;
    let costRow  = null;

    const tokens = extractTokens({ headers: responseHeaders, body: responseBody });
    const hasTokens = Object.values(tokens).some((value) => value !== null);
    if (cfg.token_tracking && hasTokens) {
      const totalTok = (tokens.input_tokens ?? 0) + (tokens.output_tokens ?? 0);

      counters.totalInputTokens  += tokens.input_tokens ?? 0;
      counters.totalOutputTokens += tokens.output_tokens ?? 0;
      counters.recentTokens.add(totalTok);

      tokenRow = {
        req_id: reqId, agent_id: agentId ?? null, model: model ?? null,
        backend: backend ?? null, session_id: sessionId ?? null,
        ts, hour_bucket: hourBucket(ts), day_bucket: dayBucket(ts),
        ...tokens,
      };

    }

    const reportedCost = Number.isFinite(actualCostUsd) && actualCostUsd >= 0
      ? actualCostUsd
      : null;
    const pricing = getPricing(model ?? '');
    const canEstimateCost = cfg.cost_tracking && !pricing.unpriced &&
      tokens.input_tokens !== null && tokens.output_tokens !== null;
    let costTruth = 'unknown';
    let totalCost = null;
    if (cfg.cost_tracking && reportedCost !== null) {
      costTruth = 'actual';
      totalCost = reportedCost;
    } else if (canEstimateCost) {
      costTruth = 'estimated';
      const cost = calcCost(tokens, pricing);
      totalCost = cost.input_cost + cost.output_cost + cost.cache_read_cost + cost.cache_write_cost;
      costRow = {
        req_id: reqId, agent_id: agentId ?? null, model: model ?? null,
        backend: backend ?? null, session_id: sessionId ?? null,
        ts, day_bucket: dayBucket(ts),
        ...cost,
      };
    }
    // Keep the legacy cost aggregate complete for consumers that already use
    // it, while the terminal row tells the truth: fallback zero pricing is not
    // an estimate and therefore remains cost_truth=unknown with cost_usd=NULL.
    if (cfg.cost_tracking && tokens.input_tokens !== null && tokens.output_tokens !== null && !costRow) {
      const legacyCost = calcCost(tokens, pricing);
      costRow = {
        req_id: reqId, agent_id: agentId ?? null, model: model ?? null,
        backend: backend ?? null, session_id: sessionId ?? null,
        ts, day_bucket: dayBucket(ts),
        ...legacyCost,
      };
    }
    const aggregateCost = totalCost ?? (costRow
      ? costRow.input_cost + costRow.output_cost + costRow.cache_read_cost + costRow.cache_write_cost
      : null);
    if (cfg.cost_tracking && aggregateCost !== null) {
      counters.totalCostUsd += aggregateCost;
      bumpCost(counters.costByAgent, agentId ?? 'anonymous', aggregateCost, pricing.unpriced);
      bumpCost(counters.costByModel, model ?? 'unknown', aggregateCost, pricing.unpriced);
    }
    if (cfg.cost_tracking && pricing.unpriced) counters.unpricedRequests++;

    const generationInterval = Number.isFinite(generationMs) && generationMs > 0
      ? generationMs
      : null;
    const generationTps = tokens.output_tokens !== null && generationInterval > 0
      ? tokens.output_tokens / (generationInterval / 1000)
      : null;

    if (db) {
      writeBuffer.push({
        _type: 'response',
        id: reqId,
        status_code: status,
        status_class: statusClass,
        terminal_state: terminalState,
        first_byte_ms: firstByte,
        total_ms: total,
        input_tokens: tokens.input_tokens,
        output_tokens: tokens.output_tokens,
        cost_usd: totalCost,
        cost_truth: costTruth,
        generation_tps: generationTps,
        // Provider-neutral rail attribution (card e19f88db / SKGW-ATTRIBUTION-01).
        // NULL when unknown; presence means we observed the value.
        client:           (typeof attribution?.client === 'string' && attribution.client) ? attribution.client : null,
        application:      (typeof attribution?.application === 'string' && attribution.application) ? attribution.application : null,
        logical_route:    (typeof attribution?.logicalRoute === 'string' && attribution.logicalRoute) ? attribution.logicalRoute : null,
        rail:             (typeof attribution?.rail === 'string' && attribution.rail) ? attribution.rail : null,
        provider:         (typeof attribution?.provider === 'string' && attribution.provider) ? attribution.provider : null,
        backend_node:     (typeof attribution?.backendNode === 'string' && attribution.backendNode) ? attribution.backendNode : null,
        requested_model:  (typeof model === 'string' && model) ? model : null,
        served_model:     (typeof modelServed === 'string' && modelServed) ? modelServed : null,
        runtime_revision: (typeof attribution?.runtimeRevision === 'string' && attribution.runtimeRevision) ? attribution.runtimeRevision : null,
        error_msg: errorMsg ?? null,
        // The serving backend, which is only knowable AFTER dispatch. The
        // insert above runs before routing resolves and can only write NULL
        // here, so without this update request_log.backend was NULL for every
        // row ever written, even though the column exists and token_usage /
        // cost_log / latency_log next to it were all populated. Card 3351d25b
        // returns this same fact to the caller as x-sk-backend, and a header
        // that names a backend the row it points at leaves blank is a join
        // that answers half the question. COALESCE so an unknown backend
        // leaves whatever is already there rather than erasing it.
        backend:       backend       ?? null,
        // The model the upstream SAID it served (card 316dd167 / A8). Both
        // request_log.model and token_usage.model are the model the caller
        // ASKED FOR, and on the live database they never once disagreed across
        // 1,445 joined rows, because they are copies of the same value. So a
        // backend that quietly answered with something else produced a row
        // indistinguishable from one that served exactly what was requested.
        //
        // NULL MEANS UNOBSERVED, AND MUST NEVER MEAN "same as requested". The
        // caller passes this straight from the parsed response body, so when
        // the body is SSE or otherwise unparseable it is already undefined and
        // the column is correctly NULL with no special-casing here. Defaulting
        // it to `model` would make every request look like it got what it asked
        // for, which is strictly worse than having no column: it would turn an
        // absence of evidence into fabricated evidence of a match. Same
        // discipline energyHeaders() follows for joules, deliberately.
        //
        // Empty string is unknown, not a model named "". COALESCE for the same
        // reason the backend line above uses it: an unknown value must leave a
        // known one alone rather than erase it.
        model_served:  (typeof modelServed === 'string' && modelServed) ? modelServed : null,
        _tokens: tokenRow,
        _cost:   costRow,
        _latency: {
          req_id: reqId, model: model ?? null, backend: backend ?? null,
          ts, first_byte_ms: firstByte, total_ms: total,
        },
      });
      maybeFlush();
    }

    // Return the anomaly record (or null) so callers (e.g. the router) can emit
    // a SIEM anomaly event. Purely additive - legacy callers ignore it.
    return anomaly;
  }

  /**
   * Record the energy cost of one upstream attempt.
   *
   * `joules: null` is a legitimate value meaning "we could not know", and the
   * row is still written: a missing row is indistinguishable from a request
   * that never happened.
   *
   * @param {object} meta
   * @param {string} [meta.reqId]
   * @param {string} [meta.agentId]
   * @param {string} [meta.model]
   * @param {string} [meta.backend]
   * @param {string} [meta.cardId]
   * @param {number|null} [meta.joules]
   * @param {string} [meta.basis]        measured_gpu | imputed_local | imputed_cloud
   * @param {string} [meta.node]
   * @param {number} [meta.concurrencyN]
   * @param {number} [meta.ts]           Unix ms, defaults to now
   * @returns {void}
   */
  function recordEnergy({
    reqId, agentId, model, backend, cardId,
    joules, basis, node, concurrencyN, ts,
  } = {}) {
    if (!db) return;
    // req_id is NOT NULL on energy_log, and flushBatch runs as one transaction,
    // so a single bad row here would roll back every unrelated row buffered in
    // the same window. A row that cannot be joined to a request is not worth
    // that risk, and we do not fabricate a synthetic reqId to route around it.
    if (!reqId) return;
    const when = ts ?? Date.now();
    writeBuffer.push({
      _type: 'energy',
      req_id: reqId ?? null,
      agent_id: agentId ?? null,
      model: model ?? null,
      backend: backend ?? null,
      card_id: cardId ?? null,
      ts: when,
      day_bucket: dayBucket(when),
      joules: (joules === null || joules === undefined) ? null : Number(joules),
      basis: basis ?? 'imputed_cloud',
      node: node ?? null,
      concurrency_n: concurrencyN ?? 1,
    });
    maybeFlush();
  }

  // ── query helpers ─────────────────────────────────────────────────────────

  /**
   * Return live in-memory stats suitable for the dashboard.
   *
   * @returns {{
   *   totalRequests: number,
   *   activeRequests: number,
   *   errorCount: number,
   *   recentRequests5m: number,
   *   recentErrors5m: number,
   *   recentTokens5m: number,
   *   totalInputTokens: number,
   *   totalOutputTokens: number,
   *   totalCostUsd: number,
   *   unpricedRequests: number,
   *   costByAgent: Record<string, { costUsd: number, requests: number, unpriced: boolean }>,
   *   costByModel: Record<string, { costUsd: number, requests: number, unpriced: boolean }>,
   *   activeSessions: Record<string, number>,
   *   latency: Record<string, { p50: number, p95: number, p99: number,
   *     mean: number, stddev: number, count: number, anomalies: number }>,
   *   anomalies: object[],
   * }}
   */
  function getStats() {
    const latency = {};
    for (const [key, est] of latencyEstimators) {
      const rs = latencyStats.get(key);
      const n = rs?.n ?? 0;
      const stddev = n > 1 ? Math.sqrt(rs.m2 / (n - 1)) : 0;
      latency[key] = {
        p50: Math.round(est.p50.value),
        p95: Math.round(est.p95.value),
        p99: Math.round(est.p99.value),
        mean:      Math.round(rs?.mean ?? 0),
        stddev:    Math.round(stddev),
        count:     n,
        anomalies: rs?.anomalies ?? 0,
      };
    }

    const activeSessions = {};
    for (const [agentId, sessions] of counters.activeSessions) {
      activeSessions[agentId] = sessions.size;
    }

    // Materialize the bounded cost breakdowns as plain objects, rounded to a
    // sane cent-fraction so the JSON payload stays compact.
    const round6 = (n) => Math.round(n * 1e6) / 1e6;
    const costByAgent = {};
    for (const [k, v] of counters.costByAgent) {
      costByAgent[k] = { costUsd: round6(v.costUsd), requests: v.requests, unpriced: v.unpriced };
    }
    const costByModel = {};
    for (const [k, v] of counters.costByModel) {
      costByModel[k] = { costUsd: round6(v.costUsd), requests: v.requests, unpriced: v.unpriced };
    }

    return {
      totalRequests:    counters.totalRequests,
      activeRequests:   counters.activeRequests,
      errorCount:       counters.errorCount,
      recentRequests5m: counters.recentRequests.total(),
      recentErrors5m:   counters.recentErrors.total(),
      recentTokens5m:   counters.recentTokens.total(),
      totalInputTokens:  counters.totalInputTokens,
      totalOutputTokens: counters.totalOutputTokens,
      totalCostUsd:     round6(counters.totalCostUsd),
      unpricedRequests: counters.unpricedRequests,
      costByAgent,
      costByModel,
      activeSessions,
      latency,
      anomalies:        recentAnomalies.slice(-ANOMALY_RING_SIZE).map(a => ({ ...a })),
    };
  }

  /**
   * Return the most recent latency anomalies (newest last), bounded to the
   * in-memory ring. Each record carries the offending backend/model, the
   * observed latency, and the baseline mean/stddev/sigma it breached.
   *
   * @param {object} [opts]
   * @param {number} [opts.limit=ANOMALY_RING_SIZE]  Max records to return.
   * @returns {object[]}
   */
  function getAnomalies({ limit = ANOMALY_RING_SIZE } = {}) {
    return recentAnomalies.slice(-limit).map(a => ({ ...a }));
  }

  /**
   * Query token usage from SQLite.
   *
   * @param {object} [filters]
   * @param {string} [filters.agentId]   Filter by agent
   * @param {string} [filters.model]     Filter by model
   * @param {string} [filters.backend]   Filter by backend
   * @param {string} [filters.sessionId] Filter by session
   * @param {number} [filters.since]     Unix ms lower bound on `ts`
   * @param {number} [filters.until]     Unix ms upper bound on `ts`
   * @param {'hour'|'day'} [filters.groupBy='day']  Aggregation granularity
   * @returns {object[]}
   */
  function getTokenUsage(filters = {}) {
    if (!db) return [];
    maybeFlush(true);

    const { agentId, model, backend, sessionId, since, until, groupBy = 'day' } = filters;
    const bucketCol = groupBy === 'hour' ? 'hour_bucket' : 'day_bucket';

    const conditions = [];
    const params     = {};

    if (agentId)   { conditions.push('agent_id   = @agentId');   params.agentId   = agentId; }
    if (model)     { conditions.push('model       = @model');     params.model     = model; }
    if (backend)   { conditions.push('backend     = @backend');   params.backend   = backend; }
    if (sessionId) { conditions.push('session_id  = @sessionId'); params.sessionId = sessionId; }
    if (since)     { conditions.push('ts >= @since');             params.since     = since; }
    if (until)     { conditions.push('ts <= @until');             params.until     = until; }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    return db.prepare(`
      SELECT
        ${bucketCol}         AS bucket,
        agent_id, model, backend,
        SUM(input_tokens)        AS input_tokens,
        SUM(output_tokens)       AS output_tokens,
        SUM(cache_read_tokens)   AS cache_read_tokens,
        SUM(cache_write_tokens)  AS cache_write_tokens,
        COUNT(*)                 AS request_count
      FROM token_usage
      ${where}
      GROUP BY ${bucketCol}, agent_id, model, backend
      ORDER BY bucket DESC
    `).all(params);
  }

  /**
   * Query cost aggregates from SQLite.
   *
   * @param {object} [filters]
   * @param {string} [filters.agentId]
   * @param {string} [filters.model]
   * @param {string} [filters.backend]
   * @param {number} [filters.since]
   * @param {number} [filters.until]
   * @param {'day'|'month'} [filters.groupBy='day']
   * @returns {object[]}
   */
  /**
   * Read terminal request rows with a stable truth contract. Columns absent
   * from legacy rows are returned as null and cost truth becomes "unknown".
   *
   * @param {{limit?:number}} [filters]
   * @returns {object[]}
   */
  function getTerminalRequests({ limit = 100 } = {}) {
    if (!db) return [];
    maybeFlush(true);
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 1000)) : 100;
    return db.prepare(`
      SELECT id, agent_id, model, model_served, backend, session_id, started_at,
             status_code, status_class,
             COALESCE(terminal_state, 'unknown') AS terminal_state,
             first_byte_ms, total_ms, input_tokens, output_tokens, cost_usd,
             COALESCE(cost_truth, 'unknown') AS cost_truth, generation_tps,
             client, application, logical_route, rail, provider, backend_node,
             requested_model, served_model, runtime_revision, error_msg
      FROM request_log
      ORDER BY started_at DESC
      LIMIT ?
    `).all(bounded);
  }

  function getCosts(filters = {}) {
    if (!db) return [];
    maybeFlush(true);

    const { agentId, model, backend, since, until, groupBy = 'day' } = filters;

    const conditions = [];
    const params     = {};

    if (agentId) { conditions.push('agent_id = @agentId'); params.agentId = agentId; }
    if (model)   { conditions.push('model    = @model');   params.model   = model; }
    if (backend) { conditions.push('backend  = @backend'); params.backend = backend; }
    if (since)   { conditions.push('ts >= @since');        params.since   = since; }
    if (until)   { conditions.push('ts <= @until');        params.until   = until; }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // For month grouping, use SUBSTR(day_bucket, 1, 7) → YYYY-MM
    const bucketExpr = groupBy === 'month'
      ? "SUBSTR(day_bucket, 1, 7)"
      : 'day_bucket';

    return db.prepare(`
      SELECT
        ${bucketExpr}          AS bucket,
        agent_id, model, backend,
        SUM(input_cost)        AS input_cost,
        SUM(output_cost)       AS output_cost,
        SUM(cache_read_cost)   AS cache_read_cost,
        SUM(cache_write_cost)  AS cache_write_cost,
        SUM(input_cost + output_cost + cache_read_cost + cache_write_cost) AS total_cost,
        COUNT(*)               AS request_count
      FROM cost_log
      ${where}
      GROUP BY ${bucketExpr}, agent_id, model, backend
      ORDER BY bucket DESC
    `).all(params);
  }

  /**
   * Flush pending writes and close the database.
   * Call during graceful shutdown.
   */
  function close() {
    if (flushTimer) clearInterval(flushTimer);
    if (purgeTimer) clearInterval(purgeTimer);
    maybeFlush(true);
    if (db) db.close();
  }

  // ── return collector ──────────────────────────────────────────────────────

  /** @typedef {object} MetricsCollector */
  return {
    recordRequest,
    recordResponse,
    recordEnergy,
    getStats,
    getAnomalies,
    getTokenUsage,
    getTerminalRequests,
    getCosts,
    close,
    /** Force a synchronous flush of the write buffer. Mainly for tests. */
    flush: () => maybeFlush(true),
    /** Direct db access for advanced queries (may be null if metrics disabled). */
    get db() { return db; },
  };
}
