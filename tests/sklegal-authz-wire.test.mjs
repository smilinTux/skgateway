/**
 * Focused tests for the SKLegal two-credential qualification wire contract.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  createSkLegalAuthzClient,
  SKLEGAL_SERVICE_AUTHORIZATION_HEADER,
  validateSkLegalDecisionResponse,
} from "../src/policy/sklegal_authz_decide.mjs";
import {
  authorizeRequest,
  createSkLegalQualificationResolver,
} from "../src/policy/authz_gate.mjs";

const RESOURCE = Object.freeze({
  tenant_id: "synthetic-tenant",
  matter_id: "synthetic-matter",
  material_id: "synthetic-material",
  material_version: "7",
  route_id: "synthetic-route",
});
const CONTEXT = Object.freeze({
  purpose: "research",
  classification: "public",
  privilege: "none",
  ethical_wall: "clear",
});
const ALLOW = Object.freeze({
  allow: true,
  reason: "allow",
  decision_id: "decision-1",
  policy_revision: "policy-1",
  correlation_id: "correlation-1",
  obligations: ["audit"],
});

function response(status, body) {
  return { status, json: async () => body };
}

function recordingFetch(result = response(200, ALLOW)) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return typeof result === "function" ? result(calls.length) : result;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function client(fetchImpl) {
  return createSkLegalAuthzClient({
    url: "http://127.0.0.1:9000/v1/authz/decide",
    serviceToken: "service-secret",
    fetchImpl,
    env: {},
  });
}

function request(fetchImpl, overrides = {}) {
  return client(fetchImpl).decideSkLegal({
    subject: "synthetic-agent",
    capability: "skgateway.infer",
    resource: RESOURCE,
    context: CONTEXT,
    requestCapAuth: "Bearer request-local-capauth",
    ...overrides,
  });
}

describe("SKLegal authorization client", () => {
  test("sends separate service and request-local credentials with the exact body", async () => {
    const fetchImpl = recordingFetch();
    const decision = await request(fetchImpl);

    assert.deepEqual(decision, ALLOW);
    assert.equal(fetchImpl.calls.length, 1);
    const call = fetchImpl.calls[0];
    assert.equal(
      call.options.headers[SKLEGAL_SERVICE_AUTHORIZATION_HEADER],
      "Bearer service-secret",
    );
    assert.equal(call.options.headers.authorization, "Bearer request-local-capauth");
    assert.notEqual(call.options.headers.authorization, call.options.headers[SKLEGAL_SERVICE_AUTHORIZATION_HEADER]);
    assert.deepEqual(call.body, {
      subject: "synthetic-agent",
      capability: "skgateway.infer",
      resource: RESOURCE,
      context: CONTEXT,
    });
  });

  test("fails closed before transport when exact scope is missing or expanded", async () => {
    const fetchImpl = recordingFetch();
    const missing = await request(fetchImpl, { resource: { ...RESOURCE, matter_id: undefined } });
    const extra = await request(fetchImpl, { context: { ...CONTEXT, prompt: "must-not-leak" } });
    assert.equal(missing.allow, false);
    assert.equal(extra.allow, false);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test("fails closed before transport without the request-local CapAuth credential", async () => {
    const fetchImpl = recordingFetch();
    const decision = await request(fetchImpl, { requestCapAuth: "" });
    assert.equal(decision.allow, false);
    assert.equal(fetchImpl.calls.length, 0);
  });

  test("preserves a sanitized deny and fails closed when the adapter is unavailable", async () => {
    const denyFetch = recordingFetch(response(200, {
      allow: false,
      reason: "policy_denied",
      decision_id: "decision-2",
      policy_revision: "policy-2",
      correlation_id: "correlation-2",
      obligations: [],
    }));
    assert.equal((await request(denyFetch)).reason, "policy_denied");

    const unavailable = recordingFetch(response(503, { detail: { code: "private-database-secret" } }));
    const failed = await request(unavailable);
    assert.equal(failed.allow, false);
    assert.match(failed.reason, /backend unavailable/);
    assert.doesNotMatch(JSON.stringify(failed), /private-database-secret|service-secret|request-local-capauth/);
  });

  test("has no allow cache", async () => {
    const fetchImpl = recordingFetch();
    const strictClient = client(fetchImpl);
    const args = {
      subject: "synthetic-agent",
      capability: "skgateway.infer",
      resource: RESOURCE,
      context: CONTEXT,
      requestCapAuth: "Bearer request-local-capauth",
    };
    await strictClient.decideSkLegal(args);
    await strictClient.decideSkLegal(args);
    assert.equal(fetchImpl.calls.length, 2);
    assert.deepEqual(strictClient.stats(), { calls: 2, configured: true, cacheEnabled: false });
  });

  test("rejects malformed, expanded, or leaking response bodies", async () => {
    const bodies = [
      { ...ALLOW, prompt: "protected-content" },
      { ...ALLOW, allow: "true" },
      { ...ALLOW, reason: "private_database_failure" },
      { ...ALLOW, reason: "policy_denied" },
      { ...ALLOW, obligations: Array.from({ length: 17 }, (_, index) => `item-${index}`) },
    ];
    for (const body of bodies) {
      const decision = await request(recordingFetch(response(200, body)));
      assert.equal(decision.allow, false);
      assert.match(decision.reason, /malformed authorization response/);
      assert.doesNotMatch(JSON.stringify(decision), /protected-content|private_database_failure/);
    }
  });
});

describe("SKLegal qualification route", () => {
  test("scope comes only from explicit trusted route configuration", () => {
    const resolver = createSkLegalQualificationResolver({
      enabled: true,
      routes: [{
        method: "POST",
        path: "/v1/chat/completions",
        subject: "synthetic-agent",
        resource: RESOURCE,
        context: CONTEXT,
      }],
    });
    assert.deepEqual(
      resolver.resolve("POST", "/v1/chat/completions?caller_scope=wrong"),
      { subject: "synthetic-agent", resource: RESOURCE, context: CONTEXT },
    );
    assert.equal(resolver.resolve("POST", "/v1/messages"), null);
  });

  test("invalid or incomplete configured scope is rejected", () => {
    assert.throws(
      () => createSkLegalQualificationResolver({
        enabled: true,
        routes: [{
          method: "POST",
          path: "/v1/chat/completions",
          subject: "synthetic-agent",
          resource: { ...RESOURCE, material_id: undefined },
          context: CONTEXT,
        }],
      }),
      /exact trusted scope/,
    );
    assert.throws(
      () => createSkLegalQualificationResolver({
        enabled: true,
        routes: [{
          method: "POST",
          path: "/v1/chat/completions",
          subject: "synthetic-agent",
          resource: RESOURCE,
          context: { ...CONTEXT, purpose: " " },
        }],
      }),
      /exact trusted scope/,
    );
  });

  test("internal peers cannot bypass the governed decision", async () => {
    const calls = [];
    const sklegalClient = {
      async decideSkLegal(args) {
        calls.push(args);
        return { allow: false, reason: "policy_denied", obligations: [] };
      },
    };
    const verdict = await authorizeRequest({
      method: "POST",
      url: "/v1/chat/completions",
      identity: null,
      client: { decide: async () => ({ allow: true, reason: "generic", obligations: [] }) },
      internal: true,
      sklegalQualification: { subject: "synthetic-agent", resource: RESOURCE, context: CONTEXT },
      requestCapAuth: "Bearer request-local-capauth",
      sklegalClient,
    });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.governed, true);
    assert.equal(calls.length, 1);
  });
});

test("response validator consumes only the bounded fields", () => {
  assert.deepEqual(validateSkLegalDecisionResponse(ALLOW), ALLOW);
  assert.equal(validateSkLegalDecisionResponse({ ...ALLOW, content: "secret" }), null);
});
