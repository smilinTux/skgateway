import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_THRESHOLDS, foldProviderSnapshot } from "../src/health/fold.mjs";
import { normalizeObservation } from "../src/health/schema.mjs";

function observation(overrides = {}) {
  return normalizeObservation({
    schema_version: 1, observation_id: overrides.observation_id || "o1",
    observed_at: overrides.observed_at || 1_800_000_000_000,
    expires_at: overrides.expires_at || 1_800_000_060_000,
    gateway_instance: "g", boot_id: "b", runtime_revision: "r", config_revision: "c",
    provider: "zai", backend_id: "glm", account_ref: "opaque-a", model_id: null,
    bucket_id: "sk-m", scope: "account", source: "account_poll", probe_cost: "zero",
    configured_mode: "active", circuit_state: "closed", dimensions: {}, success: null,
    ...overrides,
  });
}

describe("provider health snapshot fold", () => {
  test("unknown evidence remains unknown", () => {
    const snapshot = foldProviderSnapshot(null, observation(), DEFAULT_THRESHOLDS);
    assert.equal(snapshot.overall, "unknown");
    assert.equal(snapshot.dimensions.quota, "unknown");
  });

  test("configured off takes precedence", () => {
    const snapshot = foldProviderSnapshot(null, observation({ configured_mode: "off" }), DEFAULT_THRESHOLDS);
    assert.equal(snapshot.overall, "disabled");
  });

  test("terminal auth evidence applies immediately and transport requires three failures over two cycles", () => {
    let snapshot = foldProviderSnapshot(null, observation({ dimensions: { auth: "rejected" }, success: false }), DEFAULT_THRESHOLDS);
    assert.equal(snapshot.overall, "unavailable");
    snapshot = null;
    for (let i = 0; i < 2; i++) snapshot = foldProviderSnapshot(snapshot, observation({ observation_id: `t${i}`, observed_at: 1_800_000_000_000 + i, monitor_cycle: `c${i}`, dimensions: { transport: "unavailable" }, success: false }), DEFAULT_THRESHOLDS);
    assert.notEqual(snapshot.overall, "unavailable");
    snapshot = foldProviderSnapshot(snapshot, observation({ observation_id: "t3", observed_at: 1_800_000_000_003, monitor_cycle: "c2", dimensions: { transport: "unavailable" }, success: false }), DEFAULT_THRESHOLDS);
    assert.equal(snapshot.overall, "unavailable");
  });

  test("persists operational recovery state and expiry", () => {
    const snapshot = foldProviderSnapshot(null, observation({
      quarantine_scope: "account", quarantine_reason: "quota_exhausted", reset_at: 1_800_000_300_000,
      next_due_at: 1_800_000_120_000, backoff_step: 3, credential_generation: "generation-7",
      half_open_lease: { owner: "lease-a", expires_at: 1_800_000_030_000 },
    }), DEFAULT_THRESHOLDS);
    assert.equal(snapshot.evidence_expires_at, 1_800_000_060_000);
    assert.equal(snapshot.backoff_step, 3);
    assert.equal(snapshot.half_open_lease.owner, "lease-a");
  });

  test("elevated errors require both minimum failures and minimum request volume", () => {
    const small = foldProviderSnapshot(null, observation({ request_count: 10, failure_count: 5 }), DEFAULT_THRESHOLDS);
    assert.equal(small.elevated_errors, false);
    const elevated = foldProviderSnapshot(null, observation({ request_count: 20, failure_count: 5 }), DEFAULT_THRESHOLDS);
    assert.equal(elevated.elevated_errors, true);
    assert.equal(elevated.overall, "degraded");
  });
});
