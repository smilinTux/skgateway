/**
 * authz-decide.test.mjs — skgateway's PDP-delegation client (SKWorld Auth L1.8).
 *
 * Covers the non-Python PEP contract: skgateway calls the capauth
 * POST /v1/authz/decide endpoint and FAILS CLOSED on every uncertainty.
 *
 *   - allow: a 200 { allow:true } lets the request through
 *   - deny:  a 200 { allow:false } denies (a real policy deny)
 *   - fail-closed on an unreachable endpoint (transport throw) → deny
 *   - fail-closed on a non-200 status (503/500/403) → deny
 *   - fail-closed on an unparseable / malformed 200 body → deny
 *   - fail-closed when no url / token is configured → deny (no fetch call)
 *   - allow-cache: a repeated allow is served from cache (one fetch)
 *   - denies are NEVER cached: a repeated deny re-checks (fetch each time)
 *   - route classifier is method-aware; public vs gated; subject resolution
 *
 * Run with:  node --test tests/authz-decide.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  createAuthzClient,
  resolveAuthzUrl,
  authzCacheKey,
} from "../src/policy/authz_decide.mjs";
import {
  classifyRoute,
  subjectFromIdentity,
  CAP_INFER,
  CAP_ADMIN,
} from "../src/policy/authz_routes.mjs";

const URL = "http://127.0.0.1:8080/v1/authz/decide";

/** A fetch stub that records calls and returns a scripted response. */
function mkFetch(responder) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts, body: opts?.body ? JSON.parse(opts.body) : null });
    return responder(calls.length, url, opts);
  };
  fn.calls = calls;
  return fn;
}

/** A minimal Response-like object. */
function mkResp(status, jsonBody) {
  return {
    status,
    async json() {
      if (jsonBody instanceof Error) throw jsonBody;
      return jsonBody;
    },
  };
}

function client(fetchImpl, extra = {}) {
  return createAuthzClient({
    url: URL,
    token: "test-token",
    fetchImpl,
    env: {}, // hermetic: never read the real process env
    ...extra,
  });
}

// ─── allow / deny happy paths ──────────────────────────────────────────────────

describe("decide: allow and deny", () => {
  test("200 {allow:true} → allow, with the PDP reason relayed", async () => {
    const f = mkFetch(() => mkResp(200, { allow: true, reason: "granted", obligations: [{ kind: "audit" }] }));
    const c = client(f);
    const d = await c.decide("lumina@skworld.io", CAP_INFER, { path: "/v1/chat/completions" });
    assert.equal(d.allow, true);
    assert.equal(d.reason, "granted");
    assert.equal(d.obligations.length, 1);
    // request carried the right shape
    assert.equal(f.calls[0].body.subject, "lumina@skworld.io");
    assert.equal(f.calls[0].body.capability, CAP_INFER);
    assert.equal(f.calls[0].opts.headers.authorization, "Bearer test-token");
  });

  test("200 {allow:false} → deny (a real policy deny)", async () => {
    const f = mkFetch(() => mkResp(200, { allow: false, reason: "no token grants skgateway.infer", obligations: [] }));
    const c = client(f);
    const d = await c.decide("stranger@x.io", CAP_INFER);
    assert.equal(d.allow, false);
    assert.match(d.reason, /no token grants/);
  });
});

// ─── fail-closed paths ─────────────────────────────────────────────────────────

