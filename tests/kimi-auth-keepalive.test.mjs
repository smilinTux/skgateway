import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Backend, startKimiAuthKeepalive } from "../src/proxy/router.mjs";

const dir = mkdtempSync(join(tmpdir(), "kimi-keepalive-"));
const credsPath = join(dir, "kimi-code.json");

function kimiBackend(overrides = {}) {
  return new Backend({
    id: "kimi", url: "https://api.kimi.com/coding/v1", auth_type: "kimi_oauth",
    credentials_path: credsPath, models: ["kimi-for-coding"], ...overrides,
  });
}

function writeCreds({ token = "old-access", refresh = "old-refresh", expiresIn = 900 } = {}) {
  writeFileSync(credsPath, JSON.stringify({
    access_token: token, refresh_token: refresh,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    expires_in: expiresIn, scope: "kimi-code", token_type: "Bearer",
  }), { mode: 0o600 });
}

test("scheduler timer is bounded and unrefed", () => {
  let interval;
  let unrefed = false;
  const scheduled = startKimiAuthKeepalive({
    getBackends: () => [], intervalMs: 4321,
    setIntervalFn(fn, ms) { interval = { fn, ms, unref() { unrefed = true; } }; return interval; },
  });
  assert.equal(interval.ms, 4321);
  assert.equal(scheduled.timer, interval);
  assert.equal(unrefed, true);
});

test("tick refreshes and persists a near-expiry token with no request in flight", async () => {
  writeCreds({ expiresIn: 30 });
  const backend = kimiBackend();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      access_token: "proactively-refreshed", refresh_token: "new-refresh", expires_in: 900,
    }), { status: 200 });
  };
  try {
    const scheduled = startKimiAuthKeepalive({
      getBackends: () => [backend], setIntervalFn: () => ({ unref() {} }),
    });
    await scheduled.tick();
    assert.equal(calls, 1);
    const written = JSON.parse(readFileSync(credsPath, "utf8"));
    assert.equal(written.access_token, "proactively-refreshed");
  } finally { globalThis.fetch = originalFetch; }
});

test("tick is a no-op while the token is still well inside its TTL", async () => {
  writeCreds({ expiresIn: 900 });
  const backend = kimiBackend();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("unexpected fetch"); };
  try {
    const scheduled = startKimiAuthKeepalive({
      getBackends: () => [backend], setIntervalFn: () => ({ unref() {} }),
    });
    await scheduled.tick();
  } finally { globalThis.fetch = originalFetch; }
});

test("tick skips backends that are not kimi_oauth", async () => {
  const otherBackend = new Backend({
    id: "codex", url: "https://api.example.com", auth_type: "codex_oauth",
    credentials_path: join(dir, "codex-auth.json"), models: ["gpt-5"],
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("unexpected fetch"); };
  try {
    const scheduled = startKimiAuthKeepalive({
      getBackends: () => [otherBackend, null, undefined], setIntervalFn: () => ({ unref() {} }),
    });
    await scheduled.tick();
  } finally { globalThis.fetch = originalFetch; }
});

test("overlapping ticks do not run concurrently", async () => {
  writeCreds({ expiresIn: 1 });
  const backend = kimiBackend();
  const originalFetch = globalThis.fetch;
  let concurrent = 0;
  let maxConcurrent = 0;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    concurrent -= 1;
    return new Response(JSON.stringify({ access_token: "slow-refresh", expires_in: 900 }), { status: 200 });
  };
  try {
    const scheduled = startKimiAuthKeepalive({
      getBackends: () => [backend], setIntervalFn: () => ({ unref() {} }),
    });
    const first = scheduled.tick();
    const second = scheduled.tick();
    await Promise.all([first, second]);
    assert.equal(maxConcurrent, 1);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test("a failed refresh is logged, not thrown, and does not stop the scheduler", async () => {
  writeCreds({ expiresIn: 1 });
  const backend = kimiBackend();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network unreachable"); };
  const originalConsoleError = console.error;
  let loggedRefreshFailure = false;
  console.error = (...args) => {
    if (String(args[0] || "").includes("kimi oauth refresh failed")) loggedRefreshFailure = true;
  };
  try {
    const scheduled = startKimiAuthKeepalive({
      getBackends: () => [backend], setIntervalFn: () => ({ unref() {} }),
    });
    await assert.doesNotReject(scheduled.tick());
    assert.equal(loggedRefreshFailure, true);
    await assert.doesNotReject(scheduled.tick());
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
