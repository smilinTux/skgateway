#!/usr/bin/env node
/**
 * semantic-cache-report.mjs — read the shadow ledger and print the hit rate.
 *
 * Usage: node scripts/semantic-cache-report.mjs [path/to/audit.jsonl]
 *
 * This is the whole point of shadow mode: turn "we do not know the hit rate"
 * into a number, so enabling `mode: serve` is arithmetic rather than a guess.
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
  return {
    observed: shadow.length,
    wouldHit,
    // null, not 0: "no data" and "never hits" are different answers.
    hitRate: shadow.length ? wouldHit / shadow.length : null,
    medianEmbedMs: embedTimes.length ? embedTimes[Math.floor(embedTimes.length / 2)] : null,
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
}

if (import.meta.url === `file://${process.argv[1]}`) main();
