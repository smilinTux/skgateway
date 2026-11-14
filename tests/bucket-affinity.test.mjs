/**
 * bucket-affinity.test.mjs — session affinity key and member reordering.
 *
 * Run with:  node --test tests/bucket-affinity.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  bucketAffinityKey,
  isContinuation,
  preferRemembered,
} from "../src/policy/bucket-affinity.mjs";

const opening = [
  { role: "system", content: "fleet builder" },
  { role: "user", content: [{ type: "text", text: "card 52f7c2a5" }] },
];

describe("bucketAffinityKey", () => {
  test("later turns keep the key of the conversation opening", () => {
    const later = [...opening, { role: "assistant", content: "x" }, { role: "user", content: "y" }];
    assert.equal(bucketAffinityKey("sk-m", later), bucketAffinityKey("sk-m", opening));
  });

  test("a different opening, bucket or system prompt changes the key", () => {
    const key = bucketAffinityKey("sk-m", opening);
    assert.notEqual(bucketAffinityKey("sk-l", opening), key);
    assert.notEqual(
      bucketAffinityKey("sk-m", [opening[0], { role: "user", content: "card other" }]),
      key,
    );
    assert.notEqual(
      bucketAffinityKey("sk-m", [{ role: "system", content: "reviewer" }, opening[1]]),
      key,
    );
  });

  test("an explicit session id wins over the opening", () => {
    assert.equal(
      bucketAffinityKey("sk-m", opening, "sess-1"),
      bucketAffinityKey("sk-m", [{ role: "user", content: "anything" }], "sess-1"),
    );
  });

  test("no user message means no key", () => {
    assert.equal(bucketAffinityKey("sk-m", [{ role: "system", content: "s" }]), null);
    assert.equal(bucketAffinityKey("sk-m", undefined), null);
  });
});

describe("isContinuation", () => {
  test("only a conversation with a prior assistant turn continues", () => {
    assert.equal(isContinuation(opening), false);
    assert.equal(isContinuation([...opening, { role: "assistant", content: "x" }]), true);
    assert.equal(isContinuation(null), false);
  });
});

describe("preferRemembered", () => {
  const members = [
    { id: "glm-5.3", family: "glm" },
    { id: "deepseek-flash", family: "deepseek" },
    { id: "glm-5", family: "glm" },
  ];

  test("the exact remembered member moves first, others keep their order", () => {
    assert.deepEqual(
      preferRemembered(members, { id: "deepseek-flash", family: "deepseek" }).map((m) => m.id),
      ["deepseek-flash", "glm-5.3", "glm-5"],
    );
  });

  test("falls back to the same family when the exact member is gone", () => {
    const pool = members.filter((m) => m.id !== "glm-5.3");
    assert.deepEqual(
      preferRemembered(pool, { id: "glm-5.3", family: "glm" }).map((m) => m.id),
      ["glm-5", "deepseek-flash"],
    );
  });

  test("an unknown or absent memory leaves the order untouched", () => {
    assert.equal(preferRemembered(members, null), members);
    assert.equal(preferRemembered(members, { id: "kimi", family: "kimi" }), members);
  });
});
