export const DEFAULT_THRESHOLDS = Object.freeze({
  transport_failures: 3, transport_cycles: 2, elevated_failures: 5,
  elevated_requests: 20, elevated_ratio: 0.2,
});

function snapshotKey(o) { return [o.gateway_instance, o.provider, o.backend_id || "", o.account_ref, o.model_id || ""].join("|"); }

function overall(s) {
  const d = s.dimensions;
  if (s.configured_mode === "off") return "disabled";
  if (["missing", "expired", "rejected"].includes(d.auth) || d.entitlement === "denied" || d.transport === "unavailable") return "unavailable";
  if (["throttled", "exhausted"].includes(d.quota) || ["saturated", "quarantined"].includes(d.capacity) || s.quarantine_scope) return "throttled";
  if (d.entitlement === "stale" || d.auth === "near_expiry" || d.transport === "degraded" || d.inference === "degraded" || s.elevated_errors) return "degraded";
  if (Object.values(d).some((v) => v === "unknown")) return "unknown";
  if (d.transport === "available" && (d.inference === "available" || s.last_success_at != null)) return "available";
  return "unknown";
}

export function foldProviderSnapshot(previous, observation, thresholds = DEFAULT_THRESHOLDS) {
  if (previous && previous.snapshot_key !== snapshotKey(observation)) throw new TypeError("observation does not match snapshot identity");
  if (previous && observation.observed_at < previous.last_observation_at) throw new TypeError("observations must fold in chronological order");
  const successCount = observation.success === true ? (previous?.consecutive_successes || 0) + 1 : 0;
  const failureCount = observation.success === false ? (previous?.consecutive_failures || 0) + 1 : 0;
  const cycles = new Set(previous?.failure_cycles || []);
  if (observation.success === false && observation.monitor_cycle) cycles.add(observation.monitor_cycle);
  if (observation.success !== false) cycles.clear();
  const merged = { ...(previous?.dimensions || {}), ...observation.dimensions };
  if (merged.transport === "unavailable" && !(failureCount >= thresholds.transport_failures && cycles.size >= thresholds.transport_cycles)) merged.transport = "degraded";
  const requestCount = observation.request_count || 0; const failures = observation.failure_count || 0;
  const elevated = failures >= thresholds.elevated_failures && requestCount >= thresholds.elevated_requests && failures / requestCount >= thresholds.elevated_ratio;
  const s = {
    schema_version: 1, snapshot_key: snapshotKey(observation), gateway_instance: observation.gateway_instance,
    provider: observation.provider, backend_id: observation.backend_id, account_ref: observation.account_ref,
    model_id: observation.model_id, bucket_id: observation.bucket_id, logical_route: observation.logical_route,
    scope: observation.scope, configured_mode: observation.configured_mode, circuit_state: observation.circuit_state,
    quarantine_scope: observation.quarantine_scope, quarantine_reason: observation.quarantine_reason,
    dimensions: merged, overall: "unknown", last_observation_at: observation.observed_at,
    last_success_at: observation.success === true ? observation.observed_at : previous?.last_success_at ?? null,
    last_error_at: observation.success === false ? observation.observed_at : previous?.last_error_at ?? null,
    evidence_expires_at: observation.expires_at, next_due_at: observation.next_due_at, reset_at: observation.reset_at,
    consecutive_successes: successCount, consecutive_failures: failureCount, failure_cycles: [...cycles].sort(),
    elevated_errors: elevated, backoff_step: observation.backoff_step, credential_generation: observation.credential_generation,
    half_open_lease: observation.half_open_lease, last_observation_id: observation.observation_id,
    last_source: observation.source, last_probe_cost: observation.probe_cost, last_provider_error_code: observation.provider_error_code,
  };
  s.overall = overall(s);
  return Object.freeze(s);
}
