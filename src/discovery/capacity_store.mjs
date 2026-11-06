import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const CAPACITY_STORE_PATH = process.env.SKGATEWAY_CAPACITY_STORE_PATH ||
  join(homedir(), ".config", "skgateway", "capacity_store.json");
export const PRODUCTION_CAPACITY_STORE_PATH = join(homedir(), ".config", "skgateway", "capacity_store.json");
const probes = new Map();
const scheduledProbes = new Map();
const TRANSIENT_RETRY_MS = 5 * 60 * 1000;
const TERMINAL_RETRY_MS = 30 * 60 * 1000;
const MODEL_RECOVERY_RETRY_MS = 60 * 1000;
const configuredModelProbeInterval = Number(process.env.SKGATEWAY_MODEL_PROBE_INTERVAL_MS);
export const MODEL_PROBE_INTERVAL_MS = Number.isFinite(configuredModelProbeInterval) && configuredModelProbeInterval >= 1000
  ? configuredModelProbeInterval : 3 * 60 * 1000;

/** Cadence at which the bounded recovery probe may run while provider-wide
 * subscription_exhausted is in force. The stored retry_at stays whatever the
 * provider declared (or the 6h default when it said nothing), but between now
 * and that deadline the provider is probed once per interval so a provider
 * that is healthy again is re-admitted in minutes, not hours. Incident
 * 2026-11-02: a single 06:10 z.ai 429 with quota wording and no Retry-After
 * held every GLM bucket fail-closed until an operator ran clearCapacity at
 * 12:10, while a direct call at 09:08 already returned 200. */
export const SUBSCRIPTION_PROBE_INTERVAL_MS = 15 * 60 * 1000;
const ZAI_RECOVERY_MODELS = Object.freeze(["glm-4.5", "glm-4.6", "glm-4.7", "glm-5", "glm-5.3"]);

/** Keep shared provider recovery on the exact claims qualified for fleet use. */
export function selectProviderRecoveryModels(provider, models) {
  const available = new Set((models || []).filter((model) => typeof model === "string"));
  if (provider === "zai") return ZAI_RECOVERY_MODELS.filter((model) => available.has(model));
  return [...available].filter((model) => !model.includes("*"));
}

function load(path = CAPACITY_STORE_PATH) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function save(value, path = CAPACITY_STORE_PATH) {
  if ((process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === "test") &&
      resolve(path) === resolve(PRODUCTION_CAPACITY_STORE_PATH)) {
    throw new Error("refusing to write the production capacity store from a test run");
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2));
  } catch { /* capacity evidence must not break the response path */ }
}

export function capacityStatus(provider, model, { now = Date.now(), path = CAPACITY_STORE_PATH } = {}) {
  const store = load(path);
  const providerRecord = store[`provider:${provider}`];
  const modelRecord = store[`model:${provider}:${model}`];
  let record = providerRecord?.state === "throttled" ? providerRecord : (modelRecord || providerRecord);
  if (!record) return { state: "unknown", reason: null, retry_at: null, probe_state: "none", current: false };
  if (record === modelRecord && provider === "zai" && record.scope === "model" &&
      (record.reason === "malformed_response" || record.reason === "backend_cooldown") &&
      Number.isFinite(record.observed_at) && Number.isFinite(record.retry_at)) {
    record = { ...record, retry_at: Math.min(record.retry_at, record.observed_at + MODEL_RECOVERY_RETRY_MS) };
  }
  // Provider-wide subscription exhaustion keeps the declared deadline on
  // disk but exposes a bounded probe slot every SUBSCRIPTION_PROBE_INTERVAL_MS
  // from the observation, capped by the declared deadline itself. "pending"
  // therefore always means "probe due soon", never "silent for 6h".
  if (record === providerRecord && record.scope === "provider" &&
      record.reason === "subscription_exhausted" && record.state !== "available" &&
      Number.isFinite(record.observed_at) && Number.isFinite(record.retry_at)) {
    record = { ...record, retry_at: Math.min(record.retry_at, record.observed_at + SUBSCRIPTION_PROBE_INTERVAL_MS) };
  }
  // Model cooldown evidence can outlive a provider outage. Reuse the existing
  // half-open slot, but never shorten an explicit upstream Retry-After.
  // Legacy records have no retry_after_at, so their long fallback deadline is
  // eligible too (incident 2026-11-03). Keep the original retry_at on disk.
  if (record.scope === "model" && record.state !== "available" &&
      Number.isFinite(record.observed_at) && Number.isFinite(record.retry_at)) {
    const nextProbeAt = Number.isFinite(record.next_probe_at) ? record.next_probe_at
      : Math.min(record.retry_at, record.observed_at + MODEL_PROBE_INTERVAL_MS);
    record = { ...record, probe_state: "pending",
      retry_at: Math.max(nextProbeAt, record.retry_after_at || 0) };
  }
  const current = Number.isFinite(record.observed_at) && now - record.observed_at <= 48 * 60 * 60 * 1000;
  if (record.state === "available") return { ...record, current };
  return { ...record, state: "throttled", current };
}

