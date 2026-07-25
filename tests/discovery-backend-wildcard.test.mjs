/**
 * discovery-backend-wildcard.test.mjs - discovery-backend empty-models guard
 * (finding 1, final review of feat/dynamic-provider-model-discovery).
 *
 * Backend#supportsModel() treats an empty `models` list as "accept
 * everything". That is correct for an ordinary statically-configured backend
 * (main's long-standing behavior), but WRONG for a discovery-driven backend
 * (config.mjs backends.*.discovery, e.g. openrouter): before the first
 * successful discovery fetch populates its models (or after a failed fetch
 * with no on-disk cache), an empty list must mean "nothing registered yet",
 * not "matches anything". Otherwise an unknown model id resolves solely to
 * the discovery backend at its default priority (99) and gets a 400/401,
 * instead of falling back to candidatesFor()'s all-available behavior as on
 * main.
 *
 * Run with:  node --test tests/discovery-backend-wildcard.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { Backend, createRouter } from "../src/proxy/router.mjs";

describe("Backend#supportsModel - discovery-backend empty-models guard", () => {
  test("ordinary backend with empty models still wildcard-matches (unchanged, main parity)", () => {
    const b = new Backend({ id: "custom", url: "http://x/v1", models: [] });
    assert.equal(b.supportsModel("anything-goes"), true);
  });

  test("discovery backend with empty models does NOT wildcard-match", () => {
    const b = new Backend({ id: "openrouter", url: "https://openrouter.ai/api/v1", models: [], discovery: "free" });
    assert.equal(b.supportsModel("some-unknown-model"), false);
  });

  test("discovery backend matches once discovery populates its models", () => {
    const b = new Backend({ id: "openrouter", url: "https://openrouter.ai/api/v1", models: [], discovery: "free" });
    b.models = ["meta-llama/llama-3.3-70b:free"];
    assert.equal(b.supportsModel("meta-llama/llama-3.3-70b:free"), true);
    assert.equal(b.supportsModel("some-other-model"), false);
  });

  test("no model in the request is still accepted regardless of discovery flag", () => {
    const b = new Backend({ id: "openrouter", url: "https://openrouter.ai/api/v1", models: [], discovery: "free" });
    assert.equal(b.supportsModel(undefined), true);
  });
});

describe("router.route() - unknown model id falls back to ALL available backends", () => {
  function buildRouter() {
    return createRouter({
      backends: {
        nvidia: {
          url: "https://integrate.api.nvidia.com/v1",
          auth_type: "none",
          models: ["moonshotai/kimi-k2.6"],
          priority: 2,
        },
        // Mirrors config.mjs's real openrouter default: discovery-driven, no
        // static models, no explicit priority (defaults to 99).
        openrouter: {
          url: "https://openrouter.ai/api/v1",
          auth_type: "none",
          discovery: "free",
        },
      },
      failover: true,
      siem_log: false,
    });
  }

  test("unknown model id before any discovery fetch: candidates include nvidia, not openrouter alone", async () => {
    const router = buildRouter();
    const results = await router.route({ model: "totally-unknown-model-xyz" });

    const ids = results.map((r) => r.backendId);
    // Must fall back to the full available set (both backends), exactly as
    // main's "no backend claims this model" behavior, NOT resolve solely to
    // openrouter just because its models list happens to be empty.
    assert.deepEqual(new Set(ids), new Set(["nvidia", "openrouter"]));
  });

  test("once openrouter has a registered discovered id, an unknown model still falls back to all", async () => {
    const router = buildRouter();
    // Simulate registerDiscoveredRoutes() populating openrouter's catalog
    // after a successful fetch.
    router.getBackend("openrouter").models = ["some-free-model:free"];

    const results = await router.route({ model: "totally-unknown-model-xyz" });
    const ids = results.map((r) => r.backendId);
    assert.deepEqual(new Set(ids), new Set(["nvidia", "openrouter"]));
  });

  test("a model openrouter has actually discovered routes to openrouter (not wildcard, real match)", async () => {
    const router = buildRouter();
    router.getBackend("openrouter").models = ["some-free-model:free"];

    const results = await router.route({ model: "some-free-model:free" });
    assert.equal(results[0].backendId, "openrouter");
    // nvidia does not serve this id, so it must not be offered as a candidate.
    assert.ok(!results.some((r) => r.backendId === "nvidia"));
  });
});
