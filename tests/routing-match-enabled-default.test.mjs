/**
 * routing-match-enabled-default.test.mjs (card P4.4): `routing.match_enabled`
 * is a documented config default, OFF, not merely an absent key that happens
 * to read falsy.
 *
 * router.mjs's isMatchRoutingEnabled() and index.mjs's matchRoutingEnabled
 * already fail-soft to false when the key is missing (card P4.2/P4.3). This
 * card makes the default EXPLICIT in config.mjs's DEFAULTS so the flag shows
 * up in any config dump/introspection and a fresh `config/skgateway.yaml`
 * documents it. A config file that omits `routing` entirely, or sets
 * `routing: {}`, must still resolve `routing.match_enabled === false`; a
 * file that sets it true must override the default.
 *
 * Run with:  node --test tests/routing-match-enabled-default.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.mjs";

const FIX_DIR = mkdtempSync(join(tmpdir(), "skgw-match-default-"));

function fixture(name, yaml) {
  const p = join(FIX_DIR, name);
  writeFileSync(p, yaml, "utf8");
  return p;
}

describe("routing.match_enabled config default (card P4.4)", () => {
  test("a config file with no routing block at all defaults match_enabled to false", async () => {
    const p = fixture("no-routing.yaml", "server:\n  bind: 127.0.0.1\n");
    const emitter = await loadConfig({ configPath: p, silent: true });
    const cfg = emitter.current();
    assert.equal(cfg.routing.match_enabled, false);
  });

  test("a config file with an empty routing block still defaults match_enabled to false", async () => {
    const p = fixture("empty-routing.yaml", "routing: {}\n");
    const emitter = await loadConfig({ configPath: p, silent: true });
    assert.equal(emitter.current().routing.match_enabled, false);
  });

  test("routing.strict_targets default is untouched by adding match_enabled", async () => {
    const p = fixture("empty-routing2.yaml", "routing: {}\n");
    const emitter = await loadConfig({ configPath: p, silent: true });
    assert.equal(emitter.current().routing.strict_targets, true);
  });

  test("a config file that sets routing.match_enabled: true overrides the default", async () => {
    const p = fixture("on-routing.yaml", "routing:\n  match_enabled: true\n");
    const emitter = await loadConfig({ configPath: p, silent: true });
    assert.equal(emitter.current().routing.match_enabled, true);
  });
});
