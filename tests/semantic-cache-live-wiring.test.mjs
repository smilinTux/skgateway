import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createShadowRecorder } from "../src/proxy/semantic-cache-shadow.mjs";

const CFG = {
  enabled: true, mode: "shadow", threshold: 0.9, ttl_seconds: 60, max_entries: 10,
  categories: ["administrative", "system", "data_query"],
};
const fakeEmbed = async (t) => [t.length, t.charCodeAt(0) || 0, 1];

describe("live wiring contract", () => {
  test("an ineligible category is never embedded at all", async () => {
    let embedCalls = 0;
    const r = createShadowRecorder(CFG, {
      emit: () => {},
      embed: async (t) => { embedCalls++; return fakeEmbed(t); },
    });
    // The live path must consult eligible() BEFORE spending an embed call.
    if (r.eligible("tool_use")) await r.observe({ text: "x", agent: "a", category: "tool_use" });
    assert.equal(embedCalls, 0, "no embed call may be spent on ineligible traffic");
  });

  test("stats expose the numbers the go/no-go decision needs", async () => {
    const r = createShadowRecorder(CFG, { emit: () => {}, embed: fakeEmbed });
    await r.observe({ text: "a", agent: "l", category: "administrative" });
    await r.record({ text: "a", response: { ok: 1 }, agent: "l", category: "administrative" });
    await r.observe({ text: "a", agent: "l", category: "administrative" });
    const s = r.stats();
    assert.equal(s.observed, 2);
    assert.equal(s.wouldHit, 1);
    assert.equal(s.errors, 0);
  });
});
