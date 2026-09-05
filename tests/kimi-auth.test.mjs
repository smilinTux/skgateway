/**
 * kimi backend auth tests (router-level, no network).
 *
 * Pins the read-only file contract for auth_type kimi_oauth:
 *   1. Backend.buildAuthHeaders() reads the kimi CLI credential shape
 *      ({ access_token, refresh_token, expires_at, ... }) and returns a
 *      bearer header, re-reading the file when its mtime changes (the CLI
 *      refreshes tokens externally on a ~15 minute cadence; no gateway
 *      restart should be needed).
 *   2. It NEVER writes the credentials file (refresh rotation is owned by
 *      the kimi CLI on the gateway host, driven by a keepalive timer).
 *   3. A credentials file without an access token degrades to
 *      unauthenticated headers, never to a throw.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Backend } from "../src/proxy/router.mjs";

const dir = mkdtempSync(join(tmpdir(), "kimi-router-"));
const credsPath = join(dir, "kimi-code-env-test.json");

function writeCreds(token, expiresIn = 900) {
  writeFileSync(credsPath, JSON.stringify({
    access_token: token,
    refresh_token: "rt",
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    expires_in: expiresIn,
    scope: "kimi-code",
    token_type: "Bearer",
  }));
}

test("kimi_oauth buildAuthHeaders: bearer from the kimi CLI credentials file", async () => {
  writeCreds("kt-1");
  const b = new Backend({
    id: "kimi",
    url: "https://api.kimi.ai/coding/v1",
    auth_type: "kimi_oauth",
    credentials_path: credsPath,
    models: ["kimi-for-coding"],
  });
  assert.deepEqual(await b.buildAuthHeaders(), { authorization: "Bearer kt-1" });
});

test("kimi_oauth: re-reads credentials when the file mtime changes (CLI refresh, no restart)", async () => {
  writeCreds("kt-1");
  const b = new Backend({
    id: "kimi",
    url: "https://api.kimi.ai/coding/v1",
    auth_type: "kimi_oauth",
    credentials_path: credsPath,
    models: ["kimi-for-coding"],
  });
  assert.equal((await b.buildAuthHeaders()).authorization, "Bearer kt-1");
  // wait so the rewrite gets a fresh mtime even on coarse filesystems
  await new Promise((resolve) => setTimeout(resolve, 1100));
  writeCreds("kt-2");
  assert.equal((await b.buildAuthHeaders()).authorization, "Bearer kt-2");
});

test("kimi_oauth: never writes the credentials file", async () => {
  writeCreds("kt-1");
  const before = readFileSync(credsPath, "utf-8");
  const b = new Backend({
    id: "kimi",
    url: "https://api.kimi.ai/coding/v1",
    auth_type: "kimi_oauth",
    credentials_path: credsPath,
    models: ["kimi-for-coding"],
  });
  await b.buildAuthHeaders();
  await b.buildAuthHeaders();
  assert.equal(readFileSync(credsPath, "utf-8"), before);
});

test("kimi_oauth: missing access token degrades to unauthenticated, never throws", async () => {
  writeFileSync(credsPath, JSON.stringify({ refresh_token: "rt" }));
  const b = new Backend({
    id: "kimi",
    url: "https://api.kimi.ai/coding/v1",
    auth_type: "kimi_oauth",
    credentials_path: credsPath,
    models: ["kimi-for-coding"],
  });
  assert.deepEqual(await b.buildAuthHeaders(), {});
});

test("kimi_oauth: missing credentials file degrades to unauthenticated, never throws", async () => {
  const b = new Backend({
    id: "kimi",
    url: "https://api.kimi.ai/coding/v1",
    auth_type: "kimi_oauth",
    credentials_path: join(dir, "does-not-exist.json"),
    models: ["kimi-for-coding"],
  });
  assert.deepEqual(await b.buildAuthHeaders(), {});
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
