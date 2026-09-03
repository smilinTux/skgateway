/**
 * Provider purity routing tests (card f361407c, incident 2026-09-03).
 *
 * A model id that some backend DECLARES must never spray to unrelated
 * backends when every declaring backend is unavailable (error cooldown,
 * quarantine, or agent restriction). Observed live twice on 2026-09-03:
 * during a z.ai cooldown, glm-4.6/glm-4.7 fell through to primary=codex
 * and answered "model not supported"; and a fresh kimi backend's first
 * empty-content failure marked it DOWN, so k3 requests sprayed to codex.
 * The router must fail closed with 503 model_owner_backend_down instead.
 *
 * Undeclared ids keep the historic fall-through to all available backends.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../src/proxy/router.mjs";

function buildBackends() {
  return {
    zai: {
      id: "zai",
      url: "http://127.0.0.1:9/v1",
      auth_type: "none",
      models: ["glm-4.6", "glm-4.7", "glm-5.3"],
      priority: 2,
    },
    codex: {
      id: "codex",
      url: "http://127.0.0.1:9/v1",
      auth_type: "none",
      models: ["gpt-5.6-sol"],
      priority: 2,
    },
  };
}

async function assertRejectsOwnerDown(promise, model, declaredBy) {
  await promise.then(
    () => assert.fail("expected route() to reject"),
    (err) => {
      assert.equal(err.name, "ModelOwnerDownError");
      assert.equal(err.model, model);
      assert.deepEqual(err.declaredBy, declaredBy);
      assert.equal(err.status, 503);
    },
  );
}

test("declared model with owner backend DOWN fails closed, never sprays", async () => {
  const router = createRouter({ backends: buildBackends() });
  const zai = router.getBackend("zai");

  // Healthy owner routes normally.
  const healthy = await router.route({ model: "glm-4.6" });
  assert.deepEqual(healthy.map((c) => c.backendId), ["zai"]);

  // Force the owner into the DOWN error-cooldown state exactly as the
  // live error-rate machinery does.
  zai._status = "down";
  zai._downSince = Date.now();

  await assertRejectsOwnerDown(router.route({ model: "glm-4.6" }), "glm-4.6", ["zai"]);
  await assertRejectsOwnerDown(router.route({ model: "glm-4.7" }), "glm-4.7", ["zai"]);
  // The unrelated backend keeps serving its own declared model.
  const codex = await router.route({ model: "gpt-5.6-sol" });
  assert.deepEqual(codex.map((c) => c.backendId), ["codex"]);
});

test("ownerDownResponse shape: 503, retryable, names the declaring backends", async () => {
  const router = createRouter({ backends: buildBackends() });
  const zai = router.getBackend("zai");
  zai._status = "down";
  zai._downSince = Date.now();

  await assert.rejects(router.route({ model: "glm-5.3" }), { name: "ModelOwnerDownError" });
});

test("undeclared model ids keep the historic fall-through to all backends", async () => {
  const router = createRouter({ backends: buildBackends() });
  const candidates = await router.route({ model: "totally-unknown-model" });
  const ids = candidates.map((c) => c.backendId).sort();
  assert.deepEqual(ids, ["codex", "zai"]);
});

test("agent-restricted owner also fails closed instead of spraying", async () => {
  const router = createRouter({
    backends: {
      ...buildBackends(),
      zai: { ...buildBackends().zai, allowed_agents: ["worker-a"] },
    },
  });
  await assertRejectsOwnerDown(
    router.route({ model: "glm-4.6", agentId: "worker-b" }),
    "glm-4.6",
    ["zai"],
  );
});
