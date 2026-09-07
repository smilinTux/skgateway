import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const store = join(mkdtempSync(join(tmpdir(), "skgw-capacity-test-")), "capacity.json");
const capacity = await import("../src/discovery/capacity_store.mjs");
const { applyCapacityView, availabilityState } = await import("../src/proxy/advertise.mjs");

test("provider exhaustion fails closed, admits one bounded recovery probe, and clears on success", () => {
  capacity._resetCapacityProbesForTests();
  capacity.recordSubscriptionExhausted("codex", { now: 1000, retryAt: 2000, path: store });
  assert.equal(capacity.admitCapacity("codex", "gpt-5", { now: 1500, path: store }).admitted, false);
  assert.equal(capacity.admitCapacity("codex", "gpt-5", { now: 2000, publicSynthetic: true, path: store }).probe, true);
  assert.equal(capacity.admitCapacity("codex", "gpt-5.1", { now: 2000, publicSynthetic: true, path: store }).admitted, false);
  capacity.finishCapacityProbe("codex", true, { now: 2001, path: store });
  assert.equal(capacity.admitCapacity("codex", "gpt-5.1", { now: 2002, path: store }).admitted, true);
});

test("stale and failed probe evidence stays fail closed", () => {
  capacity._resetCapacityProbesForTests();
  capacity.recordSubscriptionExhausted("codex", { now: 1000, retryAt: 2000, path: store });
  const stale = capacity.admitCapacity("codex", "gpt-5", {
    now: 1000 + 49 * 60 * 60 * 1000, publicSynthetic: true, path: store,
  });
  assert.equal(stale.admitted, false);
  capacity.recordSubscriptionExhausted("codex", { now: 3000, retryAt: 4000, path: store });
  assert.equal(capacity.admitCapacity("codex", "gpt-5", { now: 4000, publicSynthetic: true, path: store }).probe, true);
  capacity.finishCapacityProbe("codex", false, { now: 4001, retryAt: 8000, path: store });
  assert.equal(capacity.admitCapacity("codex", "gpt-5", { now: 4002, path: store }).admitted, false);
});

test("catalog and monitoring share provider-wide capacity truth", () => {
  const getCapacity = (provider) => provider === "codex"
    ? { state: "throttled", reason: "subscription_exhausted", retry_at: 9, probe_state: "pending", current: true }
    : { state: "available", reason: null, retry_at: null, probe_state: "succeeded", current: true };
  const catalog = [{ id: "gpt-5", provider: "codex" }, { id: "qwen", provider: "local" }];
  assert.deepEqual(applyCapacityView(catalog, getCapacity).map((m) => m.id), ["qwen"]);
  assert.equal(getCapacity("codex").state, "throttled");
  assert.equal(getCapacity("local").state, "available");
});

test("only explicit quota language becomes provider-wide exhaustion", () => {
  assert.equal(capacity.isSubscriptionExhaustion(429, '{"error":"subscription usage limit reached"}'), true);
  assert.equal(capacity.isSubscriptionExhaustion(429, '{"error":"requests per minute"}'), false);
  assert.equal(capacity.isSubscriptionExhaustion(500, '{"error":"subscription usage limit reached"}'), false);
});

test("canonical monitoring distinguishes all availability states", () => {
  assert.equal(availabilityState({ enabled: false }), "disabled");
  assert.equal(availabilityState({ capacity: { state: "throttled" } }), "throttled");
  assert.equal(availabilityState({ health: { quarantined: true } }), "quarantined");
  assert.equal(availabilityState({ health: { observed: false, status: "unknown" } }), "unknown");
  assert.equal(availabilityState({ health: { observed: true, status: "up" } }), "available");
});
