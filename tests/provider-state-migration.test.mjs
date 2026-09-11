import test from "node:test";
import assert from "node:assert/strict";
import fs, { appendFileSync, chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import Database from "better-sqlite3";
import { buildMigrationManifest, migrateProviderState, verifyMigration } from "../scripts/migrate-provider-state.mjs";

const migrationScript = new URL("../scripts/migrate-provider-state.mjs", import.meta.url).pathname;
const cli = (...args) => spawnSync(process.execPath, [migrationScript, ...args], { encoding: "utf8" });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skgw-migrate-"));
  const a = join(root, "a"); const b = join(root, "b"); const target = join(root, "target");
  mkdirSync(a); mkdirSync(b);
  for (const dir of [a, b]) {
    const db = new Database(join(dir, "metrics.db"));
    db.exec("CREATE TABLE request_log (request_id TEXT PRIMARY KEY, ts INTEGER, model TEXT)");
    db.prepare("INSERT INTO request_log VALUES (?, ?, ?)").run("same", 1, "m");
    db.prepare("INSERT INTO request_log VALUES (?, ?, ?)").run(dir === a ? "a" : "b", 2, "m");
    db.close();
    writeFileSync(join(dir, "audit.jsonl"), JSON.stringify({ event: "same", ts: 1 }) + "\n", { mode: 0o600 });
  }
  writeFileSync(join(a, "capacity-state.json"), "{\"a\":1}\n");
  return { root, a, b, target };
}

