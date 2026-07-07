/**
 * semantic-cache.test.mjs — SC stage 1 engine (mock embed + in-memory store).
 *
 * Run with:  node --test tests/semantic-cache.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { cosineSim, createMemoryStore, createSemanticCache } from "../src/proxy/semantic-cache.mjs";

describe("cosineSim", () => {
  test("identical → 1, orthogonal → 0, opposite → -1", () => {
    assert.equal(cosineSim([1, 0], [1, 0]), 1);
    assert.equal(cosineSim([1, 0], [0, 1]), 0);
    assert.equal(cosineSim([1, 0], [-1, 0]), -1);
  });
  test("bad input → 0", () => {
    assert.equal(cosineSim([1, 2], [1]), 0);
    assert.equal(cosineSim([0, 0], [0, 0]), 0);
    assert.equal(cosineSim(null, [1]), 0);
  });
});

describe("createMemoryStore", () => {
  test("search filters by namespace + ranks by cosine", async () => {
    const s = createMemoryStore();
    await s.insert({ vec: [1, 0], ns: "a:chat", text: "x", response: 1 });
    await s.insert({ vec: [0, 1], ns: "a:chat", text: "y", response: 2 });
    await s.insert({ vec: [1, 0], ns: "b:chat", text: "z", response: 3 }); // other ns
    const hits = await s.search([1, 0], { ns: "a:chat", topK: 2 });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].response, 1);       // best match in namespace
    assert.ok(hits[0].sim > hits[1].sim);
    assert.ok(hits.every((h) => h.response !== 3)); // never crosses namespace
  });

  test("TTL expiry drops entries", async () => {
    const s = createMemoryStore();
    await s.insert({ vec: [1, 0], ns: "a:c", text: "x", response: 1, ttlMs: 20 });
    assert.equal((await s.search([1, 0], { ns: "a:c" })).length, 1);
    await new Promise((r) => setTimeout(r, 35));
    assert.equal((await s.search([1, 0], { ns: "a:c" })).length, 0);
  });

  test("evicts oldest past maxEntries", async () => {
    const s = createMemoryStore({ maxEntries: 2 });
    await s.insert({ vec: [1, 0], ns: "n", text: "a", response: 1 });
    await s.insert({ vec: [1, 0], ns: "n", text: "b", response: 2 });
    await s.insert({ vec: [1, 0], ns: "n", text: "c", response: 3 });
    assert.equal(s.size, 2);
    const texts = (await s.search([1, 0], { ns: "n", topK: 5 })).map((h) => h.text);
    assert.ok(!texts.includes("a")); // oldest evicted
  });
});

describe("createSemanticCache", () => {
  // Mock embedder: map a token to a near-orthonormal-ish vector; near-synonyms
  // share most of the vector so their cosine is high.
  const VOCAB = {
    "capital of france": [1, 0, 0, 0],
    "france capital city": [0.98, 0.02, 0, 0], // synonym → high cosine
    "weather today": [0, 0, 1, 0],
  };
  const embed = async (t) => VOCAB[t.toLowerCase()] || [0, 0, 0, 1];

  test("throws without embed/store", () => {
    assert.throws(() => createSemanticCache({ store: {} }));
    assert.throws(() => createSemanticCache({ embed, store: {} }));
  });

  test("put then lookup exact → hit", async () => {
    const c = createSemanticCache({ embed, store: createMemoryStore(), threshold: 0.9 });
    await c.put("capital of france", { answer: "Paris" }, { agent: "lumina", category: "chat" });
    const r = await c.lookup("capital of france", { agent: "lumina", category: "chat" });
    assert.equal(r.hit, true);
    assert.deepEqual(r.response, { answer: "Paris" });
  });

  test("semantically similar query → hit above threshold", async () => {
    const c = createSemanticCache({ embed, store: createMemoryStore(), threshold: 0.9 });
    await c.put("capital of france", { answer: "Paris" }, { agent: "lumina", category: "chat" });
    const r = await c.lookup("france capital city", { agent: "lumina", category: "chat" });
    assert.equal(r.hit, true);
    assert.ok(r.similarity >= 0.9);
  });

  test("unrelated query → miss", async () => {
    const c = createSemanticCache({ embed, store: createMemoryStore(), threshold: 0.9 });
    await c.put("capital of france", { answer: "Paris" }, { agent: "lumina", category: "chat" });
    assert.equal((await c.lookup("weather today", { agent: "lumina", category: "chat" })).hit, false);
  });

  test("namespace isolation: other agent / category → miss", async () => {
    const c = createSemanticCache({ embed, store: createMemoryStore(), threshold: 0.9 });
    await c.put("capital of france", { answer: "Paris" }, { agent: "lumina", category: "chat" });
    assert.equal((await c.lookup("capital of france", { agent: "jarvis", category: "chat" })).hit, false);
    assert.equal((await c.lookup("capital of france", { agent: "lumina", category: "code" })).hit, false);
  });
});
