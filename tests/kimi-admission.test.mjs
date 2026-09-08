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

const config = loadYaml(readFileSync(new URL("../config/skgateway-codex.yaml", import.meta.url), "utf8"));

describe("Kimi admission contract", () => {
  test("declares exact one-active/one-queued family domains and mappings", () => {
    assert.deepEqual(config.pooling.capacity_domains["kimi-for-coding"], {
      members: ["kimi-for-coding", "reg:kimi-for-coding"], max: 1, maxQueue: 1, queueTimeoutMs: 30000,
    });
    assert.deepEqual(config.pooling.capacity_domains["kimi-k3"], {
      members: ["kimi-k3", "reg:k3"], max: 1, maxQueue: 1, queueTimeoutMs: 30000,
    });
    assert.equal(config.backends["kimi-for-coding"].models[0], "kimi-for-coding");
    assert.equal(config.backends["kimi-k3"].models[0], "k3");
    assert.equal(config.backends["kimi-for-coding"].require_observed_health, true);
    assert.equal(config.backends["kimi-k3"].require_observed_health, true);
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