test("manifest records hashes, counts, bounds, and no-source entries", () => {
  const { a } = fixture();
  const manifest = buildMigrationManifest([
    { name: "metrics-a", kind: "sqlite", path: join(a, "metrics.db") },
    { name: "cache", kind: "memory", path: null },
  ]);
  assert.equal(manifest.version, 2);
  assert.match(manifest.sources[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(manifest.sources[0].tables.request_log.rows, 2);
  assert.equal(manifest.sources[1].status, "no_source");
});

test("migration deduplicates keyed rows but preserves repeated id-less audit events", () => {
  const { a, b, target } = fixture();
  const result = migrateProviderState({ sources: [a, b], target });
  assert.equal(result.activated, true);
  const db = new Database(join(target, "metrics.db"), { readonly: true });
  assert.equal(db.prepare("SELECT count(*) AS n FROM request_log").get().n, 3);
  db.close();
  assert.equal(readFileSync(join(target, "audit.jsonl"), "utf8").trim().split("\n").length, 2);
  assert.equal(verifyMigration(target).valid, true);
});

test("pre-activation crash leaves old paths authoritative and resume succeeds", () => {
  const { a, b, target } = fixture();
  assert.throws(() => migrateProviderState({ sources: [a, b], target, crashAt: "before-activate" }), /injected crash/);
  assert.equal(existsSync(target), false);
  appendFileSync(join(a, "audit.jsonl"), JSON.stringify({ event: "late", ts: 2 }) + "\n");
  assert.equal(verifyMigration(`${target}.staging`).valid, false);
  const result = migrateProviderState({ sources: [a, b], target });
  assert.equal(result.activated, true);
  assert.equal(readFileSync(join(target, "audit.jsonl"), "utf8").trim().split("\n").length, 3);
});

test("copy snapshot and activation stay bound to exact source and target", () => {
  const root = mkdtempSync(join(tmpdir(), "skgw-bind-"));
  const source = join(root, "source"), target = join(root, "target"); mkdirSync(source);
  const input = join(source, "audit.jsonl"); writeFileSync(input, '{"event_id":"first"}\n', { mode: 0o600 });
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function(path, ...args) { const result = originalWrite.call(this, path, ...args); if (path === `${target}.staging/audit.jsonl`) originalWrite(input, '{"event_id":"late"}\n', { flag: "a" }); return result; };
  syncBuiltinESMExports();
  try { assert.throws(() => migrateProviderState({ sources: [source], target }), /changed during staging/); }
  finally { fs.writeFileSync = originalWrite; syncBuiltinESMExports(); }
  assert.equal(existsSync(target), false);
  const intended = join(root, "intended"), substituted = join(root, "substituted");
  assert.throws(() => migrateProviderState({ sources: [source], target: intended, crashAt: "before-activate" }), /injected crash/);
  renameSync(`${intended}.staging`, `${substituted}.staging`);
  assert.notEqual(cli("--activate", substituted).status, 0);
  assert.equal(existsSync(substituted), false);
});

test("integer rekey records actual output identity and output metadata is authenticated", () => {
  const { root, a, b } = fixture();
  for (const dir of [a, b]) { unlinkSync(join(dir, "metrics.db")); const db = new Database(join(dir, "metrics.db")); db.exec("CREATE TABLE token_usage(id INTEGER PRIMARY KEY AUTOINCREMENT, req_id TEXT, ts INTEGER)"); db.prepare("INSERT INTO token_usage VALUES (1,?,?)").run(dir === a ? "a" : "b", 1); db.close(); }
  const target = join(root, "integer-target"); migrateProviderState({ sources: [a, b], target });
  const db = new Database(join(target, "metrics.db"));
  const row = db.prepare("SELECT id FROM token_usage WHERE req_id='b'").get();
  const provenance = db.prepare("SELECT output_identity FROM migration_provenance WHERE disposition='rekeyed_conflict'").get(); db.close();
  assert.equal(JSON.parse(provenance.output_identity)[0], row.id);
  const stagedTarget = join(root, "metadata-target"); assert.throws(() => migrateProviderState({ sources: [a], target: stagedTarget, crashAt: "before-activate" }), /injected crash/);
  const manifestPath = join(`${stagedTarget}.staging`, "migration-manifest.json"), manifest = JSON.parse(readFileSync(manifestPath));
  manifest.outputs[0].bytes += 1; writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  assert.equal(verifyMigration(`${stagedTarget}.staging`).valid, false);
  assert.notEqual(cli("--activate", stagedTarget).status, 0);
});

test("rollback preserves repeated ID-less events and rejects a replaced hardlink", () => {
  const root = mkdtempSync(join(tmpdir(), "skgw-rollback-")), source = join(root, "source"), target = join(root, "target"); mkdirSync(source);
  const input = join(source, "audit.jsonl"); writeFileSync(input, '{"event_id":"before"}\n', { mode: 0o600 });
  migrateProviderState({ sources: [source], target }); appendFileSync(join(target, "audit.jsonl"), '{"message":"repeat"}\n{"message":"repeat"}\n');
  assert.equal(cli("--rollback", target).status, 0);
  assert.equal(readFileSync(input, "utf8").split("\n").filter((line) => line === '{"message":"repeat"}').length, 2);
  const source2 = join(root, "source2"), target2 = join(root, "target2"); mkdirSync(source2); const input2 = join(source2, "audit.jsonl"); writeFileSync(input2, '{"event_id":"before"}\n', { mode: 0o600 });
  migrateProviderState({ sources: [source2], target: target2 }); appendFileSync(join(target2, "audit.jsonl"), '{"event_id":"late"}\n');
  const victim = join(root, "victim"); writeFileSync(victim, "outside\n", { mode: 0o600 }); unlinkSync(input2); linkSync(victim, input2); const before = readFileSync(victim, "utf8");
  assert.notEqual(cli("--rollback", target2).status, 0); assert.equal(readFileSync(victim, "utf8"), before);
});

test("rollback tracks identical ID-less events by active audit position", () => {
  const root = mkdtempSync(join(tmpdir(), "skgw-occurrence-")), source = join(root, "source"), target = join(root, "target"); mkdirSync(source);
  const input = join(source, "audit.jsonl"), line = '{"message":"repeat"}'; writeFileSync(input, `${line}\n`, { mode: 0o600 });
  migrateProviderState({ sources: [source], target }); const active = join(target, "audit.jsonl");
  appendFileSync(active, `${line}\n`); assert.equal(JSON.parse(cli("--rollback", target).stdout).replayed, 1);
  assert.equal(JSON.parse(cli("--rollback", target).stdout).replayed, 0);
  appendFileSync(active, `${line}\n`); assert.equal(JSON.parse(cli("--rollback", target).stdout).replayed, 1);
  assert.equal(readFileSync(input, "utf8").split("\n").filter((row) => row === line).length, 3);
});

test("activation rejects a known input that appeared after staging", () => {
  const root = mkdtempSync(join(tmpdir(), "skgw-input-set-")), source = join(root, "source"), target = join(root, "target"); mkdirSync(source);
  writeFileSync(join(source, "audit.jsonl"), '{"event_id":"before"}\n', { mode: 0o600 });
  assert.throws(() => migrateProviderState({ sources: [source], target, crashAt: "before-activate" }), /injected crash/);
  writeFileSync(join(source, "capacity_store.json"), '{}\n', { mode: 0o600 });
  assert.equal(verifyMigration(`${target}.staging`).valid, false);
  assert.notEqual(cli("--activate", target).status, 0);
  assert.equal(existsSync(target), false);
});
