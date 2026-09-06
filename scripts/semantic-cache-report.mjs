#!/usr/bin/env node
/**
 * semantic-cache-report.mjs — read the shadow ledger and print the hit rate.
 *
 * Usage: node scripts/semantic-cache-report.mjs [path/to/audit.jsonl]
 *
 * This is the whole point of shadow mode: turn "we do not know the hit rate"
 * into a number, so enabling `mode: serve` is arithmetic rather than a guess.
 *
 * IMPORTANT — the printed hit rate is an UPPER BOUND, not the rate serving
 * would achieve: the shadow cache key (src/index.mjs, ~line 2268) covers
 * user-role string content only, truncated to 1100 characters, and excludes
 * the system prompt. Two requests that differ only in system prompt, in a
 * non-string (multimodal) turn, or past the 1100-char truncation point
 * embed identically and count as a would-hit even though a real cache would
 * treat them as distinct. This report surfaces that caveat alongside the hit
 * rate so a reader cannot mistake "measured shadow hit rate" for "hit rate
 * serving would achieve".
 */
import { readFileSync } from "node:fs";

/** @param {Array<object>} events */
export function summarise(events) {
  const shadow = events.filter((e) => e?.event === "semantic_cache.shadow");
  const byCategory = {};
  const embedTimes = [];
  let wouldHit = 0;
  for (const e of shadow) {
    const c = e.category || "unknown";
    byCategory[c] ||= { observed: 0, wouldHit: 0 };
    byCategory[c].observed++;
    if (e.hit) { byCategory[c].wouldHit++; wouldHit++; }
    if (Number.isFinite(e.embed_ms)) embedTimes.push(e.embed_ms);
  }
  embedTimes.sort((a, b) => a - b);
  // Compute median to match p50() in src/proxy/router.mjs so the two latency
  // figures in this system are comparable: even-length arrays average their
  // two middle values (with rounding), odd-length arrays take the middle value.
  const mid = Math.floor(embedTimes.length / 2);
  const median = embedTimes.length === 0
    ? null
    : embedTimes.length % 2 === 0
      ? Math.round((embedTimes[mid - 1] + embedTimes[mid]) / 2)
      : embedTimes[mid];
  return {
    observed: shadow.length,
    wouldHit,
    // null, not 0: "no data" and "never hits" are different answers.
    hitRate: shadow.length ? wouldHit / shadow.length : null,
    medianEmbedMs: median,
    byCategory,
  };
}

function main() {
  const path = process.argv[2] || "logs/audit.jsonl";
  const events = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  const s = summarise(events);
  if (s.observed === 0) {
    console.log("No semantic_cache.shadow events. Is semantic_cache.enabled true?");
    return;
  }
  console.log(`observed        ${s.observed}`);
  console.log(`would-hit       ${s.wouldHit}`);
  console.log(`hit rate        ${(s.hitRate * 100).toFixed(1)}%`);
  console.log(`median embed    ${s.medianEmbedMs} ms`);
  console.log("");
  console.log("category            observed  would-hit  rate");
  for (const [c, v] of Object.entries(s.byCategory).sort((a, b) => b[1].observed - a[1].observed)) {
    const rate = ((v.wouldHit / v.observed) * 100).toFixed(1);
    console.log(`  ${c.padEnd(18)}${String(v.observed).padStart(8)}${String(v.wouldHit).padStart(11)}${(rate + "%").padStart(7)}`);
  }
  console.log(
    "\nCAVEAT: this hit rate is an UPPER BOUND. The cache key covers user-role\n" +
    "string content only, truncated to 1100 characters, and excludes the\n" +
    "system prompt. Requests that differ only in system prompt, in a\n" +
    "non-string (multimodal) turn, or past the truncation point embed\n" +
    "identically and count as a would-hit here even though serving would\n" +
    "treat them as distinct. Actual hit rate under `mode: serve` will be\n" +
    "at or below this number.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
