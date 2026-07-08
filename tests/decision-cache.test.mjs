/**
 * decision-cache.test.mjs — unit tests for the sk-auto routing decision cache.
 *
 * Run with:  node --test tests/decision-cache.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fnv1a, decisionKey, createDecisionCache } from "../src/proxy/decision-cache.mjs";

describe("fnv1a", () => {
  test("deterministic + 8-hex", () => {
    assert.equal(fnv1a("hello"), fnv1a("hello"));
    assert.match(fnv1a("hello"), /^[0-9a-f]{8}$/);
  });
  test("differs on different input", () => {
    assert.notEqual(fnv1a("hello"), fnv1a("hellp"));
  });
});

describe("decisionKey", () => {
  const um = (t) => [{ role: "user", content: t }];
  test("same messages + epoch → same key", () => {
    assert.equal(decisionKey(um("hi there"), 1), decisionKey(um("hi there"), 1));
  });
  test("different epoch → different key (config change invalidates)", () => {
    assert.notEqual(decisionKey(um("hi"), 1), decisionKey(um("hi"), 2));
  });
  test("different user text → different key", () => {
    assert.notEqual(decisionKey(um("hi"), 1), decisionKey(um("bye"), 1));
  });
  test("different total context size → different key (context guard)", () => {
    const a = [{ role: "system", content: "x".repeat(10) }, { role: "user", content: "hi" }];
    const b = [{ role: "system", content: "x".repeat(9999) }, { role: "user", content: "hi" }];
    assert.notEqual(decisionKey(a, 1), decisionKey(b, 1));
  });
  test("handles array-of-parts content", () => {
    const msgs = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    assert.match(decisionKey(msgs, 1), /^1:/);
  });
});

describe("createDecisionCache", () => {
  test("get/set round-trip + hit/miss counters", () => {
    const c = createDecisionCache();
    assert.equal(c.get("k"), null);
    assert.equal(c.misses, 1);
    c.set("k", { role: "sk-default" });
    assert.deepEqual(c.get("k"), { role: "sk-default" });
    assert.equal(c.hits, 1);
  });

  test("TTL expiry (per-entry override)", async () => {
    const c = createDecisionCache({ ttlMs: 60_000 });
    c.set("k", "v", 20); // 20ms life
    assert.equal(c.get("k"), "v");
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(c.get("k"), null);
  });

  test("LRU eviction at maxEntries", () => {
    const c = createDecisionCache({ maxEntries: 2 });
    c.set("a", 1); c.set("b", 2);
    c.get("a");            // touch 'a' → 'b' now oldest
    c.set("c", 3);         // evicts 'b'
    assert.equal(c.get("a"), 1);
    assert.equal(c.get("b"), null);
    assert.equal(c.get("c"), 3);
  });

  test("clear resets entries + counters", () => {
    const c = createDecisionCache();
    c.set("k", 1); c.get("k");
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c.hits, 0);
    assert.equal(c.misses, 0);
  });
});
