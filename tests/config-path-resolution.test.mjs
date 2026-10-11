/**
 * config-path-resolution.test.mjs — CR-1.5 gateway-config-out-of-repo.
 *
 * Verifies resolveConfigPath() precedence so the runtime config comes off the
 * Syncthing-synced path instead of the drift-prone in-repo file:
 *
 *   explicit (--config) > $SKGATEWAY_CONFIG
 *   > per-estate ~/.skcapstone/gateway/skgateway.$SKWORLD_ESTATE.yaml
 *   > synced ~/.skcapstone/gateway/skgateway.yaml
 *   > throw
 *
 * There is no in-repo fallback: config/skgateway.yaml and
 * config/skgateway-codex.yaml are per-estate FIXTURES, and falling through to
 * one meant a misconfigured host silently served another estate's providers.
 *
 * Run with:  node --test tests/config-path-resolution.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveConfigPath,
  estateConfigPath,
  SYNCED_CONFIG_PATH,
} from "../src/config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const IN_REPO = resolve(REPO_ROOT, "config", "skgateway.yaml");

describe("resolveConfigPath precedence (CR-1.5)", () => {
  let savedEnv;
  let savedEstate;

  beforeEach(() => {
    savedEnv = process.env.SKGATEWAY_CONFIG;
    savedEstate = process.env.SKWORLD_ESTATE;
    delete process.env.SKGATEWAY_CONFIG;
    delete process.env.SKWORLD_ESTATE;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.SKGATEWAY_CONFIG;
    else process.env.SKGATEWAY_CONFIG = savedEnv;
    if (savedEstate === undefined) delete process.env.SKWORLD_ESTATE;
    else process.env.SKWORLD_ESTATE = savedEstate;
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

  test("with no explicit path and no env: synced path if present, else throws", () => {
    // Precedence depends on whether this host has a runtime config. Either
    // outcome is correct; assert we land on exactly the right one for this host.
    if (existsSync(SYNCED_CONFIG_PATH)) {
      assert.equal(resolveConfigPath(), SYNCED_CONFIG_PATH);
    } else {
      assert.throws(() => resolveConfigPath(), /no runtime config found/);
    }
  });

  test("never silently falls back to an in-repo estate config", () => {
    // config/skgateway.yaml is a 499-line estate config, not an example. A
    // host that fell through to it served the wrong estate's providers while
    // looking healthy, which is worse for a router than refusing to boot.
    assert.ok(existsSync(IN_REPO), "fixture should still exist for other tests");
    let resolved = null;
    try {
      resolved = resolveConfigPath();
    } catch {
      return; // threw, which is the fail-closed outcome
    }
    assert.notEqual(resolved, IN_REPO, "in-repo estate config must not be a fallback");
  });

  test("estateConfigPath puts the estate in the filename, not the directory", () => {
    const nor = estateConfigPath("nor");
    const chi = estateConfigPath("chi");
    assert.ok(nor.endsWith("/.skcapstone/gateway/skgateway.nor.yaml"), nor);
    assert.ok(chi.endsWith("/.skcapstone/gateway/skgateway.chi.yaml"), chi);
    assert.notEqual(nor, chi, "two estates must not collide on one filename");
    assert.equal(dirname(nor), dirname(chi), "same synced dir, different files");
  });

  test("$SKWORLD_ESTATE is consulted only when its file exists", () => {
    process.env.SKWORLD_ESTATE = "estate-that-does-not-exist";
    if (existsSync(SYNCED_CONFIG_PATH)) {
      // Falls past a missing per-estate file to the plain synced path.
      assert.equal(resolveConfigPath(), SYNCED_CONFIG_PATH);
    } else {
      assert.throws(() => resolveConfigPath(), /no runtime config found/);
    }
  });

  test("$SKGATEWAY_CONFIG still outranks $SKWORLD_ESTATE", () => {
    process.env.SKWORLD_ESTATE = "nor";
    process.env.SKGATEWAY_CONFIG = "/explicit/env/wins.yaml";
    assert.equal(resolveConfigPath(), "/explicit/env/wins.yaml");
  });

  test("SYNCED_CONFIG_PATH points at the ~/.skcapstone/gateway tree", () => {
    assert.ok(
      SYNCED_CONFIG_PATH.endsWith("/.skcapstone/gateway/skgateway.yaml"),
      `unexpected synced path: ${SYNCED_CONFIG_PATH}`,
    );
  });
});
