import Database from "better-sqlite3";
import { writePrivateFileAtomic } from "../state/paths.mjs";
import { foldProviderSnapshot, DEFAULT_THRESHOLDS } from "./fold.mjs";
import { normalizeObservation } from "./schema.mjs";

const DDL = `
CREATE TABLE IF NOT EXISTS provider_observation (
  observation_id TEXT PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  backend_id TEXT,
  account_ref TEXT NOT NULL,
  model_id TEXT,
  bucket_id TEXT,
  logical_route TEXT,
  scope TEXT NOT NULL,
  source TEXT NOT NULL,
  probe_cost TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_snapshot (
  snapshot_key TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  backend_id TEXT,
  account_ref TEXT NOT NULL,
  model_id TEXT,
  bucket_id TEXT,
  payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_provider_observation_time ON provider_observation (observed_at, observation_id);
CREATE INDEX IF NOT EXISTS idx_provider_observation_provider_time ON provider_observation (provider, observed_at);
CREATE INDEX IF NOT EXISTS idx_provider_observation_backend_time ON provider_observation (backend_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_provider_observation_model_time ON provider_observation (model_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_provider_observation_source_time ON provider_observation (source, observed_at);
CREATE INDEX IF NOT EXISTS idx_provider_observation_expiry ON provider_observation (expires_at);
CREATE INDEX IF NOT EXISTS idx_provider_observation_bucket_time ON provider_observation (bucket_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_provider_snapshot_provider ON provider_snapshot (provider, backend_id, model_id);
`;

