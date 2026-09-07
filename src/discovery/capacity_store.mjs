import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const CAPACITY_STORE_PATH = process.env.SKGATEWAY_CAPACITY_STORE_PATH ||
  join(homedir(), ".config", "skgateway", "capacity_store.json");
export const PRODUCTION_CAPACITY_STORE_PATH = join(homedir(), ".config", "skgateway", "capacity_store.json");
const probes = new Set();
const scheduledProbes = new Set();

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
  const record = store[`model:${provider}:${model}`] || store[`provider:${provider}`];
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

export function clearCapacity(provider, model, { now = Date.now(), path = CAPACITY_STORE_PATH } = {}) {
  const store = load(path);
  const record = { state: "available", scope: "provider", reason: null, retry_at: null,
    probe_state: "succeeded", observed_at: now };
  delete store[`model:${provider}:${model}`];
  store[`provider:${provider}`] = record;
  save(store, path);
  probes.delete(provider);
  return record;
}

export function admitCapacity(provider, model, { publicSynthetic = false, now = Date.now(), path = CAPACITY_STORE_PATH } = {}) {
  const status = capacityStatus(provider, model, { now, path });
  if (status.state !== "throttled") return { admitted: true, probe: false, status };
  if (!status.current || !Number.isFinite(status.retry_at) || now < status.retry_at || !publicSynthetic || probes.has(provider)) {
    return { admitted: false, probe: false, status };
  }
  probes.add(provider);
  return { admitted: true, probe: true, status: { ...status, probe_state: "in_progress" } };
}

export function finishCapacityProbe(provider, success, { retryAt, now = Date.now(), path = CAPACITY_STORE_PATH } = {}) {
  probes.delete(provider);
  if (success) return clearCapacity(provider, null, { now, path });
  return recordSubscriptionExhausted(provider, { retryAt, now, path });
}

/** Run due subscription recovery probes. The injected probe owns outcome
 * recording on its normal response path; this wrapper only guarantees that a
 * thrown transport/audit error cannot strand the single-flight lock. */
export async function runDueCapacityProbes(targets, probe, {
  now = Date.now(), path = CAPACITY_STORE_PATH,
} = {}) {
  const results = [];
  for (const target of targets) {
    const status = capacityStatus(target.provider, target.model, { now, path });
    if (status.state !== "throttled" || !status.current ||
        !Number.isFinite(status.retry_at) || now < status.retry_at || scheduledProbes.has(target.provider)) continue;
    scheduledProbes.add(target.provider);
    try {
      results.push({ ...target, result: await probe(target) });
    } catch (error) {
      // A throw bypasses routeAndSend's normal outcome recorder. Re-arm the
      // provider instead of retrying every scheduler tick.
      finishCapacityProbe(target.provider, false, { now, path });
      results.push({ ...target, error });
    } finally {
      // routeAndSend normally clears or re-arms this itself. This is the
      // defensive transport-exception path that previously leaked the lock.
      probes.delete(target.provider);
      scheduledProbes.delete(target.provider);
    }
  }
  return results;
}

export function startCapacityProbeScheduler({
  targets, probe, intervalMs = 30_000, setIntervalFn = setInterval,
}) {
  const tick = () => runDueCapacityProbes(targets, probe);
  const timer = setIntervalFn(tick, intervalMs);
  timer?.unref?.();
  return { tick, timer };
}

export function isSubscriptionExhaustion(status, body) {
  if (status !== 429 && status !== 402) return false;
  let text = "";
  try { text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body || ""); } catch { return false; }
  return /(?:subscription|usage|plan)[\s_-]*(?:limit|quota)|quota[\s_-]*(?:exhausted|reset)/i.test(text);
}

export function _resetCapacityProbesForTests() { probes.clear(); scheduledProbes.clear(); }