export function recordSubscriptionExhausted(provider, { retryAt, now = Date.now(), path = CAPACITY_STORE_PATH } = {}) {
  const store = load(path);
  const declared = {
    scope: "provider", state: "throttled", reason: "subscription_exhausted",
    retry_at: Math.max(now + 1000, Number(retryAt) || now + 6 * 60 * 60 * 1000),
    probe_state: "pending", observed_at: now,
  };
  save({ ...store, [`provider:${provider}`]: declared }, path);
  return declared;
}

/** Record a fail-closed provider recovery deadline without changing credentials. */
export function recordProviderUnavailable(provider, {
  reason = "backend_cooldown", retryAt, now = Date.now(), path = CAPACITY_STORE_PATH,
} = {}) {
  const store = load(path);
  const longer = new Set(["authentication_failure", "subscription_exhausted", "quarantine", "malformed_response"]);
  const retryMs = longer.has(reason) ? TERMINAL_RETRY_MS : TRANSIENT_RETRY_MS;
  const suppliedRetryAt = Number(retryAt);
  const record = {
    state: "throttled", scope: "provider", reason,
    retry_at: Math.max(now + retryMs, Number.isFinite(suppliedRetryAt) ? suppliedRetryAt : 0),
    probe_state: "pending", observed_at: now,
  };
  save({ ...store, [`provider:${provider}`]: record }, path);
  return record;
}

export function recordModelThrottled(provider, model, {
  retryAt, retryAfterAt, now = Date.now(), path = CAPACITY_STORE_PATH,
} = {}) {
  return recordModelUnavailable(provider, model, {
    reason: "rate_limited", retryAt, retryAfterAt, now, path,
  });
}

export function recordModelUnavailable(provider, model, {
  reason = "backend_cooldown", retryAt, retryAfterAt, now = Date.now(), path = CAPACITY_STORE_PATH,
} = {}) {
  const store = load(path);
  const record = {
    state: "throttled", scope: "model", reason,
    retry_at: Math.max(now + 1000, Number(retryAt) || now + MODEL_RECOVERY_RETRY_MS),
    probe_state: "pending", observed_at: now,
    ...(Number.isFinite(retryAfterAt) ? { retry_after_at: retryAfterAt } : {}),
  };
  save({ ...store, [`model:${provider}:${model}`]: record }, path);
  return record;
}

export function clearCapacity(provider, model, { now = Date.now(), path = CAPACITY_STORE_PATH } = {}) {
  const store = load(path);
  const record = { state: "available", scope: "provider", reason: null, retry_at: null,
    probe_state: "succeeded", observed_at: now };
  delete store[`model:${provider}:${model}`];
  store[`provider:${provider}`] = record;
  save(store, path);
  return record;
}

export function admitCapacity(provider, model, {
  publicSynthetic = false, probeOwner = null, now = Date.now(), path = CAPACITY_STORE_PATH,
} = {}) {
  const status = capacityStatus(provider, model, { now, path });
  const active = probes.get(provider);
  if (probeOwner && active?.owner === probeOwner && (!active.model || active.model === model)) {
    return { admitted: true, probe: true, status: { ...status, probe_state: "in_progress" } };
  }
  if (status.state !== "throttled") return { admitted: true, probe: false, status };
  if (!status.current || !Number.isFinite(status.retry_at) || now < status.retry_at ||
      !publicSynthetic || !probeOwner || probes.has(provider)) {
    return { admitted: false, probe: false, status };
  }
  probes.set(provider, { owner: probeOwner, model: status.scope === "model" ? model : null });
  return { admitted: true, probe: true, status: { ...status, probe_state: "in_progress" } };
}

export function finishCapacityProbe(provider, success, {
  probeOwner = null, model = null, retryAt, retryAfterAt, providerWide = false, reason = null,
  now = Date.now(), path = CAPACITY_STORE_PATH,
} = {}) {
  const status = capacityStatus(provider, model, { now, path });
  const active = probes.get(provider);
  if (!probeOwner || active?.owner !== probeOwner || (active.model && active.model !== model)) return status;
  probes.delete(provider);
  if (success) return clearCapacity(provider, model, { now, path });
  if (providerWide) return recordSubscriptionExhausted(provider, { retryAt, now, path });
  if (model && status.scope === "model") {
    const store = load(path);
    const key = `model:${provider}:${model}`;
    const record = store[key];
    const interval = Math.min((record.probe_interval_ms || MODEL_PROBE_INTERVAL_MS) * 2,
      Math.max(MODEL_PROBE_INTERVAL_MS, record.retry_at - now));
    const nextProbeAt = record.retry_at > now ? Math.min(record.retry_at, now + interval) : now + interval;
    save({ ...store, [key]: { ...record,
      reason: reason || record.reason,
      probe_state: "pending", observed_at: now, probe_interval_ms: interval,
      next_probe_at: nextProbeAt,
      ...(Number.isFinite(retryAfterAt) ? { retry_after_at: retryAfterAt } : {}),
    } }, path);
    return capacityStatus(provider, model, { now, path });
  }
  if (model && (reason === "malformed_response" || reason === "response_budget")) {
    clearCapacity(provider, model, { now, path });
    return recordModelUnavailable(provider, model, { reason, retryAt, retryAfterAt, now, path });
  }
  if (reason || status.reason !== "subscription_exhausted") {
    return recordProviderUnavailable(provider, {
      reason: reason || status.reason || "backend_cooldown", retryAt, now, path,
    });
  }
  return recordSubscriptionExhausted(provider, { retryAt, now, path });
}

