import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { summarise } from "../scripts/semantic-cache-report.mjs";

describe("shadow report", () => {
  test("computes hit rate overall and per category", () => {
    const events = [
      { event: "semantic_cache.shadow", hit: true,  category: "administrative", embed_ms: 70 },
      { event: "semantic_cache.shadow", hit: false, category: "administrative", embed_ms: 80 },
      { event: "semantic_cache.shadow", hit: false, category: "data_query",     embed_ms: 75 },
      { event: "prompt.classified",     category: "tool_use" },
    ];
    const s = summarise(events);
    assert.equal(s.observed, 3, "only semantic_cache.shadow events count");
    assert.equal(s.wouldHit, 1);
    assert.equal(s.hitRate, 1 / 3);
    assert.equal(s.byCategory.administrative.observed, 2);
    assert.equal(s.byCategory.administrative.wouldHit, 1);
    assert.equal(s.medianEmbedMs, 75);
  });

  test("no events is reported honestly, not as a zero hit rate", () => {
    const s = summarise([]);
    assert.equal(s.observed, 0);
    assert.equal(s.hitRate, null, "no data must not be presented as 0% hit rate");
  });
});
