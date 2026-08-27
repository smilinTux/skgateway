/**
 * router-model-outcome.test.mjs: the router's candidate loop records model
 * lifecycle outcomes (card P1.2).
 *
 * Drives routeAndSend() against a fake upstream returning a controlled
 * status and asserts the concrete model's lifecycle record in
 * model_catalog_store.mjs was updated accordingly, WITHOUT changing the
 * existing `success = res.status < 500` failover decision (a 410 is still
 * routed/returned exactly as before; the response body/status here are
 * incidental to this suite, only the store side effect is under test).
 *
 * Run with:  node --test tests/router-model-outcome.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin BOTH the skmodels registry (so this test's plain model-name routing is
// unaffected by whatever registry.yaml happens to exist on this host) and the
// lifecycle store to isolated temp paths BEFORE importing router.mjs, which
// captures both paths at module-eval time (registry.mjs re-parses on mtime
// change; model_catalog_store.mjs's STORE_PATH is captured once at import,
// same convention as tests/per-agent-routing.test.mjs / local-failover.test.mjs).
const FIX_DIR = mkdtempSync(join(tmpdir(), "skgw-model-outcome-"));
process.env.SKMODELS_REGISTRY = join(FIX_DIR, "nonexistent-registry.yaml");
process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = join(FIX_DIR, "lifecycle-store.json");

const { createRouter, routeAndSend } = await import("../src/proxy/router.mjs");
const { getLifecycle, _resetCacheForTests } = await import("../src/discovery/model_catalog_store.mjs");

function startUpstream(statusRef) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const status = typeof statusRef === "function" ? statusRef() : statusRef;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: status < 400 }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const HEADERS = { "content-type": "application/json" };
const bodyFor = (model) => Buffer.from(JSON.stringify({ model, messages: [] }));

describe("routeAndSend records model lifecycle outcomes", () => {
  let up410;
  let up200;
  let up404;
  let up502;

  before(async () => {
    up410 = await startUpstream(410);
    up200 = await startUpstream(200);
    up404 = await startUpstream(404);
    up502 = await startUpstream(502);
  });

  after(async () => {
    await up410.close();
    await up200.close();
    await up404.close();
    await up502.close();
  });

  test("a 410 completion increments consecutive_permanent_errors for that model", async () => {
    _resetCacheForTests();
    const modelId = `nvidia/gone-${Date.now()}`;
    const router = createRouter({
      backends: {
        gone: { url: up410.base, auth_type: "none", models: [modelId], priority: 1 },
      },
    });

    const r = await routeAndSend(router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false);

    assert.equal(r.status, 410);
    const lc = getLifecycle(modelId);
    assert.equal(lc.consecutive_permanent_errors, 1);
    assert.equal(lc.state, "active"); // below the eolErrorThreshold (3) after one 410
  });

  test("3 consecutive 410 completions flip the model to eol", async () => {
    _resetCacheForTests();
    const modelId = `nvidia/dying-${Date.now()}`;
    const router = createRouter({
      backends: {
        dying: { url: up410.base, auth_type: "none", models: [modelId], priority: 1 },
      },
    });

    for (let i = 0; i < 3; i++) {
      const r = await routeAndSend(router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false);
      // The existing failover decision is untouched: a solo 410 candidate
      // still surfaces as a 410 response (no retryable candidate here), not
      // silently swallowed by the new lifecycle bookkeeping.
      assert.equal(r.status, 410);
    }
    const lc = getLifecycle(modelId);
    assert.equal(lc.state, "eol");
    assert.equal(lc.eol_reason, "provider_410");
    assert.equal(lc.consecutive_permanent_errors, 3);
  });

  test("a 200 completion resets the model to active with last_verified_at set", async () => {
    _resetCacheForTests();
    const modelId = `nvidia/alive-${Date.now()}`;
    const router = createRouter({
      backends: {
        alive: { url: up200.base, auth_type: "none", models: [modelId], priority: 1 },
      },
    });

    const before_ = Date.now();
    const r = await routeAndSend(router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false);
    assert.equal(r.status, 200);

    const lc = getLifecycle(modelId);
    assert.equal(lc.state, "active");
    assert.equal(lc.consecutive_permanent_errors, 0);
    assert.ok(lc.last_verified_at >= before_, "last_verified_at should be set to (approximately) now");
  });

  for (const [label, failingUrl] of [
    ["404", () => up404.base],
    ["502", () => up502.base],
    ["connection-refused", () => "http://127.0.0.1:1/v1"],
  ]) {
    test(`repeated ${label} quarantines only the exact backend-model claim`, async () => {
      _resetCacheForTests();
      const modelId = `shared/${label}-${Date.now()}`;
      const router = createRouter({
        backends: {
          dead: { url: failingUrl(), auth_type: "none", models: [modelId], priority: 1 },
          live: { url: up200.base, auth_type: "none", models: [modelId], priority: 2 },
        },
      });

      for (let i = 0; i < 3; i++) {
        const r = await routeAndSend(router, { model: modelId }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false);
        assert.equal(r.status, 200);
        assert.equal(r.backendId, "live");
      }

      assert.deepEqual(router.getHealth().dead.quarantinedModels, [modelId]);
      assert.deepEqual(router.getHealth().live.quarantinedModels, []);
      assert.equal(getLifecycle(modelId).state, "active", "another valid claimer prevents global EOL");
      assert.equal((await router.route({ model: modelId }))[0].backendId, "live");
    });
  }

  test("absent listener is classified by immediate 502, not a completion timeout", async () => {
    const modelId = `absent-listener-${Date.now()}`;
    const router = createRouter({
      backends: { absent: { url: "http://127.0.0.1:1/v1", auth_type: "none", models: [modelId], priority: 1, timeout_ms: 60_000 } },
    });
    const started = Date.now();
    const r = await routeAndSend(router, { model: modelId }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false);
    assert.equal(r.status, 502);
    assert.ok(Date.now() - started < 2_000, "connection refusal must not wait for the 60 second hang guard");
  });

  test("a slow completion timeout does not quarantine a backend-model claim", () => {
    const modelId = `slow-${Date.now()}`;
    const router = createRouter({ backends: { slow: { url: up200.base, auth_type: "none", models: [modelId] } } });
    const backend = router.getBackend("slow");
    for (let i = 0; i < 3; i++) assert.equal(backend.recordModelStatus(modelId, 504), null);
    assert.deepEqual(backend.getHealth().quarantinedModels, []);
  });

  // Store-level fail-soft behavior (a write that throws is swallowed, never
  // propagates) is covered directly in tests/model-catalog-store.test.mjs.
  // Every test in this suite is implicitly proof that routeAndSend's response
  // is unaffected by the new recordModelOutcome() call on the SUCCESS path
  // (a writable temp store): each assertion above only runs after `r.status`
  // already came back as expected.
});
