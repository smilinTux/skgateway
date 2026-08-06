/**
 * authz-gate.test.mjs — the OFF-BY-DEFAULT flag + per-request authz composition.
 *
 * The safety-critical property of this whole feature is: FLAG OFF ⇒ the gateway
 * never calls the PDP and behaves byte-identically. FLAG ON ⇒ gated routes are
 * enforced (deny → 403 upstream) and public routes still pass with no PDP call.
 *
 * These tests exercise the two pure helpers index.mjs is built from:
 *   authzEnforceEnabled(env, config)     — the master flag
 *   authorizeRequest({...})              — classify → subject → decide
 *
 * A spy client records whether decide() was called, proving the "no decide call"
 * guarantees exactly.
 *
 * Run with:  node --test tests/authz-gate.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { authzEnforceEnabled, authorizeRequest } from "../src/policy/authz_gate.mjs";
import { CAP_INFER, CAP_ADMIN } from "../src/policy/authz_routes.mjs";

/** A client whose decide() records calls and returns a scripted verdict. */
function spyClient(verdict = { allow: true, reason: "ok", obligations: [] }) {
  const calls = [];
  return {
    calls,
    decide: async (subject, capability, resource) => {
      calls.push({ subject, capability, resource });
      return verdict;
    },
  };
}

const LUMINA = { agent_id: "lumina", agent: { capauth_uri: "capauth:lumina@skworld.io" } };
const ANON = { agent_id: "anonymous", agent: null };

// ─── the master flag ───────────────────────────────────────────────────────────

describe("authzEnforceEnabled — OFF by default", () => {
  test("unset env + no config → OFF", () => {
    assert.equal(authzEnforceEnabled({}, {}), false);
    assert.equal(authzEnforceEnabled({}, { authz: {} }), false);
    assert.equal(authzEnforceEnabled({}, { authz: { enforce: false } }), false);
  });
  test("env '1' or 'true' → ON", () => {
    assert.equal(authzEnforceEnabled({ SKGATEWAY_AUTHZ_ENFORCE: "1" }, {}), true);
    assert.equal(authzEnforceEnabled({ SKGATEWAY_AUTHZ_ENFORCE: "true" }, {}), true);
  });
  test("config.authz.enforce true → ON", () => {
    assert.equal(authzEnforceEnabled({}, { authz: { enforce: true } }), true);
  });
  test("env explicit off overrides a config ON (belt-and-suspenders kill switch)", () => {
    assert.equal(authzEnforceEnabled({ SKGATEWAY_AUTHZ_ENFORCE: "0" }, { authz: { enforce: true } }), false);
    assert.equal(authzEnforceEnabled({ SKGATEWAY_AUTHZ_ENFORCE: "false" }, { authz: { enforce: true } }), false);
  });
  test("garbage env value falls back to config", () => {
    assert.equal(authzEnforceEnabled({ SKGATEWAY_AUTHZ_ENFORCE: "yes-please" }, { authz: { enforce: true } }), true);
    assert.equal(authzEnforceEnabled({ SKGATEWAY_AUTHZ_ENFORCE: "yes-please" }, {}), false);
  });
});

// ─── authorizeRequest — the flag-on enforcement composition ──────────────────────

describe("authorizeRequest (what runs only when the flag is ON)", () => {
  test("public route → allowed, and NO decide call", async () => {
    const c = spyClient();
    const v = await authorizeRequest({ method: "GET", url: "/health", identity: ANON, client: c });
    assert.equal(v.kind, "public");
    assert.equal(v.allowed, true);
    assert.equal(c.calls.length, 0, "public routes must never call the PDP");
  });

  test("GET /v1/models (read-only listing) → public, no decide call", async () => {
    const c = spyClient();
    const v = await authorizeRequest({ method: "GET", url: "/v1/models", identity: LUMINA, client: c });
    assert.equal(v.kind, "public");
    assert.equal(c.calls.length, 0);
  });

  test("gated inference route → decide called with skgateway.infer + resolved subject", async () => {
    const c = spyClient({ allow: true, reason: "granted", obligations: [{ kind: "audit" }] });
    const v = await authorizeRequest({ method: "POST", url: "/v1/chat/completions", identity: LUMINA, client: c });
    assert.equal(v.allowed, true);
    assert.equal(c.calls.length, 1);
    assert.equal(c.calls[0].capability, CAP_INFER);
    assert.equal(c.calls[0].subject, "lumina@skworld.io");
    assert.deepEqual(c.calls[0].resource, { path: "/v1/chat/completions", method: "POST" });
  });

  test("gated admin route → decide called with skgateway.admin", async () => {
    const c = spyClient({ allow: true, reason: "granted", obligations: [] });
    const v = await authorizeRequest({ method: "PUT", url: "/admin/models/advertise", identity: LUMINA, client: c });
    assert.equal(c.calls[0].capability, CAP_ADMIN);
    assert.equal(v.allowed, true);
  });

  test("gated route + PDP deny → verdict denied (index.mjs turns this into 403)", async () => {
    const c = spyClient({ allow: false, reason: "insufficient enrollment mode", obligations: [] });
    const v = await authorizeRequest({ method: "POST", url: "/v1/messages", identity: LUMINA, client: c });
    assert.equal(v.allowed, false);
    assert.match(v.reason, /insufficient/);
  });

  test("anonymous caller on a gated route → subject '' (PDP denies unknown subject)", async () => {
    const c = spyClient({ allow: false, reason: "empty subject or capability", obligations: [] });
    const v = await authorizeRequest({ method: "POST", url: "/v1/chat/completions", identity: ANON, client: c });
    assert.equal(v.subject, "");
    assert.equal(v.allowed, false);
  });
});