export function migrateProviderHealthTables(db) {
  if (!db || typeof db.exec !== "function") throw new TypeError("db must be an open SQLite handle");
  db.exec(DDL);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function parse(row) { return row ? JSON.parse(row.payload_json) : null; }
function keyFor(o) { return [o.gateway_instance, o.provider, o.backend_id || "", o.account_ref, o.model_id || ""].join("|"); }

export function createProviderHealthStore({ db, dbPath, projectionPath, clock = Date.now, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const ownsDb = !db;
  const handle = db || (dbPath ? new Database(dbPath) : null);
  if (!handle) throw new TypeError("db or dbPath is required");
  if (!projectionPath) throw new TypeError("projectionPath is required");
  if (typeof clock !== "function") throw new TypeError("clock must be a function");
  migrateProviderHealthTables(handle);

  const getObservation = handle.prepare("SELECT payload_json FROM provider_observation WHERE observation_id = ?");
  const insertObservation = handle.prepare(`INSERT INTO provider_observation
    (observation_id, observed_at, expires_at, provider, backend_id, account_ref, model_id, bucket_id, logical_route, scope, source, probe_cost, payload_json)
    VALUES (@observation_id, @observed_at, @expires_at, @provider, @backend_id, @account_ref, @model_id, @bucket_id, @logical_route, @scope, @source, @probe_cost, @payload_json)`);
  const observationsForKey = handle.prepare(`SELECT payload_json FROM provider_observation
    WHERE json_extract(payload_json, '$.gateway_instance') = ? AND provider = ? AND COALESCE(backend_id, '') = ?
      AND account_ref = ? AND COALESCE(model_id, '') = ? ORDER BY observed_at, observation_id`);
  const upsertSnapshot = handle.prepare(`INSERT INTO provider_snapshot
    (snapshot_key, updated_at, provider, backend_id, account_ref, model_id, bucket_id, payload_json)
    VALUES (@snapshot_key, @updated_at, @provider, @backend_id, @account_ref, @model_id, @bucket_id, @payload_json)
    ON CONFLICT(snapshot_key) DO UPDATE SET updated_at=excluded.updated_at, provider=excluded.provider,
      backend_id=excluded.backend_id, account_ref=excluded.account_ref, model_id=excluded.model_id,
      bucket_id=excluded.bucket_id, payload_json=excluded.payload_json`);

  const write = handle.transaction((observation) => {
    const payload = canonical(observation);
    const existing = getObservation.get(observation.observation_id);
    if (existing) {
      if (existing.payload_json !== payload) throw new Error("observation_id conflicts with different evidence");
      return parse(handle.prepare("SELECT payload_json FROM provider_snapshot WHERE snapshot_key = ?").get(keyFor(observation)));
    }
    insertObservation.run({ ...observation, payload_json: payload });
    let current = null;
    for (const row of observationsForKey.all(observation.gateway_instance, observation.provider, observation.backend_id || "", observation.account_ref, observation.model_id || "")) {
      current = foldProviderSnapshot(current, JSON.parse(row.payload_json), thresholds);
    }
    upsertSnapshot.run({ ...current, updated_at: current.last_observation_at, payload_json: canonical(current) });
    return current;
  });

  function snapshot(filter = {}) {
    const allowed = new Set(["provider", "backend_id", "account_ref", "model_id", "bucket_id"]);
    const clauses = []; const params = [];
    for (const [name, value] of Object.entries(filter)) {
      if (!allowed.has(name)) throw new TypeError(`unknown snapshot filter: ${name}`);
      clauses.push(`${name} IS ?`); params.push(value);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return handle.prepare(`SELECT payload_json FROM provider_snapshot${where} ORDER BY snapshot_key`).all(...params).map(parse).map((item) => {
      const stale = clock() > item.evidence_expires_at;
      if (!stale) return { ...item, evidence_stale: false };
      return { ...item, evidence_stale: true, overall: ["disabled", "unavailable", "throttled"].includes(item.overall) ? item.overall : "degraded" };
    });
  }

  function writeProjection() {
    const snapshots = snapshot();
    const updated_at = snapshots.reduce((max, item) => Math.max(max, item.last_observation_at), 0) || null;
    const projection = { schema_version: 1, updated_at, snapshots };
    writePrivateFileAtomic(projectionPath, `${canonical(projection)}\n`);
    return projection;
  }

  function append(input) {
    const observation = normalizeObservation(input);
    write(observation);
    try { writeProjection(); } catch (error) {
      error.message = `provider health projection write failed: ${error.message}`;
      throw error;
    }
    return snapshot({
      provider: observation.provider, backend_id: observation.backend_id,
      account_ref: observation.account_ref, model_id: observation.model_id,
    })[0];
  }

  function listObservations(query = {}) {
    const { limit = 1000, since = null, until = null, ...filter } = query;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError("limit must be between 1 and 1000");
    const allowed = new Set(["provider", "backend_id", "account_ref", "model_id", "bucket_id", "source", "scope"]);
    const clauses = []; const params = [];
    for (const [name, value] of Object.entries(filter)) {
      if (!allowed.has(name)) throw new TypeError(`unknown observation filter: ${name}`);
      clauses.push(`${name} IS ?`); params.push(value);
    }
    if (since != null) { clauses.push("observed_at >= ?"); params.push(since); }
    if (until != null) { clauses.push("observed_at <= ?"); params.push(until); }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return handle.prepare(`SELECT payload_json FROM provider_observation${where} ORDER BY observed_at, observation_id LIMIT ?`).all(...params, limit).map(parse);
  }

  function rebuildProjection() {
    const rebuilt = handle.transaction(() => {
      handle.prepare("DELETE FROM provider_snapshot").run();
      const observations = handle.prepare("SELECT payload_json FROM provider_observation ORDER BY observed_at, observation_id").all().map(parse);
      const folds = new Map();
      for (const observation of observations) folds.set(keyFor(observation), foldProviderSnapshot(folds.get(keyFor(observation)) || null, observation, thresholds));
      for (const current of [...folds.values()].sort((a, b) => a.snapshot_key.localeCompare(b.snapshot_key))) {
        upsertSnapshot.run({ ...current, updated_at: current.last_observation_at, payload_json: canonical(current) });
      }
    });
    rebuilt();
    return writeProjection();
  }

  return { append, snapshot, listObservations, rebuildProjection, close: () => { if (ownsDb) handle.close(); }, get db() { return handle; } };
}
