import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { summariseRatios } from "../scripts/token-ratio-report.mjs";

describe("token ratio report", () => {
  test("medians per model, and the drift from the 4.0 assumption", () => {
    const events = [
      { event: "token_ratio.sample", model: "a", bytes_per_token: 3 },
      { event: "token_ratio.sample", model: "a", bytes_per_token: 5 },
      { event: "token_ratio.sample", model: "a", bytes_per_token: 4 },
      { event: "token_ratio.sample", model: "b", bytes_per_token: 2 },
      { event: "semantic_cache.shadow", hit: true },
    ];
    const s = summariseRatios(events);
    assert.equal(s.models.a.samples, 3);
    assert.equal(s.models.a.median, 4);
    assert.equal(s.models.b.median, 2);
    assert.equal(s.models.b.driftFrom4, -0.5, "b packs twice the tokens per byte the guess assumes");
  });

  test("a model with too few samples is marked, not reported as fact", () => {
    const s = summariseRatios([{ event: "token_ratio.sample", model: "c", bytes_per_token: 9 }]);
    assert.equal(s.models.c.confident, false, "one sample is not a measurement");
  });

  test("median on even-length array matches router.mjs p50(): average of the two middle values", () => {
    const events = [
      { event: "token_ratio.sample", model: "m", bytes_per_token: 10 },
      { event: "token_ratio.sample", model: "m", bytes_per_token: 20 },
      { event: "token_ratio.sample", model: "m", bytes_per_token: 30 },
      { event: "token_ratio.sample", model: "m", bytes_per_token: 40 },
    ];
    const s = summariseRatios(events);
    assert.equal(s.models.m.median, 25, "median of [10,20,30,40] is (20+30)/2 = 25, not the upper-middle 30");
  });

  test("median on even-length array does NOT round (unlike router.mjs p50()): fractional ratio near 3", () => {
    // p50() rounds because it measures integer milliseconds, where rounding
    // costs nothing. This measures bytes_per_token, a small ratio (typically
    // 3-5) where rounding to an integer would swamp the drift this report
    // exists to surface. Rounding [3.2, 3.4] to 3 would report -25% drift
    // from 4.0 when the true drift is -17.5%: almost double the real number.
    const events = [
      { event: "token_ratio.sample", model: "m", bytes_per_token: 3.2 },
      { event: "token_ratio.sample", model: "m", bytes_per_token: 3.4 },
    ];
    const s = summariseRatios(events);
    assert.ok(Math.abs(s.models.m.median - 3.3) < 1e-9, "median of [3.2,3.4] is 3.3, not Math.round(3.3) = 3");
  });

  test("median on even-length array does NOT round: fractional ratio near 4.5, and drift reads correctly", () => {
    const events = [
      { event: "token_ratio.sample", model: "m", bytes_per_token: 4.4 },
      { event: "token_ratio.sample", model: "m", bytes_per_token: 4.6 },
    ];
    const s = summariseRatios(events);
    assert.ok(Math.abs(s.models.m.median - 4.5) < 1e-9, "median of [4.4,4.6] is 4.5, not Math.round(4.5) = 5");
    assert.ok(
      Math.abs(s.models.m.driftFrom4 - 0.125) < 1e-9,
      "drift from 4.0 for a true median of 4.5 is +12.5%, not the +25% a rounded median of 5 would report",
    );
  });

  test("median on odd-length array is unaffected (never rounds, has no even branch)", () => {
    const events = [
      { event: "token_ratio.sample", model: "m", bytes_per_token: 3.2 },
      { event: "token_ratio.sample", model: "m", bytes_per_token: 3.4 },
      { event: "token_ratio.sample", model: "m", bytes_per_token: 3.6 },
    ];
    const s = summariseRatios(events);
    assert.ok(Math.abs(s.models.m.median - 3.4) < 1e-9, "median of [3.2,3.4,3.6] is the middle value 3.4");
  });

  test("only token_ratio.sample events feed per-model stats; other event types never inflate the count", () => {
    const events = [
      { event: "token_ratio.sample", model: "a", bytes_per_token: 4 },
      { event: "prompt.classified", model: "a" },
      { event: "identity.resolved", model: "a" },
      { event: "semantic_cache.shadow", hit: true },
      { event: "nonstream_flip", model: "a" },
    ];
    const s = summariseRatios(events);
    assert.equal(s.models.a.samples, 1, "non-sample events must not inflate the sample count");
  });

  test("malformed sample events (non-finite bytes_per_token) are skipped, not fatal", () => {
    const s = summariseRatios([
      { event: "token_ratio.sample", model: "a", bytes_per_token: 4 },
      { event: "token_ratio.sample", model: "a", bytes_per_token: "oops" },
      { event: "token_ratio.sample", model: "a" },
    ]);
    assert.equal(s.models.a.samples, 1);
  });

  test("token_ratio.skipped events are counted by reason, and do not inflate any model's sample count", () => {
    const events = [
      { event: "token_ratio.sample", model: "a", bytes_per_token: 4 },
      { event: "token_ratio.skipped", reason: "streaming" },
      { event: "token_ratio.skipped", reason: "streaming" },
      { event: "token_ratio.skipped", reason: "no_usage" },
    ];
    const s = summariseRatios(events);
    assert.equal(s.models.a.samples, 1, "skipped events must never inflate a model's sample count");
    assert.equal(s.skipped.streaming, 2);
    assert.equal(s.skipped.no_usage, 1);
    assert.equal(s.skippedTotal, 3);
  });

  test("no skipped events at all reports zero, not undefined", () => {
    const s = summariseRatios([{ event: "token_ratio.sample", model: "a", bytes_per_token: 4 }]);
    assert.equal(s.skippedTotal, 0);
    assert.deepEqual(s.skipped, {});
  });
});
