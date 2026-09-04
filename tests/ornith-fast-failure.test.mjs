import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

import {
  createRouter,
  routeAndSend,
  ModelClaimQuarantinedError,
  isFastModelClaimFailure,
} from "../src/proxy/router.mjs";
import { buildModelCatalog, excludedModelIds, withoutExcludedModels } from "../src/proxy/advertise.mjs";
import { resolveBucket } from "../src/policy/buckets.mjs";

const HEADERS = { "content-type": "application/json" };
const body = (model) => Buffer.from(JSON.stringify({ model, messages: [{ role: "user", content: "alive" }] }));

function upstream(status) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ status }));
    });
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

function controlledUpstream() {
  let status = 502;
  let delay = 0;
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => setTimeout(() => {
        requests.push({ authorization: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(status === 200 ? {
          id: "synthetic", object: "chat.completion", created: 0, model: "glm-4.6",
          choices: [{ index: 0, message: { role: "assistant", content: "alive" }, finish_reason: "stop" }],
        } : { error: { code: "invalid_upstream_completion" } }));
      }, delay));
    });
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      requests,
      setResponse(nextStatus, nextDelay = 0) { status = nextStatus; delay = nextDelay; },
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

async function refusedUrl() {
  const socket = net.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return `http://127.0.0.1:${port}/v1`;
}

describe("exact backend-model fast-failure quarantine", () => {
  test("404, 410, 502 and connection refusal are fast; completion timeout is separate", () => {
    for (const status of [404, 410, 502]) assert.equal(isFastModelClaimFailure(status), true);
    assert.equal(isFastModelClaimFailure(504), false, "slow completion timeout is not this classifier");
  });

  test("repeated 404 quarantines only the wrong claimer while another valid claimer still serves", async () => {
    const dead = await upstream(404);
    const live = await upstream(200);
    try {
      const model = "shared-ornith";
      const router = createRouter({ backends: {
        wrong: { url: dead.url, models: [model], priority: 1, quarantine_threshold: 99 },
        valid: { url: live.url, models: [model], priority: 2, quarantine_threshold: 99 },
      }});
      for (let i = 0; i < 3; i++) {
        const r = await routeAndSend(router, { model }, "/v1/chat/completions", "POST", HEADERS, body(model), false);
        assert.equal(r.status, 404);
      }
      const candidates = await router.route({ model });
      assert.deepEqual(candidates.map((c) => c.backendId), ["valid"]);
      assert.equal(router.getBackend("wrong").isModelClaimAvailable(model), false);
      assert.equal(router.getBackend("valid").isModelClaimAvailable(model), true);
    } finally {
      await dead.close();
      await live.close();
    }
  });

  for (const fixture of [
    { name: "gateway 502", make: () => upstream(502) },
    { name: "connection-refused absent listener", make: async () => ({ url: await refusedUrl(), close: async () => {} }) },
  ]) {
    test(`repeated ${fixture.name} quarantines the exact claim without waiting for a timeout`, async () => {
      const dead = await fixture.make();
      try {
        const model = `ornith-${fixture.name}`;
        const router = createRouter({ backends: {
          exact: { url: dead.url, models: [model], priority: 1, quarantine_threshold: 99 },
        }});
        for (let i = 0; i < 3; i++) {
          const r = await routeAndSend(router, { model }, "/v1/chat/completions", "POST", HEADERS, body(model), false);
          assert.equal(r.status, 502);
        }
        await assert.rejects(router.route({ model }), ModelClaimQuarantinedError);
      } finally {
        await dead.close();
      }
    });
  }

  test("GLM claim recovery is one half-open probe and stays hidden until 2xx", async () => {
    const dead = await controlledUpstream();
    try {
      const model = "glm-4.6";
      process.env.SKGATEWAY_TEST_ZAI_KEY = "synthetic-test-token";
      const config = { backends: {
        zai: {
          url: dead.url,
          models: [model],
          auth_type: "api_key",
          api_key_env: "SKGATEWAY_TEST_ZAI_KEY",
          priority: 1,
          quarantine_threshold: 3,
          quarantine_cooldown_ms: 10,
          cooldown_ms: 1,
          model_claim_quarantine_cooldown_ms: 10,
        },
      }};
      const router = createRouter(config);
      for (let i = 0; i < 3; i++) {
        const result = await routeAndSend(
          router, { model }, "/v1/chat/completions", "POST", HEADERS, body(model), false,
        );
        assert.equal(result.status, 502);
      }

      const backend = router.getBackend("zai");
      const quarantined = backend.getModelClaimHealth(model);
      assert.equal(quarantined.status, "quarantined");
      assert.equal(quarantined.lastFailureReason, "invalid_upstream_completion");
      assert.equal(router.getHealth().zai.modelClaims[model].quarantined, true);
      const unavailable = buildModelCatalog(config.backends, router, "flag")[0];
      assert.equal(unavailable.status, "unavailable");
      assert.equal(unavailable.claim_health.status, "quarantined");
      assert.deepEqual(buildModelCatalog(config.backends, router, "hide"), []);
      await assert.rejects(router.route({ model }), ModelClaimQuarantinedError);

      await new Promise((resolve) => setTimeout(resolve, 15));
      dead.setResponse(200, 20);
      const beforeProbe = dead.requests.length;
      const probe = routeAndSend(
        router, { model }, "/v1/chat/completions", "POST", HEADERS, body(model), false,
      );
      const suppressed = routeAndSend(
        router, { model }, "/v1/chat/completions", "POST", HEADERS, body(model), false,
      );
      assert.equal(backend.getModelClaimHealth(model).status, "half_open");
      const [probeResult, suppressedResult] = await Promise.allSettled([probe, suppressed]);
      assert.equal(probeResult.status, "fulfilled");
      assert.equal(probeResult.value.status, 200);
      assert.equal(suppressedResult.status, "fulfilled");
      assert.equal(suppressedResult.value.status, 503);
      assert.equal(JSON.parse(suppressedResult.value.body).error.type, "model_claim_quarantined");
      assert.equal(dead.requests.length - beforeProbe, 1, "only one half-open request reaches upstream");
      assert.equal(dead.requests.at(-1).authorization, "Bearer synthetic-test-token");
      assert.deepEqual(dead.requests.at(-1).body.messages, [{ role: "user", content: "alive" }]);
      assert.equal(backend.getModelClaimHealth(model), null);
      assert.equal(buildModelCatalog(config.backends, router, "flag")[0].status, "available");

      for (let i = 0; i < 3; i++) backend.recordModelClaimOutcome(
        model, 502, "invalid_upstream_completion",
      );
      assert.equal(backend.getModelClaimHealth(model).status, "quarantined");
      assert.equal(
        backend.getModelClaimHealth(model).lastFailureReason,
        "invalid_upstream_completion",
      );
    } finally {
      delete process.env.SKGATEWAY_TEST_ZAI_KEY;
      await dead.close();
    }
  });
});

