import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import Database from "better-sqlite3";
import { buildMigrationManifest, migrateProviderState, verifyMigration } from "../scripts/migrate-provider-state.mjs";

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
  assert.equal(manifest.version, 1);
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
