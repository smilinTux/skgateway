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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyDifficulty } from "../src/classifiers/difficulty.mjs";
import { loadConfig, getConfig, reloadConfig } from "../src/config.mjs";
import {
  genericParticipationDecision,
  genericPolicyRevision,
} from "../src/policy/generic-participation.mjs";

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

describe("routing.generic_participation config wiring (G3)", () => {
  function fixture(lines) {
    const dir = mkdtempSync(join(tmpdir(), "skgw-generic-participation-"));
    const path = join(dir, "skgateway.yaml");
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    return path;
  }

  const VALID = [
    "routing:",
    "  generic_participation:",
    "    providers:",
    "      deepseek: { enabled: true, weight: 45 }",
    "      zai: { enabled: true, weight: 35 }",
    "      codex: { enabled: false }",
  ];

  const path = fixture(VALID);

  test("boot normalizes the policy and exposes a frozen empty default", async () => {
    await loadConfig({ configPath: path, silent: true });
    const policy = getConfig().routing.generic_participation;
    assert.ok(Object.isFrozen(policy));
    assert.equal(policy.providers.deepseek.weight, 45);
    assert.equal(policy.providers.codex.enabled, false);
    assert.match(genericPolicyRevision(policy), /^[0-9a-f]{64}$/);
  });

  test("invalid boot candidate throws before becoming active", async () => {
    const bad = fixture([
      "routing:",
      "  generic_participation:",
      "    providers:",
      "      codex: { enabled: not-a-boolean }",
    ]);
    await assert.rejects(
      () => loadConfig({ configPath: bad, silent: true }),
      (err) => /routing\.generic_participation/.test(err.message),
    );
  });

  test("an invalid reload leaves the active policy unchanged", async () => {
    await loadConfig({ configPath: path, silent: true });
    const before = genericPolicyRevision(getConfig().routing.generic_participation);

    writeFileSync(path, [
      "routing:",
      "  generic_participation:",
      "    providers:",
      "      deepseek: { enabled: true, weight: 10001 }",
    ].join("\n") + "\n", "utf8");
    const result = reloadConfig(true);
    assert.equal(result.ok, false);
    assert.equal(
      genericPolicyRevision(getConfig().routing.generic_participation),
      before,
      "active policy must survive a rejected SIGHUP candidate",
    );
  });

  test("a valid reload replaces the active policy", async () => {
    writeFileSync(path, [
      "routing:",
      "  generic_participation:",
      "    providers:",
      "      deepseek: { enabled: true, weight: 60 }",
      "      codex: { enabled: false }",
    ].join("\n") + "\n", "utf8");
    assert.equal(reloadConfig(true).ok, true);
    const policy = getConfig().routing.generic_participation;
    assert.equal(policy.providers.deepseek.weight, 60);
  });

  test("Codex generic disable still admits a focused sk-codex route", () => {
    const policy = getConfig().routing.generic_participation;
    const codex = { provider: "codex", id: "gpt-5" };
    assert.equal(genericParticipationDecision(codex, "sk-s", policy).eligible, false);
    assert.deepEqual(
      genericParticipationDecision(codex, "sk-codex-m", policy),
      { eligible: true, weight: 1, reason: "focused-route", scope: "focused" },
    );
  });
});
