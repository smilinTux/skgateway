/**
 * advertise-reconcile.test.mjs - advertised-vs-working reconciliation.
 *
 * SKGateway card 5c680ee9. Drives the pure catalog reconciliation used by
 * GET /v1/models: a model whose only serving backend(s) are down or quarantined
 * is flagged (default) or hidden per config, a healthy model is advertised
 * normally, recovery re-advertises, and the default mode is non-breaking.
 *
 * Uses a duck-typed fake router (getHealth / getBackend, with backends exposing
 * supportsModel / isAvailable) so the test does not pull in the js-yaml config
 * loader. This is exactly the surface index.mjs hands buildModelCatalog().
 *
 * Run with:  node --test tests/advertise-reconcile.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildModelCatalog,
  isModelAvailable,
  normalizeReconcileMode,
  reconcileModeFromConfig,
  DEFAULT_RECONCILE_MODE,
} from "../src/proxy/advertise.mjs";

// ── Fake backend matching the router's Backend public surface ──
function fakeBackend({ models = [], available = true }) {
  return {
    models,
    supportsModel(model) {
      if (!model || models.length === 0) return true;
      return models.includes(model);
    },
    isAvailable() {
      return available;
    },
  };
}

// ── Fake router (getHealth ids + getBackend) ──
function fakeRouter(backendMap) {
  return {
    getHealth() {
      const out = {};
      for (const id of Object.keys(backendMap)) out[id] = { status: "up" };
      return out;
    },
    getBackend(id) {
      return backendMap[id] || null;
    },
  };
}

// Committed config.backends: healthy `local` model + all-down `nvidia` models.
const BACKENDS = {
  local: { models: ["ornith-1.0-9b"] },
  nvidia: { models: ["nvidia/llama-3.1-70b"] },
};

function router({ localUp, nvidiaUp }) {
  return fakeRouter({
    local: fakeBackend({ models: ["ornith-1.0-9b"], available: localUp }),
    nvidia: fakeBackend({ models: ["nvidia/llama-3.1-70b"], available: nvidiaUp }),
  });
}

describe("mode normalization + config resolution", () => {
  test("unknown / missing value falls back to safe default (flag)", () => {
    assert.equal(DEFAULT_RECONCILE_MODE, "flag");
    assert.equal(normalizeReconcileMode(undefined), "flag");
    assert.equal(normalizeReconcileMode("bogus"), "flag");
    assert.equal(normalizeReconcileMode(42), "flag");
  });
  test("valid modes are accepted case-insensitively", () => {
    assert.equal(normalizeReconcileMode("HIDE"), "hide");
    assert.equal(normalizeReconcileMode(" Off "), "off");
    assert.equal(normalizeReconcileMode("flag"), "flag");
  });
  test("config resolves nested advertise.reconcile and flat alias", () => {
    assert.equal(reconcileModeFromConfig({ advertise: { reconcile: "hide" } }), "hide");
    assert.equal(reconcileModeFromConfig({ reconcile_advertised: "off" }), "off");
    assert.equal(reconcileModeFromConfig({}), "flag");
  });
});

describe("isModelAvailable composes with quarantine/health", () => {
  test("available when at least one serving backend is up", () => {
    assert.equal(isModelAvailable("ornith-1.0-9b", router({ localUp: true, nvidiaUp: false })), true);
  });
  test("unavailable when every serving backend is down/quarantined", () => {
    assert.equal(isModelAvailable("nvidia/llama-3.1-70b", router({ localUp: true, nvidiaUp: false })), false);
  });
  test("fails OPEN when no router signal is present", () => {
    assert.equal(isModelAvailable("anything", null), true);
  });
  test("fails OPEN when no router backend claims the model", () => {
    assert.equal(isModelAvailable("ghost-model", router({ localUp: true, nvidiaUp: true })), true);
  });
});

describe("flag mode (default, non-breaking)", () => {
  test("healthy model advertised as available, dead model flagged unavailable", () => {
    const data = buildModelCatalog(BACKENDS, router({ localUp: true, nvidiaUp: false }), "flag");
    const local = data.find((m) => m.id === "ornith-1.0-9b");
    const nvidia = data.find((m) => m.id === "nvidia/llama-3.1-70b");
    // Non-breaking: BOTH models still present in the catalog.
    assert.equal(data.length, 2);
    assert.equal(local.status, "available");
    assert.equal(nvidia.status, "unavailable");
  });

  test("default (no mode arg) equals flag and never drops a model", () => {
    const data = buildModelCatalog(BACKENDS, router({ localUp: true, nvidiaUp: false }));
    assert.equal(data.length, 2, "default mode must not hide any model");
    assert.ok(data.every((m) => typeof m.status === "string"));
  });
});

describe("hide mode omits dead models", () => {
  test("dead model omitted, healthy model kept without status noise", () => {
    const data = buildModelCatalog(BACKENDS, router({ localUp: true, nvidiaUp: false }), "hide");
    assert.equal(data.length, 1);
    assert.equal(data[0].id, "ornith-1.0-9b");
    assert.equal(data[0].status, undefined);
    assert.equal(data.find((m) => m.id === "nvidia/llama-3.1-70b"), undefined);
  });
});

describe("off mode preserves legacy behavior", () => {
  test("advertises everything with no status field, health ignored", () => {
    const data = buildModelCatalog(BACKENDS, router({ localUp: false, nvidiaUp: false }), "off");
    assert.equal(data.length, 2);
    assert.ok(data.every((m) => m.status === undefined));
  });

  test("shape matches the pre-reconcile catalog entries", () => {
    const data = buildModelCatalog(BACKENDS, router({ localUp: true, nvidiaUp: true }), "off");
    assert.deepEqual(data[0], {
      id: "ornith-1.0-9b",
      object: "model",
      created: 0,
      owned_by: "local",
    });
  });
});

describe("recovery re-admits a model", () => {
  test("flag: unavailable -> available when the backend comes back", () => {
    const down = buildModelCatalog(BACKENDS, router({ localUp: true, nvidiaUp: false }), "flag");
    assert.equal(down.find((m) => m.id === "nvidia/llama-3.1-70b").status, "unavailable");

    const up = buildModelCatalog(BACKENDS, router({ localUp: true, nvidiaUp: true }), "flag");
    assert.equal(up.find((m) => m.id === "nvidia/llama-3.1-70b").status, "available");
  });

  test("hide: model reappears in the catalog after recovery", () => {
    const down = buildModelCatalog(BACKENDS, router({ localUp: true, nvidiaUp: false }), "hide");
    assert.equal(down.find((m) => m.id === "nvidia/llama-3.1-70b"), undefined);

    const up = buildModelCatalog(BACKENDS, router({ localUp: true, nvidiaUp: true }), "hide");
    assert.ok(up.find((m) => m.id === "nvidia/llama-3.1-70b"));
    assert.equal(up.length, 2);
  });
});

describe("catalog construction parity", () => {
  test("dedupes model ids and skips wildcard patterns", () => {
    const backends = {
      a: { models: ["m1", "wild/*", "dup"] },
      b: { models: ["dup", "m2"] },
    };
    const r = fakeRouter({
      a: fakeBackend({ models: ["m1", "wild/*", "dup"], available: true }),
      b: fakeBackend({ models: ["dup", "m2"], available: true }),
    });
    const ids = buildModelCatalog(backends, r, "flag").map((m) => m.id);
    assert.deepEqual(ids, ["m1", "dup", "m2"]);
  });

  test("no router still yields a full, all-available-flagged catalog", () => {
    const data = buildModelCatalog(BACKENDS, null, "flag");
    assert.equal(data.length, 2);
    assert.ok(data.every((m) => m.status === "available"));
  });
});
