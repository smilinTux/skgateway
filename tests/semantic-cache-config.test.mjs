import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.mjs";

// These assertions are about the configs COMMITTED to this repo, so they name
// them. resolveConfigPath() deliberately has no in-repo fallback (a host that
// fell through to it served another estate's providers), so an implicit
// loadConfig() resolved to the developer's ~/.skcapstone config locally and
// threw on a CI runner that has none.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IN_REPO_CONFIG = join(REPO_ROOT, "config", "skgateway.yaml");

/** Every committed config: the in-repo fixtures plus the per-estate copies. */
function committedConfigs() {
  const paths = [IN_REPO_CONFIG, join(REPO_ROOT, "config", "skgateway-codex.yaml")];
  const estates = join(REPO_ROOT, "configs", "estates");
  if (existsSync(estates)) {
    for (const f of readdirSync(estates)) {
      if (f.endsWith(".yaml") || f.endsWith(".yml")) paths.push(join(estates, f));
    }
  }
  return paths.filter((p) => existsSync(p));
}

describe("semantic_cache config", () => {
  test("absent section defaults to disabled shadow mode", async () => {
    const cfg = (await loadConfig({ configPath: IN_REPO_CONFIG, silent: true })).current();
    const sc = cfg.semantic_cache;
    assert.ok(sc, "semantic_cache must always be present after normalisation");
    assert.equal(sc.enabled, false, "must be OFF unless explicitly enabled");
    assert.equal(sc.mode, "shadow", "shadow is the only safe default");
    assert.deepEqual(sc.categories, ["administrative", "system", "data_query"]);
  });

  test("serve mode is refused until shadow data justifies it", async () => {
    // Covers every committed config, including configs/estates/*.yaml, so a
    // new estate file cannot quietly ship mode: serve.
    const checked = committedConfigs();
    assert.ok(checked.length >= 2, `expected committed configs, found ${checked.length}`);
    for (const configPath of checked) {
      const cfg = (await loadConfig({ configPath, silent: true })).current();
      assert.notEqual(
        cfg.semantic_cache.mode,
        "serve",
        `no committed config may ship mode: serve (${configPath})`,
      );
    }
  });
});
