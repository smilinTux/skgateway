/**
 * request-limits.test.mjs — Unit tests for src/proxy/request-limits.mjs
 *
 * Explicit transport byte bounds on the request body and the system/developer
 * message slice of it. Unlike the existing trim-based model limits (card
 * 080e032e, src/index.mjs), these never edit the client's conversation to fit
 * a budget: an oversized request is rejected (413) with the history intact,
 * so the caller can retry with a smaller payload instead of silently losing
 * context. Chi (ab1608f9) runs this; porting it to main for parity.
 *
 * Run with: node --test tests/request-limits.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  modelRequestLimits,
  ingressRequestLimit,
  requestLimitError,
  requestLimitResponse,
} from "../src/proxy/request-limits.mjs";

describe("modelRequestLimits", () => {
  test("happy path: falls back to chi's defaults when config is empty", () => {
    const limits = modelRequestLimits({}, "some-model");
    assert.equal(limits.maxBodyBytes, 120000);
    assert.equal(limits.maxSystemBytes, 40000);
  });

  test("happy path: global sanitizer config overrides the built-in defaults", () => {
    const config = { sanitizer: { max_body_bytes: 90000, max_system_bytes: 20000 } };
    const limits = modelRequestLimits(config, "some-model");
    assert.equal(limits.maxBodyBytes, 90000);
    assert.equal(limits.maxSystemBytes, 20000);
  });

  test("edge case: a per-model override takes precedence over the global default", () => {
    const config = {
      sanitizer: { max_body_bytes: 90000, max_system_bytes: 20000 },
      model_limits: { "big-model": { max_body_bytes: 500000, max_system_bytes: 100000 } },
    };
    const limits = modelRequestLimits(config, "big-model");
    assert.equal(limits.maxBodyBytes, 500000);
    assert.equal(limits.maxSystemBytes, 100000);
  });

  test("edge case: an aliased requestedModel narrows the resolved limit, never widens it", () => {
    const config = {
      model_limits: {
        "concrete-model": { max_body_bytes: 500000, max_system_bytes: 100000 },
        "public-alias": { max_body_bytes: 50000, max_system_bytes: 10000 },
      },
    };
    const limits = modelRequestLimits(config, "concrete-model", "public-alias");
    assert.equal(limits.maxBodyBytes, 50000, "the alias restriction must win (the tighter bound)");
    assert.equal(limits.maxSystemBytes, 10000);
  });

  test("edge case: a wider alias limit does not relax the concrete model's bound", () => {
    const config = {
      model_limits: {
        "concrete-model": { max_body_bytes: 50000, max_system_bytes: 10000 },
        "public-alias": { max_body_bytes: 500000, max_system_bytes: 100000 },
      },
    };
    const limits = modelRequestLimits(config, "concrete-model", "public-alias");
    assert.equal(limits.maxBodyBytes, 50000);
    assert.equal(limits.maxSystemBytes, 10000);
  });

  test("failure case: a zero or negative configured limit throws rather than silently disabling the bound", () => {
    assert.throws(() => modelRequestLimits({ sanitizer: { max_body_bytes: 0 } }, "m"), TypeError);
    assert.throws(() => modelRequestLimits({ sanitizer: { max_body_bytes: -1 } }, "m"), TypeError);
  });

  test("failure case: a non-integer configured limit throws", () => {
    assert.throws(() => modelRequestLimits({ sanitizer: { max_body_bytes: 1.5 } }, "m"), TypeError);
    assert.throws(() => modelRequestLimits({ sanitizer: { max_body_bytes: "120000" } }, "m"), TypeError);
  });
});

describe("ingressRequestLimit", () => {
  test("happy path: returns the sanitizer default with no model_limits configured", () => {
    assert.equal(ingressRequestLimit({}), 120000);
  });

  test("edge case: takes the maximum across every configured per-model body limit", () => {
    const config = {
      sanitizer: { max_body_bytes: 120000 },
      model_limits: {
        a: { max_body_bytes: 90000 },
        b: { max_body_bytes: 500000 },
      },
    };
    assert.equal(ingressRequestLimit(config), 500000, "ingress must admit the largest model's allowance");
  });

  test("edge case: a model_limits entry with no max_body_bytes is ignored, not treated as zero", () => {
    const config = {
      sanitizer: { max_body_bytes: 120000 },
      model_limits: { a: { max_system_bytes: 1000 } },
    };
    assert.equal(ingressRequestLimit(config), 120000);
  });

  test("failure case: an enabled client_auth cap tightens the ingress ceiling below the model maximum", () => {
    const config = {
      sanitizer: { max_body_bytes: 120000 },
      model_limits: { a: { max_body_bytes: 500000 } },
      client_auth: { enabled: true, max_request_body_bytes: 60000 },
    };
    assert.equal(ingressRequestLimit(config), 60000, "a tighter client_auth cap must win over the model max");
  });

  test("failure case: client_auth enabled but with no cap configured does not change the ceiling", () => {
    const config = {
      sanitizer: { max_body_bytes: 120000 },
      client_auth: { enabled: true, max_request_body_bytes: null },
    };
    assert.equal(ingressRequestLimit(config), 120000);
  });

  test("failure case: a disabled client_auth never constrains ingress even if a cap is set", () => {
    const config = {
      sanitizer: { max_body_bytes: 120000 },
      client_auth: { enabled: false, max_request_body_bytes: 1 },
    };
    assert.equal(ingressRequestLimit(config), 120000);
  });
});

describe("requestLimitError", () => {
  const limits = { maxBodyBytes: 100, maxSystemBytes: 50 };

  test("happy path: a small, well-formed request passes with no rejection", () => {
    const body = Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }));
    assert.equal(requestLimitError(body, limits), null);
  });

  test("edge case: a body over maxBodyBytes is rejected with the body param and byte counts", () => {
    const content = "x".repeat(200);
    const body = Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content }] }));
    const err = requestLimitError(body, limits);
    assert.ok(err);
    assert.equal(err.param, "body");
    assert.equal(err.code, "request_too_large");
    assert.equal(err.retryable, false);
    assert.equal(err.limit_bytes, 100);
    assert.ok(err.actual_bytes > 100);
    assert.match(err.message, /history was not modified/);
  });

  // A generous body ceiling with a tight system ceiling, so these cases
  // isolate the system/developer check from the body-size check above it.
  const systemLimits = { maxBodyBytes: 100000, maxSystemBytes: 50 };

  test("edge case: oversized system/developer content is rejected with the system param, body itself within bounds", () => {
    const body = Buffer.from(JSON.stringify({
      model: "m",
      messages: [
        { role: "system", content: "s".repeat(60) },
        { role: "user", content: "hi" },
      ],
    }));
    const err = requestLimitError(body, systemLimits);
    assert.ok(err);
    assert.equal(err.param, "system");
    assert.equal(err.limit_bytes, 50);
  });

  test("edge case: developer-role messages count toward the system budget same as system", () => {
    const body = Buffer.from(JSON.stringify({
      model: "m",
      messages: [{ role: "developer", content: "d".repeat(60) }],
    }));
    const err = requestLimitError(body, systemLimits);
    assert.ok(err);
    assert.equal(err.param, "system");
  });

  test("failure case: malformed JSON body is not parseable for the system check, returns null (ingress already bounded it)", () => {
    const body = Buffer.from("not json at all");
    assert.equal(requestLimitError(body, limits), null);
  });

  test("failure case: accepts a plain object body (not just a Buffer) for the size computation", () => {
    const obj = { model: "m", messages: [{ role: "user", content: "x".repeat(200) }] };
    const err = requestLimitError(obj, limits);
    assert.ok(err);
    assert.equal(err.param, "body");
  });
});

describe("requestLimitResponse", () => {
  test("happy path: wraps the error into a 413 JSON response with no-store caching", () => {
    const error = { message: "too big", code: "request_too_large" };
    const result = requestLimitResponse(error);
    assert.equal(result.status, 413);
    assert.equal(result.headers["content-type"], "application/json");
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(result.backendId, null);
    assert.equal(result.failover, false);
    const parsed = JSON.parse(result.body.toString("utf-8"));
    assert.deepEqual(parsed.error, error);
  });
});
