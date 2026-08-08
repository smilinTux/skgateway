/**
 * router-eol-gate.test.mjs: known-eol concrete model ids are gated at
 * candidatesFor()'s fall-back-to-all-backends branch (card P1.6).
 *
 * When a request names a concrete model id that no backend explicitly
 * claims AND the lifecycle store (model_catalog_store.mjs) knows is
 * eol/dead, routeAndSend() answers with a clean 404 + eol_reason and no
 * backend is attempted at all, instead of today's fall-through, which
 * would spray the request across every available backend. An id the store
 * has never seen (or still active/suspect) keeps that fall-through
 * unchanged, and an id explicitly claimed by a backend routes normally
 * regardless of lifecycle state.
 *
 * Run with:  node --test tests/router-eol-gate.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same convention as tests/router-model-outcome.test.mjs: pin the skmodels
// registry (so this test's plain model-name routing is unaffected by
// whatever registry.yaml happens to exist on this host) and the lifecycle
// store to isolated temp paths BEFORE importing router.mjs, which captures
// both paths at module-eval time.
const FIX_DIR = mkdtempSync(join(tmpdir(), "skgw-eol-gate-"));
process.env.SKMODELS_REGISTRY = join(FIX_DIR, "nonexistent-registry.yaml");
const STORE_PATH = join(FIX_DIR, "lifecycle-store.json");
process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = STORE_PATH;

const { createRouter, routeAndSend, ModelEolError } = await import("../src/proxy/router.mjs");
const { recordModelOutcome, getLifecycle, _resetCacheForTests } = await import("../src/discovery/model_catalog_store.mjs");

function startUpstream(status = 200) {
  let requestCount = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requestCount++;
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(r)),
        get requestCount() {
          return requestCount;
        },
      });
    });
  });
}

const HEADERS = { "content-type": "application/json" };
const bodyFor = (model) => Buffer.from(JSON.stringify({ model, messages: [] }));

/**
 * Flip `modelId`'s lifecycle record to `eol` via 3 consecutive 410
 * completion outcomes (the eolErrorThreshold from lifecycle.mjs), the same
 * passive signal the router's own candidate loop records in production
 * (card P1.2). Seeded directly here so this suite can test the gate in
 * isolation from that recording path.
 */
function seedEol(modelId) {
  for (let i = 0; i < 3; i++) {
    recordModelOutcome(modelId, { status: 410, now: Date.now() });
  }
}

/**
 * Write a `dead` (tombstoned) lifecycle record directly into the store file.
 * model_catalog_store.mjs has no public "set" API (by design, production
 * only ever reaches `dead` via lifecycle.mjs's 30-day aging step, out of
 * scope for this card), so this reaches in at the file level to prove the
 * gate covers BOTH non-routable states, not just `eol`.
 */
function seedDead(modelId) {
  let store = {};
  try {
    store = JSON.parse(readFileSync(STORE_PATH, "utf8"));
  } catch {
    // no store on disk yet, start fresh.
  }
  store[modelId] = {
    state: "dead",
    last_verified_at: null,
    consecutive_permanent_errors: 3,
    absent_cycles: 3,
    eol_reason: "dropped_from_catalog",
    eol_at: Date.now() - 40 * 24 * 60 * 60 * 1000,
  };
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

describe("router gates known-eol/dead concrete model ids (card P1.6)", () => {
  let up;

  before(async () => {
    up = await startUpstream(200);
  });

  after(async () => {
    await up.close();
  });

  test("a known-eol id gets a clean 404 + eol_reason, no backend attempted", async () => {
    _resetCacheForTests();
    const modelId = `nvidia/dead-${Date.now()}`;
    seedEol(modelId);
    const lc = getLifecycle(modelId);
    assert.equal(lc.state, "eol");
    assert.equal(lc.eol_reason, "provider_410");

    const before_ = up.requestCount;
    const router = createRouter({
      backends: {
        // Does NOT declare modelId, so it falls into candidatesFor()'s
        // fall-back-to-all-backends branch: the branch under test.
        other: { url: up.base, auth_type: "none", models: ["some-other-model"], priority: 1 },
      },
    });

    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false
    );

    assert.equal(r.status, 404);
    assert.equal(r.backendId, null);
    assert.equal(up.requestCount, before_, "no backend attempt should have been made");
    const payload = JSON.parse(r.body.toString("utf-8"));
    assert.equal(payload.eol_reason, "provider_410");
    assert.equal(payload.error.code, 404);
  });

  test("a dead (tombstoned) id is gated the same way", async () => {
    _resetCacheForTests();
    const modelId = `nvidia/tombstoned-${Date.now()}`;
    seedDead(modelId);
    const lc = getLifecycle(modelId);
    assert.equal(lc.state, "dead");

    const before_ = up.requestCount;
    const router = createRouter({
      backends: {
        other: { url: up.base, auth_type: "none", models: ["some-other-model"], priority: 1 },
      },
    });

    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false
    );

    assert.equal(r.status, 404);
    assert.equal(up.requestCount, before_, "no backend attempt should have been made");
    const payload = JSON.parse(r.body.toString("utf-8"));
    assert.equal(payload.eol_reason, "dropped_from_catalog");
  });

  test("router.route() rejects a known-eol id with ModelEolError (status 404)", async () => {
    _resetCacheForTests();
    const modelId = `nvidia/dead2-${Date.now()}`;
    seedEol(modelId);

    const router = createRouter({
      backends: {
        other: { url: up.base, auth_type: "none", models: ["some-other-model"], priority: 1 },
      },
    });

    await assert.rejects(
      () => router.route({ model: modelId, agentId: "test" }),
      (err) => {
        assert.ok(err instanceof ModelEolError);
        assert.equal(err.status, 404);
        assert.equal(err.eolReason, "provider_410");
        assert.equal(err.model, modelId);
        return true;
      }
    );
  });

  test("an unknown id keeps the fall-through unchanged (backend still attempted)", async () => {
    _resetCacheForTests();
    const modelId = `nvidia/never-seen-${Date.now()}`;
    const lc = getLifecycle(modelId);
    assert.equal(lc.state, "active", "an id the store has never recorded defaults to active");

    const before_ = up.requestCount;
    const router = createRouter({
      backends: {
        other: { url: up.base, auth_type: "none", models: ["some-other-model"], priority: 1 },
      },
    });

    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false
    );

    assert.equal(r.status, 200, "unknown id falls through to the only available backend, which serves it");
    assert.equal(up.requestCount, before_ + 1, "the backend WAS attempted (fall-through unchanged)");
  });

  test("an active id explicitly claimed by a backend is unaffected", async () => {
    _resetCacheForTests();
    const modelId = `nvidia/thriving-${Date.now()}`;

    const before_ = up.requestCount;
    const router = createRouter({
      backends: {
        home: { url: up.base, auth_type: "none", models: [modelId], priority: 1 },
      },
    });

    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false
    );

    assert.equal(r.status, 200);
    assert.equal(up.requestCount, before_ + 1, "an explicitly-claimed model is routed normally, gate never consulted");
  });
});
