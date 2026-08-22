/**
 * Registry-route auth regression tests (no external network; one loopback
 * http server per test to observe the exact upstream request).
 *
 * THE BUG THIS PINS (measured live on chiap01, 2026-08-22): a skmodels
 * registry role whose target url points at an AUTHENTICATED configured
 * backend (auth_type codex_oauth / api_key / oauth) used to build its
 * candidate with hardcoded `authHeaders: {}`. The client's own credential
 * headers are stripped before forwarding (card 6e61f798), so the request
 * reached the upstream with NO credentials at all and 401'd. Local llama.cpp
 * targets were unaffected (they need no auth), which is exactly why the
 * empty-hardcode looked right until a role pointed at the codex backend.
 *
 * The fix: when the registry url matches a CONFIGURED backend, the candidate
 * is built from that backend (its buildAuthHeaders(), shared health/pooling,
 * localUrl fed only for genuinely local urls). Unconfigured registry urls
 * keep the synthetic reg: pool with empty auth, byte-identical to before.
 *
 * SETUP NOTE: routeAndSend's registry block resolves through registry.mjs's
 * module-level REGISTRY_PATH, which binds $SKMODELS_REGISTRY at import time.
 * The env var is therefore set BEFORE the dynamic import of router.mjs below,
 * the same convention tests/bucket-routing-integration.test.mjs uses. The one
 * registry file is rewritten between tests; loadRegistry's mtime cache picks
 * the rewrite up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

const dir = mkdtempSync(join(tmpdir(), "reg-auth-"));
const REGISTRY = join(dir, "registry.yaml");
writeFileSync(REGISTRY, "# placeholder until each test rewrites it\n");
process.env.SKMODELS_REGISTRY = REGISTRY;

const { createRouter, routeAndSend } = await import("../src/proxy/router.mjs");

const CHAT_BODY = (model) => Buffer.from(JSON.stringify({
  model,
  messages: [{ role: "user", content: "hi" }],
}));

/** Loopback OpenAI-compatible server capturing authorization + body model. */
async function captureServer() {
  const captured = { auth: "NONE-RECEIVED", bodyModel: null, path: null };
  const server = await new Promise((resolve) => {
    const s = createServer((req, res) => {
      captured.path = req.url;
      captured.auth = req.headers.authorization || null;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try { captured.bodyModel = JSON.parse(body).model; } catch { /* keep null */ }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "x", object: "chat.completion", created: 1, model: captured.bodyModel || "m",
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { server, captured };
}

test("registry role -> CONFIGURED authenticated backend carries its auth headers", async () => {
  const { server, captured } = await captureServer();
  try {
    const port = server.address().port;
    writeFileSync(REGISTRY, [
      "backends:",
      "  remotebox:",
      `    url: http://127.0.0.1:${port}/v1`,
      "    model: remote-model-x",
      "roles:",
      "  sk-remote: remotebox",
    ].join("\n"));
    const router = createRouter({
      backends: {
        remotebox: {
          url: `http://127.0.0.1:${port}/v1`,
          auth_type: "api_key",
          api_key: "sk-regression-key",
          models: ["remote-model-x"],
          priority: 1,
        },
      },
      failover: false,
      siem_log: false,
    });
    const res = await routeAndSend(
      router, { model: "sk-remote" }, "/v1/chat/completions", "POST", {}, CHAT_BODY("sk-remote"), false,
    );
    assert.equal(res.status, 200);
    assert.equal(captured.auth, "Bearer sk-regression-key",
      "configured backend auth must reach the upstream (was hardcoded empty before the fix)");
    assert.equal(captured.bodyModel, "remote-model-x", "body model rewritten to the registry target");
  } finally {
    server.close();
  }
});

test("registry role -> UNCONFIGURED url keeps the synthetic reg: pool (no auth, unchanged)", async () => {
  const { server, captured } = await captureServer();
  try {
    const port = server.address().port;
    writeFileSync(REGISTRY, [
      "backends:",
      "  orphan:",
      `    url: http://127.0.0.1:${port}/v1`,
      "    model: orphan-model",
      "roles:",
      "  sk-orphan: orphan",
    ].join("\n"));
    const router = createRouter({
      backends: {}, // nothing configured: the orphan url is undeclared
      failover: false,
      siem_log: false,
    });
    const res = await routeAndSend(
      router, { model: "sk-orphan" }, "/v1/chat/completions", "POST", {}, CHAT_BODY("sk-orphan"), false,
    );
    assert.equal(res.status, 200);
    assert.equal(captured.auth, null, "synthetic reg pool stays unauthenticated, same as before the fix");
    assert.equal(captured.bodyModel, "orphan-model");
  } finally {
    server.close();
  }
});

test("configured codex_oauth backend bound by a registry role builds codex headers", async () => {
  const credsPath = join(dir, "auth.json");
  writeFileSync(credsPath, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "at-reg", refresh_token: "rt", account_id: "acc-reg" },
  }));
  writeFileSync(REGISTRY, [
    "backends:",
    "  codex-role-target:",
    "    url: https://chatgpt.com/backend-api/codex",
    "    model: gpt-5.6-sol",
    "roles:",
    "  sk-codex: codex-role-target",
  ].join("\n"));
  const router = createRouter({
    backends: {
      codex: {
        url: "https://chatgpt.com/backend-api/codex",
        auth_type: "codex_oauth",
        credentials_path: credsPath,
        models: ["gpt-5.6-sol", "gpt-5.4-mini"],
        priority: 2,
      },
    },
    failover: false,
    siem_log: false,
  });
  const codex = [...router.getBackends().values()].find((b) => b.id === "codex");
  assert.ok(codex, "codex backend configured");
  const headers = await codex.buildAuthHeaders();
  assert.equal(headers.authorization, "Bearer at-reg");
  assert.equal(headers["chatgpt-account-id"], "acc-reg");
});

test("cleanup", () => {
  rmSync(dir, { recursive: true, force: true });
});
