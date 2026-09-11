import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { load as yamlLoad } from "js-yaml";

import { Backend, createRouter, routeAndSend } from "../src/proxy/router.mjs";
import {
  _resetCapacityProbesForTests,
  CAPACITY_STORE_PATH,
  capacityStatus,
  clearCapacity,
  finishCapacityProbe,
  recordProviderUnavailable,
  runDueCapacityProbes,
  selectProviderRecoveryModels,
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
  assert.equal(recordProviderUnavailable("zai", {
    reason: "backend_cooldown", now: 1_000, retryAt: 61_000, path: transientStore,
  }).retry_at, 301_000);
  assert.equal(recordProviderUnavailable("zai", {
    reason: "authentication_failure", now: 1_000, retryAt: 61_000, path: terminalStore,
  }).retry_at, 1_801_000);
});

test("legacy model-local GLM recovery deadlines normalize without touching policy state", () => {
  const now = 2_000_000;
  const cases = [
    ["zai", "model", "malformed_response", now + 6 * 60 * 60 * 1000, now + 60_000],
    ["zai", "model", "backend_cooldown", now + 6 * 60 * 60 * 1000, now + 60_000],
    ["zai", "model", "rate_limited", now + 6 * 60 * 60 * 1000, now + 6 * 60 * 60 * 1000],
    ["zai", "model", "quarantine", now + 6 * 60 * 60 * 1000, now + 6 * 60 * 60 * 1000],
    ["codex", "model", "malformed_response", now + 6 * 60 * 60 * 1000, now + 6 * 60 * 60 * 1000],
    ["zai", "provider", "authentication_failure", now + 30 * 60 * 1000, now + 30 * 60 * 1000],
    ["zai", "provider", "subscription_exhausted", now + 6 * 60 * 60 * 1000, now + 6 * 60 * 60 * 1000],
  ];
  for (const [provider, scope, reason, retryAt, expected] of cases) {
    const path = store(`${provider}-${scope}-${reason}`);
    writeFileSync(path, JSON.stringify({
      [`${scope}:${provider}${scope === "model" ? ":glm-4.7" : ""}`]: {
        state: "throttled", scope, reason, retry_at: retryAt,
        probe_state: "pending", observed_at: now,
      },
    }));
    assert.equal(capacityStatus(provider, "glm-4.7", { now: now + 1, path }).retry_at, expected);
    assert.equal(JSON.parse(readFileSync(path, "utf8"))[
      `${scope}:${provider}${scope === "model" ? ":glm-4.7" : ""}`
    ].retry_at, retryAt);
  }
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

  const first = runDueCapacityProbes(target, probe, { now: 1_801_000, path });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await runDueCapacityProbes(target, probe, { now: 1_801_000, path }), []);
  release();
  await first;
  assert.equal(calls, 1);
  assert.equal(capacityStatus("zai", "glm-5.3-flash", { now: 1_801_001, path }).reason,
    "malformed_response");
});

test("non-2xx probe attempts cannot clear response-budget health evidence", () => {
  for (const status of [401, 403, 429]) {
    const backend = new Backend({
      id: `zai-${status}`,
      url: "http://127.0.0.1:9/v1",
      models: ["glm-4.7"],
      quarantine_threshold: 0,
    });
    backend.recordOutcome(false, 1, { failureClass: "response_budget" });
    backend.recordOutcome(status < 500, 1, {
      failureClass: status === 401 || status === 403 ? "authentication_failure" : null,
      authoritativeRecovery: false,
    });
    assert.equal(backend.getHealth().status, "down");
    assert.ok(backend.getHealth().errorRate > 0);
  }
});

