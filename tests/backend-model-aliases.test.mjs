/**
 * backend-model-aliases.test.mjs: backends.<id>.model_aliases lets two
 * name-strict upstreams that both serve "qwen3.8-27b" sit behind gateway ids
 * of their own, without stealing requests for another backend's qwen3.8-27b.
 *
 * Run with:  node --test tests/backend-model-aliases.test.mjs
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REG_DIR = mkdtempSync(join(tmpdir(), "skgw-bma-"));
process.env.SKMODELS_REGISTRY = join(REG_DIR, "registry.yaml");
process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = join(REG_DIR, "model_catalog_store.json");
writeFileSync(process.env.SKMODELS_REGISTRY, "backends: {}\nroles: {}\n", "utf8");

const { createRouter, routeAndSend } = await import("../src/proxy/router.mjs");
const { assertProviderRoutes } = await import("../src/config.mjs");

// A vLLM-like upstream: rejects any model id except the one it serves.
function strictUpstream(name, served) {
  const seen = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let buf = "";
      req.on("data", (c) => { buf += c; });
      req.on("end", () => {
        if (req.url.startsWith("/v1/models") || req.url.startsWith("/health")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ data: [{ id: served }] }));
        }
        const model = JSON.parse(buf || "{}").model;
        seen.push(model);
        if (model !== served) {
          res.writeHead(404, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { message: `The model \`${model}\` does not exist.` } }));
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "x", object: "chat.completion", model, served_by: name,
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({
      base: `http://127.0.0.1:${server.address().port}/v1`, seen,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

describe("per-backend model_aliases", () => {
  let a, b, other, router;
  const H = { "content-type": "application/json" };
  const send = (model) => routeAndSend(router, { model }, "/v1/chat/completions", "POST", H,
    Buffer.from(JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] })), false);

  before(async () => {
    a = await strictUpstream("a", "qwen3.8-27b");
    b = await strictUpstream("b", "qwen3.8-27b");
    other = await strictUpstream("other", "qwen3.8-27b");
    router = createRouter({
      backends: {
        "tyler-primary": { url: a.base, auth_type: "none", no_failover: true, priority: 3,
          models: ["tyler-primary"], model_aliases: { "tyler-primary": "qwen3.8-27b" } },
        "tyler-secondary": { url: b.base, auth_type: "none", no_failover: true, priority: 3,
          models: ["tyler-secondary"], model_aliases: { "tyler-secondary": "qwen3.8-27b" } },
        chiap08: { url: other.base, auth_type: "none", priority: 3, models: ["qwen3.8-27b"] },
      },
      failover: false,
    });
  });
  after(async () => { await a.close(); await b.close(); await other.close(); });

  test("gateway id reaches only its backend, under the upstream name", async () => {
    const res = await send("tyler-primary");
    assert.equal(res.status, 200);
    assert.deepEqual(a.seen, ["qwen3.8-27b"]);
    assert.equal(b.seen.length, 0);
    assert.equal(other.seen.length, 0);
    const res2 = await send("tyler-secondary");
    assert.equal(res2.status, 200);
    assert.deepEqual(b.seen, ["qwen3.8-27b"]);
  });

  test("the shared upstream name still routes to its own backend only", async () => {
    const before = [a.seen.length, b.seen.length];
    const res = await send("qwen3.8-27b");
    assert.equal(res.status, 200);
    assert.equal(other.seen.at(-1), "qwen3.8-27b");
    assert.deepEqual([a.seen.length, b.seen.length], before);
  });

  test("config validation rejects a malformed model_aliases", () => {
    const errs = [];
    try {
      assertProviderRoutes({ backends: { x: { url: "http://h/v1", auth_type: "none", models: ["m"], model_aliases: ["m"] } } }, errs);
    } catch { /* it may throw after collecting */ }
    assert.ok(errs.some((e) => e.includes("model_aliases")), errs.join("; "));
  });
});
