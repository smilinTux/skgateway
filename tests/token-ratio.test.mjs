import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sampleTokenRatio } from "../src/metrics/token-ratio.mjs";

describe("token ratio sampling", () => {
  test("computes bytes per token from a reported usage", () => {
    const s = sampleTokenRatio({ model: "ornith-1.5-9b", bodyBytes: 4000, usage: { prompt_tokens: 1000 } });
    assert.equal(s.model, "ornith-1.5-9b");
    assert.equal(s.body_bytes, 4000);
    assert.equal(s.prompt_tokens, 1000);
    assert.equal(s.bytes_per_token, 4);
  });

  test("accepts the Anthropic usage spelling too", () => {
    const s = sampleTokenRatio({ model: "claude-opus-5", bodyBytes: 900, usage: { input_tokens: 300 } });
    assert.equal(s.bytes_per_token, 3);
  });

  test("returns null when there is nothing to measure", () => {
    assert.equal(sampleTokenRatio({ model: "m", bodyBytes: 100, usage: {} }), null);
    assert.equal(sampleTokenRatio({ model: "m", bodyBytes: 100, usage: { prompt_tokens: 0 } }), null,
      "zero tokens would divide by zero, not a measurement");
    assert.equal(sampleTokenRatio({ model: "m", bodyBytes: 0, usage: { prompt_tokens: 10 } }), null);
    assert.equal(sampleTokenRatio({ model: "", bodyBytes: 100, usage: { prompt_tokens: 10 } }), null);
  });
});
