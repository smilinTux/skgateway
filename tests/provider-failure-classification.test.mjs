import test from "node:test";
import assert from "node:assert/strict";

import {
  effectiveInferenceEligibility,
  independentAttemptCandidates,
  normalizeFailure,
  selectTerminalFailure,
} from "../src/health/failure.mjs";
import { capacityProjectionFromHealth } from "../src/discovery/capacity_store.mjs";
import { terminalSseFailure } from "../src/proxy/response-contract.mjs";

test("attempt selection permits three independent capacity domains", () => {
  const selected = independentAttemptCandidates([
    { backendId: "a1", backend: { capacity_domain: "a" } },
    { backendId: "a2", backend: { capacity_domain: "a" } },
    { backendId: "b", backend: { capacity_domain: "b" } },
    { backendId: "c", backend: { capacity_domain: "c" } },
    { backendId: "d", backend: { capacity_domain: "d" } },
  ]);
  assert.deepEqual(selected.map((item) => item.backendId), ["a1", "b", "c"]);
});

test("capacity compatibility is a projection of durable health", () => {
  const projected = capacityProjectionFromHealth({
    overall: "throttled", circuit_state: "open", scope: "model",
    last_provider_error_code: "rate_limited", reset_at: 20,
    last_observation_at: 5, evidence_expires_at: 15,
  }, { now: 10 });
  assert.equal(projected.state, "throttled");
  assert.equal(projected.reason, "rate_limited");
  assert.equal(projected.current, true);
});

test("partial stream failure is exactly one terminal SSE error", () => {
  const wire = terminalSseFailure({ requestId: "req-1" }).toString("utf8");
  assert.equal((wire.match(/event: error/g) || []).length, 1);
  assert.match(wire, /partial_stream_failed/);
  assert.ok(wire.endsWith("\n\n"));
});

test("only an observed upstream 429 is returned as 429", () => {
  const upstream = normalizeFailure({ origin: "upstream", upstreamStatus: 429, upstreamAttempted: true });
  assert.equal(upstream.clientStatus, 429);
  assert.equal(upstream.reason, "rate_limited");

  const local = normalizeFailure({ origin: "gateway", reason: "cooldown_active", upstreamAttempted: false });
  assert.equal(local.clientStatus, 503);
  assert.equal(local.upstreamStatus, null);
  assert.equal(local.upstreamAttempted, false);
});

test("quota, provider auth, caller auth, and malformed success remain distinct", () => {
  for (const upstreamStatus of [402, 403, 429]) {
    const quota = normalizeFailure({ origin: "upstream", upstreamStatus, upstreamAttempted: true, quotaProven: true });
    assert.equal(quota.clientStatus, 429);
    assert.equal(quota.reason, "quota_exhausted");
  }
  assert.deepEqual(
    normalizeFailure({ origin: "upstream", upstreamStatus: 401, upstreamAttempted: true }).clientStatus,
    503,
  );
  assert.equal(normalizeFailure({ origin: "caller", upstreamStatus: 401, upstreamAttempted: false }).clientStatus, 401);
  assert.equal(normalizeFailure({ origin: "caller", upstreamStatus: 403, upstreamAttempted: false }).clientStatus, 403);
  const malformed = normalizeFailure({ origin: "upstream", upstreamStatus: 200, reason: "malformed_response", upstreamAttempted: true, retryAt: 99 });
  assert.equal(malformed.clientStatus, 502);
  assert.equal(malformed.retryAt, null);
});

test("configured mode and circuit admission are independent", () => {
  assert.equal(effectiveInferenceEligibility({ mode: "active", circuit: "closed", purpose: "inference" }), true);
  assert.equal(effectiveInferenceEligibility({ mode: "canary", circuit: "closed", purpose: "qualification", explicitlyAuthorized: true }), true);
  assert.equal(effectiveInferenceEligibility({ mode: "canary", circuit: "closed", purpose: "qualification" }), false);
  assert.equal(effectiveInferenceEligibility({ mode: "monitor_only", circuit: "closed", purpose: "inference" }), false);
  assert.equal(effectiveInferenceEligibility({ mode: "disabled", circuit: "closed", purpose: "inference" }), false);
  assert.equal(effectiveInferenceEligibility({ mode: "active", circuit: "half_open", purpose: "recovery", lease: { owner: "x", expires_at: 20 }, leaseOwner: "x", now: 10 }), true);
  assert.equal(effectiveInferenceEligibility({ mode: "active", circuit: "half_open", purpose: "recovery", lease: { owner: "x", expires_at: 20 }, leaseOwner: "y", now: 10 }), false);
});

test("terminal selection is deterministic and bounds retry metadata", () => {
  const picked = selectTerminalFailure([
    normalizeFailure({ origin: "gateway", reason: "cooldown_active", upstreamAttempted: false }),
    normalizeFailure({ origin: "upstream", upstreamStatus: 429, upstreamAttempted: true, retryAt: 200 }),
  ], 150);
  assert.equal(picked.clientStatus, 503);
  assert.equal(picked.retryAt, null);
  assert.equal(picked.attemptCount, 1);
});
