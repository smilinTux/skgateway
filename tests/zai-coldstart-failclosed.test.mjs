import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { load as loadYaml } from "js-yaml";

const dir = mkdtempSync(join(tmpdir(), "skgw-zai-coldstart-"));
process.env.SKMODELS_REGISTRY = join(dir, "no-registry.yaml");
process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = join(dir, "lifecycle.json");
const { createRouter, routeAndSend } = await import("../src/proxy/router.mjs");

const headers = { "content-type": "application/json" };
const body = Buffer.from(JSON.stringify({ model: "glm-4.6", messages: [{ role: "user", content: "hi" }] }));

test("production profile keeps Z.ai namespace discovery managed", () => {
  const config = loadYaml(readFileSync(
    new URL("../config/skgateway-codex.yaml", import.meta.url), "utf8",
  ));
  assert.equal(config.backends.zai.discovery, "zai");
  assert.deepEqual(config.backends.zai.models, []);
  assert.equal(config.discovery.providers.zai.enabled, true);
});

function upstream(name) {
  let calls = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      calls += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "glm-4.6", choices: [{ message: { content: name } }] }));
    });
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      calls: () => calls,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

async function request(router, events = []) {
  return routeAndSend(router, { model: "glm-4.6", agentId: "coldstart-test" },
    "/chat/completions", "POST", headers, body, false, (event) => events.push(event));
}

test("Z.ai delayed discovery fails closed, never calls nvidia, then records revisioned success and recovery", async (t) => {
  const zai = await upstream("zai");
  const nvidia = await upstream("nvidia");
  t.after(() => Promise.all([zai.close(), nvidia.close()]));

  const router = createRouter({ backends: {
    nvidia: { url: nvidia.url, auth_type: "none", models: ["nvidia-only"], priority: 1 },
    zai: { url: zai.url, auth_type: "zai_oauth", models: [], priority: 2 },
  }});

  const cold = await request(router);
  assert.equal(cold.status, 503);
  assert.equal(JSON.parse(cold.body).error.code, "model_discovery_not_ready");
  assert.equal(nvidia.calls(), 0);
  assert.equal(zai.calls(), 0);

  router.registerDiscoveredModels("zai", [], { ok: false, at: 100 });
  const connectionFailure = await request(router);
  assert.equal(connectionFailure.status, 503);
  assert.equal(JSON.parse(connectionFailure.body).discovery_status, "failed");
  assert.equal(nvidia.calls(), 0);

  router.registerDiscoveredModels("zai", ["glm-4.6"], { ok: false, stale: true, at: 200 });
  const stale = await request(router);
  assert.equal(stale.status, 200, "a stale catalog retains only its prior explicit claims");
  assert.equal(stale.backendId, "zai");
  assert.equal(nvidia.calls(), 0);

  router.registerDiscoveredModels("zai", ["glm-4.6"], { ok: true, at: 300 });
  const events = [];
  const recovered = await request(router, events);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.backendId, "zai");
  assert.equal(recovered.servedModel, "glm-4.6");
  assert.ok(recovered.readinessRevision > 0);
  assert.ok(recovered.discoveryRevision >= 3);
  const response = events.find((event) => event.event_type === "response");
  assert.equal(response.details.requested_model, "glm-4.6");
  assert.equal(response.details.chosen_backend, "zai");
  assert.equal(response.details.served_model, "glm-4.6");
  assert.equal(response.details.readiness_revision, recovered.readinessRevision);
  assert.equal(response.details.discovery_revision, recovered.discoveryRevision);
  assert.equal(nvidia.calls(), 0);
});

test("Z.ai discovery timeout remains pending and fail-closed", async () => {
  const nvidia = await upstream("nvidia");
  try {
    const router = createRouter({ backends: {
      nvidia: { url: nvidia.url, auth_type: "none", models: ["nvidia-only"], priority: 1 },
      zai: { url: "http://127.0.0.1:1/v1", auth_type: "zai_oauth", models: [], priority: 2 },
    }});
    const result = await Promise.race([
      request(router),
      new Promise((_, reject) => setTimeout(() => reject(new Error("request did not fail fast")), 100)),
    ]);
    assert.equal(result.status, 503);
    assert.equal(nvidia.calls(), 0);
  } finally {
    await nvidia.close();
  }
});

test("successful empty Z.ai discovery still owns raw GLM namespace fail closed", async (t) => {
  const qwen = await upstream("qwen");
  const nvidia = await upstream("nvidia");
  t.after(() => Promise.all([qwen.close(), nvidia.close()]));
  const router = createRouter({ backends: {
    qwen: { url: qwen.url, auth_type: "none", models: ["qwen-model"], priority: 1 },
    nvidia: { url: nvidia.url, auth_type: "none", models: ["nvidia-model"], priority: 1 },
    zai: {
      url: "http://127.0.0.1:1/v1", auth_type: "zai_oauth", discovery: "zai",
      models: [], priority: 2,
    },
  }});
  router.registerDiscoveredModels("zai", [], { ok: true, at: 300 });
  for (const model of ["glm-4.6", "glm-4.7", "glm-5.3"]) {
    const result = await routeAndSend(router, { model, agentId: "production-config-test" },
      "/chat/completions", "POST", headers,
      Buffer.from(JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] })),
      false);
    assert.equal(result.status, 503);
    assert.equal(JSON.parse(result.body).error.code, "model_discovery_not_ready");
  }
  assert.equal(qwen.calls(), 0);
  assert.equal(nvidia.calls(), 0);
});
