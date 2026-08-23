/**
 * Systemd credential-file boundary for SKLegal qualification service auth.
 */

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSkLegalAuthzClient,
  readSkLegalServiceCredential,
  SKLEGAL_SERVICE_AUTHORIZATION_HEADER,
} from "../src/policy/sklegal_authz_decide.mjs";

const RESOURCE = Object.freeze({
  tenant_id: "synthetic-tenant",
  matter_id: "synthetic-matter",
  material_id: "synthetic-material",
  material_version: "1",
  route_id: "synthetic-route",
});
const CONTEXT = Object.freeze({
  purpose: "legal_research",
  classification: "public",
  privilege: "none",
  ethical_wall: "clear",
});
const REQUEST = Object.freeze({
  subject: "synthetic:service:skgateway-qualification",
  capability: "skgateway.infer",
  resource: RESOURCE,
  context: CONTEXT,
  requestCapAuth: "Bearer synthetic-request-capauth",
});
const ALLOW = Object.freeze({ allow: true, reason: "allow", obligations: [] });
const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function root() {
  const value = mkdtempSync(join(tmpdir(), "skgw-service-credential-"));
  roots.push(value);
  return value;
}

function credential(value = "synthetic-service-credential") {
  const path = join(root(), "skgateway-authz-service-token");
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function client(path, fetchImpl, extra = {}) {
  return createSkLegalAuthzClient({
    url: "http://127.0.0.1:28779/v1/authz/decide",
    qualificationEnabled: true,
    serviceCredentialFile: path,
    serviceCredentialMaxAgeMs: 300000,
    fetchImpl,
    env: {},
    ...extra,
  });
}

describe("SKLegal systemd credential-file source", () => {
  test("reads an exact fresh owner-only regular file", () => {
    const path = credential();
    const value = readSkLegalServiceCredential(path);
    assert.equal(value.toString("ascii"), "synthetic-service-credential");
    value.fill(0);
  });

  test("sends the file credential only to the local PDP and keeps request CapAuth separate", async () => {
    const path = credential();
    const calls = [];
    const fetchImpl = async (url, options) => {
      calls.push({ url, options });
      return { status: 200, json: async () => ALLOW };
    };
    const decision = await client(path, fetchImpl).decideSkLegal(REQUEST);
    assert.deepEqual(decision, {
      ...ALLOW,
      decision_id: null,
      policy_revision: null,
      correlation_id: null,
    });
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].options.headers[SKLEGAL_SERVICE_AUTHORIZATION_HEADER],
      "Bearer synthetic-service-credential",
    );
    assert.equal(calls[0].options.headers.authorization, REQUEST.requestCapAuth);
    assert.doesNotMatch(JSON.stringify(decision), /synthetic-service-credential/);
  });

  test("rejects environment and inline service credentials in qualification mode", () => {
    assert.throws(
      () => client(credential(), async () => {}, {
        env: { SKLEGAL_AUTHZ_SERVICE_TOKEN: "prohibited-environment-value" },
      }),
      /forbids environment or inline service credentials/,
    );
    assert.throws(
      () => client(credential(), async () => {}, {
        serviceToken: "prohibited-inline-value",
      }),
      /forbids environment or inline service credentials/,
    );
  });

  test("missing request CapAuth denies before the credential file is opened", async () => {
    let calls = 0;
    const decision = await client("/nonexistent/credential", async () => { calls++; })
      .decideSkLegal({ ...REQUEST, requestCapAuth: "" });
    assert.equal(decision.allow, false);
    assert.match(decision.reason, /request-local CapAuth/);
    assert.equal(calls, 0);
  });

  test("missing and unsafe file states deny before PDP transport", async (context) => {
    const valid = credential();
    const base = root();
    const missing = join(base, "missing");
    const symlink = join(base, "symlink");
    symlinkSync(valid, symlink);
    const hardlink = join(base, "hardlink");
    linkSync(valid, hardlink);
    const world = join(base, "world");
    writeFileSync(world, "synthetic", { mode: 0o600 });
    chmodSync(world, 0o644);
    const unreadable = join(base, "unreadable");
    writeFileSync(unreadable, "synthetic", { mode: 0o600 });
    chmodSync(unreadable, 0o000);
    const empty = join(base, "empty");
    writeFileSync(empty, "", { mode: 0o600 });
    const multiline = join(base, "multiline");
    writeFileSync(multiline, "synthetic\nvalue", { mode: 0o600 });
    const nul = join(base, "nul");
    writeFileSync(nul, Buffer.from("synthetic\0value"), { mode: 0o600 });
    const oversized = join(base, "oversized");
    writeFileSync(oversized, "x".repeat(8193), { mode: 0o600 });
    const stale = join(base, "stale");
    writeFileSync(stale, "synthetic", { mode: 0o600 });
    const old = new Date(Date.now() - 600000);
    utimesSync(stale, old, old);

    for (const [name, path] of [
      ["relative", "relative/path"],
      ["missing", missing],
      ["symlink", symlink],
      ["hardlink", hardlink],
      ["world-readable", world],
      ["unreadable", unreadable],
      ["empty", empty],
      ["multiline", multiline],
      ["nul", nul],
      ["oversized", oversized],
      ["stale", stale],
    ]) {
      await context.test(name, async () => {
        let calls = 0;
        const decision = await client(path, async () => { calls++; })
          .decideSkLegal(REQUEST);
        assert.equal(decision.allow, false);
        assert.equal(decision.reason, "authz_decide fail-closed: authorization backend unavailable");
        assert.equal(calls, 0);
      });
    }
  });

  test("wrong owner and a concurrent path replacement fail closed", () => {
    const path = credential();
    const currentUid = typeof process.geteuid === "function" ? process.geteuid() : 0;
    if (currentUid !== 0) {
      assert.throws(
        () => readSkLegalServiceCredential(path, { currentUid: currentUid + 1 }),
        /credential file is unavailable/,
      );
    }

    const replacement = join(root(), "replacement");
    writeFileSync(replacement, "rotated-service-credential", { mode: 0o600 });
    assert.throws(
      () => readSkLegalServiceCredential(path, {
        afterLstat() {
          const old = `${path}.old`;
          renameSync(path, old);
          renameSync(replacement, path);
        },
      }),
      /credential file is unavailable/,
    );
  });

  test("rotation is read through across reload and restart with no stale fallback", async () => {
    const path = credential("synthetic-service-one");
    const headers = [];
    const strict = client(path, async (_url, options) => {
      headers.push(options.headers[SKLEGAL_SERVICE_AUTHORIZATION_HEADER]);
      return { status: 200, json: async () => ALLOW };
    });
    assert.equal((await strict.decideSkLegal(REQUEST)).allow, true);
    const next = `${path}.next`;
    writeFileSync(next, "synthetic-service-two", { mode: 0o600 });
    renameSync(next, path);
    assert.equal((await strict.decideSkLegal(REQUEST)).allow, true);
    const restarted = client(path, async (_url, options) => {
      headers.push(options.headers[SKLEGAL_SERVICE_AUTHORIZATION_HEADER]);
      return { status: 200, json: async () => ALLOW };
    });
    assert.equal((await restarted.decideSkLegal(REQUEST)).allow, true);
    unlinkSync(path);
    assert.equal((await strict.decideSkLegal(REQUEST)).allow, false);
    assert.deepEqual(headers, [
      "Bearer synthetic-service-one",
      "Bearer synthetic-service-two",
      "Bearer synthetic-service-two",
    ]);
    assert.deepEqual(strict.stats(), { calls: 2, configured: true, cacheEnabled: false });
  });
});
