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
