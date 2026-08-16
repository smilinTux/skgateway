/**
 * health-never-probed.test.mjs
 *
 * A backend nobody has called must report `unknown`, never `up`.
 *
 * Backend health is derived from OBSERVED request outcomes, not from active
 * probing, so `BackendState` starts life at the optimistic `status: "up"` and
 * stays there until something actually fails. That made "never probed" and
 * "probed and healthy" produce an identical reading.
 *
 * The live incident this encodes (2026-08-16): the machine hosting `local`
 * (192.168.0.100:8082, ornith) and `ollama` (192.168.0.100:11434) was hard down
 * for over an hour. `/health` reported both as `status: "up", errorRate: 0,
 * lastCheck: 0`, while `sk-default` failed over to a cloud model and answered
 * perfectly. Sovereign work left the fleet and every dashboard stayed green.
 *
 * Selection behaviour is deliberately NOT changed here: an unobserved backend
 * stays selectable. Treating unknown as down would refuse every backend at
 * startup, which trades a silent lie for a loud outage.
 *
 * Run with:  node --test tests/health-never-probed.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { createRouter } = await import("../src/proxy/router.mjs");

/** Minimal always-200 upstream so one backend can actually be observed. */
function upstream() {
  const ref = { status: 200, hits: 0 };
  const server = http.createServer((req, res) => {
    ref.hits += 1;
    res.writeHead(ref.status, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", model: "probe-model", choices: [] }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        ref,
        base: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

describe("never-probed backends do not report as healthy", () => {
  let live;

  before(async () => {
    live = await upstream();
  });
  after(async () => {
    await live.close();
  });

  function makeRouter() {
    return createRouter({
      backends: {
        // A real, reachable upstream we can actually exercise.
        live: { url: live.base, auth_type: "none", models: ["probe-model"], priority: 1 },
        // Points at a port nothing listens on, and we never call it. This is
        // the shape `local` and `ollama` were in during the incident: configured,
        // never observed, and (unknown to the gateway) hosted on a dead machine.
        neverCalled: {
          url: "http://127.0.0.1:9/v1",
          auth_type: "none",
          models: ["never-called-model"],
          priority: 9,
        },
      },
    });
  }

  test("a backend with no observations reports status 'unknown', not 'up'", () => {
    const router = makeRouter();
    const h = router.getHealth();

    assert.equal(
      h.neverCalled.status,
      "unknown",
      "an unobserved backend must not claim to be up",
    );
    assert.equal(h.neverCalled.observed, false);
    assert.equal(h.neverCalled.lastCheck, 0, "lastCheck 0 is what proves it was never observed");
  });

  test("the incident is reproducible: two unobserved backends are not 'all green'", () => {
    const router = makeRouter();
    const h = router.getHealth();

    // The exact query a dashboard or an operator would run.
    const claimingHealthy = Object.entries(h)
      .filter(([, v]) => v.status === "up")
      .map(([k]) => k);

    assert.ok(
      !claimingHealthy.includes("neverCalled"),
      "a never-probed backend appearing in the healthy set is the bug that hid a dead machine",
    );
  });

  test("errorRate 0 on an unobserved backend is flagged as uninformative", () => {
    const router = makeRouter();
    const h = router.getHealth();

    // errorRate stays numerically 0 (consumers expect a number), but `observed`
    // must make it interpretable. 0 errors out of 0 requests is not good news.
    assert.equal(h.neverCalled.errorRate, 0);
    assert.equal(
      h.neverCalled.observed,
      false,
      "observed=false is what stops errorRate 0 reading as a clean bill of health",
    );
  });

  test("NEGATIVE CONTROL: once observed, a healthy backend reports 'up' again", async () => {
    const router = makeRouter();

    // Before: unknown, like every other backend at boot.
    assert.equal(router.getHealth().live.status, "unknown");

    // Record one successful outcome through whatever seam the router exposes,
    // so this test proves the field flips rather than being permanently stuck
    // at "unknown" (which would be a new lie in the other direction).
    const backend = router.getBackend ? router.getBackend("live") : null;
    assert.ok(backend, "router must expose its backends for this control to be meaningful");
    backend.recordOutcome(true, 5);

    const after = router.getHealth().live;
    assert.equal(after.observed, true, "a recorded outcome must count as an observation");
    assert.equal(after.status, "up", "an observed healthy backend must still report up");
    assert.ok(after.lastCheck > 0, "lastCheck must advance off 0 once observed");
  });

  test("unknown stays SELECTABLE: reporting changed, routing did not", () => {
    const router = makeRouter();
    const backend = router.getBackend ? router.getBackend("neverCalled") : null;
    assert.ok(backend, "router must expose its backends");

    // The whole point of fixing the report rather than the selector: if unknown
    // were treated as down, every backend would be refused at startup.
    assert.equal(
      backend.isAvailable(),
      true,
      "an unobserved backend must remain selectable; treating unknown as down would refuse everything at boot",
    );
  });
});