test("source purge leaves zero dead Ornith catalog and bucket members, with buckets disabled", () => {
  const cfg = load(readFileSync(new URL("../config/skgateway.yaml", import.meta.url), "utf8"));
  const dead = new Set(["ornith-1.5-9b", "ornith-1.0-35b", "ornith-big", "ornith-1.0-9b"]);
  const excluded = excludedModelIds(cfg);
  assert.deepEqual([...excluded].filter((id) => dead.has(id)).sort(), [...dead].sort());
  assert.notEqual(cfg.routing?.buckets_enabled, true);

  const advertised = buildModelCatalog(cfg.backends, null, "off", excluded);
  assert.deepEqual(advertised.filter((m) => dead.has(m.id)), []);

  const staleCache = [...dead].map((id) => ({
    id,
    url: "http://dead.invalid/v1",
    provider: "ornith",
    capabilities: { trust_zone: 0, size_class: "L", sovereignty: "local" },
  }));
  const catalog = withoutExcludedModels(staleCache, excluded);
  const bucket = resolveBucket({ bucket: { model_class: "S", sensitivity: "secret" }, catalog });
  assert.deepEqual(bucket.members.filter((m) => dead.has(m.id)), []);
});

test("four aliases on one llama-server report one physical server", () => {
  const url = "http://127.0.0.1:11439/v1";
  const catalog = ["qwen-a", "qwen-b", "qwen-c", "qwen-d"].map((id) => ({
    id,
    provider: "chiap08-qwen38",
    url,
    capabilities: { trust_zone: 0, size_class: "L", sovereignty: "local" },
  }));
  const { members } = resolveBucket({ bucket: { model_class: "S", sensitivity: "secret" }, catalog });
  assert.equal(members.length, 4, "addressable aliases remain visible");
  assert.equal(new Set(members.map((m) => m.physical_resource_id)).size, 1, "capacity is one physical llama-server");
});
