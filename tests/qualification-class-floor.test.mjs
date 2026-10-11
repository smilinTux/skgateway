/**
 * qualification-class-floor.test.mjs: src/policy/buckets.mjs,
 * effectiveQualifiedClass() and meetsClassFloor()'s reviewed-qualification
 * integration (chi port, inventory item 3).
 *
 * A reviewed qualification result can LOWER a model's effective class (it is
 * evidence against the declared prior) but never raise it, and any malformed
 * or expired evidence fails closed for generic bucket membership; a focused
 * provider route (`applyReviewedQualification: false`, resolveBucket's
 * default for `bucket.provider` truthy) is unaffected either way.
 *
 * Run with: node --test tests/qualification-class-floor.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { effectiveQualifiedClass, meetsClassFloor } from "../src/policy/buckets.mjs";

const HASH = "a".repeat(64);
const future = () => new Date(Date.now() + 86_400_000).toISOString();
const past = () => new Date(Date.now() - 86_400_000).toISOString();

const qualification = (overrides = {}) => ({
  reviewed: true,
  case_set_hash: HASH,
  response_schema_hash: HASH,
  result_hash: HASH,
  expires_at: future(),
  status: "pass",
  qualified_class: "M",
  ...overrides,
});

describe("effectiveQualifiedClass", () => {
  test("happy path: no qualification (or unreviewed) preserves the declared prior unchanged", () => {
    assert.deepEqual(effectiveQualifiedClass("L", null), { cls: "L", basis: "declared-size-prior", eligible: true });
    assert.deepEqual(effectiveQualifiedClass("L", { reviewed: false }), { cls: "L", basis: "declared-size-prior", eligible: true });
    assert.deepEqual(effectiveQualifiedClass(null, null), { cls: null, basis: "unknown", eligible: true });
  });

  test("happy path: a passing qualification below the declared prior lowers the class", () => {
    const result = effectiveQualifiedClass("L", qualification({ qualified_class: "M" }));
    assert.equal(result.eligible, true);
    assert.equal(result.cls, "M");
    assert.match(result.basis, /below declared L/);
  });

  test("edge case: a passing qualification AT or ABOVE the declared prior is capped by the prior, never raised", () => {
    const atPrior = effectiveQualifiedClass("M", qualification({ qualified_class: "M" }));
    assert.equal(atPrior.cls, "M");
    assert.match(atPrior.basis, /capped by declared prior/);

    const aboveDeclared = effectiveQualifiedClass("S", qualification({ qualified_class: "XL" }));
    assert.equal(aboveDeclared.cls, "S", "a qualification result must never raise the declared prior");
    assert.match(aboveDeclared.basis, /capped by declared prior/);
  });

  test("failure case: malformed hashes, an expired result, or a failed status are rejected (ineligible)", () => {
    assert.equal(effectiveQualifiedClass("L", qualification({ case_set_hash: "not-a-hash" })).eligible, false);
    assert.equal(effectiveQualifiedClass("L", qualification({ case_set_hash: "not-a-hash" })).basis, "reviewed-qualification-malformed");

    assert.equal(effectiveQualifiedClass("L", qualification({ expires_at: past() })).eligible, false);
    assert.equal(effectiveQualifiedClass("L", qualification({ expires_at: past() })).basis, "reviewed-qualification-expired");

    assert.equal(effectiveQualifiedClass("L", qualification({ status: "fail" })).eligible, false);
    assert.equal(effectiveQualifiedClass("L", qualification({ status: "fail" })).basis, "reviewed-qualification-failed");

    assert.equal(effectiveQualifiedClass("L", qualification({ expires_at: "not-a-date" })).eligible, false);
    assert.equal(effectiveQualifiedClass(null, qualification()).eligible, false, "an unranked declared class with a reviewed result is malformed, not passed-through");
  });
});

describe("meetsClassFloor reviewed-qualification integration", () => {
  const entryFor = (qual) => ({
    id: "qualified-model",
    capabilities: { size_class: "L" },
    card: { size_class: "L", ...(qual ? { qualification: qual } : {}) },
  });

  test("happy path: applyReviewedQualification off (the default, and every focused-route call) ignores qualification entirely", () => {
    const result = meetsClassFloor(entryFor(qualification({ qualified_class: "S" })), "L");
    assert.equal(result.ok, true, "with the flag off, the declared L prior alone must still clear the L floor");
  });

  test("edge case: a passing qualification that lowers the effective class below the floor fails it", () => {
    const result = meetsClassFloor(entryFor(qualification({ qualified_class: "S" })), "L", { applyReviewedQualification: true });
    assert.equal(result.ok, false, "a qualified-down-to-S model must not clear an L floor");
  });

  test("edge case: a passing qualification that still meets the floor (at or above) passes", () => {
    const result = meetsClassFloor(entryFor(qualification({ qualified_class: "L" })), "L", { applyReviewedQualification: true });
    assert.equal(result.ok, true);
  });

  test("failure case: malformed/expired qualification evidence fails the floor closed, even for a class the declared prior would clear", () => {
    const result = meetsClassFloor(entryFor(qualification({ expires_at: past() })), "S", { applyReviewedQualification: true });
    assert.equal(result.ok, false, "expired qualification evidence must fail closed for generic membership, not fall back to the declared prior");
    assert.equal(result.basis, "reviewed-qualification-expired");
  });
});
