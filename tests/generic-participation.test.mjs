/**
 * generic-participation.test.mjs — src/policy/generic-participation.mjs
 *
 * Port of chi's unmerged generic bucket participation policy (ab1608f9).
 * Covers the pure value layer: normalizeGenericParticipation() (schema
 * validation + freezing), genericParticipationDecision() (precedence), and
 * genericPolicyRevision() (stable content-addressed hashing).
 *
 * Run with: node --test tests/generic-participation.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeGenericParticipation,
  genericParticipationDecision,
  genericPolicyRevision,
  GenericParticipationError,
} from "../src/policy/generic-participation.mjs";

describe("normalizeGenericParticipation", () => {
  test("happy path: undefined/null normalizes to the empty, frozen policy", () => {
    for (const raw of [undefined, null]) {
      const policy = normalizeGenericParticipation(raw);
      assert.deepEqual(policy, { providers: {}, models: {}, buckets: {} });
      assert.ok(Object.isFrozen(policy));
      assert.ok(Object.isFrozen(policy.providers));
    }
  });

  test("happy path: a full valid policy normalizes with defaults filled in", () => {
    const policy = normalizeGenericParticipation({
      providers: { deepseek: { enabled: true, weight: 45 }, codex: { enabled: false } },
      models: { "kimi-k2.5": { weight: 10 } },
      buckets: { "sk-l": { providers: { deepseek: { weight: 20 } } } },
    });
    assert.deepEqual(policy.providers.deepseek, { enabled: true, weight: 45 });
    assert.deepEqual(policy.providers.codex, { enabled: false, weight: 1 });
    assert.deepEqual(policy.models["kimi-k2.5"], { enabled: true, weight: 10 });
    assert.deepEqual(policy.buckets["sk-l"].providers.deepseek, { enabled: true, weight: 20 });
    assert.deepEqual(policy.buckets["sk-l"].models, {});
  });

  test("edge case: glm is a provider alias that collapses to zai, including duplicate detection", () => {
    const policy = normalizeGenericParticipation({ providers: { glm: { weight: 35 } } });
    assert.deepEqual(policy.providers, { zai: { enabled: true, weight: 35 } });
    assert.throws(
      () => normalizeGenericParticipation({ providers: { glm: { weight: 1 }, zai: { weight: 2 } } }),
      GenericParticipationError,
    );
  });

  test("edge case: a short bucket id normalizes the same as a long one, and focused bucket ids are rejected", () => {
    const policy = normalizeGenericParticipation({ buckets: { "sk-l": { providers: {} } } });
    assert.ok(policy.buckets["sk-l"]);
    assert.throws(
      () => normalizeGenericParticipation({ buckets: { "sk-codex-l": { providers: {} } } }),
      /focused provider buckets bypass generic participation/,
    );
  });

  test("failure case: an unknown top-level key is rejected", () => {
    assert.throws(() => normalizeGenericParticipation({ bogus: {} }), GenericParticipationError);
  });

  test("failure case: a non-boolean enabled or an out-of-range/non-integer weight is rejected", () => {
    assert.throws(() => normalizeGenericParticipation({ providers: { zai: { enabled: "yes" } } }), /must be a boolean/);
    assert.throws(() => normalizeGenericParticipation({ providers: { zai: { weight: -1 } } }), /must be between/);
    assert.throws(() => normalizeGenericParticipation({ providers: { zai: { weight: 10_001 } } }), /must be between/);
    assert.throws(() => normalizeGenericParticipation({ providers: { zai: { weight: 1.5 } } }), /must be an integer/);
  });

  test("failure case: an empty provider/model name is rejected", () => {
    assert.throws(() => normalizeGenericParticipation({ providers: { "": { enabled: true } } }), GenericParticipationError);
    assert.throws(() => normalizeGenericParticipation({ models: { "": { enabled: true } } }), GenericParticipationError);
  });
});

describe("genericParticipationDecision", () => {
  const policy = normalizeGenericParticipation({
    providers: { deepseek: { enabled: true, weight: 45 }, codex: { enabled: false } },
    models: { "kimi-k2.5": { enabled: false } },
    buckets: { "sk-l": { providers: { deepseek: { enabled: true, weight: 99 } }, models: { "deepseek-flash": { enabled: false } } } },
  });

  test("happy path: an entry with no override is eligible by default with weight 1", () => {
    const decision = genericParticipationDecision({ id: "unknown-model", provider: "unknown" }, "sk-m", policy);
    assert.deepEqual(decision, { eligible: true, weight: 1, reason: "default", scope: null });
  });

  test("edge case: precedence is bucket-model > bucket-provider > global-model > global-provider > default", () => {
    // bucket-model wins over bucket-provider for the same bucket.
    const bucketModel = genericParticipationDecision({ id: "deepseek-flash", provider: "deepseek" }, "sk-l", policy);
    assert.equal(bucketModel.eligible, false);
    assert.equal(bucketModel.scope, "bucket-model");

    // bucket-provider applies to a different deepseek model in the same bucket.
    const bucketProvider = genericParticipationDecision({ id: "deepseek-chat", provider: "deepseek" }, "sk-l", policy);
    assert.equal(bucketProvider.eligible, true);
    assert.equal(bucketProvider.weight, 99);
    assert.equal(bucketProvider.scope, "bucket-provider");

    // global-model applies outside sk-l.
    const globalModel = genericParticipationDecision({ id: "kimi-k2.5", provider: "kimi" }, "sk-m", policy);
    assert.equal(globalModel.eligible, false);
    assert.equal(globalModel.scope, "model");

    // global-provider applies with no bucket/model override.
    const globalProvider = genericParticipationDecision({ id: "codex-fast", provider: "codex" }, "sk-m", policy);
    assert.equal(globalProvider.eligible, false);
    assert.equal(globalProvider.scope, "provider");
  });

  test("failure case: a focused provider bucket always returns focused-route, ignoring every override", () => {
    const decision = genericParticipationDecision({ id: "codex-fast", provider: "codex" }, "sk-codex-l", policy);
    assert.deepEqual(decision, { eligible: true, weight: 1, reason: "focused-route", scope: "focused" });
  });

  test("failure case: a disabled global provider cannot be re-enabled by an entry with no bucket override", () => {
    const decision = genericParticipationDecision({ id: "codex-fast", provider: "codex" }, { bucket: "sk-s" }, policy);
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, "disabled");
  });
});

describe("genericPolicyRevision", () => {
  test("happy path: equal policies (including undefined vs empty) produce the same revision", () => {
    const a = genericPolicyRevision(undefined);
    const b = genericPolicyRevision(normalizeGenericParticipation(undefined));
    assert.equal(a, b);
    assert.match(a, /^[a-f0-9]{64}$/);
  });

  test("edge case: key order never changes the revision", () => {
    const p1 = normalizeGenericParticipation({ providers: { zai: { weight: 1 }, codex: { weight: 2 } } });
    const p2 = normalizeGenericParticipation({ providers: { codex: { weight: 2 }, zai: { weight: 1 } } });
    assert.equal(genericPolicyRevision(p1), genericPolicyRevision(p2));
  });

  test("failure case: any material change produces a different revision", () => {
    const p1 = normalizeGenericParticipation({ providers: { zai: { weight: 1 } } });
    const p2 = normalizeGenericParticipation({ providers: { zai: { weight: 2 } } });
    assert.notEqual(genericPolicyRevision(p1), genericPolicyRevision(p2));
  });
});
