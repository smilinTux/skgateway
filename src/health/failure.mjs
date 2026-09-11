const ORIGINS = new Set(["caller", "gateway", "upstream"]);
const MODES = new Set(["disabled", "monitor_only", "canary", "active"]);
const CIRCUITS = new Set(["closed", "open", "half_open"]);

function safeStatus(value) {
  return Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
}

function classify({ origin, upstreamStatus, reason, quotaProven }) {
  if (origin === "caller") return { clientStatus: upstreamStatus || 400, reason: reason || "caller_rejected", retryable: false };
  if (origin === "gateway") return {
    clientStatus: reason === "operation_timeout" ? 504 : 503,
    reason: reason || "gateway_unavailable",
    retryable: true,
  };
  if (reason === "malformed_response" || (upstreamStatus >= 200 && upstreamStatus < 300 && reason)) {
    return { clientStatus: 502, reason: "malformed_response", retryable: true };
  }
  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return {
      clientStatus: 503,
      reason: upstreamStatus === 401 ? "provider_auth_unavailable" : "provider_entitlement_unavailable",
      retryable: false,
    };
  }
  if (upstreamStatus === 429) return {
    clientStatus: 429,
    reason: quotaProven ? "quota_exhausted" : "rate_limited",
    retryable: true,
  };
  if (upstreamStatus === 402 && quotaProven) return { clientStatus: 503, reason: "quota_exhausted", retryable: true };
  if ([502, 503, 504, 529].includes(upstreamStatus)) return {
    clientStatus: upstreamStatus === 504 ? 504 : 502,
    reason: upstreamStatus === 504 ? "upstream_timeout" : "upstream_unavailable",
    retryable: true,
  };
  return { clientStatus: upstreamStatus || 502, reason: reason || "upstream_failure", retryable: false };
}

export function normalizeFailure(input = {}) {
  const origin = ORIGINS.has(input.origin) ? input.origin : "gateway";
  const upstreamAttempted = input.upstreamAttempted === true;
  const upstreamStatus = origin === "upstream" && upstreamAttempted ? safeStatus(input.upstreamStatus) : null;
  const result = classify({ ...input, origin, upstreamStatus: origin === "caller" ? safeStatus(input.upstreamStatus) : upstreamStatus });
  const retryAt = result.reason === "malformed_response" || !Number.isSafeInteger(input.retryAt)
    ? null
    : input.retryAt;
  return Object.freeze({
    clientStatus: result.clientStatus,
    upstreamStatus,
    origin,
    reason: result.reason,
    retryable: result.retryable,
    retryAt,
    requestId: typeof input.requestId === "string" ? input.requestId : null,
    attemptCount: Number.isSafeInteger(input.attemptCount) && input.attemptCount >= 0
      ? input.attemptCount
      : (upstreamAttempted ? 1 : 0),
    upstreamAttempted,
  });
}

export function effectiveInferenceEligibility({
  mode, circuit, purpose = "inference", explicitlyAuthorized = false,
  lease = null, leaseOwner = null, now = Date.now(), scopeMatches = true,
} = {}) {
  if (!MODES.has(mode) || !CIRCUITS.has(circuit)) return false;
  if (mode === "disabled" || mode === "monitor_only" || circuit === "open") return false;
  if (purpose === "inference") return mode === "active" && circuit === "closed";
  if (purpose === "qualification") return mode === "canary" && circuit === "closed" && explicitlyAuthorized === true;
  if (purpose !== "recovery" || !["active", "canary"].includes(mode) || circuit !== "half_open") return false;
  return scopeMatches === true && lease?.owner === leaseOwner && Number.isSafeInteger(lease.expires_at) && lease.expires_at > now;
}

const TERMINAL_PRECEDENCE = Object.freeze({
  caller_rejected: 100,
  policy_rejected: 100,
  provider_auth_unavailable: 90,
  provider_entitlement_unavailable: 90,
  quota_exhausted: 80,
  operation_timeout: 70,
  capacity_saturated: 60,
  cooldown_active: 60,
  rate_limited: 50,
  upstream_timeout: 40,
  upstream_unavailable: 30,
  malformed_response: 20,
  gateway_unavailable: 10,
});

export function selectTerminalFailure(attempts = [], operationDeadline = null) {
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return normalizeFailure({ origin: "gateway", reason: "gateway_unavailable", upstreamAttempted: false });
  }
  const selected = attempts.reduce((best, item) =>
    (TERMINAL_PRECEDENCE[item.reason] || 0) > (TERMINAL_PRECEDENCE[best.reason] || 0) ? item : best);
  const attemptCount = attempts.filter((item) => item.upstreamAttempted).length;
  const retryAt = Number.isSafeInteger(selected.retryAt) &&
    (!Number.isSafeInteger(operationDeadline) || selected.retryAt <= operationDeadline)
    ? selected.retryAt
    : null;
  return Object.freeze({ ...selected, retryAt, attemptCount });
}

export function independentAttemptCandidates(candidates = [], { maxAttempts = 3 } = {}) {
  const domains = new Set();
  const selected = [];
  for (const candidate of candidates) {
    const domain = candidate?.capacityDomain || candidate?.backend?.capacity_domain || candidate?.backendId;
    if (!domain || domains.has(domain)) continue;
    domains.add(domain);
    selected.push(candidate);
    if (selected.length === maxAttempts) break;
  }
  return selected;
}
