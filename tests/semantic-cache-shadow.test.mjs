import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createShadowRecorder } from "../src/proxy/semantic-cache-shadow.mjs";

const CFG = {
  enabled: true, mode: "shadow", threshold: 0.9, ttl_seconds: 60,
  max_entries: 10, categories: ["administrative", "system", "data_query"],
};
// Deterministic stand-in for mxbai: identical text embeds identically.
const fakeEmbed = async (t) => [t.length, t.charCodeAt(0) || 0, 1];

describe("shadow recorder", () => {
  test("only the eligible categories are observed", () => {
    const r = createShadowRecorder(CFG, { emit: () => {}, embed: fakeEmbed });
    assert.equal(r.eligible("administrative"), true);
    assert.equal(r.eligible("data_query"), true);
    assert.equal(r.eligible("tool_use"), false, "tool_use has side effects");
    assert.equal(r.eligible("conversation"), false, "memory-grounded");
    assert.equal(r.eligible(undefined), false);
  });

  test("a repeated prompt is recorded as a WOULD-HIT and still returns no response", async () => {
    const events = [];
    const r = createShadowRecorder(CFG, { emit: (e) => events.push(e), embed: fakeEmbed });
    const args = { text: "what is the gtd status", agent: "lumina", category: "administrative" };

    const first = await r.observe(args);
    assert.equal(first.hit, false, "nothing stored yet");

    await r.record({ ...args, response: { choices: [{ message: { content: "answer" } }] } });

    const second = await r.observe(args);
    assert.equal(second.hit, true, "the same prompt must match");
    assert.equal(second.response, undefined,
      "SHADOW MODE: a would-hit must never carry a response back to the caller");

    const hits = events.filter((e) => e.event === "semantic_cache.shadow" && e.hit);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].category, "administrative");
    assert.ok(hits[0].similarity >= 0.9);
  });

  test("an embed failure is swallowed and reported as a miss", async () => {
    const events = [];
    const r = createShadowRecorder(CFG, {
      emit: (e) => events.push(e),
      embed: async () => { throw new Error("mxbai down"); },
    });
    const out = await r.observe({ text: "x", agent: "a", category: "system" });
    assert.equal(out.hit, false, "must fail open, never throw into the request path");
    assert.ok(events.some((e) => e.event === "semantic_cache.error"));
  });

  test("agent and category namespaces do not bleed into each other", async () => {
    const r = createShadowRecorder(CFG, { emit: () => {}, embed: fakeEmbed });
    const text = "same words entirely";
    await r.record({ text, response: { a: 1 }, agent: "lumina", category: "administrative" });
    const other = await r.observe({ text, agent: "jarvis", category: "administrative" });
    assert.equal(other.hit, false, "agent A's cache must never serve agent B");
    const otherCat = await r.observe({ text, agent: "lumina", category: "system" });
    assert.equal(otherCat.hit, false, "a system answer must not serve an administrative query");
  });
});
