/**
 * generic-participation.test.mjs — G3 (card 8aca26e9).
 *
 * Strict schema, precedence, focused-route bypass and revision stability for
 * `routing.generic_participation`.
 *
 * Run with:  node --test --import ./tests/_setup.mjs tests/generic-participation.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeGenericParticipation,
  genericParticipationDecision,
  genericPolicyRevision,
  GenericParticipationError,
} from "../src/policy/generic-participation.mjs";

const VALID = {
  providers: {
    deepseek: { enabled: true, weight: 45 },
    zai: { enabled: true, weight: 35 },
    kimi: { enabled: true, weight: 10 },
    codex: { enabled: false, weight: 10 },
  },
  models: {},
  buckets: {},
};

const entry = (provider, id) => ({ provider, id });

describe("normalizeGenericParticipation schema", () => {
  test("accepts the G3 fixture and normalizes enabled/weight", () => {
    const p = normalizeGenericParticipation(VALID);
    assert.deepEqual(p.providers, {
      deepseek: { enabled: true, weight: 45 },
      zai: { enabled: true, weight: 35 },
      kimi: { enabled: true, weight: 10 },
      codex: { enabled: false, weight: 10 },
    });
    assert.deepEqual(p.models, {});
    assert.deepEqual(p.buckets, {});
  });

  test("undefined/null and {} all normalize to an empty policy", () => {
    for (const raw of [undefined, null, {}]) {
      const p = normalizeGenericParticipation(raw);
      assert.deepEqual(p, { providers: {}, models: {}, buckets: {} });
    }
  });

  test("glm is an alias of zai and its weight is looked up under zai", () => {
    const p = normalizeGenericParticipation({
      providers: { glm: { enabled: true, weight: 7 } },
    });
    assert.deepEqual(p.providers, { zai: { enabled: true, weight: 7 } });
  });

  test("bucket overrides accept generic ids and their provider/model maps", () => {
    const p = normalizeGenericParticipation({
      buckets: {
        "sk-l": { providers: { deepseek: { enabled: true, weight: 20 } } },
        "SK-M-Public": { models: { "deepseek-flash": { enabled: false } } },
      },
    });
    assert.deepEqual(Object.keys(p.buckets).sort(), ["sk-l", "sk-m-public"]);
    assert.equal(p.buckets["sk-l"].providers.deepseek.weight, 20);
    assert.equal(p.buckets["sk-m-public"].models["deepseek-flash"].enabled, false);
  });

  test("enabled defaults true and weight defaults 1 for explicit entries", () => {
    const p = normalizeGenericParticipation({ providers: { nvidia: {} } });
    assert.deepEqual(p.providers.nvidia, { enabled: true, weight: 1 });
  });

  test("weight bounds 0 and 10000 are accepted", () => {
    const p = normalizeGenericParticipation({
      providers: { a: { weight: 0 }, b: { weight: 10000 } },
    });
    assert.equal(p.providers.a.weight, 0);
    assert.equal(p.providers.b.weight, 10000);
  });

  test("rejects unknown keys at every level", () => {
    const bad = [
      { providers: { deepseek: { enabled: true } }, surprise: 1 },
      { providers: { deepseek: { enabled: true, priority: 1 } } },
      { buckets: { "sk-l": { providers: {}, models: {}, enabled: true } } },
    ];
    for (const raw of bad) {
      assert.throws(() => normalizeGenericParticipation(raw), GenericParticipationError);
    }
  });

  test("rejects non-boolean enabled", () => {
    for (const value of ["yes", 1, 0, null]) {
      assert.throws(
        () => normalizeGenericParticipation({ providers: { deepseek: { enabled: value } } }),
        GenericParticipationError,
      );
    }
  });

  test("rejects non-integer and out-of-range weights", () => {
    for (const value of [1.5, "45", -1, 10001, NaN, Infinity]) {
      assert.throws(
        () => normalizeGenericParticipation({ providers: { deepseek: { weight: value } } }),
        GenericParticipationError,
      );
    }
  });

  test("rejects unknown and focused bucket ids", () => {
    for (const id of ["sk-nope", "sk-s-nope", "sk-codex-s", "not-a-bucket", ""]) {
      assert.throws(
        () => normalizeGenericParticipation({ buckets: { [id]: {} } }),
        GenericParticipationError,
      );
    }
  });

  test("rejects duplicate normalized provider aliases", () => {
    assert.throws(
      () => normalizeGenericParticipation({
        providers: { glm: { enabled: true }, zai: { enabled: true } },
      }),
      GenericParticipationError,
    );
  });

  test("rejects non-object model and provider overrides", () => {
    const bad = [
      { models: { "deepseek-flash": true } },
      { models: { "deepseek-flash": null } },
      { providers: { deepseek: "on" } },
      { buckets: { "sk-l": { models: { x: 1 } } } },
    ];
    for (const raw of bad) {
      assert.throws(() => normalizeGenericParticipation(raw), GenericParticipationError);
    }
  });

  test("normalized policy is frozen", () => {
    const p = normalizeGenericParticipation(VALID);
    assert.ok(Object.isFrozen(p));
    assert.ok(Object.isFrozen(p.providers));
    assert.ok(Object.isFrozen(p.providers.deepseek));
  });
});

describe("genericParticipationDecision precedence", () => {
  const policy = normalizeGenericParticipation({
    providers: {
      deepseek: { enabled: true, weight: 45 },
      codex: { enabled: false, weight: 10 },
      zai: { enabled: true, weight: 35 },
    },
    models: {
      "global-model": { enabled: true, weight: 7 },
      "shadowed-model": { enabled: false },
    },
    buckets: {
      "sk-l": {
        providers: { zai: { enabled: true, weight: 20 } },
        models: {
          "bucket-model": { enabled: true, weight: 3 },
          "shadowed-model": { enabled: true, weight: 9 },
        },
      },
    },
  });

  test("bucket model beats bucket provider, global model and global provider", () => {
    const d = genericParticipationDecision(entry("zai", "bucket-model"), "sk-l", policy);
    assert.deepEqual(d, { eligible: true, weight: 3, reason: "enabled", scope: "bucket-model" });
  });

  test("bucket provider beats global model and global provider", () => {
    const d = genericParticipationDecision(entry("zai", "global-model"), "sk-l", policy);
    assert.deepEqual(d, { eligible: true, weight: 20, reason: "enabled", scope: "bucket-provider" });
  });

  test("bucket model override wins even when the global model is disabled", () => {
    const d = genericParticipationDecision(entry("zai", "shadowed-model"), "sk-l", policy);
    assert.equal(d.eligible, true);
    assert.equal(d.weight, 9);
    assert.equal(d.scope, "bucket-model");
  });

  test("global model beats global provider", () => {
    const d = genericParticipationDecision(entry("deepseek", "global-model"), "sk-s", policy);
    assert.deepEqual(d, { eligible: true, weight: 7, reason: "enabled", scope: "model" });
  });

  test("global provider default applies when nothing more specific matches", () => {
    const d = genericParticipationDecision(entry("deepseek", "unlisted"), "sk-m", policy);
    assert.deepEqual(d, { eligible: true, weight: 45, reason: "enabled", scope: "provider" });
  });

  test("disabled global provider yields eligible false, weight 0", () => {
    const d = genericParticipationDecision(entry("codex", "unlisted"), "sk-s", policy);
    assert.deepEqual(d, { eligible: false, weight: 0, reason: "disabled", scope: "provider" });
  });

  test("unconfigured provider falls through to implicit enabled weight 1", () => {
    const d = genericParticipationDecision(entry("nvidia", "unlisted"), "sk-s", policy);
    assert.deepEqual(d, { eligible: true, weight: 1, reason: "default", scope: null });
  });

  test("accepts a bucket object as well as a bucket id string", () => {
    const byId = genericParticipationDecision(entry("deepseek", "x"), "sk-m", policy);
    const byObj = genericParticipationDecision(entry("deepseek", "x"), { bucket: "sk-m" }, policy);
    assert.deepEqual(byId, byObj);
  });
});

describe("focused provider buckets bypass generic exclusions", () => {
  const policy = normalizeGenericParticipation({
    providers: { codex: { enabled: false, weight: 10 } },
  });

  test("generic bucket still disables Codex", () => {
    const d = genericParticipationDecision(entry("codex", "gpt-5"), "sk-s", policy);
    assert.equal(d.eligible, false);
  });

  test("sk-codex-* returns focused-route despite the generic disable", () => {
    for (const bucket of ["sk-codex-s", "sk-codex-m", "sk-codex-l"]) {
      const d = genericParticipationDecision(entry("codex", "gpt-5"), bucket, policy);
      assert.deepEqual(d, { eligible: true, weight: 1, reason: "focused-route", scope: "focused" });
    }
  });

  test("a focused DeepSeek bucket likewise bypasses and is eligible", () => {
    const d = genericParticipationDecision(
      entry("deepseek", "deepseek-flash"), "sk-deepseek-l", policy,
    );
    assert.equal(d.eligible, true);
    assert.equal(d.reason, "focused-route");
  });

  test("direct routing is not represented by this policy: an unconfigured direct entry defaults", () => {
    // Direct routes never call genericParticipationDecision; this asserts the
    // policy itself cannot claim authority over a provider it does not name.
    const d = genericParticipationDecision(entry("codex", "gpt-5"), "sk-m", policy);
    assert.equal(d.reason, "disabled");
    const other = genericParticipationDecision(entry("anthropic", "claude"), "sk-m", policy);
    assert.deepEqual(other, { eligible: true, weight: 1, reason: "default", scope: null });
  });
});

describe("genericPolicyRevision", () => {
  test("is stable, order-independent and alias-normalized", () => {
    const a = normalizeGenericParticipation({
      providers: { deepseek: { enabled: true, weight: 45 }, glm: { weight: 5 } },
    });
    const b = normalizeGenericParticipation({
      providers: { zai: { weight: 5 }, deepseek: { weight: 45, enabled: true } },
    });
    assert.equal(genericPolicyRevision(a), genericPolicyRevision(b));
    assert.match(genericPolicyRevision(a), /^[0-9a-f]{64}$/);
  });

  test("changes when the policy changes and when only a weight changes", () => {
    const base = normalizeGenericParticipation(VALID);
    const changed = normalizeGenericParticipation({
      ...VALID,
      providers: { ...VALID.providers, deepseek: { enabled: true, weight: 46 } },
    });
    assert.notEqual(genericPolicyRevision(base), genericPolicyRevision(changed));
    assert.notEqual(genericPolicyRevision(base), genericPolicyRevision({}));
  });
});