export function releaseCapacityProbe(provider, probeOwner) {
  if (!probeOwner || probes.get(provider)?.owner !== probeOwner) return false;
  probes.delete(provider);
  return true;
}

/** Run due capacity recovery probes. This scheduler acquires the exact
 * half-open owner token and passes it into the routed probe. */
export async function runDueCapacityProbes(targets, probe, {
  now = Date.now(), path = CAPACITY_STORE_PATH, deadlineMs = 8_000,
} = {}) {
  const results = [];
  if (typeof targets === "function") targets = targets();
  const handledProviders = new Set();
  for (const target of targets) {
    if (handledProviders.has(target.provider)) continue;
    let status = capacityStatus(target.provider, target.model, { now, path });
    if (status.state !== "throttled" && target.unavailable === true) {
      status = recordProviderUnavailable(target.provider, {
        reason: target.reason || "backend_cooldown",
        retryAt: target.retryAt,
        now,
        path,
      });
    }
    if (status.state !== "throttled" || !status.current ||
        !Number.isFinite(status.retry_at) || now < status.retry_at ||
        scheduledProbes.has(target.provider)) continue;
    const owner = Symbol(target.provider);
    const admission = admitCapacity(target.provider, target.model, {
      publicSynthetic: true, probeOwner: owner, now, path,
    });
    if (!admission.probe) continue;
    handledProviders.add(target.provider);
    scheduledProbes.set(target.provider, owner);
    // Provider recovery still qualifies every exact claim. A model cooldown
    // gets only its own request, at most one per provider per scheduler tick.
    const providerTargets = status.scope === "model" ? [target]
      : targets.filter((candidate) => candidate.provider === target.provider);
    try {
      for (const exactTarget of providerTargets) {
        // routeAndSend settles and releases this token after each exact model.
        // Reuse the same transaction owner so one result cannot suppress the
        // remaining exact claims, while scheduledProbes still excludes every
        // concurrent provider recovery transaction.
        probes.set(target.provider, { owner, model: status.scope === "model" ? exactTarget.model : null });
        const controller = new AbortController();
        let timer;
        try {
          const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("capacity probe deadline exceeded"));
            }, deadlineMs);
          });
          results.push({ ...exactTarget, result: await Promise.race([
            probe(exactTarget, { signal: controller.signal, probeOwner: owner }), deadline,
          ]) });
        } catch (error) {
          if (probes.get(target.provider)?.owner === owner) {
            finishCapacityProbe(target.provider, false, {
              probeOwner: owner, model: exactTarget.model, now, path,
            });
          }
          results.push({ ...exactTarget, error });
        } finally {
          clearTimeout(timer);
          if (probes.get(target.provider)?.owner === owner) {
            finishCapacityProbe(target.provider, false, {
              probeOwner: owner, model: exactTarget.model, now, path,
            });
          }
        }
      }
    } finally {
      releaseCapacityProbe(target.provider, owner);
      if (scheduledProbes.get(target.provider) === owner) scheduledProbes.delete(target.provider);
    }
  }
  return results;
}

export function startCapacityProbeScheduler({
  targets, probe, intervalMs = 30_000, deadlineMs = 8_000, setIntervalFn = setInterval,
}) {
  const tick = () => runDueCapacityProbes(targets, probe, { deadlineMs });
  const timer = setIntervalFn(tick, intervalMs);
  timer?.unref?.();
  return { tick, timer };
}

export function isSubscriptionExhaustion(status, body) {
  if (status !== 429 && status !== 402) return false;
  let text = "";
  try {
    text = Buffer.isBuffer(body)
      ? body.toString("utf8")
      : typeof body === "object" && body !== null ? JSON.stringify(body) : String(body || "");
  } catch { return false; }
  return /(?:subscription(?:[\s_-]+usage)?|usage|plan)[\s_-]*(?:limit|quota)|quota[\s_-]*(?:exhausted|reset)/i.test(text);
}

export function _resetCapacityProbesForTests() { probes.clear(); scheduledProbes.clear(); }
