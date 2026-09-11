import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "skgw-qwen-role-"));
const registryPath = join(dir, "registry.yaml");
process.env.SKMODELS_REGISTRY = registryPath;

let upstream;
let upstreamUrl;
let dispatches = 0;

before(async () => {
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      dispatches += 1;
      const received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "qwen-role-test",
        model: received.model,
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  writeFileSync(registryPath, [
    "backends:",
    "  qwen38:",
    `    url: ${upstreamUrl}`,
    "    model: qwen3.8-27b-huihui-abliterated-q4_k_m",
    "roles:",
    "  sk-default: qwen38",
    "  sk-qwen: qwen38",
    "defaults:",
    "  role: sk-default",
    "",
  ].join("\n"));
});

after(async () => {
  await new Promise((resolve) => upstream.close(resolve));
});

test("shipped registry explicitly binds sk-qwen to qwen38", async () => {
  const { resolve } = await import("../src/proxy/registry.mjs");
  const shipped = fileURLToPath(new URL("../config/registry.yaml", import.meta.url));
  const resolved = resolve({ model: "sk-qwen" }, shipped);
  assert.equal(resolved.backend, "qwen38");
  assert.equal(resolved.model, "qwen3.8-27b-huihui-abliterated-q4_k_m");
  assert.equal(resolved.role, "sk-qwen");
});

test("resolver rejects unknown sk roles but retains nonlogical defaults", async () => {
  const { resolve } = await import("../src/proxy/registry.mjs");
  assert.equal(resolve({ model: "sk-does-not-exist" }), null);
  const ordinary = resolve({ model: "vendor/concrete-model" });
  assert.equal(ordinary.backend, "qwen38");
  assert.equal(ordinary.role, "sk-default");
  assert.equal(ordinary.via, "default");
});

test("sk-qwen resolves and routes to Qwen38 with exact attribution", async () => {
  const { resolve } = await import("../src/proxy/registry.mjs");
  const { createRouter, routeAndSend } = await import("../src/proxy/router.mjs");
  const concrete = "qwen3.8-27b-huihui-abliterated-q4_k_m";

  const resolved = resolve({ model: "sk-qwen" });
  assert.equal(resolved.backend, "qwen38");
  assert.equal(resolved.model, concrete);
  assert.equal(resolved.role, "sk-qwen");
  assert.equal(resolved.via, "role");

  const router = createRouter({
    backends: {
      qwen38: { url: upstreamUrl, auth_type: "none", models: [concrete] },
      wildcard: { url: "http://127.0.0.1:9/v1", auth_type: "none", models: ["*"] },
    },
  });
  const result = await routeAndSend(
    router,
    { model: "sk-qwen", agentId: "test" },
    "/chat/completions",
    "POST",
    { "content-type": "application/json" },
    Buffer.from(JSON.stringify({ model: "sk-qwen", messages: [{ role: "user", content: "ping" }] })),
    false,
  );

  assert.equal(result.status, 200);
  assert.equal(result.requestedModel, "sk-qwen");
  assert.equal(result.backendId, "qwen38");
  assert.equal(result.servedModel, concrete);
  assert.equal(result.role, "sk-qwen");
  assert.equal(result.logicalRoute, "sk-qwen");
});

test("unknown sk role fails closed without reaching a wildcard backend", async () => {
  const { createRouter, routeAndSend } = await import("../src/proxy/router.mjs");
  const beforeDispatches = dispatches;
  const router = createRouter({
    backends: {
      wildcard: { url: upstreamUrl, auth_type: "none", models: ["*"] },
    },
  });
  const result = await routeAndSend(
    router,
    { model: "sk-does-not-exist", agentId: "test" },
    "/chat/completions",
    "POST",
    { "content-type": "application/json" },
    Buffer.from(JSON.stringify({ model: "sk-does-not-exist", messages: [] })),
    false,
  );

  assert.equal(result.status, 404);
  assert.equal(JSON.parse(result.body).error.code, "unknown_logical_role");
  assert.equal(result.requestedModel, "sk-does-not-exist");
  assert.equal(dispatches, beforeDispatches);
});

test("an undeclared concrete model retains normal wildcard routing", async () => {
  const { createRouter, routeAndSend } = await import("../src/proxy/router.mjs");
  const router = createRouter({
    backends: {
      wildcard: { url: upstreamUrl, auth_type: "none", models: ["*"] },
    },
  });
  const result = await routeAndSend(
    router,
    { model: "vendor/concrete-model", agentId: "test" },
    "/chat/completions",
    "POST",
    { "content-type": "application/json" },
    Buffer.from(JSON.stringify({ model: "vendor/concrete-model", messages: [] })),
    false,
  );
  assert.equal(result.status, 200);
  assert.equal(result.backendId, "wildcard");
  assert.equal(result.requestedModel, "vendor/concrete-model");
});