describe("decide: fail closed on every uncertainty", () => {
  test("transport throw (endpoint unreachable) → deny, reason names transport", async () => {
    const f = mkFetch(() => { throw new Error("ECONNREFUSED"); });
    const c = client(f);
    const d = await c.decide("lumina@skworld.io", CAP_INFER);
    assert.equal(d.allow, false);
    assert.match(d.reason, /fail-closed/);
    assert.match(d.reason, /transport error/);
  });

  test("non-200 status (503) → deny", async () => {
    const f = mkFetch(() => mkResp(503, { detail: "endpoint disabled" }));
    const c = client(f);
    const d = await c.decide("lumina@skworld.io", CAP_INFER);
    assert.equal(d.allow, false);
    assert.match(d.reason, /non-200/);
  });

  test("non-200 status (500) → deny", async () => {
    const f = mkFetch(() => mkResp(500, {}));
    const c = client(f);
    const d = await c.decide("lumina@skworld.io", CAP_ADMIN);
    assert.equal(d.allow, false);
  });

  test("200 but body throws on json() → deny", async () => {
    const f = mkFetch(() => mkResp(200, new Error("bad json")));
    const c = client(f);
    const d = await c.decide("lumina@skworld.io", CAP_INFER);
    assert.equal(d.allow, false);
    assert.match(d.reason, /unparseable/);
  });

  test("200 but body has no boolean allow → deny", async () => {
    const f = mkFetch(() => mkResp(200, { reason: "weird" }));
    const c = client(f);
    const d = await c.decide("lumina@skworld.io", CAP_INFER);
    assert.equal(d.allow, false);
    assert.match(d.reason, /missing boolean allow/);
  });

  test("no url/token configured → deny WITHOUT calling fetch", async () => {
    const f = mkFetch(() => mkResp(200, { allow: true }));
    const c = createAuthzClient({ url: null, token: "", fetchImpl: f, env: {} });
    assert.equal(c.configured, false);
    const d = await c.decide("lumina@skworld.io", CAP_INFER);
    assert.equal(d.allow, false);
    assert.equal(f.calls.length, 0); // never dialed the PDP
  });

  test("empty subject or capability → deny WITHOUT calling fetch", async () => {
    const f = mkFetch(() => mkResp(200, { allow: true }));
    const c = client(f);
    assert.equal((await c.decide("", CAP_INFER)).allow, false);
    assert.equal((await c.decide("lumina@skworld.io", "")).allow, false);
    assert.equal(f.calls.length, 0);
  });
});

// ─── caching: allows cached, denies never ──────────────────────────────────────

describe("decide: allow-cache, denies never cached", () => {
  test("repeated ALLOW is served from cache (one fetch)", async () => {
    const f = mkFetch(() => mkResp(200, { allow: true, reason: "granted", obligations: [] }));
    const c = client(f, { cacheTtlMs: 60_000 });
    const a = await c.decide("lumina@skworld.io", CAP_INFER, { path: "/v1/chat/completions" });
    const b = await c.decide("lumina@skworld.io", CAP_INFER, { path: "/v1/chat/completions" });
    assert.equal(a.allow, true);
    assert.equal(b.allow, true);
    assert.equal(f.calls.length, 1, "second identical allow must hit the cache");
    assert.match(b.reason, /cache/);
  });

  test("repeated DENY re-checks every time (no deny caching)", async () => {
    const f = mkFetch(() => mkResp(200, { allow: false, reason: "denied", obligations: [] }));
    const c = client(f, { cacheTtlMs: 60_000 });
    await c.decide("stranger@x.io", CAP_INFER, { path: "/v1/chat/completions" });
    await c.decide("stranger@x.io", CAP_INFER, { path: "/v1/chat/completions" });
    assert.equal(f.calls.length, 2, "a deny must never be cached — always re-check");
  });

  test("cacheTtlMs=0 disables the cache (every allow re-fetches)", async () => {
    const f = mkFetch(() => mkResp(200, { allow: true, reason: "granted", obligations: [] }));
    const c = client(f, { cacheTtlMs: 0 });
    await c.decide("lumina@skworld.io", CAP_INFER);
    await c.decide("lumina@skworld.io", CAP_INFER);
    assert.equal(f.calls.length, 2);
  });

  test("different resource → different cache key → separate fetch", async () => {
    const f = mkFetch(() => mkResp(200, { allow: true, reason: "granted", obligations: [] }));
    const c = client(f, { cacheTtlMs: 60_000 });
    await c.decide("lumina@skworld.io", CAP_INFER, { path: "/v1/chat/completions" });
    await c.decide("lumina@skworld.io", CAP_INFER, { path: "/v1/messages" });
    assert.equal(f.calls.length, 2);
  });
});

// ─── url resolution + cache key ────────────────────────────────────────────────

describe("resolveAuthzUrl + authzCacheKey", () => {
  test("appends the standard path to a base url", () => {
    assert.equal(resolveAuthzUrl("http://host:8080", {}), "http://host:8080/v1/authz/decide");
  });
  test("keeps a full decide url as-is (trailing slash trimmed)", () => {
    assert.equal(resolveAuthzUrl("http://host:8080/v1/authz/decide/", {}), "http://host:8080/v1/authz/decide");
  });
  test("falls back to CAPAUTH_AUTHZ_URL from env", () => {
    assert.equal(resolveAuthzUrl(undefined, { CAPAUTH_AUTHZ_URL: "http://e:9/v1/authz/decide" }), "http://e:9/v1/authz/decide");
  });
  test("null when nothing configured", () => {
    assert.equal(resolveAuthzUrl(undefined, {}), null);
  });
  test("cache key is resource-order-independent", () => {
    const k1 = authzCacheKey("s", "c", { a: 1, b: 2 });
    const k2 = authzCacheKey("s", "c", { b: 2, a: 1 });
    assert.equal(k1, k2);
  });
});

