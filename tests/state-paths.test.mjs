import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { resolveStatePaths, validateStateRoot, ensureStatePaths } from "../src/state/paths.mjs";

test("state paths are provider neutral and absolute", () => {
  const paths = resolveStatePaths({
    env: { XDG_CONFIG_HOME: "/tmp/u/config", XDG_STATE_HOME: "/tmp/u/state" },
    uid: process.getuid(), home: "/tmp/u",
  });
  assert.equal(paths.configRoot, "/tmp/u/config/skgateway");
  assert.equal(paths.metricsDb, "/tmp/u/state/skgateway/metrics.db");
  assert.equal(paths.auditLog, "/tmp/u/state/skgateway/audit.jsonl");
  assert.equal(paths.capacityState, "/tmp/u/state/skgateway/capacity-state.json");
});

test("relative XDG overrides fail closed", () => {
  assert.throws(() => resolveStatePaths({ env: { XDG_STATE_HOME: "relative" }, home: "/tmp/u" }), /absolute/);
});

test("symlinked and group writable roots fail closed", () => {
  const base = mkdtempSync(join(tmpdir(), "skgw-paths-"));
  const real = join(base, "real");
  const link = join(base, "link");
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, link);
  assert.throws(() => validateStateRoot(link, { uid: process.getuid() }), /symlink/);
  chmodSync(real, 0o770);
  assert.throws(() => validateStateRoot(real, { uid: process.getuid() }), /permissions/);
});

test("ensureStatePaths creates private directories", () => {
  const base = mkdtempSync(join(tmpdir(), "skgw-create-"));
  const paths = resolveStatePaths({ env: { XDG_CONFIG_HOME: join(base, "config"), XDG_STATE_HOME: join(base, "state") }, home: base });
  ensureStatePaths(paths, { uid: process.getuid() });
  assert.equal(lstatSync(paths.configRoot).mode & 0o777, 0o700);
  assert.equal(lstatSync(paths.stateRoot).mode & 0o777, 0o700);
  assert.equal(lstatSync(paths.semanticCache).mode & 0o777, 0o700);
});
