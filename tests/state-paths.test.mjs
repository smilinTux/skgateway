import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { ensurePrivateFile, resolveStatePaths, validateStateRoot, ensureStatePaths, writePrivateFileAtomic } from "../src/state/paths.mjs";

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

test("unsafe existing mutable modes reject before mutation", () => {
  const base = mkdtempSync(join(tmpdir(), "skgw-modes-"));
  for (const mode of [0o644, 0o660, 0o666]) {
    for (const writer of [ensurePrivateFile, (path) => writePrivateFileAtomic(path, "replacement")]) {
      const path = join(base, `${mode}-${Math.random()}`);
      writeFileSync(path, "original", { mode });
      chmodSync(path, mode);
      assert.throws(() => writer(path), /unsafe permissions/);
      assert.equal(readFileSync(path, "utf8"), "original");
      assert.equal(lstatSync(path).mode & 0o777, mode);
    }
  }
});

test("default XDG state root is validated before production file creation", () => {
  const base = mkdtempSync(join(tmpdir(), "skgw-default-root-")), root = join(base, "skgateway"); mkdirSync(root, { mode: 0o700 }); chmodSync(root, 0o777);
  const modulePath = new URL("../src/state/paths.mjs", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import { DEFAULT_STATE_PATHS, ensurePrivateFile } from ${JSON.stringify(modulePath)}; ensurePrivateFile(DEFAULT_STATE_PATHS.metricsDb);`], { env: { ...process.env, XDG_STATE_HOME: base }, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(root, "metrics.db")), false);
});