// ─── route classifier (method-aware) + subject resolution ──────────────────────

describe("classifyRoute is method-aware and coverage-complete", () => {
  test("public infra + read-only model listing", () => {
    for (const [m, u] of [
      ["GET", "/health"], ["GET", "/healthz"], ["GET", "/status"], ["GET", "/queue"],
      ["GET", "/"], ["GET", "/dashboard"], ["GET", "/.well-known/skworld-module.json"],
      ["GET", "/api/hello"], ["HEAD", "/api/hello"],
      ["GET", "/v1/models"], ["GET", "/v1/models/ornith-big"], ["GET", "/v1/models?x=1"],
    ]) {
      assert.equal(classifyRoute(m, u).kind, "public", `${m} ${u} should be public`);
    }
  });

  test("inference proxy paths → gated skgateway.infer", () => {
    for (const [m, u] of [
      ["POST", "/v1/chat/completions"], ["POST", "/v1/messages"], ["POST", "/v1/messages?beta=true"],
      ["POST", "/v1/completions"], ["POST", "/v1/embeddings"],
    ]) {
      const r = classifyRoute(m, u);
      assert.equal(r.kind, "gated");
      assert.equal(r.capability, CAP_INFER, `${m} ${u}`);
    }
  });

  test("admin surface → gated skgateway.admin (any method)", () => {
    for (const [m, u] of [
      ["GET", "/admin/models"], ["PUT", "/admin/models/advertise"],
      ["GET", "/admin/models/status"], ["POST", "/admin/models/refresh"],
    ]) {
      const r = classifyRoute(m, u);
      assert.equal(r.kind, "gated");
      assert.equal(r.capability, CAP_ADMIN, `${m} ${u}`);
    }
  });

  test("a POST to /v1/models is NOT a public read (falls to infer, method-aware)", () => {
    // Only GET /v1/models is public; a write verb is not.
    const r = classifyRoute("POST", "/v1/models");
    assert.equal(r.kind, "gated");
    assert.equal(r.capability, CAP_INFER);
  });
});

describe("subjectFromIdentity resolves from the credential-backed entry only", () => {
  test("once verified, prefers fqid, then capauth_uri (scheme stripped), then agent_id", () => {
    assert.equal(subjectFromIdentity({ agent_id: "lumina", agent: { fqid: "lumina@chef.skworld" }, verified: true }), "lumina@chef.skworld");
    assert.equal(subjectFromIdentity({ agent_id: "lumina", agent: { capauth_uri: "capauth:lumina@skworld.io" }, verified: true }), "lumina@skworld.io");
    assert.equal(subjectFromIdentity({ agent_id: "lumina", agent: null, verified: true }), "lumina");
  });
  test("anonymous / empty resolves to '' so the PDP denies (fail closed)", () => {
    assert.equal(subjectFromIdentity({ agent_id: "anonymous", agent: null, verified: true }), "");
    assert.equal(subjectFromIdentity({ agent_id: "", agent: null, verified: true }), "");
    assert.equal(subjectFromIdentity(null), "");
  });
  // SKW-AUTONOMY-E1 / card 1911481e / incident inc-37456f9f: this is the
  // negative test the containment card requires. Before the fix, verified was
  // never inspected here, so an unverified identity with a fully-populated
  // registry entry (the exact shape a header or bearer claim produces) resolved
  // a real subject string, identical to what a signed request would produce.
  // This test fails on unfixed subjectFromIdentity() and passes after the fix.
  test("unverified identity yields no policy-decision subject, even with a full agent match", () => {
    assert.equal(subjectFromIdentity({ agent_id: "lumina", agent: { fqid: "lumina@chef.skworld" }, verified: false }), "");
    assert.equal(subjectFromIdentity({ agent_id: "lumina", agent: { capauth_uri: "capauth:lumina@skworld.io" }, verified: false }), "");
    assert.equal(subjectFromIdentity({ agent_id: "lumina", agent: { fqid: "lumina@chef.skworld" } }), ""); // verified omitted (header/bearer shape)
    assert.equal(subjectFromIdentity({ agent_id: "lumina", agent: null, verified: false }), "");
  });
});
