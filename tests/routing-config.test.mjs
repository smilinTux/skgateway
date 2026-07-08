/**
 * routing-config.test.mjs — sk-auto config-driven routing (S1).
 *
 * Verifies the routing CRITERION is tunable via config (opts), not hardcoded:
 * the infra-intent signal can be overridden with `infra_patterns`.
 *
 * Run with:  node --test tests/routing-config.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyDifficulty } from "../src/classifiers/difficulty.mjs";

const um = (t) => [{ role: "user", content: t }];

describe("infra_patterns config override", () => {
  test("default INFRA_RE routes an ops query to sk-heavy", () => {
    assert.equal(classifyDifficulty(um("can you run nvidia-smi for me")).role, "sk-heavy");
  });

  test("custom infra_patterns REPLACES the default set", () => {
    // With a custom set that does NOT include nvidia-smi, the ops query is no
    // longer flagged as infra → falls through to the local default.
    assert.equal(
      classifyDifficulty(um("can you run nvidia-smi for me"), { infra_patterns: ["frobnicate"] }).role,
      "sk-default",
    );
    // ...and the custom term now routes to heavy.
    assert.equal(
      classifyDifficulty(um("please frobnicate the widget"), { infra_patterns: ["frobnicate"] }).role,
      "sk-heavy",
    );
  });

  test("empty/invalid infra_patterns falls back to the default", () => {
    assert.equal(classifyDifficulty(um("run nvidia-smi"), { infra_patterns: [] }).role, "sk-heavy");
    // A malformed regex fragment must not throw — falls back to default INFRA_RE.
    assert.equal(classifyDifficulty(um("run nvidia-smi"), { infra_patterns: ["("] }).role, "sk-heavy");
  });

  test("thresholds still tunable: max_easy_chars raises the long-text bar", () => {
    const medium = um("word ".repeat(500)); // 2500 chars
    assert.equal(classifyDifficulty(medium).role, "sk-heavy");              // default 2000 → long
    assert.equal(classifyDifficulty(medium, { max_easy_chars: 5000 }).role, "sk-default"); // raised
  });
});
