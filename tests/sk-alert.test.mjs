/**
 * sk-alert.test.mjs - card a7f65226.
 *
 * Proves the calling convention that the fleet incident
 * (sk-alert-never-fired-from-schedulers) requires: an ABSOLUTE, PATH-independent
 * binary resolution, and the message passed as an ARGUMENT, never piped to
 * stdin. A stub that drains stdin would pass a wrapper that pipes - the same
 * lesson that incident's own test suite calls out - so the fake exec here
 * records ARGUMENTS only.
 *
 * Run with:  node --test tests/sk-alert.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSkAlertBin, fireSkAlert, DEFAULT_SK_ALERT_BIN } from "../scripts/lib/sk-alert.mjs";

describe("resolveSkAlertBin", () => {
  test("resolves SK_ALERT_BIN when it points at a real file", () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-skalert-"));
    const fake = join(dir, "sk-alert");
    writeFileSync(fake, "#!/bin/sh\n");
    chmodSync(fake, 0o755);
    const prev = process.env.SK_ALERT_BIN;
    process.env.SK_ALERT_BIN = fake;
    try {
      assert.equal(resolveSkAlertBin(), fake);
    } finally {
      if (prev === undefined) delete process.env.SK_ALERT_BIN; else process.env.SK_ALERT_BIN = prev;
    }
  });

  test("ignores SK_ALERT_BIN pointed at a nonexistent file rather than silently using it", () => {
    const prev = process.env.SK_ALERT_BIN;
    process.env.SK_ALERT_BIN = "/definitely/not/a/real/path/sk-alert";
    try {
      const resolved = resolveSkAlertBin();
      assert.notEqual(resolved, "/definitely/not/a/real/path/sk-alert");
    } finally {
      if (prev === undefined) delete process.env.SK_ALERT_BIN; else process.env.SK_ALERT_BIN = prev;
    }
  });

  test("DEFAULT_SK_ALERT_BIN is an absolute path under ~/.skenv/bin, never a bare command name", () => {
    assert.ok(DEFAULT_SK_ALERT_BIN.startsWith("/"), "must be absolute - a bare 'sk-alert' is exactly what fails under a scheduler PATH");
    assert.match(DEFAULT_SK_ALERT_BIN, /\.skenv\/bin\/sk-alert$/);
  });
});

describe("fireSkAlert", () => {
  test("rejects an empty message before ever touching exec, mirroring sk-alert's own 'empty message' guard", async () => {
    const execImpl = async () => { throw new Error("must not be called"); };
    const r = await fireSkAlert({ message: "", execImpl });
    assert.equal(r.fired, false);
    assert.match(r.reason, /empty message/);
  });

  test("passes the message as an ARGUMENT, not stdin - the exact bug that made sk-alert never fire from a scheduler", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-skalert-fire-"));
    const fake = join(dir, "sk-alert");
    writeFileSync(fake, "#!/bin/sh\n");
    chmodSync(fake, 0o755);
    const prev = process.env.SK_ALERT_BIN;
    process.env.SK_ALERT_BIN = fake;
    let seenArgv;
    const execImpl = async (bin, argv) => { seenArgv = argv; return { stdout: "", stderr: "" }; };
    try {
      const r = await fireSkAlert({ message: "test alert body", level: "crit", key: "unit-test-key", ttlSeconds: 60, execImpl });
      assert.equal(r.fired, true);
      // the message must be a literal element of argv, findable without any
      // stdin/pipe machinery
      assert.ok(seenArgv.includes("test alert body"));
      assert.ok(seenArgv.includes("-l"));
      assert.ok(seenArgv.includes("crit"));
      assert.ok(seenArgv.includes("-k"));
      assert.ok(seenArgv.includes("unit-test-key"));
      assert.ok(seenArgv.includes("-t"));
      assert.ok(seenArgv.includes("60"));
    } finally {
      if (prev === undefined) delete process.env.SK_ALERT_BIN; else process.env.SK_ALERT_BIN = prev;
    }
  });

  test("no resolvable binary -> fired:false with a clear reason, never throws", async () => {
    const r = await fireSkAlert({
      message: "hi",
      resolveBinImpl: () => null,
      execImpl: async () => { throw new Error("must not be called"); },
    });
    assert.equal(r.fired, false);
    assert.match(r.reason, /not found/);
  });

  test("an exec failure is captured, never thrown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-skalert-fail-"));
    const fake = join(dir, "sk-alert");
    writeFileSync(fake, "#!/bin/sh\n");
    chmodSync(fake, 0o755);
    const prev = process.env.SK_ALERT_BIN;
    process.env.SK_ALERT_BIN = fake;
    const execImpl = async () => { throw new Error("boom"); };
    try {
      const r = await fireSkAlert({ message: "hi", execImpl });
      assert.equal(r.fired, false);
      assert.match(r.reason, /boom/);
    } finally {
      if (prev === undefined) delete process.env.SK_ALERT_BIN; else process.env.SK_ALERT_BIN = prev;
    }
  });
});