test("routed 401 recovery attempt remains fail closed", async (t) => {
  _resetCapacityProbesForTests();
  const upstream = http.createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "unauthorized" } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const router = createRouter({ backends: { zai: {
    url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_type: "none",
    discovery: "zai", models: ["glm-4.7"], quarantine_threshold: 0,
  } } });
  const backend = router.getBackend("zai");
  backend.recordOutcome(false, 1, { failureClass: "response_budget" });
  const oldNow = Date.now() - 31 * 60_000;
  recordProviderUnavailable("zai", {
    reason: "authentication_failure", now: oldNow, path: CAPACITY_STORE_PATH,
  });
  const result = await routeAndSend(router, {
    model: "glm-4.7", context: "public", capacityProbeOwner: {},
  }, "/v1/chat/completions", "POST", {
    "x-sk-context": "public", "x-sk-probe": "synthetic",
  }, Buffer.from(JSON.stringify({
    model: "glm-4.7", messages: [{ role: "user", content: "Reply ok." }],
    max_tokens: 256, stream: false,
  })), false);
  assert.equal(result.status, 401);
  assert.equal(backend.getHealth().status, "down");
  assert.ok(backend.getHealth().errorRate > 0);
  assert.equal(capacityStatus("zai", "glm-4.7", { path: CAPACITY_STORE_PATH }).reason,
    "authentication_failure");
});

test("malformed GLM output does not poison shared backend lifecycle", async (t) => {
  _resetCapacityProbesForTests();
  clearCapacity("zai", null, { path: CAPACITY_STORE_PATH });
  t.after(() => clearCapacity("zai", null, { path: CAPACITY_STORE_PATH }));
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "glm-4.7", choices: [] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const router = createRouter({ backends: { zai: {
    url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_type: "none",
    discovery: "zai", models: ["glm-4.7", "glm-5.3"],
    quarantine_threshold: 1, model_claim_quarantine_threshold: 1,
  } } });
  const result = await routeAndSend(router, { model: "glm-4.7" },
    "/v1/chat/completions", "POST", {}, Buffer.from(JSON.stringify({
      model: "glm-4.7", messages: [{ role: "user", content: "Reply ok." }],
      max_tokens: 256, stream: false,
    })), false);
  assert.equal(result.status, 502);
  assert.equal(router.getBackend("zai").getHealth().status, "up");
  assert.equal(router.getBackend("zai").getModelClaimHealth("glm-4.7").quarantined, false);
  const status = capacityStatus("zai", "glm-4.7", { path: CAPACITY_STORE_PATH });
  assert.equal(status.scope, "model");
  assert.equal(status.reason, "malformed_response");
  assert.ok(status.retry_at - status.observed_at <= 60_000);
  assert.equal(capacityStatus("zai", "glm-5.3", { path: CAPACITY_STORE_PATH }).state, "available");
});

