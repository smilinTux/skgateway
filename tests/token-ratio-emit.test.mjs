import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sampleTokenRatio } from "../src/metrics/token-ratio.mjs";

describe("token ratio emission contract", () => {
  test("a sample carries exactly the fields the report needs", () => {
    const s = sampleTokenRatio({ model: "qwen3.8-27b", bodyBytes: 8192, usage: { prompt_tokens: 2048 } });
    const evt = { ts: new Date().toISOString(), event: "token_ratio.sample", ...s };
    for (const k of ["model", "body_bytes", "prompt_tokens", "bytes_per_token"]) {
      assert.ok(k in evt, `report joins on ${k}`);
    }
    assert.equal(evt.bytes_per_token, 4);
  });

  test("an unmeasurable request produces no event", () => {
    assert.equal(sampleTokenRatio({ model: "m", bodyBytes: 10, usage: {} }), null,
      "a backend that reports no usage must not emit a fabricated ratio");
  });
});
