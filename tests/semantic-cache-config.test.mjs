import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.mjs";

describe("semantic_cache config", () => {
  test("absent section defaults to disabled shadow mode", async () => {
    const cfg = (await loadConfig({ silent: true })).current();
    const sc = cfg.semantic_cache;
    assert.ok(sc, "semantic_cache must always be present after normalisation");
    assert.equal(sc.enabled, false, "must be OFF unless explicitly enabled");
    assert.equal(sc.mode, "shadow", "shadow is the only safe default");
    assert.deepEqual(sc.categories, ["administrative", "system", "data_query"]);
  });

  test("serve mode is refused until shadow data justifies it", async () => {
    const cfg = (await loadConfig({ silent: true })).current();
    assert.notEqual(cfg.semantic_cache.mode, "serve",
      "no committed config may ship mode: serve");
  });
});
