#!/usr/bin/env node
/**
 * token-ratio-report.mjs — what bytes-per-token actually is, per model.
 *
 * Usage: node scripts/token-ratio-report.mjs [path/to/audit.jsonl]
 *
 * The context guard assumes ~4 bytes per token. This prints the measured
 * median per model and how far the assumption drifts, so max_body_bytes can be
 * set from data instead of a guess.
 *
 * IMPORTANT — coverage, not just calibration: streaming (SSE) responses
 * cannot be measured (their bodies are not a single JSON object), so the
 * sampler emits a `token_ratio.skipped` event instead of a sample for them.
 * Transport varies by caller and model (auto_nonstream config, the
 * x-skgateway-nonstream force header), so the unmeasured population is not
 * necessarily random. This report surfaces the skipped count so a reader
 * cannot mistake "median over non-streaming responses" for "median over all
 * traffic".
 */
import { readFileSync } from "node:fs";

const ASSUMED_BYTES_PER_TOKEN = 4;
export const MIN_CONFIDENT_SAMPLES = 30;

/** @param {Array<object>} events */
export function summariseRatios(events) {
  const byModel = {};
  const skipped = {};
  let skippedTotal = 0;
  for (const e of events) {
    if (e?.event === "token_ratio.skipped") {
      const reason = e.reason || "unknown";
      skipped[reason] = (skipped[reason] || 0) + 1;
      skippedTotal++;
      continue;
    }
    if (e?.event !== "token_ratio.sample") continue;
    if (!Number.isFinite(e.bytes_per_token)) continue;
    // A line lacking model would otherwise key a row literally "undefined",
    // which a human reads as a real model name. Our own emitter cannot
    // produce this (sampleTokenRatio() returns null on an empty model), but
    // audit.jsonl is appended by multiple writers, so defend against a
    // malformed or foreign log line here too.
    if (typeof e.model !== "string" || !e.model) continue;
    (byModel[e.model] ||= []).push(e.bytes_per_token);
  }
  const models = {};
  for (const [model, values] of Object.entries(byModel)) {
    values.sort((a, b) => a - b);
    // Median matches p50() in src/proxy/router.mjs:708-715 in ALGORITHM:
    // average the two middle values on even-length input, rather than
    // Math.floor(n/2) alone, which returns the upper-middle value, not a
    // true median. It deliberately does NOT round like p50() does: p50()
    // measures integer milliseconds, where rounding costs nothing, but this
    // measures a small ratio (typically 3-5 bytes/token) where rounding to
    // an integer swamps the drift this report exists to surface. Do not
    // "restore consistency" with p50()'s rounding; that would reintroduce
    // exactly the bug this comment is here to prevent.
    const mid = Math.floor(values.length / 2);
    const median = values.length % 2 === 0
      ? (values[mid - 1] + values[mid]) / 2
      : values[mid];
    models[model] = {
      samples: values.length,
      median,
      min: values[0],
      max: values[values.length - 1],
      driftFrom4: (median - ASSUMED_BYTES_PER_TOKEN) / ASSUMED_BYTES_PER_TOKEN,
      confident: values.length >= MIN_CONFIDENT_SAMPLES,
    };
  }
  return { models, skipped, skippedTotal };
}

function main() {
  const path = process.argv[2] || "logs/audit.jsonl";
  const events = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  const { models: s, skipped, skippedTotal } = summariseRatios(events);
  const modelEntries = Object.entries(s).sort((a, b) => b[1].samples - a[1].samples);
  if (!modelEntries.length) {
    console.log("No token_ratio.sample events yet.");
  } else {
    console.log("model                                samples  median  drift vs 4.0  confident");
    for (const [m, v] of modelEntries) {
      const drift = `${v.driftFrom4 >= 0 ? "+" : ""}${(v.driftFrom4 * 100).toFixed(1)}%`;
      console.log(
        `  ${m.slice(0, 34).padEnd(34)}${String(v.samples).padStart(7)}` +
        `${v.median.toFixed(2).padStart(8)}${drift.padStart(14)}${(v.confident ? "yes" : "NO").padStart(11)}`,
      );
    }
    console.log(`\n(confident = at least ${MIN_CONFIDENT_SAMPLES} samples)`);
  }

  console.log("");
  console.log(`skipped (unmeasurable)  ${skippedTotal}`);
  for (const [reason, count] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason.padEnd(20)}${count}`);
  }
  console.log(
    "\nNOTE: these medians cover non-streaming responses only. Streaming (SSE)\n" +
    "responses cannot be measured and are counted above as skipped, not as\n" +
    "zero-drift samples. Since transport varies by caller and model, the\n" +
    "unmeasured population may not be a random subset of traffic.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
