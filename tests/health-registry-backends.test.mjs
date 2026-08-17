/**
 * health-registry-backends.test.mjs
 *
 * Registry-routed doors (`reg:<name>`) must appear in getHealth().
 *
 * `getRegBackend()` creates its Backend objects in the module-level
 * `_regBackends` map, not in the router's configured `backends`. `getHealth()`
 * only walked `backends`, so the path that serves most traffic recorded its
 * outcomes into objects nothing ever read.
 *
 * The consequence, live on 2026-08-16: a request through `sk-default` records
 * against `reg:ornith`, while `/health` reports on `local` / `ollama` /
 * `anthropic`. Those sets never intersect, so `local` and `ollama` stayed at
 * `lastCheck: 0` forever and a hard-down machine read as healthy. The outcomes
 * were recorded correctly the entire time. They were never reported.
 *
 * Run with:  node --test tests/health-registry-backends.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { createRouter, _getRegBackendForTests } = await import("../src/proxy/router.mjs");

function makeRouter() {
  return createRouter({
    backends: {
      configured: {
        url: "http://127.0.0.1:9/v1",
        auth_type: "none",
        models: ["configured-model"],
        priority: 1,
      },
    },
  });
}

describe("registry-routed backends appear in health", () => {
  test("a reg: door shows up in getHealth() once it exists", () => {
    const router = makeRouter();

    // Before any registry routing, only the configured backend is present.
    const before = router.getHealth();
    assert.ok(before.configured, "the configured backend must always be present");

    // Create a reg door the way the registry path does.
    const reg = _getRegBackendForTests("reg:probe", "http://127.0.0.1:9/v1");
    assert.ok(reg, "test seam must expose getRegBackend");

    const after = router.getHealth();
    assert.ok(
      after["reg:probe"],
      "a registry-routed door must be visible in health; this is the gap that hid a dead machine",
    );
    assert.ok(after.configured, "configured backends must still be reported");
  });

  test("a reg door's recorded outcome is actually readable", () => {
    const router = makeRouter();
    const reg = _getRegBackendForTests("reg:observed", "http://127.0.0.1:9/v1");

    // Unobserved: honest unknown, same contract as any other backend.
    assert.equal(router.getHealth()["reg:observed"].status, "unknown");
    assert.equal(router.getHealth()["reg:observed"].observed, false);

    reg.recordOutcome(true, 12);

    const h = router.getHealth()["reg:observed"];
    assert.equal(h.observed, true, "the outcome recorded on a reg door must be readable");
    assert.equal(h.status, "up");
    assert.ok(h.lastCheck > 0, "lastCheck must advance off 0");
    assert.equal(h.totalRequests, 1);
  });

  test("a failure on a reg door is visible too, not just a success", () => {
    const router = makeRouter();
    const reg = _getRegBackendForTests("reg:failing", "http://127.0.0.1:9/v1");

    reg.recordOutcome(false, 30);

    const h = router.getHealth()["reg:failing"];
    assert.equal(h.observed, true);
    assert.equal(h.totalErrors, 1, "an error on the registry path must reach the health surface");
    assert.ok(h.errorRate > 0, "errorRate must reflect the failure");
  });

  test("a configured backend is never shadowed by a same-named reg door", () => {
    const router = makeRouter();
    // Force the pathological case: a reg door claiming a configured id.
    const impostor = _getRegBackendForTests("configured", "http://127.0.0.1:9/v1");
    impostor.recordOutcome(false, 99);

    const h = router.getHealth().configured;
    assert.equal(
      h.observed,
      false,
      "the CONFIGURED backend's own health must win; a reg door must not overwrite it",
    );
  });
});
