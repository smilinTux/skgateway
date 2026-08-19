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
 * as long as the lifecycle store still calls it routable.
 *
 * The gate is also consulted in the matched branch (an id a Backend.models
 * snapshot explicitly claims), card C4: that snapshot is only refreshed
 * once an hour, so a model that flips to eol mid-hour would otherwise keep
 * routing until the next refresh. See "flips eol mid-hour" below.
 *
 * 2026-08-18 refinement (incident inc-2026-08-18-qwen38-eol / problem
 * prob-2026-08-18-model-discovery-validation): a claim is only preempted by
 * a verdict ATTRIBUTED TO THE CLAIMING SIDE (isEffectivelyRoutable,
 * lifecycle.mjs). The C4 live case was a verdict tagged with the claiming
 * provider (nvidia 410'd the id, nvidia is the only claimer, and the record
 * carries the nvidia provider tag from reconcilePresence) — that still
 * gates. An UNATTRIBUTED verdict (provider tag null — the 404s that
 * accumulated for qwen38-abliterated came from non-claiming backends in a
 * fail-over spray) or a verdict against a DIFFERENT provider does not
 * overrule a local claim, so the healthy local door keeps routing. Those
 * two scenarios are the last three tests in this suite.
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
    assert.equal(up.requestCount, before_ + 1, "an explicitly-claimed active model routes normally");
  });

  test("a model listed in Backend.models that flips eol mid-hour is still gated when the verdict implicates the claimer (card C4)", async () => {
    _resetCacheForTests();
    const modelId = `nvidia/stale-snapshot-${Date.now()}`;

    // Backend.models is a startup snapshot (registerDiscoveredRoutes() in
    // src/index.mjs) that only refreshes once per discovery.refresh_seconds
    // or on a manual POST /admin/models/refresh. Declare the model here to
    // simulate a snapshot taken BEFORE the model went eol: this is the
    // matched branch of candidatesFor() (supportsModel() finds it), not the
    // fallback branch the other tests in this suite exercise.
    const router = createRouter({
      backends: {
        home: { url: up.base, auth_type: "none", models: [modelId], priority: 1 },
      },
    });

    // Now the lifecycle store flips to eol mid-hour, independent of the
    // stale Backend.models snapshot, exactly like the live reproduction in
    // card C4 (openai/gpt-oss-20b: state eol in the store, still listed in
    // Backend.models, and a chat completion returned 200).
    seedEol(modelId);
    // 2026-08-18 (incident inc-2026-08-18-qwen38-eol): C4's live record was
    // ATTRIBUTED to the claiming provider — reconcilePresence tags a model
    // declared under backends.nvidia with provider 'nvidia' (see
    // sliceByProvider/reconcilePresence in src/discovery.mjs), and the C4
    // claimer IS the nvidia backend. Attribute the fixture the same way so
    // the test pins the production shape: a verdict that implicates the
    // claimer still gates. (An unattributed verdict no longer preempts a
    // claim — see the next tests.)
    let store = {};
    try {
      store = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    } catch { /* no store yet */ }
    store[modelId] = { ...store[modelId], provider: "home" };
    writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
    _resetCacheForTests();
    const lc = getLifecycle(modelId);
    assert.equal(lc.state, "eol");
    assert.equal(lc.provider, "home");

    const before_ = up.requestCount;
    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false
    );

    assert.equal(r.status, 404, "a claimer-attributed eol verdict must still gate the matched branch (card C4)");
    assert.equal(
      up.requestCount, before_,
      "no backend attempt should have been made even though Backend.models still claims the model"
    );
    const payload = JSON.parse(r.body.toString("utf-8"));
    assert.equal(payload.eol_reason, "provider_410");
    assert.equal(payload.error.code, 404);
  });

  test("an unattributed eol verdict does NOT preempt a healthy claimer (incident: qwen38-abliterated)", async () => {
    _resetCacheForTests();
    const modelId = `local/qwen38-abliterated-${Date.now()}`;

    // The incident shape: a custom alias declared under a local backend
    // (chiap08-qwen38), an eol record with provider tag NULL — the
    // 404/410s that condemned it came from non-claiming backends in a
    // fail-over spray, not from the local door that actually serves it.
    seedEol(modelId);
    const lc = getLifecycle(modelId);
    assert.equal(lc.state, "eol");
    assert.equal(lc.provider, undefined, "the fixture must be unattributed (completion-path records carry no provider tag at all)");

    const router = createRouter({
      backends: {
        // The healthy local claimer (chiap08-qwen38 in production): the
        // name-agnostic llama.cpp door that serves the alias fine.
        local: { url: up.base, auth_type: "none", models: [modelId], priority: 3 },
        // A non-claiming door that 404'd the alias in the spray that formed
        // the false positive.
        nvidia: { url: up.base, auth_type: "none", models: ["some-nvidia-model"], priority: 1 },
      },
    });

    const before_ = up.requestCount;
    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false
    );

    assert.equal(r.status, 200, "the healthy claimer must keep routing despite the unattributed eol verdict");
    assert.equal(r.backendId, "local", "the request must land on the claiming backend");
    assert.equal(up.requestCount, before_ + 1, "the claiming backend WAS attempted");
  });

  test("a verdict against a FOREIGN provider does NOT preempt a local claim (multi-provider)", async () => {
    _resetCacheForTests();
    const modelId = `multi/both-${Date.now()}`;

    // The model is declared under both a remote provider and a local
    // backend. The remote provider retired it (record tagged with the
    // remote provider, as reconcilePresence would), but the local claimer
    // still serves it: only EOL if ALL providers fail, so a single
    // provider's verdict must not gate the id out of existence.
    seedEol(modelId);
    let store = {};
    try {
      store = JSON.parse(readFileSync(STORE_PATH, "utf8"));
    } catch { /* no store yet */ }
    store[modelId] = { ...store[modelId], provider: "remote" };
    writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
    _resetCacheForTests();

    const router = createRouter({
      backends: {
        remote: { url: up.base, auth_type: "none", models: [modelId], priority: 1 },
        local: { url: up.base, auth_type: "none", models: [modelId], priority: 3 },
      },
    });

    const before_ = up.requestCount;
    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false
    );

    // Before the fix this request died at the gate: a clean 404 + eol_reason
    // with ZERO backend attempts. With a surviving claimer outside the
    // verdict's provider the id must route (the primary claimer here is
    // healthy in this fixture and answers 200; in production the same
    // request either lands on the healthy door or fails over to the local
    // claimer instead of being preempted).
    assert.equal(r.status, 200, "a claimer outside the verdict's provider must keep the id routable");
    assert.equal(up.requestCount, before_ + 1, "a backend WAS attempted — the gate did not preempt the claim");
  });
});