test("transport 502 and 504 stay model-local with bounded recovery", async (t) => {
  _resetCapacityProbesForTests();
  clearCapacity("zai", null, { path: CAPACITY_STORE_PATH });
  t.after(() => clearCapacity("zai", null, { path: CAPACITY_STORE_PATH }));
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const model = JSON.parse(Buffer.concat(chunks).toString("utf8")).model;
      res.writeHead(model === "glm-4.6" ? 504 : 502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "upstream_transport" } }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  for (const model of ["glm-4.6", "glm-4.7"]) {
    clearCapacity("zai", model, { path: CAPACITY_STORE_PATH });
    const router = createRouter({ backends: { zai: {
      url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_type: "none",
      discovery: "zai", models: [model], quarantine_threshold: 0,
    } } });
    const result = await routeAndSend(router, { model }, "/v1/chat/completions", "POST", {},
      Buffer.from(JSON.stringify({ model, messages: [], max_tokens: 512 })), false);
    assert.equal(result.status, model === "glm-4.6" ? 504 : 502);
    const status = capacityStatus("zai", model, { path: CAPACITY_STORE_PATH });
    assert.equal(status.scope, "model");
    assert.equal(status.reason, "backend_cooldown");
    assert.ok(status.retry_at - status.observed_at <= 60_000);
  }
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

test("the shared recovery probe gives reasoning GLM a verified response budget", () => {
  const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  const matches = [...source.matchAll(/max_tokens:\s*(\d+)/g)].map((match) => Number(match[1]));
  assert.equal(matches.filter((value) => value === 512).length, 2);
  assert.equal(matches.some((value) => value < 512), false);
});

test("Z.ai recovery selects only canonical fleet claims from discovery", () => {
  assert.deepEqual(selectProviderRecoveryModels("zai", [
    "glm-4.5", "glm-4.5-air", "glm-4.6", "glm-4.7", "glm-5",
    "glm-5.1", "glm-5.2", "glm-5.3", "glm-5.3-flash",
  ]), ["glm-4.6", "glm-4.7", "glm-5.3"]);
  assert.deepEqual(selectProviderRecoveryModels("zai", ["glm-4.5", "glm-5.3-flash"]), []);
});

test("canonical GLM recovery claims keep their authoritative class floors", () => {
  const cards = yamlLoad(readFileSync(
    new URL("../config/model-cards.overrides.yaml", import.meta.url), "utf8",
  )).overrides;
  assert.deepEqual(
    ["glm-4.6", "glm-4.7", "glm-5.3"].map((model) => cards[model].size_class),
    ["M", "L", "XL"],
  );
});

test("other provider recovery keeps its configured exact models", () => {
  assert.deepEqual(selectProviderRecoveryModels("codex", ["gpt-5", "gpt-*", "gpt-5"]), ["gpt-5"]);
});

test("owned recovery probe cannot escape to colliding foreign backends", async (t) => {
  const calls = { owner: 0, qwen: 0, nvidia: 0 };
  const servers = {};
  for (const [name, servedModel] of [
    ["owner", "glm-4.6"],
    ["qwen", "qwen3.8"],
    ["nvidia", "glm-4.6-nvidia"],
  ]) {
    servers[name] = http.createServer((_req, res) => {
      calls[name]++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: `response-${name}`,
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        model: servedModel,
      }));
    });
    await new Promise((resolve) => servers[name].listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => servers[name].close(resolve)));
  }

  const router = createRouter({ backends: {
    qwen: {
      url: `http://127.0.0.1:${servers.qwen.address().port}/v1`,
      models: ["glm-4.6"], priority: 1,
    },
    nvidia: {
      url: `http://127.0.0.1:${servers.nvidia.address().port}/v1`,
      models: ["glm-4.6"], priority: 2,
    },
    owner: {
      url: `http://127.0.0.1:${servers.owner.address().port}/v1`,
      models: ["glm-4.6"], priority: 99,
    },
  } });
  const request = {
    model: "glm-4.6", context: "public", capacityProbeOwner: {},
    agentId: "skgateway-capacity-probe",
  };
  const result = await routeAndSend(
    router, request, "/v1/chat/completions", "POST",
    { "x-sk-context": "public", "x-sk-probe": "synthetic" },
    Buffer.from(JSON.stringify({
      model: "glm-4.6", messages: [{ role: "user", content: "Reply with ok." }],
      max_tokens: 512, stream: false,
    })), false, null, null, "owner",
  );

  assert.equal(result.status, 200);
  assert.deepEqual(calls, { owner: 1, qwen: 0, nvidia: 0 });
});

