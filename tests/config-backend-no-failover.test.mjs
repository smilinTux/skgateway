/**
 * config-backend-no-failover.test.mjs: a no_failover declaration on a
 * config/skgateway.yaml backend must block the registry-path cloud failover
 * when the registry target's MODEL is served by that backend, even though the
 * registry addresses it by a different host string (IP vs hostname). Control case proves the
 * same setup DOES fail over without the flag.
 *
 * Run with:  node --test tests/config-backend-no-failover.test.mjs
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { load as yamlLoad } from "js-yaml";

const REG_DIR = mkdtempSync(join(tmpdir(), "skgw-cfgnofo-"));
const REG_PATH = join(REG_DIR, "registry.yaml");
process.env.SKMODELS_REGISTRY = REG_PATH;
process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = join(REG_DIR, "model_catalog_store.json");

const { resetLocalHealth } = await import("../src/proxy/local-failover.mjs");
const { createRouter, routeAndSend, unmatchedNoFailoverBackends, warnUnmatchedNoFailover } = await import("../src/proxy/router.mjs");

function upstream(handler) {
  const state = { chat: 0 };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => handler(req, res, state));
    });
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}/v1`, state,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

describe("config backend no_failover", () => {
  let local, cloud;
  const H = { "content-type": "application/json" };
  const body = () => Buffer.from(JSON.stringify({ model: "sk-default", messages: [] }));
  const send = (router) => routeAndSend(router, { model: "sk-default" }, "/v1/chat/completions", "POST", H, body(), false);
  const mk = (noFailover) => createRouter({
    backends: {
      sovereign: { url: "http://chiap08-hostname.invalid:11439/v1", auth_type: "none", models: ["ornith-1.0-9b"], priority: 1,
        ...(noFailover ? { no_failover: true } : {}) },
      cloud: { url: cloud.base, auth_type: "none", models: ["*"], priority: 9 },
    },
    failover: true,
  });

  before(async () => {
    // The local upstream is DOWN: its liveness probe (/models) returns 503.
    local = await upstream((req, res, st) => {
      if (req.url.startsWith("/v1/models")) { res.writeHead(503); return res.end("{}"); }
      st.chat++; res.writeHead(502); res.end("{}");
    });
    cloud = await upstream((req, res, st) => {
      st.chat++; res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ served: "cloud" }));
    });
    // The registry entry deliberately does NOT carry no_failover: only the
    // skgateway.yaml backend does.
    writeFileSync(REG_PATH, `backends:
  ornith:
    url: ${local.base}
    model: ornith-1.0-9b
    kind: chat
roles:
  sk-default: ornith
defaults:
  role: sk-default
`, "utf8");
  });
  after(async () => { await local.close(); await cloud.close(); });
  beforeEach(() => {
    resetLocalHealth(); local.state.chat = 0; cloud.state.chat = 0;
    delete process.env.SKGATEWAY_LOCAL_FAILOVER;
    process.env.SKGATEWAY_LOCAL_FALLBACK_BACKEND = "cloud";
    process.env.SKGATEWAY_LOCAL_FALLBACK_MODEL = "deepseek-test";
    process.env.SKGATEWAY_LOCAL_HEALTH_TIMEOUT_MS = "1500";
    process.env.SKGATEWAY_LOCAL_HEALTH_TTL_MS = "20000";
  });

  test("control: without the flag a dead local backend fails over to cloud", async () => {
    const r = await send(mk(false));
    assert.equal(r.status, 200);
    assert.equal(cloud.state.chat, 1);
  });

  test("no_failover on the config backend blocks cloud substitution", async () => {
    const r = await send(mk(true));
    assert.notEqual(r.status, 200);
    assert.equal(cloud.state.chat, 0, "cloud must never be contacted");
  });
});

test("tracked registry template declares no_failover on the sovereign qwen38 backend", () => {
  const reg = yamlLoad(readFileSync(new URL("../config/registry.yaml", import.meta.url), "utf8"));
  assert.equal(reg.backends.qwen38.no_failover, true);
});

test("a no_failover backend that matches no registry route emits a startup warning", () => {
  const backends = [
    { id: "orphan", no_failover: true, models: ["nobody-serves-this"], url: "http://orphan:1/v1" },
    { id: "covered", no_failover: true, models: ["m1"], url: "http://covered:1/v1" },
    { id: "plain", models: ["m2"], url: "http://plain:1/v1" },
  ];
  const registry = { backends: { r: { url: "http://10.0.0.1:1/v1", model: "m1" } } };
  assert.deepEqual(unmatchedNoFailoverBackends(backends, registry), ["orphan"]);
  const logs = [];
  warnUnmatchedNoFailover(backends, registry, (m) => logs.push(m));
  assert.equal(logs.length, 1);
  assert.match(logs[0], /backend=orphan declares no_failover/);
});

test("repo config: report which no_failover config backends match the tracked registry template", () => {
  const cfg = yamlLoad(readFileSync(new URL("../config/skgateway.yaml", import.meta.url), "utf8"));
  const reg = yamlLoad(readFileSync(new URL("../config/registry.yaml", import.meta.url), "utf8"));
  const backends = Object.entries(cfg.backends).map(([id, b]) => ({ id, ...b }));
  const unmatched = unmatchedNoFailoverBackends(backends, reg);
  // qwen38 template route (tailnet IP) must cover both replicas by model id.
  assert.equal(unmatched.includes("chiap08-qwen38"), false);
  assert.equal(unmatched.includes("chiap01-qwen38"), false);
});
