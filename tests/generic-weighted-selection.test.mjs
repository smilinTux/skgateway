/**
 * generic-weighted-selection.test.mjs — src/policy/buckets.mjs:
 * orderMembersByGenericWeight() (chi port, inventory item 3).
 *
 * Weighted ticket selection across providers inside an open generic S/M/L
 * bucket, driven by generic-participation.mjs's policy. A focused provider
 * bucket keeps ordinary cost ordering (generic weighting never applies
 * there); a generic bucket's winner is a function of the rotation counter and
 * each eligible provider's weight, deterministic and reproducible.
 *
 * Run with: node --test tests/generic-weighted-selection.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { orderMembersByGenericWeight } from "../src/policy/buckets.mjs";
import { normalizeGenericParticipation } from "../src/policy/generic-participation.mjs";

const member = (id, provider) => ({ id, provider });

describe("orderMembersByGenericWeight", () => {
  test("happy path: an empty policy gives every provider equal weight 1, rotating deterministically", () => {
    const members = [member("a", "zai"), member("b", "deepseek"), member("c", "kimi")];
    const policy = normalizeGenericParticipation(undefined);
    const winners = new Set();
    for (let counter = 0; counter < 3; counter++) {
      const ordered = orderMembersByGenericWeight(members, counter, "sk-m", policy);
      assert.equal(ordered.length, 3, "every eligible member must appear in the failover chain");
      winners.add(ordered[0].provider);
    }
    assert.equal(winners.size, 3, "with equal weights, rotating the counter must cycle through every provider");
  });

  test("happy path: metadata (policy revision, weight, reason, counter) is attached to every ordered member", () => {
    const members = [member("a", "zai")];
    const policy = normalizeGenericParticipation({ providers: { zai: { weight: 7 } } });
    const [ordered] = orderMembersByGenericWeight(members, 2, "sk-s", policy);
    assert.equal(ordered.generic_rotation_counter, 2);
    assert.equal(ordered.generic_provider_weight, 7);
    assert.equal(ordered.generic_participation_reason, "enabled");
    assert.match(ordered.generic_policy_revision, /^[a-f0-9]{64}$/);
  });

  test("edge case: a higher-weighted provider wins strictly more of the rotation", () => {
    const members = [member("a", "zai"), member("b", "deepseek")];
    const policy = normalizeGenericParticipation({
      providers: { zai: { weight: 1 }, deepseek: { weight: 9 } },
    });
    const totalWeight = 10;
    const winCounts = { zai: 0, deepseek: 0 };
    for (let counter = 0; counter < totalWeight; counter++) {
      winCounts[orderMembersByGenericWeight(members, counter, "sk-m", policy)[0].provider]++;
    }
    assert.equal(winCounts.deepseek, 9);
    assert.equal(winCounts.zai, 1);
  });

  test("edge case: a focused provider bucket keeps plain cost ordering and ignores the weight policy", () => {
    const members = [member("a", "codex")];
    const policy = normalizeGenericParticipation({ providers: { codex: { enabled: false } } });
    const ordered = orderMembersByGenericWeight(members, 0, "sk-codex-l", policy);
    assert.equal(ordered.length, 1, "a disabled GENERIC policy must never remove a focused route's own member");
    assert.equal(ordered[0].generic_participation_reason, "focused-route");
  });

  test("failure case: a provider disabled by policy is excluded from the rotation entirely", () => {
    const members = [member("a", "zai"), member("b", "codex")];
    const policy = normalizeGenericParticipation({ providers: { codex: { enabled: false } } });
    const ordered = orderMembersByGenericWeight(members, 0, "sk-m", policy);
    assert.deepEqual(ordered.map((m) => m.provider), ["zai"]);
  });

  test("failure case: every provider disabled leaves nothing eligible, returns an empty chain", () => {
    const members = [member("a", "zai")];
    const policy = normalizeGenericParticipation({ providers: { zai: { enabled: false } } });
    assert.deepEqual(orderMembersByGenericWeight(members, 0, "sk-m", policy), []);
  });

  test("failure case: an empty members array, or an invalid bucket/counter, returns an empty chain without throwing", () => {
    const policy = normalizeGenericParticipation(undefined);
    assert.deepEqual(orderMembersByGenericWeight([], 0, "sk-m", policy), []);
    assert.deepEqual(orderMembersByGenericWeight([member("a", "zai")], -1, "sk-m", policy), []);
    assert.deepEqual(orderMembersByGenericWeight([member("a", "zai")], 0, "not-a-bucket", policy), []);
  });
});
