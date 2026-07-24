/**
 * quarantine.test.mjs - dead-alias auto-quarantine hook (card 2d1f3a2c).
 *
 * The router already has an error-rate health machine (up/degraded/down over a
 * 100-request window) plus SPOF failover. Those react slowly for a freshly-dead
 * alias whose prior successes dilute the window, and a backend can sit in
 * "degraded" (still selectable) while failing every call. The quarantine hook
 * adds a faster CONSECUTIVE-failure trip: after N failures in a row an alias is
 * pulled OUT of rotation for a cooldown, then a single probe is admitted; a
 * success re-admits it. Quarantine + re-admit emit a SIEM/log event.
 *
 * Coverage:
 *   1. Backend quarantined after N consecutive failures (out of rotation).
 *   2. Consecutive counter resets on an interleaved success (no false trip).
 *   3. Healthy path is unchanged - successes never quarantine.
 *   4. Re-admitted after the cooldown probe succeeds.
 *   5. routeAndSend skips a quarantined alias in backend selection.
 *   6. routeAndSend emits a SIEM anomaly event on quarantine.
 *   7. threshold <= 0 disables the layer.
 *
 * Run with:  node --test tests/quarantine.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { Backend, createRouter, routeAndSend } from "../src/proxy/router.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── fake upstream helper ────────────────────────────────────────────────────

/**
 * Start a throwaway upstream whose status is controlled by a mutable ref.
 * Returns { base, close, count } - count is the number of requests received.
 */
function startUpstream(statusRef) {
  return new Promise((resolve) => {
    const state = { count: 0 };
    const server = http.createServer((req, res) => {
      state.count++;
      const status = typeof statusRef === "function" ? statusRef() : statusRef;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: status < 400, id: req.url }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(r)),
        state,
      });
    });
  });
}

const BODY = Buffer.from(JSON.stringify({ model: "mock-model", messages: [] }));
const HEADERS = { "content-type": "application/json" };

// ── 1-4, 7: Backend-level unit tests (no network) ───────────────────────────

describe("Backend quarantine (consecutive-failure trip)", () => {
  test("quarantines after N consecutive failures and leaves rotation", () => {
    const b = new Backend({ id: "dead", url: "http://x/v1", quarantine_threshold: 3, quarantine_cooldown_ms: 10_000 });
    assert.equal(b.isAvailable(), true);

    assert.equal(b.recordOutcome(false, 1), null); // 1
    assert.equal(b.recordOutcome(false, 1), null); // 2
    assert.equal(b.getHealth().quarantined, false, "not yet at threshold");

    const t = b.recordOutcome(false, 1);           // 3 → trip
    assert.ok(t && t.transition === "quarantined", "3rd consecutive failure trips quarantine");
    assert.equal(t.consecutiveFailures, 3);
    assert.equal(t.threshold, 3);

    assert.equal(b.getHealth().quarantined, true);
    assert.equal(b.isAvailable(), false, "quarantined alias is skipped while in cooldown");
  });

  test("interleaved success resets the consecutive counter (no false trip)", () => {
    const b = new Backend({ id: "flappy", url: "http://x/v1", quarantine_threshold: 5, quarantine_cooldown_ms: 10_000 });
    for (let i = 0; i < 4; i++) b.recordOutcome(false, 1);
    assert.equal(b.getHealth().consecutiveFailures, 4);
    assert.equal(b.recordOutcome(true, 1), null);              // reset
    assert.equal(b.getHealth().consecutiveFailures, 0);
    for (let i = 0; i < 4; i++) assert.equal(b.recordOutcome(false, 1), null); // 4 < 5
    assert.equal(b.getHealth().quarantined, false, "never reached 5 in a row");
  });

  test("healthy path is unchanged - successes never quarantine", () => {
    const b = new Backend({ id: "healthy", url: "http://x/v1", quarantine_threshold: 3 });
    for (let i = 0; i < 50; i++) assert.equal(b.recordOutcome(true, 5), null);
    const h = b.getHealth();
    assert.equal(h.quarantined, false);
    assert.equal(h.consecutiveFailures, 0);
    assert.equal(b.isAvailable(), true);
    assert.equal(h.status, "up");
  });

  test("re-admitted after the cooldown probe succeeds", async () => {
    const b = new Backend({ id: "recover", url: "http://x/v1", quarantine_threshold: 2, quarantine_cooldown_ms: 40 });
    b.recordOutcome(false, 1);
    assert.ok(b.recordOutcome(false, 1)?.transition === "quarantined");
    assert.equal(b.isAvailable(), false, "still in cooldown");

    await sleep(60);
    assert.equal(b.isAvailable(), true, "cooldown elapsed - probe admitted");

    const t = b.recordOutcome(true, 5);
    assert.ok(t && t.transition === "readmitted", "probe success re-admits");
    assert.equal(b.getHealth().quarantined, false);
    assert.equal(b.isAvailable(), true);
  });

  test("a failed probe stays quarantined and re-arms the cooldown", async () => {
    const b = new Backend({ id: "stilldead", url: "http://x/v1", quarantine_threshold: 1, quarantine_cooldown_ms: 30 });
    assert.ok(b.recordOutcome(false, 1)?.transition === "quarantined");
    await sleep(45);
    assert.equal(b.isAvailable(), true, "probe admitted");
    assert.equal(b.recordOutcome(false, 1), null, "probe failed - no new transition");
    assert.equal(b.getHealth().quarantined, true);
    assert.equal(b.isAvailable(), false, "cooldown re-armed after failed probe");
  });

  test("threshold <= 0 disables quarantine", () => {
    const b = new Backend({ id: "nolimit", url: "http://x/v1", quarantine_threshold: 0 });
    for (let i = 0; i < 100; i++) assert.equal(b.recordOutcome(false, 1), null);
    assert.equal(b.getHealth().quarantined, false);
  });
});

