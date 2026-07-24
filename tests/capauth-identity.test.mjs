/**
 * capauth-identity.test.mjs — CapAuth agent-identity integration (SKGateway P2.1).
 *
 * Covers the identity module used on the live /v1/* request path:
 *   - registry loading (builtins + config overrides)
 *   - identity extraction: header / bearer / capauth / anonymous
 *   - fail-safe degradation (invalid signature / token → anonymous, never throws)
 *   - request enrichment (agent_id stamped, SIEM event carries verified flag)
 *   - middleware auth gate (require_agent_id opt-in)
 *
 * Run with:  node --test tests/capauth-identity.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  loadAgentRegistry,
  extractIdentity,
  enrichRequest,
  identityMiddleware,
  ANONYMOUS_AGENT_ID,
} from "../src/identity/capauth.mjs";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal Node-style request object. */
function mkReq(headers = {}, { method = "POST", url = "/v1/chat/completions" } = {}) {
  return {
    headers,
    method,
    url,
    socket: { remoteAddress: "127.0.0.1" },
  };
}

/** Build a fake response that records the status + body written. */
function mkRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

// A registry with no ~/.skcapstone discovery noise — builtins + explicit overrides.
function mkRegistry(extra = {}) {
  return loadAgentRegistry({
    identity: {
      // point discovery at a non-existent dir so tests are hermetic
      agents_dir: "/nonexistent-skgateway-test-dir",
      ...extra,
    },
  });
}

// ─── registry ─────────────────────────────────────────────────────────────────

describe("loadAgentRegistry", () => {
  test("seeds built-in agents", () => {
    const reg = mkRegistry();
    assert.ok(reg.byName.has("lumina"));
    assert.ok(reg.byName.has("jarvis"));
    assert.equal(reg.byName.get("lumina").name, "lumina");
  });

  test("config override merges bearer tokens into byToken index", () => {
    const reg = mkRegistry({
      agents: [{ name: "lumina", bearer_tokens: ["s3cret-token"] }],
    });
    // token index is keyed by sha256(token) → agent name
    assert.equal([...reg.byToken.values()].includes("lumina"), true);
  });

  test("allow_anonymous:false → no default agent", () => {
    const reg = mkRegistry({ allow_anonymous: false });
    assert.equal(reg.defaultAgent, null);
  });
});

// ─── extraction ───────────────────────────────────────────────────────────────

