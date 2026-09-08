import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Backend, createRouter } from "../src/proxy/router.mjs";
import {
  _resetCapacityProbesForTests,
  capacityStatus,
  finishCapacityProbe,
  recordProviderUnavailable,
  runDueCapacityProbes,
} from "../src/discovery/capacity_store.mjs";

function store(name) {
  const path = join(tmpdir(), `skgateway-zai-recovery-${process.pid}-${name}.json`);
  rmSync(path, { force: true });
  return path;
}

test("normal-budget success removes only tiny-budget health failures", () => {
  const backend = new Backend({
    id: "zai",
    url: "http://127.0.0.1:9/v1",
    models: ["glm-5.3-flash"],
    quarantine_threshold: 0,
  });
  backend.recordOutcome(false, 1, { failureClass: "response_budget" });
  assert.equal(backend.getHealth().status, "down");

  backend.recordOutcome(true, 1, { authoritativeRecovery: true });
  assert.equal(backend.getHealth().status, "up");
  assert.equal(backend.getHealth().errorRate, 0);
});

test("authoritative recovery preserves real high error rate", () => {
  const backend = new Backend({
    id: "zai",
    url: "http://127.0.0.1:9/v1",
    models: ["glm-5.3-flash"],
    quarantine_threshold: 0,
  });
  backend.recordOutcome(false, 1, { failureClass: "authentication_failure" });
  backend.recordOutcome(false, 1, { failureClass: "response_budget" });
  backend.recordOutcome(true, 1, { authoritativeRecovery: true });

  const health = backend.getHealth();
  assert.equal(health.status, "down");
  assert.equal(health.errorRate, 0.5);
});

test("provider recovery uses five-minute transient and longer terminal deadlines", () => {
  const transientStore = store("transient");
  const terminalStore = store("terminal");
  assert.equal(recordProviderUnavailable("zai", {
    reason: "backend_cooldown", now: 1_000, path: transientStore,
  }).retry_at, 301_000);
  assert.equal(recordProviderUnavailable("zai", {
    reason: "authentication_failure", now: 1_000, path: terminalStore,
  }).retry_at, 1_801_000);
});

test("due Z.ai recovery remains provider-singleflight and preserves terminal reason", async () => {
  _resetCapacityProbesForTests();
  const path = store("singleflight");
  recordProviderUnavailable("zai", {
    reason: "malformed_response", now: 1_000, retryAt: 2_000, path,
  });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const probe = async () => { calls++; await held; return { status: 502 }; };
  const target = () => [{ provider: "zai", model: "glm-5.3-flash" }];

  const first = runDueCapacityProbes(target, probe, { now: 2_000, path });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await runDueCapacityProbes(target, probe, { now: 2_000, path }), []);
  release();
  await first;
  assert.equal(calls, 1);
  assert.equal(capacityStatus("zai", "glm-5.3-flash", { now: 2_001, path }).reason,
    "malformed_response");
});

test("only the owned schema-valid success clears recovery state", () => {
  _resetCapacityProbesForTests();
  const path = store("ownership");
  recordProviderUnavailable("zai", {
    reason: "backend_cooldown", now: 1_000, retryAt: 2_000, path,
  });
  finishCapacityProbe("zai", true, {
    probeOwner: {}, model: "glm-5.3-flash", now: 2_001, path,
  });
  assert.equal(capacityStatus("zai", "glm-5.3-flash", { now: 2_002, path }).state,
    "throttled");
});

test("the shared recovery probe gives GLM enough response budget", () => {
  const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  const matches = [...source.matchAll(/max_tokens:\s*(\d+)/g)].map((match) => Number(match[1]));
  assert.ok(matches.includes(256));
  assert.equal(matches.some((value) => value < 256), false);
});

test("raw GLM claim admission agrees after exact successful recovery", async () => {
  const models = ["glm-4.6", "glm-4.7", "glm-5.3"];
  const router = createRouter({ backends: { zai: {
    url: "http://127.0.0.1:9/v1",
    models,
    provider_purity: true,
    model_claim_quarantine_threshold: 2,
    model_claim_quarantine_cooldown_ms: 1,
  } } });
  const zai = router.getBackend("zai");

  for (const model of models) {
    zai.recordModelClaimOutcome(model, 502);
    zai.recordModelClaimOutcome(model, 502);
    assert.equal(zai.getModelClaimHealth(model).quarantined, true);
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (const model of models) {
    assert.deepEqual((await router.route({ model })).map((candidate) => candidate.backendId), ["zai"]);
    assert.equal(zai.recordModelClaimOutcome(model, 200)?.transition, "readmitted");
    assert.equal(zai.getModelClaimHealth(model).quarantined, false);
  }
  assert.equal(router.getHealth().zai.status, "unknown");
});
