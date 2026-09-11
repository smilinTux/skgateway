/** Local-only Kimi admission and compatibility probes. No provider calls. */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  Backend, createRouter, routeAndSend, ModelOwnerDownError, shouldUseRegistryRouting,
} from "../src/proxy/router.mjs";
import { ConnectionPool } from "../src/proxy/connection-pool.mjs";
import { buildCapabilityCatalog } from "../src/ranking/catalog.mjs";
import { loadCardOverrides, applyCardOverlays, CARD_OVERRIDES_PATH } from "../src/discovery.mjs";
import { loadProviderPostures } from "../src/discovery/provider-posture.mjs";
import { attributionHeaders } from "../src/metrics/attribution.mjs";
import {
  parseBucketId, resolveBucket, requiresToolUse, selectProviderBucketMember,
} from "../src/policy/buckets.mjs";

const config = loadYaml(readFileSync(new URL("../config/skgateway-codex.yaml", import.meta.url), "utf8"));

describe("Kimi admission contract", () => {
  test("declares exact one-active/one-queued family domains and mappings", () => {
    assert.deepEqual(config.pooling.capacity_domains["kimi-for-coding"], {
      members: ["kimi-for-coding", "reg:kimi-for-coding", "reg:kimi-for-coding-highspeed"], max: 1, maxQueue: 1, queueTimeoutMs: 30000,
    });
    assert.deepEqual(config.pooling.capacity_domains["kimi-k3"], {
      members: ["kimi-k3", "reg:k3", "reg:k3-256k"], max: 1, maxQueue: 1, queueTimeoutMs: 30000,
    });
    assert.deepEqual(config.backends["kimi-for-coding"].models, ["kimi-for-coding-highspeed", "kimi-for-coding"]);
    assert.deepEqual(config.backends["kimi-k3"].models, ["k3-256k", "k3"]);
    for (const id of ["kimi-for-coding-highspeed", "kimi-for-coding", "k3-256k", "k3"]) {
      assert.ok(config.model_limits[id], `${id} has an exact context-derived request limit`);
    }
    assert.equal(config.backends["kimi-for-coding"].require_observed_health, true);
    assert.equal(config.backends["kimi-k3"].require_observed_health, true);
  });

  test("four real ids map to exact S, M, L, XL Kimi buckets with paid attribution", () => {
    const ids = ["kimi-for-coding-highspeed", "kimi-for-coding", "k3-256k", "k3"];
    const models = applyCardOverlays(
      ids.map((id) => ({ id, provider: id.startsWith("k3") ? "kimi-k3" : "kimi-for-coding", free: false })),
      loadCardOverrides(CARD_OVERRIDES_PATH),
    );
    const catalog = buildCapabilityCatalog(models, {
      providers: loadProviderPostures(),
      getLifecycleFn: () => ({ state: "active" }),
    });
    for (const [index, cls] of ["S", "M", "L", "XL"].entries()) {
      const { members } = resolveBucket({ bucket: parseBucketId(`sk-kimi-${cls.toLowerCase()}`), catalog });
      assert.equal(members[0].id, ids[index]);
      assert.equal(members[0].model_class, cls);
      assert.equal(members[0].cost_tier, "paid-cloud");
      assert.ok(members.every((member) => member.id === ids[index] || ["S", "M", "L", "XL"].indexOf(member.model_class) > index));
    }
  });

  test("tool-bearing Kimi S excludes highspeed and escalates within Kimi", () => {
    const ids = ["kimi-for-coding-highspeed", "kimi-for-coding", "k3-256k", "k3"];
    const catalog = buildCapabilityCatalog(applyCardOverlays(
      ids.map((id) => ({ id, provider: id.startsWith("k3") ? "kimi-k3" : "kimi-for-coding", free: false })),
      loadCardOverrides(CARD_OVERRIDES_PATH),
    ), { providers: loadProviderPostures(), getLifecycleFn: () => ({ state: "active" }) });
    const resolved = resolveBucket({
      bucket: parseBucketId("sk-kimi-s"), catalog,
      requireToolUse: requiresToolUse({ tools: [{ type: "function" }] }),
    });
    assert.equal(resolved.members.some(({ id }) => id === "kimi-for-coding-highspeed"), false);
    assert.equal(resolved.members[0].id, "kimi-for-coding");
    assert.match(resolved.rejected.find(({ id }) => id === "kimi-for-coding-highspeed").reason, /sent tools/);
    assert.ok(resolved.members.every(({ id }) => ids.includes(id)));
  });

  test("exact Kimi tier wins rotation and a larger healthy tier is fallback", () => {
    const bucket = parseBucketId("sk-kimi-m");
    const members = [
      { id: "k3", model_class: "XL", cost_tier: "paid-cloud" },
      { id: "kimi-for-coding", model_class: "M", cost_tier: "paid-cloud" },
      { id: "k3-256k", model_class: "L", cost_tier: "paid-cloud" },
    ];
    for (const counter of [0, 1, 99]) {
      assert.equal(selectProviderBucketMember(bucket, members, counter).id, "kimi-for-coding");
    }
    assert.ok(["k3", "k3-256k"].includes(
      selectProviderBucketMember(bucket, members.filter(({ model_class }) => model_class !== "M"), 0).id,
    ));
    assert.equal(selectProviderBucketMember(bucket, [], 0), null);
  });

  test("Kimi bucket attribution preserves requested route, exact member, provider, and backend", () => {
    assert.deepEqual(attributionHeaders("req-kimi", {
      backendId: "kimi-k3",
      servedModel: "k3-256k",
      requestedModel: "sk-kimi-l",
      bucket: "sk-kimi-l",
      bucketMember: "k3-256k",
      provider: "kimi-k3",
      rail: "cloud",
    }), {
      "x-sk-req-id": "req-kimi",
      "x-sk-backend": "kimi-k3",
      "x-sk-model-served": "k3-256k",
      "x-sk-model-requested": "sk-kimi-l",
      "x-sk-bucket": "sk-kimi-l",
      "x-sk-bucket-member": "k3-256k",
      "x-sk-provider": "kimi-k3",
      "x-sk-rail": "cloud",
    });
  });

  test("unknown Kimi health fails closed and auth is read-only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kimi-admission-"));
    const creds = join(dir, "credentials.json");
    writeFileSync(creds, JSON.stringify({ access_token: "fixture-token" }));
    const cfg = { id: "kimi-for-coding", url: "https://api.kimi.ai/coding/v1", auth_type: "kimi_oauth",
      credentials_path: creds, models: ["kimi-for-coding"], require_observed_health: true };
    const backend = new Backend(cfg);
    assert.equal(backend.isAvailable(), false);
    assert.deepEqual(await backend.buildAuthHeaders(), { authorization: "Bearer fixture-token" });
    const router = createRouter({ backends: { "kimi-for-coding": cfg }, siem_log: false });
    await assert.rejects(() => router.route({ model: "kimi-for-coding", agentId: "probe" }),
      (error) => error instanceof ModelOwnerDownError);
    const probe = await router.route({
      model: "kimi-for-coding", agentId: "probe", bootstrapProbe: true,
    });
    assert.equal(probe.length, 1);
    assert.equal(probe[0].backendId, "kimi-for-coding");
    assert.equal(router.getHealth()["kimi-for-coding"].observed, false);
    backend.recordOutcome(true, 1);
    assert.equal(backend.isAvailable(), true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("capacity pool admits one and queues one", async () => {
    const pool = new ConnectionPool({ capacityDomains: {
      "kimi-for-coding": { members: ["kimi-for-coding", "reg:kimi-for-coding"], max: 1, maxQueue: 1, queueTimeoutMs: 1000 },
    } });
    const first = await pool.acquire("kimi-for-coding");
    const queued = pool.acquire("reg:kimi-for-coding");
    assert.equal(pool.getStats("kimi-for-coding").active, 1);
    assert.equal(pool.getStats("kimi-for-coding").queued, 1);
    pool.release(first);
    const second = await queued;
    assert.equal(second.inflightConcurrency, 1);
    pool.release(second);
  });
});