describe("extractIdentity", () => {
  test("valid X-Agent-Id header → agent set, method=header, resolved registry entry", async () => {
    const reg = mkRegistry();
    const id = await extractIdentity(mkReq({ "x-agent-id": "Lumina" }), reg);
    assert.equal(id.agent_id, "lumina");      // normalized lowercase
    assert.equal(id.method, "header");
    assert.equal(id.verified, false);          // header alone is never "verified"
    assert.ok(id.agent);                       // registry entry attached
    assert.equal(id.agent.name, "lumina");
  });

  test("absent identity → anonymous, verified:false", async () => {
    const reg = mkRegistry();
    const id = await extractIdentity(mkReq({}), reg);
    assert.equal(id.agent_id, ANONYMOUS_AGENT_ID);
    assert.equal(id.method, "anonymous");
    assert.equal(id.verified, false);
  });

  test("valid bearer token → agent resolved, method=bearer", async () => {
    const reg = mkRegistry({ agents: [{ name: "jarvis", bearer_tokens: ["good-token"] }] });
    const id = await extractIdentity(mkReq({ authorization: "Bearer good-token" }), reg);
    assert.equal(id.agent_id, "jarvis");
    assert.equal(id.method, "bearer");
    assert.equal(id.verified, false);
  });

  test("invalid bearer token → degrades to anonymous (not rejected/thrown)", async () => {
    const reg = mkRegistry();
    const id = await extractIdentity(mkReq({ authorization: "Bearer wrong-token" }), reg);
    assert.equal(id.agent_id, ANONYMOUS_AGENT_ID);
    assert.equal(id.method, "anonymous");
  });

  test("CapAuth signature with stale timestamp → falls back to header, verified:false", async () => {
    const reg = mkRegistry();
    const staleTs = String(Math.floor(Date.now() / 1000) - 10_000); // outside ±300s
    const id = await extractIdentity(mkReq({
      "x-agent-id": "lumina",
      "x-capauth-signature": "-----BEGIN PGP SIGNATURE-----\nxx\n-----END PGP SIGNATURE-----",
      "x-capauth-timestamp": staleTs,
    }), reg);
    assert.equal(id.agent_id, "lumina");
    assert.equal(id.method, "header");   // stale ts → capauth branch skipped
    assert.equal(id.verified, false);
  });

  test("CapAuth signature, fresh ts, no verifiable key → NOT verified, no crash", async () => {
    // Built-in lumina has no public_key_armor and openpgp is optional →
    // verification cannot succeed, but the request must not throw and must
    // still resolve the claimed agent (unverified).
    const reg = mkRegistry();
    const freshTs = String(Math.floor(Date.now() / 1000));
    const id = await extractIdentity(mkReq({
      "x-agent-id": "lumina",
      "x-capauth-signature": "-----BEGIN PGP SIGNATURE-----\nxx\n-----END PGP SIGNATURE-----",
      "x-capauth-timestamp": freshTs,
    }), reg);
    assert.equal(id.agent_id, "lumina");
    assert.equal(id.method, "capauth");
    assert.equal(id.verified, false);   // fail-safe: unverified, not trusted
  });

  test("X-Session-Id is carried through", async () => {
    const reg = mkRegistry();
    const id = await extractIdentity(mkReq({ "x-agent-id": "opus", "x-session-id": "sess-42" }), reg);
    assert.equal(id.session_id, "sess-42");
  });
});

// ─── enrichment ───────────────────────────────────────────────────────────────

describe("enrichRequest", () => {
  test("stamps req.agent_id and emits identity SIEM event with verified flag", () => {
    const events = [];
    const req = mkReq({});
    req.siemEmitter = { emit: (name, evt) => events.push({ name, evt }) };
    enrichRequest(req, {
      agent_id: "lumina", verified: true, method: "capauth",
      session_id: "s1", fingerprint: "ABCD", agent: null,
    });
    assert.equal(req.agent_id, "lumina");
    assert.equal(req.identity.verified, true);
    assert.equal(events.length, 1);
    assert.equal(events[0].evt.agent_id, "lumina");
    assert.equal(events[0].evt.verified, true);
  });
});

// ─── middleware auth gate ───────────────────────────────────────────────────────

describe("identityMiddleware", () => {
  test("require_agent_id:false → anonymous request passes through (next called)", async () => {
    const reg = mkRegistry();
    const mw = identityMiddleware({ registry: reg, require_agent_id: false, log_auth: false });
    const req = mkReq({});
    const res = mkRes();
    let nexted = false;
    await mw(req, res, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(res.statusCode, null);          // not blocked
    assert.equal(req.identity.method, "anonymous");
  });

  test("require_agent_id:true → anonymous request blocked with 403", async () => {
    const reg = mkRegistry();
    const mw = identityMiddleware({ registry: reg, require_agent_id: true, log_auth: false });
    const req = mkReq({});
    const res = mkRes();
    let nexted = false;
    await mw(req, res, () => { nexted = true; });
    assert.equal(nexted, false);
    assert.equal(res.statusCode, 403);
    assert.match(res.body, /identity_required/);
  });

  test("require_agent_id:true → identified request passes (next called, agent_id set)", async () => {
    const reg = mkRegistry();
    const mw = identityMiddleware({ registry: reg, require_agent_id: true, log_auth: false });
    const req = mkReq({ "x-agent-id": "lumina" });
    const res = mkRes();
    let nexted = false;
    await mw(req, res, () => { nexted = true; });
    assert.equal(nexted, true);
    assert.equal(res.statusCode, null);
    assert.equal(req.agent_id, "lumina");
  });
});
