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

  test("counts cached prompt tokens instead of only the uncached remainder", () => {
    // 200KB body, 190KB of which was prompt-cached. Anthropic reports
    // input_tokens for only the uncached sliver (500), with the cached
    // portion split across cache_read_input_tokens (a hit) and
    // cache_creation_input_tokens (a write). Counting input_tokens alone
    // would yield 200000/500 = 400 bytes/token; the true prompt is ~50000
    // tokens, so the real ratio is ~4.
    const s = sampleTokenRatio({
      model: "claude-opus-5",
      bodyBytes: 200000,
      usage: { input_tokens: 500, cache_read_input_tokens: 45000, cache_creation_input_tokens: 4500 },
    });
    assert.ok(s, "expected a measurement");
    assert.equal(s.prompt_tokens, 50000);
    assert.equal(s.bytes_per_token, 4);
    assert.notEqual(Math.round(s.bytes_per_token), 400,
      "must not regress to counting only the uncached remainder");
  });

  test("plain OpenAI usage with only prompt_tokens is unchanged", () => {
    const s = sampleTokenRatio({ model: "gpt-4o", bodyBytes: 4000, usage: { prompt_tokens: 1000 } });
    assert.equal(s.prompt_tokens, 1000);
    assert.equal(s.bytes_per_token, 4);
  });
});
