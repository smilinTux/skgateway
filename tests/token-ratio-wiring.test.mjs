/**
 * token-ratio-wiring.test.mjs — guards the WIRING in src/index.mjs, not just
 * sampleTokenRatio() in isolation (that's tests/token-ratio-emit.test.mjs).
 *
 * IMPORTANT — what this test actually is:
 * src/index.mjs unconditionally calls `server.listen(...)` at module load
 * (src/index.mjs:2589), so importing it in a test boots a real gateway
 * against real config/backends. No test in this suite imports src/index.mjs
 * directly for exactly that reason (see tests/siem-live-hook.test.mjs and
 * tests/energy-metering-integration.test.mjs, which drive router.mjs's
 * routeAndSend() instead — the token-ratio block lives in index.mjs's own
 * request handler, not in router.mjs, so that route to a real code path
 * isn't available here either).
 *
 * So this test MIRRORS the shape of the token_ratio block at
 * src/index.mjs:2337-2374, rather than exercising the real code path. It
 * does NOT prove the wiring inside index.mjs is correct — a copy-paste of
 * the block that then silently drifts from the real one would still pass
 * this test. It exists to catch a class of regression at the level this
 * block reasons at: given the same shapes of `result`, `transformedBody`
 * and `siemHook` the real block receives, does the intended event
 * (token_ratio.sample or token_ratio.skipped) fire with the right shape.
 * Treat a pass here as "the intended logic is self-consistent", not as
 * "the block in index.mjs is definitely wired correctly" — do not
 * over-trust it as an end-to-end guard.
 *
 * If this block in index.mjs is ever refactored into an importable function,
 * this test should be rewritten to import and call that function directly,
 * which would turn it into a real wiring test instead of a mirror.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sampleTokenRatio } from "../src/metrics/token-ratio.mjs";

// Mirrors src/index.mjs:2337-2374 exactly in control flow. Keep in sync by
// hand if that block changes.
function emitTokenRatio(result, transformedBody, siemHook) {
  try {
    if (result.headers?.["content-type"]?.includes("text/event-stream")) {
      siemHook({ ts: new Date().toISOString(), event: "token_ratio.skipped", reason: "streaming" });
    } else {
      const _parsed = JSON.parse(result.body.toString("utf-8"));
      const _sample = sampleTokenRatio({
        model: (typeof _parsed?.model === "string" && _parsed.model) ? _parsed.model : result?.servedModel,
        bodyBytes: transformedBody?.length ?? 0,
        usage: _parsed?.usage,
      });
      if (_sample) siemHook({ ts: new Date().toISOString(), event: "token_ratio.sample", ..._sample });
    }
  } catch { /* a backend that reports no usage simply is not measured */ }
}

describe("token ratio wiring (mirrors src/index.mjs, does not exercise it)", () => {
  test("a non-streaming JSON response with usage fires token_ratio.sample with all fields", () => {
    const body = Buffer.from(JSON.stringify({
      id: "cmpl-1",
      model: "ornith-1.0-9b",
      choices: [{ message: { role: "assistant", content: "hi" } }],
      usage: { prompt_tokens: 2048 },
    }));
    const result = { headers: { "content-type": "application/json" }, body, servedModel: "sk-default" };
    const transformedBody = Buffer.from("x".repeat(8192));

    const events = [];
    emitTokenRatio(result, transformedBody, (evt) => events.push(evt));

    assert.equal(events.length, 1);
    const [evt] = events;
    assert.equal(evt.event, "token_ratio.sample");
    for (const k of ["ts", "model", "body_bytes", "prompt_tokens", "bytes_per_token"]) {
      assert.ok(k in evt, `event carries ${k}`);
    }
    // Backend-named model wins over the router's servedModel (ruling 4).
    assert.equal(evt.model, "ornith-1.0-9b");
    assert.equal(evt.body_bytes, 8192);
    assert.equal(evt.prompt_tokens, 2048);
    assert.equal(evt.bytes_per_token, 4);
  });

  test("a streaming (SSE) response fires token_ratio.skipped, never a sample", () => {
    const result = {
      headers: { "content-type": "text/event-stream" },
      body: Buffer.from("data: {\"choices\":[]}\n\n"),
      servedModel: "sk-default",
    };
    const transformedBody = Buffer.from("x".repeat(8192));

    const events = [];
    emitTokenRatio(result, transformedBody, (evt) => events.push(evt));

    assert.equal(events.length, 1);
    assert.equal(events[0].event, "token_ratio.skipped");
    assert.equal(events[0].reason, "streaming");
    assert.ok(!("bytes_per_token" in events[0]), "a skip must never carry a fabricated ratio");
  });

  test("a non-streaming response the backend named differently attributes to the backend's name, not the alias", () => {
    const body = Buffer.from(JSON.stringify({
      model: "claude-sonnet-5",
      usage: { input_tokens: 300 },
    }));
    const result = { headers: { "content-type": "application/json" }, body, servedModel: "sk-m-internal" };
    const transformedBody = Buffer.from("x".repeat(900));

    const events = [];
    emitTokenRatio(result, transformedBody, (evt) => events.push(evt));

    assert.equal(events.length, 1);
    assert.equal(events[0].model, "claude-sonnet-5");
  });

  test("no usage in the body fails open silently: no event, no throw", () => {
    const body = Buffer.from(JSON.stringify({ model: "m", choices: [] }));
    const result = { headers: { "content-type": "application/json" }, body, servedModel: "m" };
    const transformedBody = Buffer.from("x".repeat(100));

    const events = [];
    assert.doesNotThrow(() => emitTokenRatio(result, transformedBody, (evt) => events.push(evt)));
    assert.equal(events.length, 0);
  });
});
