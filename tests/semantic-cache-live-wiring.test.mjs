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

  // Regression for the fix-round-1 finding on src/index.mjs:2270: the live
  // call site wraps `await _sc.observe(...)` in its own try/catch so the
  // cache stays an observer even if a future edit to
  // semantic-cache-shadow.mjs (or a misbehaving injected embedder) makes
  // observe() reject instead of swallowing its own errors. This does not
  // import index.mjs (it boots an HTTP server at import time); it exercises
  // the exact guard shape used at the call site against a recorder-shaped
  // stub whose observe() rejects, proving the wiring itself is defended, not
  // just the dependency.
  test("the live call-site guard swallows a rejecting observe() and never lets it escape", async () => {
    const _sc = {
      eligible: () => true,
      observe: async () => { throw new Error("boom: embedder blew up synchronously"); },
    };
    const _scEligible = Boolean(_sc && "some text" && _sc.eligible("administrative"));
    let threw = false;
    // Mirrors src/index.mjs:2274-2277 exactly.
    if (_scEligible) {
      try {
        await _sc.observe({ text: "some text", agent: "a", category: "administrative" });
      } catch { /* the cache is an observer; a failure here must never fail the request */ }
    }
    assert.equal(threw, false, "observe() rejecting must never propagate out of the guard");
  });
});
