import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import Database from "better-sqlite3";
import { createProviderHealthStore, migrateProviderHealthTables } from "../src/health/store.mjs";
import { createMetricsCollector } from "../src/metrics/collector.mjs";

const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function input(id, observed_at) {
  return {
    schema_version: 1, observation_id: id, observed_at, expires_at: observed_at + 60_000,
    gateway_instance: "g", boot_id: "b", runtime_revision: "r", config_revision: "c",
    provider: "zai", backend_id: "glm", account_ref: "opaque-a", model_id: "glm-4.5",
    bucket_id: "sk-m", scope: "model", source: "real_request", probe_cost: "zero",
    configured_mode: "active", circuit_state: "closed",
    dimensions: { transport: "available", auth: "ready", entitlement: "fresh", quota: "available", capacity: "available", inference: "available" },
    success: true,
  };
}

describe("provider health durable store", () => {
  test("append, restart, filtering, and projection rebuild have exact parity", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-health-")); dirs.push(dir);
    const dbPath = join(dir, "metrics.db"); const projectionPath = join(dir, "provider-health.json");
    let db = new Database(dbPath); migrateProviderHealthTables(db);
    let store = createProviderHealthStore({ db, projectionPath, clock: () => 1_800_000_010_000 });
    store.append(input("o2", 1_800_000_002_000)); store.append(input("o1", 1_800_000_001_000));
    const before = store.snapshot();
    assert.equal(store.listObservations({ provider: "zai", bucket_id: "sk-m" }).length, 2);
    db.close();
    db = new Database(dbPath); migrateProviderHealthTables(db);
    store = createProviderHealthStore({ db, projectionPath, clock: () => 1_800_000_010_000 });
    assert.deepEqual(store.snapshot(), before);
    const firstProjection = readFileSync(projectionPath, "utf8");
    store.rebuildProjection();
    assert.equal(readFileSync(projectionPath, "utf8"), firstProjection);
    assert.deepEqual(JSON.parse(readFileSync(projectionPath, "utf8")).snapshots, before);
    assert.deepEqual(store.append(input("o1", 1_800_000_001_000)), before[0]);
    assert.throws(() => store.append({ ...input("o1", 1_800_000_001_000), bucket_id: "sk-l" }), /observation_id/);
    db.close();
  });

  test("migration is additive and indexed", () => {
    const db = new Database(":memory:"); migrateProviderHealthTables(db); migrateProviderHealthTables(db);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all().map((r) => r.name);
    assert.ok(names.includes("provider_observation"));
    assert.ok(names.includes("provider_snapshot"));
    assert.ok(names.includes("idx_provider_observation_provider_time"));
    db.close();
  });

  test("expired supporting evidence becomes degraded without becoming healthy", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-health-expiry-")); dirs.push(dir);
    const db = new Database(join(dir, "metrics.db")); migrateProviderHealthTables(db);
    const store = createProviderHealthStore({ db, projectionPath: join(dir, "provider-health.json"), clock: () => 1_800_000_061_000 });
    store.append(input("expired", 1_800_000_000_000));
    assert.equal(store.snapshot()[0].evidence_stale, true);
    assert.equal(store.snapshot()[0].overall, "degraded");
    db.close();
  });

  test("collector owns the shared SQLite handle and co-located projection", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-health-collector-")); dirs.push(dir);
    const collector = createMetricsCollector({ enabled: true, db_path: join(dir, "metrics.db"), retention_days: 1 });
    assert.equal(collector.healthStore.db, collector.db);
    const tables = collector.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
    assert.ok(tables.includes("provider_observation"));
    collector.close();
  });

  test("malformed authoritative state fails visibly and is never treated as healthy", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-health-malformed-")); dirs.push(dir);
    const db = new Database(join(dir, "metrics.db")); migrateProviderHealthTables(db);
    const store = createProviderHealthStore({ db, projectionPath: join(dir, "provider-health.json") });
    store.append(input("valid", 1_800_000_000_000));
    db.prepare("UPDATE provider_observation SET payload_json = ? WHERE observation_id = ?").run("{bad-json", "valid");
    assert.throws(() => store.rebuildProjection(), /JSON/);
    db.close();
  });
});
