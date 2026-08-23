/**
 * codex backend auth + dispatch wiring tests (router-level, no network).
 *
 * Pins three things:
 *   1. Backend.buildAuthHeaders() for auth_type codex_oauth reads the Codex
 *      CLI auth.json shape and returns bearer + chatgpt-account-id, and
 *      re-reads the file when its mtime changes (tokens are refreshed
 *      externally and synced in; no restart should be needed).
 *   2. It NEVER writes the credentials file (refresh-token rotation is owned
 *      by the Codex CLI login host; see codex-adapter.mjs).
 *   3. Config validation accepts codex_oauth only with a credentials file,
 *      and credentials_path (the YAML-documented key) reaches the Backend.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Backend } from "../src/proxy/router.mjs";
import { assertProviderRoutes, loadConfig } from "../src/config.mjs";

const dir = mkdtempSync(join(tmpdir(), "codex-router-"));
const credsPath = join(dir, "auth.json");

function writeCreds(token, accountId) {
  writeFileSync(credsPath, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: token, refresh_token: "rt", account_id: accountId },
    last_refresh: "2026-08-22T00:00:00Z",
  }));
}

test("codex_oauth buildAuthHeaders: bearer + chatgpt-account-id from auth.json", async () => {
  writeCreds("at-1", "acc-1");
  const b = new Backend({
    id: "codex",
    url: "https://chatgpt.com/backend-api/codex",
    auth_type: "codex_oauth",
    credentials_path: credsPath,
    models: ["gpt-5.6-sol"],
  });
  assert.deepEqual(await b.buildAuthHeaders(), {
    authorization: "Bearer at-1",
    "chatgpt-account-id": "acc-1",
  });
});

test("codex_oauth: re-reads credentials when the file mtime changes (synced tokens, no restart)", async () => {
  writeCreds("at-1", "acc-1");
  const b = new Backend({
    id: "codex",
    url: "https://chatgpt.com/backend-api/codex",
    auth_type: "codex_oauth",
    credentials_path: credsPath,
    models: ["gpt-5.6-sol"],
  });
  assert.equal((await b.buildAuthHeaders()).authorization, "Bearer at-1");
  writeCreds("at-2", "acc-1");
  // mtime must actually advance for the cache to invalidate
  utimesSync(credsPath, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal((await b.buildAuthHeaders()).authorization, "Bearer at-2");
});

test("codex_oauth: never writes the credentials file (read-only by design)", async () => {
  writeCreds("at-1", "acc-1");
  const before = readFileSync(credsPath, "utf-8");
  const b = new Backend({
    id: "codex",
    url: "https://chatgpt.com/backend-api/codex",
    auth_type: "codex_oauth",
    credentials_path: credsPath,
    models: ["gpt-5.6-sol"],
  });
  await b.buildAuthHeaders();
  await b.buildAuthHeaders();
  assert.equal(readFileSync(credsPath, "utf-8"), before);
});

test("codex_oauth: missing/unreadable credentials degrade to empty headers with a warning", async () => {
  const b = new Backend({
    id: "codex",
    url: "https://chatgpt.com/backend-api/codex",
    auth_type: "codex_oauth",
    credentials_path: join(dir, "nope.json"),
    models: ["gpt-5.6-sol"],
  });
  assert.deepEqual(await b.buildAuthHeaders(), {});
});

test("credentials_path (the YAML key) reaches the Backend for oauth too", async () => {
  // Regression for the latent gap fixed with the codex backend: Backend used
  // to read only credentials_file, so a backend declared with the
  // YAML-documented credentials_path behaved like unauthenticated.
  const creds = join(dir, "claude.json");
  writeFileSync(creds, JSON.stringify({ access_token: "sk-ant-1", expires_at: 4102444800 }));
  const b = new Backend({
    id: "anthropic-direct",
    url: "https://api.anthropic.com/v1",
    auth_type: "oauth",
    credentials_path: creds,
    models: ["claude-opus-4-8"],
  });
  assert.equal(b._credentials_file, creds);
  const headers = await b.buildAuthHeaders();
  assert.equal(headers.authorization, "Bearer sk-ant-1");
});

test("config validation: codex_oauth requires a credentials file; unknown auth types rejected", () => {
  const errs = [];
  assertProviderRoutes({
    backends: {
      codex: { url: "https://chatgpt.com/backend-api/codex", auth_type: "codex_oauth" },
    },
  }, errs);
  assert.ok(errs.some((e) => e.includes("codex_oauth") && e.includes("credentials")));

  const errsOk = [];
  assertProviderRoutes({
    backends: {
      codex: {
        url: "https://chatgpt.com/backend-api/codex",
        auth_type: "codex_oauth",
        credentials_path: credsPath,
      },
    },
  }, errsOk);
  assert.deepEqual(errsOk, []);

  // the full config loader must accept codex_oauth as a valid auth type
  const cfgDir = mkdtempSync(join(tmpdir(), "codex-cfg-"));
  try {
    const cfgPath = join(cfgDir, "skgateway.yaml");
    writeFileSync(cfgPath, [
      "server: { port: 18799 }",
      "backends:",
      "  codex:",
      "    url: https://chatgpt.com/backend-api/codex",
      `    credentials_path: ${credsPath}`,
      "    auth_type: codex_oauth",
      "    models: [gpt-5.6-sol]",
      "    priority: 2",
    ].join("\n"));
    loadConfig({ configPath: cfgPath, watch: false });
    assert.ok(true, "codex_oauth accepted by the loader");
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
});

test("config validation accepts zai_oauth with a credentials file", () => {
  const errs = [];
  assertProviderRoutes({
    backends: {
      zai: {
        url: "https://api.z.ai/api/coding/paas/v4",
        auth_type: "zai_oauth",
        credentials_path: credsPath,
      },
    },
  }, errs);
  assert.deepEqual(errs, []);
});

// cleanup after the whole file (node:test runs tests in order)
test("cleanup", () => {
  rmSync(dir, { recursive: true, force: true });
});