describe("Kimi synthetic request probes", () => {
  test("only an exact admission-owner bootstrap bypasses public registry routing", () => {
    const router = createRouter({ backends: {
      kimi: {
        url: "http://127.0.0.1:9/v1", auth_type: "none", models: ["kimi-for-coding"],
        require_observed_health: true,
      },
    }, siem_log: false });

    assert.equal(shouldUseRegistryRouting(router, {
      model: "kimi-for-coding", context: "public",
    }, true), false);
    assert.equal(shouldUseRegistryRouting(router, {
      model: "ordinary-synthetic", context: "public",
    }, true), true);
  });

  test("chat and tool schema succeed; timeout is bounded", async () => {
    const state = { delay: 0, body: null };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        state.body = JSON.parse(Buffer.concat(chunks));
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ready", tool_calls: [] } }] }));
        }, state.delay);
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const body = (model) => Buffer.from(JSON.stringify({ model, messages: [{ role: "user", content: "ready" }],
      tools: [{ type: "function", function: { name: "probe", parameters: { type: "object" } } }] }));
    const router = createRouter({ backends: {
      kimi: {
        url: `http://127.0.0.1:${port}/v1`, auth_type: "none", models: ["kimi-for-coding"], timeout_ms: 20,
        require_observed_health: true,
      },
      foreign: {
        url: "http://127.0.0.1:9/v1", auth_type: "none", models: ["*"], priority: 1,
      },
    }, failover: true, siem_log: false });
    await assert.rejects(() => router.route({ model: "kimi-for-coding", agentId: "ordinary" }),
      (error) => error instanceof ModelOwnerDownError);
    const ok = await routeAndSend(router, {
      model: "kimi-for-coding", agentId: "probe", context: "public",
    }, "/chat/completions", "POST",
      { "content-type": "application/json", "x-sk-context": "public", "x-sk-probe": "synthetic" },
      body("kimi-for-coding"), false);
    assert.equal(ok.status, 200);
    assert.equal(ok.backendId, "kimi");
    assert.equal(state.body.tools[0].function.name, "probe");
    state.delay = 80;
    const timeout = await routeAndSend(router, { model: "kimi-for-coding", agentId: "probe" }, "/chat/completions", "POST",
      { "content-type": "application/json" }, body("kimi-for-coding"), false);
    assert.equal(timeout.status, 504);
    await new Promise((resolve) => server.close(resolve));
  });

  test("temporary upstream error remains retryable evidence", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "temporary" } }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const router = createRouter({ backends: { kimi: {
      url: `http://127.0.0.1:${port}/v1`, auth_type: "none", models: ["kimi-for-coding"], timeout_ms: 100,
    } }, failover: false, siem_log: false });
    const result = await routeAndSend(router, { model: "kimi-for-coding", agentId: "probe" }, "/chat/completions", "POST",
      { "content-type": "application/json" }, Buffer.from(JSON.stringify({ model: "kimi-for-coding", messages: [] })), false);
    assert.equal(result.status, 503);
    await new Promise((resolve) => server.close(resolve));
  });
});
