/**
 * config-path-resolution.test.mjs — CR-1.5 gateway-config-out-of-repo.
 *
 * Verifies resolveConfigPath() precedence so the runtime config comes off the
 * Syncthing-synced path instead of the drift-prone in-repo file:
 *
 *   explicit (--config) > $SKGATEWAY_CONFIG > synced ~/.skcapstone/gateway
 *   > in-repo config/skgateway.yaml
 *
 * Run with:  node --test tests/config-path-resolution.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveConfigPath, SYNCED_CONFIG_PATH } from "../src/config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const IN_REPO = resolve(REPO_ROOT, "config", "skgateway.yaml");

describe("resolveConfigPath precedence (CR-1.5)", () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = process.env.SKGATEWAY_CONFIG;
    delete process.env.SKGATEWAY_CONFIG;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.SKGATEWAY_CONFIG;
    else process.env.SKGATEWAY_CONFIG = savedEnv;
  });

  test("explicit override wins over env and everything else", () => {
    process.env.SKGATEWAY_CONFIG = "/env/should/not/win.yaml";
    assert.equal(resolveConfigPath("/explicit/path.yaml"), "/explicit/path.yaml");
  });

  test("explicit override expands a leading ~/", () => {
    const got = resolveConfigPath("~/some/where.yaml");
    assert.ok(got.endsWith("/some/where.yaml"));
    assert.ok(!got.startsWith("~"), "tilde must be expanded to an absolute path");
  });

  test("$SKGATEWAY_CONFIG wins when no explicit override", () => {
    process.env.SKGATEWAY_CONFIG = "/env/config.yaml";
    assert.equal(resolveConfigPath(), "/env/config.yaml");
  });

  test("$SKGATEWAY_CONFIG expands a leading ~/ (systemd does not)", () => {
    process.env.SKGATEWAY_CONFIG = "~/.skcapstone/gateway/skgateway.yaml";
    const got = resolveConfigPath();
    assert.ok(got.endsWith("/.skcapstone/gateway/skgateway.yaml"));
    assert.ok(!got.startsWith("~"));
  });

  test("with no explicit path and no env: synced path if present, else in-repo", () => {
    // Precedence 3 vs 4 depends on whether this host has been migrated. Either
    // outcome is correct; assert we land on exactly the right one for this host.
    if (existsSync(SYNCED_CONFIG_PATH)) {
      assert.equal(resolveConfigPath(), SYNCED_CONFIG_PATH);
    } else {
      assert.equal(resolveConfigPath(), IN_REPO);
    }
  });

  test("SYNCED_CONFIG_PATH points at the ~/.skcapstone/gateway tree", () => {
    assert.ok(
      SYNCED_CONFIG_PATH.endsWith("/.skcapstone/gateway/skgateway.yaml"),
      `unexpected synced path: ${SYNCED_CONFIG_PATH}`,
    );
  });
});
