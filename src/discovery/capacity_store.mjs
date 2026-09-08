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
  const record = providerRecord?.state === "throttled" ? providerRecord : (modelRecord || providerRecord);
  if (!record) return { state: "unknown", reason: null, retry_at: null, probe_state: "none", current: false };
  const current = Number.isFinite(record.observed_at) && now - record.observed_at <= 48 * 60 * 60 * 1000;
  if (record.state === "available") return { ...record, current };
  return { ...record, state: "throttled", current };
}

export function recordSubscriptionExhausted(provider, { retryAt, now = Date.now(), path = CAPACITY_STORE_PATH } = {}) {
  const store = load(path);
  const record = {
    state: "throttled", scope: "provider", reason: "subscription_exhausted",
    retry_at: Math.max(now + 1000, Number(retryAt) || now + 6 * 60 * 60 * 1000),
    probe_state: "pending", observed_at: now,
  };
  save({ ...store, [`provider:${provider}`]: record }, path);
  return record;
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
  retryAt, now = Date.now(), path = CAPACITY_STORE_PATH,
} = {}) {
  const store = load(path);
  const record = {
    state: "throttled", scope: "model", reason: "rate_limited",
    retry_at: Math.max(now + 1000, Number(retryAt) || now + 60_000),
    probe_state: "none", observed_at: now,
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
  if (status.state !== "throttled") return { admitted: true, probe: false, status };
  if (probeOwner && probes.get(provider) === probeOwner) {
    return { admitted: true, probe: true, status: { ...status, probe_state: "in_progress" } };
  }
  if (!status.current || !Number.isFinite(status.retry_at) || now < status.retry_at ||
      !publicSynthetic || !probeOwner || probes.has(provider)) {
    return { admitted: false, probe: false, status };
  }
  probes.set(provider, probeOwner);
  return { admitted: true, probe: true, status: { ...status, probe_state: "in_progress" } };
}

export function finishCapacityProbe(provider, success, {
  probeOwner = null, model = null, retryAt, providerWide = false, reason = null,
  now = Date.now(), path = CAPACITY_STORE_PATH,
} = {}) {
  const status = capacityStatus(provider, model, { now, path });
  if (!probeOwner || probes.get(provider) !== probeOwner) return status;
  probes.delete(provider);
  if (success) return clearCapacity(provider, model, { now, path });
  if (providerWide) return recordSubscriptionExhausted(provider, { retryAt, now, path });
  if (!providerWide && status.scope === "model") {
    return recordModelThrottled(provider, model, { retryAt, now, path });
  }
  if (reason || status.reason !== "subscription_exhausted") {
    return recordProviderUnavailable(provider, {
      reason: reason || status.reason || "backend_cooldown", retryAt, now, path,
    });
  }
  return recordSubscriptionExhausted(provider, { retryAt, now, path });
}

export function releaseCapacityProbe(provider, probeOwner) {
  if (!probeOwner || probes.get(provider) !== probeOwner) return false;
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
    const providerTargets = targets.filter((candidate) => candidate.provider === target.provider);
    try {
      for (const exactTarget of providerTargets) {
        // routeAndSend settles and releases this token after each exact model.
        // Reuse the same transaction owner so one result cannot suppress the
        // remaining exact claims, while scheduledProbes still excludes every
        // concurrent provider recovery transaction.
        probes.set(target.provider, owner);
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
          if (probes.get(target.provider) === owner) {
            finishCapacityProbe(target.provider, false, {
              probeOwner: owner, model: exactTarget.model, now, path,
            });
          }
          results.push({ ...exactTarget, error });
        } finally {
          clearTimeout(timer);
          if (probes.get(target.provider) === owner) {
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
