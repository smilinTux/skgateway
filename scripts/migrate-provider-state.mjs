#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

const FILES = [
  "metrics.db", "audit.jsonl", "capacity-state.json", "provider-health.json",
  "model_catalog_store.json", "model_catalog_cache.json",
];

function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sqliteDetails(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const tables = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      const columns = db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all();
      const time = columns.find((c) => ["ts", "timestamp", "created_at", "observed_at"].includes(c.name));
      const bounds = time ? db.prepare(`SELECT min(${JSON.stringify(time.name)}) AS first, max(${JSON.stringify(time.name)}) AS last FROM ${JSON.stringify(name)}`).get() : {};
      tables[name] = { rows: db.prepare(`SELECT count(*) AS n FROM ${JSON.stringify(name)}`).get().n, ...bounds };
    }
    return tables;
  } finally { db.close(); }
}

export function buildMigrationManifest(inventory) {
  const sources = inventory.map((source) => {
    if (!source.path || source.kind === "memory") return { name: source.name, kind: source.kind, status: "no_source" };
    const path = resolve(source.path);
    if (!existsSync(path)) return { name: source.name, kind: source.kind, path, status: "missing" };
    const item = { name: source.name, kind: source.kind, path, status: "present", bytes: statSync(path).size, sha256: hashFile(path) };
    if (source.kind === "sqlite") item.tables = sqliteDetails(path);
    if (source.kind === "jsonl") item.records = readFileSync(path, "utf8").split("\n").filter(Boolean).length;
    return item;
  });
  return { version: 1, created_at: new Date().toISOString(), sources };
}

function quote(id) { return `"${String(id).replaceAll('"', '""')}"`; }

function mergeSqlite(paths, output) {
  const db = new Database(output);
  try {
    db.pragma("journal_mode = DELETE");
    for (let i = 0; i < paths.length; i += 1) {
      const alias = `source_${i}`;
      db.prepare(`ATTACH DATABASE ? AS ${quote(alias)}`).run(paths[i]);
      const tables = db.prepare(`SELECT name, sql FROM ${quote(alias)}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
      for (const table of tables) {
        const local = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table.name);
        if (!local) db.exec(table.sql);
        const columns = db.prepare(`PRAGMA ${quote(alias)}.table_info(${quote(table.name)})`).all().map((c) => c.name);
        if (columns.length) {
          const list = columns.map(quote).join(", ");
          db.exec(`INSERT OR IGNORE INTO ${quote(table.name)} (${list}) SELECT ${list} FROM ${quote(alias)}.${quote(table.name)}`);
        }
      }
      db.prepare(`DETACH DATABASE ${quote(alias)}`).run();
    }
  } finally { db.close(); }
  chmodSync(output, 0o600);
}

function writeAudit(paths, output) {
  const fd = openSync(output, "w", 0o600);
  try {
    for (const path of paths) {
      const sourceHash = hashFile(path);
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      for (let index = 0; index < lines.length; index += 1) {
        const event = JSON.parse(lines[index]);
        event.migration_provenance = { source_sha256: sourceHash, source_record: index + 1 };
        writeFileSync(fd, `${JSON.stringify(event)}\n`);
      }
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  chmodSync(output, 0o600);
}

function mergeJsonObjects(paths, output) {
  const merged = {};
  for (const path of paths) {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`expected JSON object: ${path}`);
    Object.assign(merged, value);
  }
  writeFileSync(output, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
}

function stageProviderState({ sources, target }) {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error("at least one source is required");
  const resolvedSources = sources.map((source) => resolve(source));
  for (const source of resolvedSources) {
    const stat = lstatSync(source);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe source: ${source}`);
  }
  const stage = `${resolve(target)}.staging`;
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true, mode: 0o700 });
  const inventory = [];
  for (const source of resolvedSources) {
    for (const file of FILES) {
      const path = join(source, file);
      if (existsSync(path)) inventory.push({ name: `${basename(source)}:${file}`, kind: file.endsWith(".db") ? "sqlite" : file.endsWith(".jsonl") ? "jsonl" : "json", path });
    }
  }
  inventory.push({ name: "semantic-cache-memory", kind: "memory", path: null });
  const manifest = buildMigrationManifest(inventory);
  const metrics = inventory.filter((x) => x.kind === "sqlite" && x.path).map((x) => x.path);
  const audits = inventory.filter((x) => x.kind === "jsonl" && x.path).map((x) => x.path);
  if (metrics.length) mergeSqlite(metrics, join(stage, "metrics.db"));
  if (audits.length) writeAudit(audits, join(stage, "audit.jsonl"));
  for (const file of ["capacity-state.json", "provider-health.json", "model_catalog_store.json", "model_catalog_cache.json"]) {
    const candidates = resolvedSources.map((root) => join(root, file)).filter(existsSync);
    if (candidates.length) mergeJsonObjects(candidates, join(stage, file));
  }
  writeFileSync(join(stage, "migration-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  const fd = openSync(stage, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  return { stage, manifest };
}

export function verifyMigration(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "migration-manifest.json"), "utf8"));
    if (manifest.version !== 1) return { valid: false, reason: "manifest_version" };
    for (const source of manifest.sources.filter((x) => x.status === "present")) {
      if (!existsSync(source.path) || hashFile(source.path) !== source.sha256) return { valid: false, reason: "source_changed" };
    }
    if (existsSync(join(root, "metrics.db"))) sqliteDetails(join(root, "metrics.db"));
    return { valid: true, manifest };
  } catch (error) { return { valid: false, reason: error.message }; }
}

export function migrateProviderState({ sources, target, crashAt } = {}) {
  const destination = resolve(target);
  if (existsSync(destination)) throw new Error(`target already exists: ${destination}`);
  const { stage, manifest } = stageProviderState({ sources, target: destination });
  if (crashAt === "before-activate") throw new Error("injected crash before-activate");
  const verified = verifyMigration(stage);
  if (!verified.valid) throw new Error(`migration verification failed: ${verified.reason}`);
  renameSync(stage, destination);
  const parentFd = openSync(dirname(destination), "r"); try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
  return { activated: true, target: destination, manifest };
}

function usage() {
  process.stderr.write("usage: migrate-provider-state.mjs --inventory SOURCE... | --stage TARGET SOURCE... | --verify TARGET | --activate TARGET | --rollback TARGET\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, target, ...sources] = process.argv.slice(2);
  if (command === "--inventory") console.log(JSON.stringify(buildMigrationManifest([target, ...sources].map((path) => ({ name: basename(path), kind: path.endsWith(".db") ? "sqlite" : "json", path }))), null, 2));
  else if (command === "--stage") console.log(JSON.stringify(stageProviderState({ sources, target }), null, 2));
  else if (command === "--verify") { const result = verifyMigration(target); console.log(JSON.stringify(result)); if (!result.valid) process.exitCode = 1; }
  else if (command === "--activate") {
    const stage = `${resolve(target)}.staging`; const result = verifyMigration(stage);
    if (!result.valid || existsSync(target)) throw new Error(result.reason || "target already exists");
    renameSync(stage, resolve(target));
  } else if (command === "--rollback") rmSync(`${resolve(target)}.staging`, { recursive: true, force: true });
  else { usage(); process.exitCode = 2; }
}