test("failed owned recovery probe has no foreign fallback", async (t) => {
  const calls = { owner: 0, qwen: 0 };
  const owner = http.createServer((_req, res) => {
    calls.owner++;
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "synthetic failure" } }));
  });
  const qwen = http.createServer((_req, res) => {
    calls.qwen++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  await new Promise((resolve) => owner.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => qwen.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => owner.close(resolve)));
  t.after(() => new Promise((resolve) => qwen.close(resolve)));

  const router = createRouter({ backends: {
    qwen: { url: `http://127.0.0.1:${qwen.address().port}/v1`, models: ["glm-4.7"], priority: 1 },
    owner: { url: `http://127.0.0.1:${owner.address().port}/v1`, models: ["glm-4.7"], priority: 99 },
  } });
  const result = await routeAndSend(
    router,
    { model: "glm-4.7", context: "public", capacityProbeOwner: {} },
    "/v1/chat/completions", "POST",
    { "x-sk-context": "public", "x-sk-probe": "synthetic" },
    Buffer.from(JSON.stringify({ model: "glm-4.7", messages: [], max_tokens: 512 })),
    false, null, null, "owner",
  );

  assert.equal(result.status, 502);
  assert.deepEqual(calls, { owner: 1, qwen: 0 });
});

test("scheduler passes the provider as the private exact-backend constraint", () => {
  const source = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
  assert.match(source, /probe:\s*\(\{ provider, model \}/);
  assert.match(source, /siemHook, signal, provider\)/);
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

test("scheduled provider recovery attempts every exact GLM claim", async () => {
  _resetCapacityProbesForTests();
  const path = store("all-exact-claims");
  const models = ["glm-4.6", "glm-4.7", "glm-5.3"];
  const router = createRouter({ backends: { zai: {
    url: "http://127.0.0.1:9/v1", models, provider_purity: true,
    model_claim_quarantine_threshold: 2, model_claim_quarantine_cooldown_ms: 1,
  } } });
  const zai = router.getBackend("zai");
  for (const model of models) {
    zai.recordModelClaimOutcome(model, 502);
    zai.recordModelClaimOutcome(model, 502);
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  recordProviderUnavailable("zai", {
    reason: "backend_cooldown", now: 1_000, retryAt: 301_000, path,
  });

  const calls = [];
  const results = await runDueCapacityProbes(
    models.map((model) => ({ provider: "zai", model })),
    async (target, { probeOwner }) => {
      calls.push(target.model);
      zai.recordModelClaimOutcome(target.model, 200);
      finishCapacityProbe("zai", true, {
        probeOwner, model: target.model, now: 301_000, path,
      });
      return { status: 200 };
    },
    { now: 301_000, path },
  );

  assert.deepEqual(calls, models);
  assert.equal(results.length, models.length);
  for (const model of models) assert.equal(zai.getModelClaimHealth(model).quarantined, false);
});

test("scheduled mixed recovery leaves unproven exact claims quarantined", async () => {
  _resetCapacityProbesForTests();
  const path = store("mixed-exact-claims");
  const models = ["glm-4.6", "glm-4.7", "glm-5.3"];
  const router = createRouter({ backends: { zai: {
    url: "http://127.0.0.1:9/v1", models, provider_purity: true,
    model_claim_quarantine_threshold: 2, model_claim_quarantine_cooldown_ms: 1,
  } } });
  const zai = router.getBackend("zai");
  for (const model of models) {
    zai.recordModelClaimOutcome(model, 502);
    zai.recordModelClaimOutcome(model, 502);
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
  recordProviderUnavailable("zai", {
    reason: "backend_cooldown", now: 1_000, retryAt: 301_000, path,
  });

  const calls = [];
  await runDueCapacityProbes(
    models.map((model) => ({ provider: "zai", model })),
    async (target, { probeOwner }) => {
      calls.push(target.model);
      const success = target.model !== "glm-4.7";
      zai.recordModelClaimOutcome(target.model, success ? 200 : 502);
      finishCapacityProbe("zai", success, {
        probeOwner, model: target.model, reason: success ? null : "backend_cooldown",
        now: 301_000, path,
      });
      return { status: success ? 200 : 502 };
    },
    { now: 301_000, path },
  );

  assert.deepEqual(calls, models);
  assert.equal(zai.getModelClaimHealth("glm-4.6").quarantined, false);
  assert.equal(zai.getModelClaimHealth("glm-4.7").quarantined, true);
  assert.equal(zai.getModelClaimHealth("glm-5.3").quarantined, false);
});
