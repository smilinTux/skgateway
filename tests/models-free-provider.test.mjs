/**
 * models-free-provider.test.mjs accurate free + provider tags on /v1/models
 * (card 9a606884).
 *
 * The /v1/models builder is assembled from two pure helpers in
 * src/proxy/advertise.mjs:
 *   - tagLocalModels(backends)      tags each static/local backend model with
 *                                   its owning provider + an accurate free flag.
 *   - mergeDiscoveredCatalog(a, b)  merges the reconciled static catalog with the
 *                                   discovery catalog and guarantees a provider.
 *
 * These prove the two symptoms on record are fixed:
 *   1. paid Claude models routed through the OpenAI-compatible LOCAL wrapper
 *      backend (auth_type none, loopback url) are NOT marked free;
 *   2. every advertised model carries a non-empty provider (no untagged model),
 *      including a model known only to the reconciled static catalog.
 *
 * Run with:  node --test tests/models-free-provider.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tagLocalModels, mergeDiscoveredCatalog } from "../src/proxy/advertise.mjs";
import { isAnthropicModelId } from "../src/proxy/anthropic-adapter.mjs";

// ── isAnthropicModelId: the per-id paid-family signal ─────────────────────────
describe("isAnthropicModelId", () => {
  test("claude-* ids are paid Anthropic family", () => {
    assert.equal(isAnthropicModelId("claude-opus-4-8"), true);
    assert.equal(isAnthropicModelId("claude-sonnet-4-6"), true);
    assert.equal(isAnthropicModelId("anthropic/claude-3-haiku"), true);
  });
  test("local/free model ids are not", () => {
    assert.equal(isAnthropicModelId("ornith-1.0-9b"), false);
    assert.equal(isAnthropicModelId("ornith-tiny"), false);
    assert.equal(isAnthropicModelId("qwen/qwen3.5-122b-a10b"), false);
    assert.equal(isAnthropicModelId(undefined), false);
  });
});

// ── tagLocalModels: accurate free + provider per backend ──────────────────────
describe("tagLocalModels free + provider", () => {
  // Mirrors the real config: `anthropic` is the LOCAL Claude wrapper
  // (loopback url, auth_type none) that is OpenAI-compatible, so
  // isAnthropicBackend does NOT flag it, yet it still serves PAID claude-*
  // models. `anthropic-direct` is the oauth fallback. `local` is a
  // genuinely-free ornith backend.
  const backends = {
    local: {
      url: "http://192.168.0.100:8082/v1",
      auth_type: "none",
      models: ["ornith-tiny", "ornith-1.0-9b"],
    },
    anthropic: {
      // loopback wrapper: OpenAI-compatible, auth_type none (the free footgun)
      url: "http://127.0.0.1:18782/v1",
      auth_type: "none",
      models: ["claude-opus-4-8", "claude-sonnet-4-6"],
    },
    "anthropic-direct": {
      url: "https://api.anthropic.com/v1",
      auth_type: "oauth",
      models: ["claude-haiku-4-5"],
    },
    ollama: { url: "http://x/v1", auth_type: "none", models: ["dolphin-*"] },
    // nvidia/openrouter are live-discovered, not tagged here:
    nvidia: { url: "https://integrate.api.nvidia.com/v1", models: ["qwen/qwen3.5-122b-a10b"] },
    openrouter: { url: "https://openrouter.ai/api/v1", models: [] },
  };

  const tagged = tagLocalModels(backends);
  const byId = new Map(tagged.map((m) => [m.id, m]));

  test("paid Claude via the local wrapper backend is NOT free", () => {
    assert.equal(byId.get("claude-opus-4-8").free, false);
    assert.equal(byId.get("claude-sonnet-4-6").free, false);
  });

  test("paid Claude via the oauth direct backend is NOT free", () => {
    assert.equal(byId.get("claude-haiku-4-5").free, false);
  });

  test("genuinely-local ornith models stay free", () => {
    assert.equal(byId.get("ornith-tiny").free, true);
    assert.equal(byId.get("ornith-1.0-9b").free, true);
  });

  test("every tagged model carries its owning-backend provider", () => {
    for (const m of tagged) {
      assert.ok(m.provider && m.provider.length > 0, `blank provider on ${m.id}`);
    }
    assert.equal(byId.get("ornith-tiny").provider, "local");
    assert.equal(byId.get("claude-opus-4-8").provider, "anthropic");
  });

  test("nvidia/openrouter are excluded (live-discovered elsewhere)", () => {
    assert.equal(byId.has("qwen/qwen3.5-122b-a10b"), false);
  });

  test("wildcard patterns are skipped, not advertised as ids", () => {
    assert.equal(byId.has("dolphin-*"), false);
  });
});

// ── mergeDiscoveredCatalog: provider always present ───────────────────────────
describe("mergeDiscoveredCatalog provider always present", () => {
  test("a reconciled-only model (no discovery tag) still gets a provider from owned_by", () => {
    // nvidia static config model present in the reconciled catalog but NOT in
    // this cycle's discovery result (e.g. live fetch failed / disabled).
    const reconciled = [
      { id: "qwen/qwen3.5-122b-a10b", object: "model", created: 0, owned_by: "nvidia", status: "available" },
    ];
    const discovered = [];
    const out = mergeDiscoveredCatalog(reconciled, discovered);
    assert.equal(out.length, 1);
    assert.equal(out[0].provider, "nvidia"); // fell back to owned_by, not blank
    assert.equal(out[0].status, "available"); // reconciled health preserved
  });

  test("discovery provider/free tags win and are layered onto reconciled health", () => {
    const reconciled = [
      { id: "claude-opus-4-8", object: "model", created: 0, owned_by: "anthropic", status: "available" },
    ];
    const discovered = [{ id: "claude-opus-4-8", provider: "anthropic", free: false }];
    const out = mergeDiscoveredCatalog(reconciled, discovered);
    assert.equal(out[0].provider, "anthropic");
    assert.equal(out[0].free, false);
    assert.equal(out[0].status, "available");
  });

  test("a discovery-only model is admitted with its provider intact", () => {
    const out = mergeDiscoveredCatalog([], [{ id: "google/gemma-4:free", provider: "openrouter", free: true }]);
    assert.equal(out[0].provider, "openrouter");
    assert.equal(out[0].free, true);
  });

  test("no advertised model is ever left with a blank provider", () => {
    const reconciled = [{ id: "mystery", object: "model", created: 0 }]; // no owned_by, no provider
    const out = mergeDiscoveredCatalog(reconciled, []);
    assert.equal(out[0].provider, "discovery"); // last-resort literal, never blank
  });
});
