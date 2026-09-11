#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { writePrivateFileAtomic } from "../src/state/paths.mjs";

const ROOT_FILES = [["metrics.db", "sqlite"], ["audit.jsonl", "jsonl"], ["capacity-state.json", "json"], ["capacity_store.json", "json"], ["provider-health.json", "json"], ["model_catalog_store.json", "json"], ["model_catalog_cache.json", "json"], ["skgateway.yaml", "yaml"], ["registry.yaml", "yaml"], ["model-registry.yaml", "yaml"], ["model-cards.overrides.yaml", "yaml"]];
const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashFile = (path) => hashBytes(readFileSync(path));
const quote = (id) => `"${String(id).replaceAll('"', '""')}"`;
function pathEntryExists(path) { try { lstatSync(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }

function syncFile(path) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function syncDirectory(path) { const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } }
function assertRegularSingleLink(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`source must be a regular single-link file: ${path}`);
  return stat;
}
function sqliteDetails(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma("quick_check", { simple: true });
    if (integrity !== "ok") throw new Error(`SQLite integrity failed for ${path}: ${integrity}`);
    const tables = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      const columns = db.prepare(`PRAGMA table_info(${quote(name)})`).all();
      const time = columns.find((c) => ["ts", "timestamp", "started_at", "created_at", "observed_at"].includes(c.name));
      const bounds = time ? db.prepare(`SELECT min(${quote(time.name)}) AS first, max(${quote(time.name)}) AS last FROM ${quote(name)}`).get() : {};
      tables[name] = { rows: db.prepare(`SELECT count(*) AS n FROM ${quote(name)}`).get().n, ...bounds };
    }
    return { integrity, schema_version: db.pragma("schema_version", { simple: true }), user_version: db.pragma("user_version", { simple: true }), tables };
  } finally { db.close(); }
}
function cacheRootDetails(path) {
  const root = lstatSync(path);
  if (!root.isDirectory() || root.isSymbolicLink() || root.nlink < 1) throw new Error(`cache root must be a real directory: ${path}`);
  const entries = [];
  for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) {
    const itemPath = join(entry.parentPath || entry.path, entry.name), stat = lstatSync(itemPath), type = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "unsupported";
    entries.push({ path: relative(path, itemPath), type, device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o777, links: stat.nlink, ...(type === "file" ? { bytes: stat.size, sha256: hashFile(itemPath) } : {}) });
  }
  return { device: root.dev, inode: root.ino, uid: root.uid, mode: root.mode & 0o777, links: root.nlink, entries: entries.sort((a, b) => a.path.localeCompare(b.path)) };
}
function describeSource(source) {
  if (!source.path || source.kind === "memory") return { name: source.name, kind: source.kind, status: "no_source" };
  const path = resolve(source.path);
  if (!pathEntryExists(path)) return { name: source.name, kind: source.kind, path, status: "missing" };
  if (source.kind === "cache-root") return { name: source.name, kind: source.kind, path, status: "present", ...cacheRootDetails(path) };
  const stat = assertRegularSingleLink(path);
  const item = { name: source.name, kind: source.kind, path, status: "present", bytes: stat.size, sha256: hashFile(path), device: stat.dev, inode: stat.ino, uid: stat.uid, mode: stat.mode & 0o777, links: stat.nlink };
  const companions = [];
  for (const suffix of source.kind === "sqlite" ? ["-wal", "-shm"] : []) {
    const companion = `${path}${suffix}`;
    if (existsSync(companion)) { const s = assertRegularSingleLink(companion); companions.push({ path: companion, bytes: s.size, sha256: hashFile(companion) }); }
  }
  if (companions.length) item.companions = companions;
  if (source.kind === "sqlite") Object.assign(item, sqliteDetails(path));
  if (source.kind === "jsonl") item.records = readFileSync(path, "utf8").split("\n").filter(Boolean).map(JSON.parse).length;
  if (source.kind === "json") JSON.parse(readFileSync(path, "utf8"));
  return item;
}
export function buildMigrationManifest(inventory, metadata = {}) {
  return { version: 2, migration_id: metadata.migrationId || randomUUID(), created_at: new Date().toISOString(), target: metadata.target ? resolve(metadata.target) : null, source_precedence: "later_sources_override_earlier_sources", sources: inventory.map(describeSource), outputs: metadata.outputs || [], activated_at: metadata.activatedAt || null };
}
const rowKey = (row, columns) => JSON.stringify(columns.map((column) => row[column]));
const equalRows = (a, b, columns) => columns.every((column) => a[column] === b[column]);
function mergeSqlite(paths, output) {
  const db = new Database(output); const indexes = new Map();
  try {
    db.pragma("journal_mode = DELETE");
    db.exec("CREATE TABLE migration_provenance(table_name TEXT NOT NULL, source_path TEXT NOT NULL, source_sha256 TEXT NOT NULL, source_identity TEXT, output_identity TEXT, disposition TEXT NOT NULL)");
    for (let sourceIndex = 0; sourceIndex < paths.length; sourceIndex += 1) {
      const sourcePath = paths[sourceIndex], alias = `source_${sourceIndex}`, sourceHash = hashFile(sourcePath);
      db.prepare(`ATTACH DATABASE ? AS ${quote(alias)}`).run(sourcePath);
      const tables = db.prepare(`SELECT name, sql FROM ${quote(alias)}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all();
      for (const table of tables) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table.name)) db.exec(table.sql);
        for (const index of db.prepare(`SELECT name, sql FROM ${quote(alias)}.sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`).all(table.name)) indexes.set(index.name, index.sql);
        const info = db.prepare(`PRAGMA ${quote(alias)}.table_info(${quote(table.name)})`).all(), columns = info.map((c) => c.name), primary = info.filter((c) => c.pk).sort((a, b) => a.pk - b.pk);
        const integerPrimary = primary.length === 1 && /INT/i.test(primary[0].type);
        const selectExisting = primary.length ? db.prepare(`SELECT * FROM ${quote(table.name)} WHERE ${primary.map((c) => `${quote(c.name)} IS ?`).join(" AND ")}`) : null;
        for (const sourceRow of db.prepare(`SELECT * FROM ${quote(alias)}.${quote(table.name)}`).all()) {
          const row = { ...sourceRow }, sourceIdentity = primary.length ? rowKey(row, primary.map((c) => c.name)) : null;
          let disposition = "inserted";
          if (selectExisting) {
            const existing = selectExisting.get(...primary.map((c) => row[c.name]));
            if (existing && equalRows(existing, row, columns)) disposition = "deduplicated";
            else if (existing) { disposition = "rekeyed_conflict"; if (integerPrimary) delete row[primary[0].name]; else row[primary[0].name] = `${row[primary[0].name]}#migration:${sourceHash.slice(0, 12)}:${sourceIndex}`; }
          }
          if (disposition !== "deduplicated") { const names = columns.filter((c) => Object.hasOwn(row, c)); const inserted = db.prepare(`INSERT INTO ${quote(table.name)} (${names.map(quote).join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map((c) => row[c])); if (integerPrimary && !Object.hasOwn(row, primary[0].name)) row[primary[0].name] = Number(inserted.lastInsertRowid); }
          db.prepare("INSERT INTO migration_provenance VALUES (?, ?, ?, ?, ?, ?)").run(table.name, sourcePath, sourceHash, sourceIdentity, primary.length ? rowKey(row, primary.map((c) => c.name)) : null, disposition);
        }
      }
      db.prepare(`DETACH DATABASE ${quote(alias)}`).run();
    }
    for (const sql of indexes.values()) { try { db.exec(sql); } catch (error) { if (!/already exists/i.test(error.message)) throw error; } }
    if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("merged SQLite integrity check failed");
  } finally { db.close(); }
  chmodSync(output, 0o600); syncFile(output);
}
function writeAudit(paths, output) {
  const seenStable = new Map(), records = [];
  for (const sourcePath of paths) {
    const sourceHash = hashFile(sourcePath), lines = readFileSync(sourcePath, "utf8").split("\n").filter(Boolean);
    for (let index = 0; index < lines.length; index += 1) {
      const event = JSON.parse(lines[index]), stableId = event.event_id ?? event.id ?? null;
      if (stableId != null) { const canonical = JSON.stringify(event); if (seenStable.get(String(stableId)) === canonical) continue; if (seenStable.has(String(stableId))) event.event_id = `${stableId}#migration:${sourceHash.slice(0, 12)}:${index + 1}`; seenStable.set(String(stableId), canonical); }
      event.migration_provenance = { source_path: sourcePath, source_sha256: sourceHash, source_record: index + 1 }; records.push(event);
    }
  }
  writeFileSync(output, records.map(JSON.stringify).join("\n") + (records.length ? "\n" : ""), { mode: 0o600 }); syncFile(output);
}
function mergeJsonObjects(paths, output) {
  const merged = {};
  for (const path of paths) { const value = JSON.parse(readFileSync(path, "utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`expected JSON object: ${path}`); Object.assign(merged, value); }
  writeFileSync(output, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 }); syncFile(output);
}
function inventoryRoots(roots) {
  const inventory = [];
  for (const root of roots) {
    for (const [file, kind] of ROOT_FILES) { const path = join(root, file); inventory.push({ name: `${basename(root)}:${file}`, kind, path }); }
    const cacheRoot = join(root, "semantic-cache");
    inventory.push({ name: `${basename(root)}:semantic-cache`, kind: "cache-root", path: cacheRoot });
    if (existsSync(cacheRoot)) for (const entry of readdirSync(cacheRoot, { recursive: true, withFileTypes: true })) { if (entry.isFile()) { const path = join(entry.parentPath || entry.path, entry.name); inventory.push({ name: `${basename(root)}:semantic-cache/${relative(cacheRoot, path)}`, kind: "cache", path }); } }
  }
  if (!inventory.some((entry) => entry.kind === "cache")) inventory.push({ name: "semantic-cache-memory", kind: "memory", path: null });
  return inventory;
}
function copyInventoryFiles(inventory, stage) {
  const files = inventory.filter((item) => ["yaml", "cache"].includes(item.kind) && item.path && existsSync(item.path));
  files.forEach((item, index) => { const directory = item.kind === "cache" ? join(stage, "semantic-cache") : join(stage, "inventory"); mkdirSync(directory, { recursive: true, mode: 0o700 }); const output = join(directory, `${index}-${basename(item.path)}`); copyFileSync(item.path, output, constants.COPYFILE_EXCL); chmodSync(output, 0o600); syncFile(output); });
}
function describeOutputs(stage) {
  const outputs = [];
  const walk = (directory) => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) walk(path); else if (entry.name !== "migration-manifest.json") { assertRegularSingleLink(path); const kind = entry.name.endsWith(".db") ? "sqlite" : entry.name.endsWith(".jsonl") ? "jsonl" : entry.name.endsWith(".json") ? "json" : "file"; const item = { path: relative(stage, path), kind, bytes: statSync(path).size, sha256: hashFile(path) }; if (kind === "sqlite") Object.assign(item, sqliteDetails(path)); if (kind === "jsonl") item.records = readFileSync(path, "utf8").split("\n").filter(Boolean).map(JSON.parse).length; if (kind === "json") JSON.parse(readFileSync(path, "utf8")); outputs.push(item); } } };
  walk(stage); return outputs.sort((a, b) => a.path.localeCompare(b.path));
}
function ownedManifest(root, target) { const path = join(root, "migration-manifest.json"); if (!existsSync(path)) throw new Error(`refusing unowned migration directory: ${root}`); const manifest = JSON.parse(readFileSync(path, "utf8")); if (manifest.version !== 2 || manifest.target !== resolve(target) || !manifest.migration_id) throw new Error(`invalid migration ownership: ${root}`); return manifest; }
function stageProviderState({ sources, target }) {
  if (!Array.isArray(sources) || !sources.length) throw new Error("at least one source is required");
  const roots = sources.map((source) => resolve(source));
  for (const source of roots) { const stat = lstatSync(source); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe source: ${source}`); }
  const destination = resolve(target), stage = `${destination}.staging`;
  if (existsSync(stage)) { ownedManifest(stage, destination); rmSync(stage, { recursive: true }); }
  mkdirSync(stage, { mode: 0o700 });
  const inventory = inventoryRoots(roots), migrationId = randomUUID(), snapshot = buildMigrationManifest(inventory, { migrationId, target: destination }), metrics = inventory.filter((i) => i.kind === "sqlite" && existsSync(i.path)).map((i) => i.path), audits = inventory.filter((i) => i.kind === "jsonl" && existsSync(i.path)).map((i) => i.path);
  if (metrics.length) mergeSqlite(metrics, join(stage, "metrics.db")); if (audits.length) writeAudit(audits, join(stage, "audit.jsonl"));
  for (const [output, names] of [["capacity-state.json", ["capacity-state.json", "capacity_store.json"]], ["provider-health.json", ["provider-health.json"]], ["model_catalog_store.json", ["model_catalog_store.json"]], ["model_catalog_cache.json", ["model_catalog_cache.json"]]]) { const paths = inventory.filter((i) => i.kind === "json" && existsSync(i.path) && names.includes(basename(i.path))).map((i) => i.path); if (paths.length) mergeJsonObjects(paths, join(stage, output)); }
  copyInventoryFiles(inventory, stage);
  const outputs = describeOutputs(stage);
  for (const source of snapshot.sources.filter((item) => item.status === "present")) if (!sourceUnchanged(source)) throw new Error(`source changed during staging: ${source.path}`);
  const manifest = { ...snapshot, outputs }, manifestPath = join(stage, "migration-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }); syncFile(manifestPath); syncDirectory(stage); return { stage, manifest };
}
function sourceUnchanged(source) {
  if (source.status === "missing") return !pathEntryExists(source.path);
  if (source.status !== "present" || !pathEntryExists(source.path)) return false;
  if (source.kind === "cache-root") {
    try { const current = cacheRootDetails(source.path); return JSON.stringify(current) === JSON.stringify({ device: source.device, inode: source.inode, uid: source.uid, mode: source.mode, links: source.links, entries: source.entries }); } catch { return false; }
  }
  const current = lstatSync(source.path);
  if (!current.isFile() || current.nlink !== source.links || current.dev !== source.device || current.ino !== source.inode || current.uid !== source.uid || (current.mode & 0o777) !== source.mode || hashFile(source.path) !== source.sha256) return false;
  const expected = new Map((source.companions || []).map((item) => [item.path, item.sha256]));
  for (const suffix of source.kind === "sqlite" ? ["-wal", "-shm"] : []) { const path = `${source.path}${suffix}`; if (existsSync(path) !== expected.has(path) || (existsSync(path) && hashFile(path) !== expected.get(path))) return false; }
  return true;
}
export function verifyMigration(root) {
  try {
    const manifest = JSON.parse(readFileSync(join(root, "migration-manifest.json"), "utf8"));
    if (manifest.version !== 2 || !manifest.migration_id || !manifest.target) return { valid: false, reason: "manifest_identity" };
    for (const source of manifest.sources.filter((i) => i.status !== "no_source")) if (!sourceUnchanged(source)) return { valid: false, reason: "source_changed" };
    for (const output of manifest.outputs) { const path = join(root, output.path); if (!existsSync(path)) return { valid: false, reason: "output_missing" }; const stat = assertRegularSingleLink(path); if (stat.size !== output.bytes || hashFile(path) !== output.sha256) return { valid: false, reason: "output_changed" }; if (output.kind === "sqlite") { const details = sqliteDetails(path); if (JSON.stringify(details.tables) !== JSON.stringify(output.tables)) return { valid: false, reason: "output_counts_changed" }; } else if (output.kind === "jsonl") { const records = readFileSync(path, "utf8").split("\n").filter(Boolean).map(JSON.parse).length; if (records !== output.records) return { valid: false, reason: "output_counts_changed" }; } else if (output.kind === "json") JSON.parse(readFileSync(path, "utf8")); }
    return { valid: true, manifest };
  } catch (error) { return { valid: false, reason: error.message }; }
}
function activateStage(target) {
  const destination = resolve(target), stage = `${destination}.staging`;
  if (existsSync(destination)) throw new Error(`target already exists: ${destination}`);
  ownedManifest(stage, destination);
  const verified = verifyMigration(stage); if (!verified.valid) throw new Error(`migration verification failed: ${verified.reason}`);
  const manifest = { ...verified.manifest, activated_at: new Date().toISOString() }, manifestPath = join(stage, "migration-manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }); syncFile(manifestPath); syncDirectory(stage); renameSync(stage, destination); syncDirectory(dirname(destination)); return manifest;
}
export function migrateProviderState({ sources, target, crashAt } = {}) { const destination = resolve(target); if (existsSync(destination)) throw new Error(`target already exists: ${destination}`); const { manifest } = stageProviderState({ sources, target: destination }); if (crashAt === "before-activate") throw new Error("injected crash before-activate"); activateStage(destination); return { activated: true, target: destination, manifest }; }
function rollback(target) {
  const destination = resolve(target), stage = `${destination}.staging`;
  if (!existsSync(destination)) { if (!existsSync(stage)) throw new Error("no owned migration to roll back"); ownedManifest(stage, destination); rmSync(stage, { recursive: true }); syncDirectory(dirname(destination)); return { staged_removed: true }; }
  const manifest = ownedManifest(destination, destination), activeAudit = join(destination, "audit.jsonl"), sourceAudit = manifest.sources.find((i) => i.kind === "jsonl" && i.status === "present")?.path; let replayed = 0;
  if (sourceAudit && existsSync(activeAudit)) { const sourceRecord = manifest.sources.find((item) => item.path === sourceAudit), activeLines = readFileSync(activeAudit, "utf8").split("\n").filter(Boolean), cursorPath = join(dirname(sourceAudit), `.skgateway-rollback-${manifest.migration_id}.json`); let cursor = manifest.outputs.find((item) => item.path === "audit.jsonl")?.records ?? 0; if (existsSync(cursorPath)) { const saved = JSON.parse(readFileSync(cursorPath, "utf8")); if (saved.migration_id !== manifest.migration_id || !Number.isSafeInteger(saved.active_records)) throw new Error("invalid rollback cursor"); cursor = saved.active_records; } if (cursor > activeLines.length) throw new Error("active audit truncated after rollback"); const additions = activeLines.slice(cursor).filter((line) => !JSON.parse(line).migration_provenance); if (additions.length) { const fd = openSync(sourceAudit, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW); try { const opened = fstatSync(fd); if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== sourceRecord.device || opened.ino !== sourceRecord.inode || opened.uid !== sourceRecord.uid || (opened.mode & 0o777) !== sourceRecord.mode) throw new Error("rollback source identity changed"); writeFileSync(fd, `${additions.join("\n")}\n`); fsyncSync(fd); } finally { closeSync(fd); } replayed = additions.length; } writePrivateFileAtomic(cursorPath, `${JSON.stringify({ migration_id: manifest.migration_id, active_records: activeLines.length })}\n`); }
  return { active_preserved: true, replayed };
}
function usage() { process.stderr.write("usage: migrate-provider-state.mjs --inventory SOURCE... | --stage TARGET SOURCE... | --verify TARGET | --activate TARGET | --rollback TARGET\n"); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { const [command, target, ...sources] = process.argv.slice(2); if (command === "--inventory") console.log(JSON.stringify(buildMigrationManifest(inventoryRoots([target, ...sources].map((p) => resolve(p)))), null, 2)); else if (command === "--stage") console.log(JSON.stringify(stageProviderState({ sources, target }), null, 2)); else if (command === "--verify") { const result = verifyMigration(target); console.log(JSON.stringify(result)); if (!result.valid) process.exitCode = 1; } else if (command === "--activate") console.log(JSON.stringify(activateStage(target))); else if (command === "--rollback") console.log(JSON.stringify(rollback(target))); else { usage(); process.exitCode = 2; } }
