/**
 * generation-defaults-focused-alias.test.mjs — src/index.mjs:
 * applyGenerationDefaults() and applyFocusedAliasMetadata() (chi port,
 * inventory item 5).
 *
 * applyGenerationDefaults() projects the operator's EXPLICIT generation-token
 * cap (model-cards.overrides.yaml) onto a catalog entry, replacing any
 * provider-claimed or stale cached value; it never trusts the provider's own
 * claim. applyFocusedAliasMetadata() exposes a provider-focused
 * `sk-<provider>-<bucket>` alias under its own provider identity ONLY when
 * every member of its current pool genuinely qualifies (advertised, not
 * stale, reasoning-capable, tools + tool_choice support); otherwise it
 * projects an unavailable `skgateway`-owned stub rather than silently
 * exposing a provider identity the pool cannot actually back.
 *
 * Uses the same safe direct-import pattern as
 * tests/refresh-catalog-probe-wiring.test.mjs (discovery disabled at startup)
 * since src/index.mjs starts listening on import.
 *
 * Run with: node --test tests/generation-defaults-focused-alias.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(__dirname, "..", "src", "index.mjs");

const PORT = 18993, DASH = 18994;

describe("item 5: applyGenerationDefaults + applyFocusedAliasMetadata", () => {
  let mod;
  let tmpDir;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "skgw-gen-defaults-focused-alias-"));
    const cfgPath = join(tmpDir, "gw.yaml");
    const storePath = join(tmpDir, "model_catalog_store.json");
    writeFileSync(storePath, "{}");
    writeFileSync(
      cfgPath,
      [
        "server:", "  bind: 127.0.0.1", `  port: ${PORT}`, `  dashboard_port: ${DASH}`,
        "dashboard:", `  port: ${DASH}`,
        "discovery:", "  enabled: false",
        "identity:", "  enabled: false",
        "backends:", "  local:", "    url: http://127.0.0.1:1/v1", "    auth_type: none",
        "    priority: 1", "    models: [gen-defaults-neutral]",
        "",
      ].join("\n"),
    );
    process.env.SKGATEWAY_CONFIG = cfgPath;
    process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = storePath;
    mod = await import(pathToFileURL(INDEX).href);
  });

  after(() => {
    delete process.env.SKGATEWAY_CONFIG;
    delete process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH;
    try { mod.server.close(); } catch { /* best effort */ }
    try { mod.dashboard?.close?.(); } catch { /* best effort */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  describe("applyGenerationDefaults", () => {
    test("happy path: a valid override projects generation_default_tokens, replacing any provider claim", () => {
      const data = [{ id: "m1", card: { generation_default_tokens: 999_999 } }];
      const out = mod.applyGenerationDefaults(data, { m1: { generation_default_tokens: 4096 } });
      assert.equal(out[0].card.generation_default_tokens, 4096);
    });

    test("edge case: no override and no existing field leaves the model untouched (same reference)", () => {
      const model = { id: "m2", card: { context_length: 1000 } };
      const out = mod.applyGenerationDefaults([model], {});
      assert.equal(out[0], model, "a model with nothing to change must not be rebuilt");
    });

    test("failure case: an invalid/absent override value strips a stale cached default instead of trusting it", () => {
      const data = [{ id: "m3", card: { generation_default_tokens: 123456 } }];
      const out = mod.applyGenerationDefaults(data, { m3: { generation_default_tokens: -1 } });
      assert.equal(Object.hasOwn(out[0].card, "generation_default_tokens"), false);

      const noOverrideAtAll = mod.applyGenerationDefaults(
        [{ id: "m4", card: { generation_default_tokens: 50000 } }], {},
      );
      assert.equal(Object.hasOwn(noOverrideAtAll[0].card, "generation_default_tokens"), false,
        "a stale cached default with NO override entry at all must still be stripped, never trusted");
    });
  });

  describe("applyFocusedAliasMetadata", () => {
    const qualifiedMember = {
      id: "zai-flagship", provider: "zai", advertised: true, stale: false,
      status: "available",
      card: { reasoning: true, supported_parameters: ["tools", "tool_choice"], tier: "paid-cloud", size_class: "L" },
    };

    test("happy path: a fully-qualified pool projects the alias under its own provider identity", () => {
      const aliasEntry = { id: "sk-zai-l", kind: "bucket", provider: "skgateway", card: {} };
      const data = [aliasEntry, qualifiedMember];
      const cfg = { backends: { zai: { enabled: true } } };
      const out = mod.applyFocusedAliasMetadata(data, cfg, { membership: data });
      const projected = out.find((e) => e.id === "sk-zai-l");
      assert.equal(projected.provider, "zai");
      assert.equal(projected.advertised, true);
      assert.equal(projected.stale, false);
      assert.equal(projected.card.reasoning, true);
      assert.deepEqual(projected.card.supported_parameters, ["tools", "tool_choice", "reasoning"]);
    });

    test("edge case: a non-bucket entry passes through unchanged", () => {
      const concrete = { id: "zai-flagship", provider: "zai", card: {} };
      const out = mod.applyFocusedAliasMetadata([concrete], { backends: {} }, { membership: [concrete] });
      assert.equal(out[0], concrete);
    });

    test("failure case: a disabled backend projects an unavailable skgateway-owned stub", () => {
      const aliasEntry = { id: "sk-zai-l", kind: "bucket", provider: "skgateway", card: {} };
      const data = [aliasEntry, qualifiedMember];
      const cfg = { backends: { zai: { enabled: false } } };
      const out = mod.applyFocusedAliasMetadata(data, cfg, { membership: data });
      const projected = out.find((e) => e.id === "sk-zai-l");
      assert.equal(projected.provider, "skgateway");
      assert.equal(projected.advertised, false);
      assert.equal(projected.stale, true);
    });

    test("failure case: a member missing tool_choice support fails qualification and still stubs out", () => {
      const unqualified = {
        id: "zai-flagship", provider: "zai", advertised: true, stale: false,
        card: { reasoning: true, supported_parameters: ["tools"], size_class: "L" }, // missing tool_choice
      };
      const aliasEntry = { id: "sk-zai-l", kind: "bucket", provider: "skgateway", card: {} };
      const data = [aliasEntry, unqualified];
      const cfg = { backends: { zai: { enabled: true } } };
      const out = mod.applyFocusedAliasMetadata(data, cfg, { membership: data });
      const projected = out.find((e) => e.id === "sk-zai-l");
      assert.equal(projected.provider, "skgateway");
      assert.equal(projected.advertised, false);
    });
  });
});