// ── 5-6: routeAndSend integration (real local upstreams) ────────────────────

describe("routeAndSend quarantine integration", () => {
  let primary, secondary;
  let primaryStatus = 200; // mutable - start healthy, later go dead

  before(async () => {
    primary = await startUpstream(() => primaryStatus);
    secondary = await startUpstream(() => 200); // healthy fallback
  });

  after(async () => {
    await primary.close();
    await secondary.close();
  });

  test("skips a quarantined alias in selection and emits a SIEM anomaly", async () => {
    const events = [];
    const siem = (e) => events.push(e);

    const router = createRouter({
      backends: {
        primary:   { url: primary.base,   auth_type: "none", models: ["mock-model"], priority: 1 },
        secondary: { url: secondary.base, auth_type: "none", models: ["mock-model"], priority: 2 },
      },
      quarantine: { threshold: 3, cooldown_ms: 10_000 },
      failover: true,
    });

    const req = { model: "mock-model" };

    // Warm-up: 10 healthy requests keep primary's error-rate window well under the
    // DOWN threshold, so the pre-existing rate machine leaves it selectable. This
    // isolates the CONSECUTIVE-failure quarantine trip from the rate machine
    // (which would otherwise mark a 100%-dead alias down after one failure).
    for (let i = 0; i < 10; i++) {
      const r = await routeAndSend(router, req, "/v1/chat/completions", "POST", HEADERS, BODY, false, siem);
      assert.equal(r.status, 200);
      assert.equal(r.backendId, "primary");
    }
    assert.equal(primary.state.count, 10);

    // Kill primary. It is still selectable (diluted window → "degraded"), so each
    // request tries primary (500) then fails over to secondary (200).
    primaryStatus = 500;
    for (let i = 0; i < 3; i++) {
      const r = await routeAndSend(router, req, "/v1/chat/completions", "POST", HEADERS, BODY, false, siem);
      assert.equal(r.status, 200);
      assert.equal(r.backendId, "secondary", "failed over to healthy fallback");
    }

    const primaryHits = primary.state.count; // 10 warm-up + 3 failed attempts
    assert.equal(primaryHits, 13, "primary attempted on each of the 3 failing requests");
    assert.equal(router.getHealth().primary.quarantined, true, "quarantined after 3 consecutive 500s");

    // A quarantine SIEM anomaly event was emitted through the shared emitter.
    const q = events.find((e) => e.event_type === "anomaly" && e.details?.type === "backend_quarantine");
    assert.ok(q, "quarantine emits a SIEM anomaly event");
    assert.equal(q.backend, "primary");
    assert.equal(q.details.threshold, 3);
    assert.equal(q.details.consecutive_failures, 3);

    // Next request: primary is out of rotation - it must NOT be hit again, and the
    // response comes straight from secondary with no failover.
    const r4 = await routeAndSend(router, req, "/v1/chat/completions", "POST", HEADERS, BODY, false, siem);
    assert.equal(r4.status, 200);
    assert.equal(r4.backendId, "secondary");
    assert.equal(r4.failover, false, "no failover - quarantined primary was skipped in selection");
    assert.equal(primary.state.count, primaryHits, "quarantined primary received no further requests");
  });
});
