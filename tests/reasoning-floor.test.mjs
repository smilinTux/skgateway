/**
 * reasoning-floor.test.mjs — Unit tests for applyReasoningFloor().
 *
 * Thinking models (ornith-1.0-9b on .100:8082) spend most of their token
 * budget inside <think>; a low client max_tokens starves the visible answer
 * to empty content. applyReasoningFloor raises an explicit sub-floor cap to
 * the configured floor, without lowering higher caps or touching omitted caps
 * or non-reasoning models.
 *
 * Run with:  node --test tests/reasoning-floor.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyReasoningFloor } from "../src/proxy/core.mjs";

const cfg = { reasoningFloorMaxTokens: 2048, reasoningModels: ["ornith-1.0-9b"] };

describe("applyReasoningFloor", () => {
  test("raises an explicit sub-floor cap to the floor for a reasoning model", () => {
    const parsed = { max_tokens: 400 };
    const changed = applyReasoningFloor(parsed, cfg, "ornith-1.0-9b");
    assert.equal(changed, true);
    assert.equal(parsed.max_tokens, 2048);
  });

  test("leaves a higher cap unchanged", () => {
    const parsed = { max_tokens: 8000 };
    const changed = applyReasoningFloor(parsed, cfg, "ornith-1.0-9b");
    assert.equal(changed, false);
    assert.equal(parsed.max_tokens, 8000);
  });

  test("leaves an omitted max_tokens untouched (stays unbounded)", () => {
    const parsed = {};
    const changed = applyReasoningFloor(parsed, cfg, "ornith-1.0-9b");
    assert.equal(changed, false);
    assert.equal(parsed.max_tokens, undefined);
  });

  test("does not touch non-reasoning models", () => {
    const parsed = { max_tokens: 100 };
    const changed = applyReasoningFloor(parsed, cfg, "claude-opus-4-8");
    assert.equal(changed, false);
    assert.equal(parsed.max_tokens, 100);
  });

  test("disabled when floor is 0", () => {
    const parsed = { max_tokens: 100 };
    const changed = applyReasoningFloor(
      parsed,
      { reasoningFloorMaxTokens: 0, reasoningModels: ["ornith-1.0-9b"] },
      "ornith-1.0-9b",
    );
    assert.equal(changed, false);
    assert.equal(parsed.max_tokens, 100);
  });

  test("equal-to-floor cap is left unchanged (strict below-floor only)", () => {
    const parsed = { max_tokens: 2048 };
    const changed = applyReasoningFloor(parsed, cfg, "ornith-1.0-9b");
    assert.equal(changed, false);
    assert.equal(parsed.max_tokens, 2048);
  });
});
