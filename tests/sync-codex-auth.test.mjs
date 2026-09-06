import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "sync-codex-auth.sh");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skgateway-auth-sync-"));
  const bin = join(root, "bin");
  const secrets = join(root, "secrets");
  mkdirSync(bin);
  mkdirSync(secrets);
  const source = join(root, "upstream-auth.json");
  const destination = join(secrets, "codex-auth.json");
  const scpLog = join(root, "scp.log");
  const fakeScp = join(bin, "scp");
  writeFileSync(fakeScp, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' "$@" > "$SCP_LOG"\nargs=("$@")\ncp -- "\${args[\${#args[@]}-2]}" "\${args[\${#args[@]}-1]}"\n`);
  chmodSync(fakeScp, 0o755);
  return { root, bin, source, destination, scpLog };
}

function run(paths, source = paths.source, destination = paths.destination) {
  return spawnSync("bash", [SCRIPT, source, destination], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: `${paths.bin}:${process.env.PATH}`, SCP_LOG: paths.scpLog },
  });
}

test("auth sync validates then atomically installs a mode-600 credential without exposing it", () => {
  const paths = fixture();
  const sentinel = "fixture-access-token-must-not-appear-in-output";
  writeFileSync(paths.source, JSON.stringify({ tokens: { access_token: sentinel } }));
  writeFileSync(paths.destination, "old credential");

  const result = run(paths);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(paths.destination, "utf8")).tokens.access_token, sentinel);
  assert.equal(lstatSync(paths.destination).mode & 0o777, 0o600);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel));
  const scpArgs = readFileSync(paths.scpLog, "utf8").trim().split("\n");
  assert.equal(scpArgs.at(-2), paths.source);
  assert.match(scpArgs.at(-1), /\/secrets\/\.codex-auth\.[^/]+$/);
});

test("invalid incoming content preserves the installed credential and removes temporary files", () => {
  const paths = fixture();
  writeFileSync(paths.source, JSON.stringify({ tokens: {} }));
  writeFileSync(paths.destination, "preserve me");

  const result = run(paths);

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(paths.destination, "utf8"), "preserve me");
  assert.deepEqual(readdirSync(dirname(paths.destination)).filter((name) => name.startsWith(".codex-auth.")), []);
});

test("auth sync rejects relative destinations and destination symlinks before scp", () => {
  const paths = fixture();
  writeFileSync(paths.source, JSON.stringify({ tokens: { access_token: "fixture" } }));

  const relative = run(paths, paths.source, "secrets/codex-auth.json");
  assert.equal(relative.status, 64);

  const target = join(paths.root, "do-not-overwrite");
  writeFileSync(target, "sentinel");
  symlinkSync(target, paths.destination);
  const symlink = run(paths);
  assert.equal(symlink.status, 65);
  assert.equal(readFileSync(target, "utf8"), "sentinel");
  assert.throws(() => readFileSync(paths.scpLog), { code: "ENOENT" });
});
