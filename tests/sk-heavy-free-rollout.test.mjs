/**
 * sk-heavy-free-rollout.test.mjs (card P4.4): rollout flag + sk-heavy-free A/B (Q1).
 *
 * Locked decision Q1 (epic cards doc): `sk-heavy` stays PINNED to Opus.
 * `sk-heavy-free` is a new `@match` role for opt-in A/B: an explicit
 * context/role points at it, ratings compare it against sk-heavy over time.
 * The difficulty classifier keeps emitting the role name "sk-heavy" for hard
 * prompts unconditionally; it is the REGISTRY (a context override) that
 * decides whether that name resolves to the pinned Opus backend or to the
 * opt-in free ranked chain. Nothing here talks to a live server; resolve()
 * and classifyDifficulty() are both pure/file-backed, same style as
 * registry-match.test.mjs and routing-config.test.mjs.
 *
 * Run with:  node --test tests/sk-heavy-free-rollout.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolve, getRequirements } from "../src/proxy/registry.mjs";
import { classifyDifficulty } from "../src/classifiers/difficulty.mjs";

const dir = mkdtempSync(join(tmpdir(), "skgw-sk-heavy-free-"));
const REGISTRY_PATH = join(dir, "registry.yaml");

writeFileSync(
  REGISTRY_PATH,
  `backends:
  ornith:
    url: http://192.168.0.100:8082/v1
    model: ornith-1.0-9b
    ctx: 131072
    kind: chat
  opus:
    url: http://192.168.0.41:18780/v1
    model: claude-opus-4-8
    ctx: 500000
    kind: chat
roles:
  sk-default: ornith
  sk-heavy: opus
  sk-heavy-free: "@match"
  sk-auto: auto
requirements:
  sk-heavy-free:
    require: {}
    prefer: [reasoning, coding, success_rate]
    tier: [local, free-remote]
contexts:
  agent:optedin: sk-heavy-free
defaults:
  role: sk-default
`,
  "utf8",
);

const um = (t) => [{ role: "user", content: t }];
const HARD_PROMPT = "can you run nvidia-smi for me";

describe("card P4.4: sk-heavy stays pinned, sk-heavy-free is opt-in @match", () => {
  test("sk-heavy resolves to the pinned opus backend, unchanged by sk-heavy-free existing", () => {
    const r = resolve({ role: "sk-heavy" }, REGISTRY_PATH);
    assert.equal(r.backend, "opus");
    assert.equal(r.role, "sk-heavy");
    assert.equal(r.match, undefined, "sk-heavy must NOT be a match marker");
  });

  test("sk-heavy-free resolves via the @match marker with a deep-reasoning requirement block", () => {
    const r = resolve({ role: "sk-heavy-free" }, REGISTRY_PATH);
    assert.equal(r.match, true);
    assert.equal(r.role, "sk-heavy-free");
    assert.deepEqual(r.requirements.prefer, ["reasoning", "coding", "success_rate"]);
    assert.deepEqual(r.requirements.tier, ["local", "free-remote"]);
    assert.equal(
      getRequirements("sk-heavy-free", REGISTRY_PATH).tier.includes("paid-cloud"),
      false,
      "sk-heavy-free must never escalate to paid-cloud (that stays sk-heavy's job)",
    );
  });

  test("the difficulty classifier still emits role 'sk-heavy' for a hard prompt (tierer unchanged)", () => {
    assert.equal(classifyDifficulty(um(HARD_PROMPT)).role, "sk-heavy");
  });

  test("default hard-prompt routing is NOT altered: classifier role 'sk-heavy' with no opt-in context resolves to opus, not the free chain", () => {
    const role = classifyDifficulty(um(HARD_PROMPT)).role;
    const r = resolve({ role }, REGISTRY_PATH);
    assert.equal(r.backend, "opus");
    assert.equal(r.match, undefined);
  });

  test("the A/B is opt-in only: an explicit context pointing at sk-heavy-free overrides the default hard-prompt role", () => {
    // Precedence context > service > role (registry.mjs resolve()): a caller
    // whose context has opted into sk-heavy-free gets the free ranked chain
    // even though the classifier (or an explicit role header) said sk-heavy.
    const r = resolve({ context: "agent:optedin", role: "sk-heavy" }, REGISTRY_PATH);
    assert.equal(r.match, true);
    assert.equal(r.role, "sk-heavy-free");
    assert.equal(r.via, "context");
  });

  test("a caller with no opt-in context and role sk-heavy is unaffected by the opt-in existing elsewhere", () => {
    const r = resolve({ role: "sk-heavy" }, REGISTRY_PATH);
    assert.equal(r.backend, "opus");
  });
});
