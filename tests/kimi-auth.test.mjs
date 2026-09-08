import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Backend } from "../src/proxy/router.mjs";

const dir = mkdtempSync(join(tmpdir(), "kimi-router-"));
const credsPath = join(dir, "kimi-code.json");

function backend() {
  return new Backend({
    id: "kimi", url: "https://api.kimi.com/coding/v1", auth_type: "kimi_oauth",
    credentials_path: credsPath, models: ["kimi-for-coding"],
  });
}

function writeCreds({ token = "old-access", refresh = "old-refresh", expiresIn = 900 } = {}) {
  writeFileSync(credsPath, JSON.stringify({
    access_token: token, refresh_token: refresh,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    expires_in: expiresIn, scope: "kimi-code", token_type: "Bearer",
  }), { mode: 0o600 });
}

test("kimi_oauth returns a current bearer without refreshing", async () => {
  writeCreds();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("unexpected fetch"); };
  try {
    assert.deepEqual(await backend().buildAuthHeaders(), { authorization: "Bearer old-access" });
  } finally { globalThis.fetch = originalFetch; }
});

test("kimi_oauth reevaluates cached expiry when credential mtime is unchanged", async () => {
  const originalNow = Date.now;
  const originalFetch = globalThis.fetch;
  let now = 2_000_000_000_000;
  let calls = 0;
  Date.now = () => now;
  writeCreds({ expiresIn: 120 });
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ access_token: "renewed", expires_in: 900 }), { status: 200 });
  };
  try {
    const candidate = backend();
    assert.deepEqual(await candidate.buildAuthHeaders(), { authorization: "Bearer old-access" });
    assert.equal(calls, 0);
    now += 70_000;
    assert.deepEqual(await candidate.buildAuthHeaders(), { authorization: "Bearer renewed" });
    assert.equal(calls, 1);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = originalFetch;
  }
});

test("kimi_oauth refreshes near expiry and atomically writes mode 0600", async () => {
  writeCreds({ expiresIn: 1 });
  chmodSync(credsPath, 0o644);
  const originalInode = statSync(credsPath).ino;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://auth.kimi.com/api/oauth/token");
    assert.equal(options.method, "POST");
    const body = new URLSearchParams(options.body);
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "old-refresh");
    assert.ok(body.get("client_id"));
    return new Response(JSON.stringify({
      access_token: "new-access", refresh_token: "new-refresh",
      expires_in: 900, scope: "kimi-code", token_type: "Bearer",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    assert.deepEqual(await backend().buildAuthHeaders(), { authorization: "Bearer new-access" });
    const written = JSON.parse(readFileSync(credsPath, "utf8"));
    assert.equal(written.access_token, "new-access");
    assert.equal(written.refresh_token, "new-refresh");
    assert.equal(statSync(credsPath).mode & 0o777, 0o600);
    assert.notEqual(statSync(credsPath).ino, originalInode);
  } finally { globalThis.fetch = originalFetch; }
});

test("kimi_oauth coalesces concurrent refreshes", async () => {
  writeCreds({ expiresIn: -1 });
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ access_token: "shared", expires_in: 900 }), { status: 200 });
  };
  try {
    const candidates = Array.from({ length: 6 }, () => backend());
    const results = await Promise.all(candidates.map((candidate) => candidate.buildAuthHeaders()));
    assert.equal(calls, 1);
    assert.ok(results.every((headers) => headers.authorization === "Bearer shared"));
  } finally { globalThis.fetch = originalFetch; }
});

test("kimi_oauth fails closed and preserves credentials when refresh fails", async () => {
  writeCreds({ expiresIn: -1 });
  const before = readFileSync(credsPath, "utf8");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 });
  try {
    assert.deepEqual(await backend().buildAuthHeaders(), {});
    assert.equal(readFileSync(credsPath, "utf8"), before);
  } finally { globalThis.fetch = originalFetch; }
});

test("kimi_oauth missing credentials degrades to unauthenticated", async () => {
  const candidate = new Backend({
    id: "kimi", url: "https://api.kimi.com/coding/v1", auth_type: "kimi_oauth",
    credentials_path: join(dir, "missing.json"),
  });
  assert.deepEqual(await candidate.buildAuthHeaders(), {});
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
