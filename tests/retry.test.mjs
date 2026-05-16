/**
 * retry.test.mjs — Unit tests for retry primitives used by core.mjs
 *
 * Covers the building blocks of the 429-aware retry loop: Retry-After
 * parsing and jittered backoff. The core.mjs inner 429 loop composes
 * these primitives plus a cfg.rateLimitMaxMs cap, so anchoring the
 * primitives here protects the cap behavior by extension.
 *
 * Run with:  node --test tests/retry.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfter, jitteredBackoff, classifyError } from "../src/proxy/retry.mjs";

describe("parseRetryAfter", () => {
  test("returns fallback when header is undefined", () => {
    assert.equal(parseRetryAfter(undefined, 1234), 1234);
  });

  test("returns fallback when header is empty string", () => {
    assert.equal(parseRetryAfter("", 999), 999);
  });

  test("parses delta-seconds form (integer)", () => {
    assert.equal(parseRetryAfter("5", 0), 5000);
  });

  test("parses delta-seconds form (float)", () => {
    assert.equal(parseRetryAfter("2.5", 0), 2500);
  });

  test("parses delta-seconds form (zero)", () => {
    assert.equal(parseRetryAfter("0", 9999), 0);
  });

  test("parses HTTP-date form", () => {
    const futureMs = Date.now() + 7000;
    const httpDate = new Date(futureMs).toUTCString();
    const result = parseRetryAfter(httpDate, 0);
    assert.ok(result > 5000 && result <= 7500, `expected ~7000, got ${result}`);
  });

  test("returns 0 for HTTP-date in the past", () => {
    const pastDate = new Date(Date.now() - 60_000).toUTCString();
    assert.equal(parseRetryAfter(pastDate, 8888), 0);
  });

  test("returns fallback for malformed header", () => {
    assert.equal(parseRetryAfter("not-a-date-or-number-xyz", 4242), 4242);
  });

  test("sentinel pattern: -1 fallback signals 'no header present'", () => {
    // core.mjs uses parseRetryAfter(header, -1) and checks `>= 0` to decide
    // whether the header was usable. Lock that contract.
    assert.equal(parseRetryAfter(undefined, -1), -1);
    assert.equal(parseRetryAfter("", -1), -1);
    assert.equal(parseRetryAfter("garbage", -1), -1);
    assert.ok(parseRetryAfter("3", -1) >= 0);
  });
});

describe("jitteredBackoff", () => {
  test("never exceeds the cap", () => {
    for (let i = 0; i < 200; i++) {
      const v = jitteredBackoff(0, 1000, 5000);
      assert.ok(v >= 0 && v < 5000, `attempt 0 produced ${v}`);
    }
  });

  test("grows exponentially with attempt but stays under cap", () => {
    const cap = 30_000;
    for (let attempt = 0; attempt < 10; attempt++) {
      for (let trial = 0; trial < 50; trial++) {
        const v = jitteredBackoff(attempt, 500, cap);
        assert.ok(v >= 0 && v < cap, `attempt=${attempt} produced ${v}, cap=${cap}`);
      }
    }
  });

  test("returns non-negative integer", () => {
    const v = jitteredBackoff(3, 500, 10_000);
    assert.ok(Number.isInteger(v));
    assert.ok(v >= 0);
  });
});

describe("classifyError", () => {
  test("429 → rate_limit", () => {
    assert.equal(classifyError(429), "rate_limit");
  });

  test("400 → bad_payload", () => {
    assert.equal(classifyError(400), "bad_payload");
  });

  test("401/403 → auth_error", () => {
    assert.equal(classifyError(401), "auth_error");
    assert.equal(classifyError(403), "auth_error");
  });

  test("500/502/503 → backend_error", () => {
    assert.equal(classifyError(500), "backend_error");
    assert.equal(classifyError(502), "backend_error");
    assert.equal(classifyError(503), "backend_error");
  });

  test("529 → overloaded (Anthropic-specific)", () => {
    assert.equal(classifyError(529), "overloaded");
  });

  test("504 → timeout", () => {
    assert.equal(classifyError(504), "timeout");
  });
});

// ---------------------------------------------------------------------------
// 429 loop composition — verifies the core.mjs delay-selection logic
// ---------------------------------------------------------------------------

describe("core.mjs 429 delay composition", () => {
  /**
   * Replica of the delay-selection branch from core.mjs handleRequest().
   * Keeping a local copy here makes the test independent of internal
   * core.mjs symbols (handleRequest needs a live HTTP server to drive).
   */
  function pickDelay(retryAfterHeader, rateLimitDelayMs, rateLimitMaxMs, r429) {
    const headerWait = parseRetryAfter(retryAfterHeader, -1);
    const fallback = Math.min(
      rateLimitMaxMs,
      jitteredBackoff(r429, rateLimitDelayMs, rateLimitMaxMs),
    );
    return headerWait >= 0
      ? Math.min(headerWait, rateLimitMaxMs)
      : Math.max(rateLimitDelayMs, fallback);
  }

  test("honors a reasonable Retry-After header verbatim", () => {
    // NVIDIA NIM returns 12s — we should wait 12s, not the 2s fallback
    assert.equal(pickDelay("12", 2000, 30_000, 0), 12_000);
  });

  test("caps a hostile Retry-After at rateLimitMaxMs", () => {
    // Some upstreams send "600" (10 min) — must not block the gateway that long
    assert.equal(pickDelay("600", 2000, 30_000, 0), 30_000);
  });

  test("uses ≥ rateLimitDelayMs floor when header is absent", () => {
    // Repeated trials: every result must be at least rateLimitDelayMs (2000)
    // since the Math.max(rateLimitDelayMs, fallback) clause floors the jitter
    for (let i = 0; i < 50; i++) {
      const d = pickDelay(undefined, 2000, 30_000, 0);
      assert.ok(d >= 2000, `expected ≥ 2000, got ${d}`);
      assert.ok(d <= 30_000, `expected ≤ 30000, got ${d}`);
    }
  });

  test("zero-second Retry-After honored as 0 wait", () => {
    // Some APIs say "you can retry immediately" with Retry-After: 0
    assert.equal(pickDelay("0", 2000, 30_000, 0), 0);
  });

  test("malformed Retry-After falls back to jitter path", () => {
    for (let i = 0; i < 30; i++) {
      const d = pickDelay("definitely-not-a-date", 2000, 30_000, 1);
      assert.ok(d >= 2000 && d <= 30_000, `got ${d}`);
    }
  });
});
