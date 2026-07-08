/**
 * empirical.mjs — empirical feedback adjuster for the sk-auto difficulty router.
 *
 * The pure heuristic in {@link module:classifiers/difficulty} is the BASELINE.
 * This module reads a shared, append-only ratings JSONL (written by the Telegram
 * bridge via skchat's `telegram_ratings` store — coord c87faa13) and applies a
 * BOUNDED nudge on top of the heuristic:
 *
 *   - If sk-default's model has empirically LOW mean scores (< lowThreshold over
 *     >= minSamples rated samples) for this prompt class → ESCALATE to sk-heavy.
 *   - If the heuristic chose sk-heavy but sk-default's model scores FINE
 *     (>= goodThreshold over >= minSamples) for this prompt class → allow
 *     DE-ESCALATION back to sk-default (save the expensive model).
 *
 * The heuristic always wins on structure (vision is never touched); empirical
 * only shifts the default↔heavy boundary, and only when there is enough signal.
 * Every adjustment is annotated in `signals` (e.g. `empirical:escalate(ornith
 * mean=1.80 n=7)`) so it is observable in the router logs.
 *
 * Shared contract (matches skchat/src/skchat/telegram_ratings.py):
 *   Path: ~/.skcapstone/models/ratings.jsonl (env `SK_RATINGS_PATH` override).
 *   One JSON object per line:
 *     {ts, chat_id, msg_id, model, prompt_class, prompt_hash, score(1..5|null)}
 *   Rated rows (score != null) collapse by (chat_id,msg_id) last-write-wins.
 *
 * File reads are mtime-cached (like registry.mjs) so this never hammers disk.
 *
 * @module classifiers/empirical
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";

/** Absolute path to the ratings JSONL (env override honoured). */
export const RATINGS_PATH =
  process.env.SK_RATINGS_PATH ||
  pathResolve(homedir(), ".skcapstone", "models", "ratings.jsonl");

// Tuning defaults — overridable via the registry `auto:` block (config.empirical).
const DEFAULT_MIN_SAMPLES = 5; // min rated samples before empirical acts
const DEFAULT_LOW_THRESHOLD = 2.5; // mean below this => escalate
const DEFAULT_GOOD_THRESHOLD = 3.5; // mean at/above this => allow de-escalation
const DEFAULT_WINDOW = 500; // most-recent rated rows considered

const DEFAULT_ROLE = "sk-default";
const HEAVY_ROLE = "sk-heavy";

// mtime-keyed cache — re-parse only when the file actually changes.
let _cache = null;
let _cacheMtime = -1;
let _cachePath = null;

/**
 * Read + parse the ratings JSONL, collapsing rated rows by (chat_id,msg_id)
 * with last-write-wins. Missing/unreadable file => []. mtime-cached.
 *
 * @param {string} [path]
 * @returns {Array<{model:string, prompt_class:string|null, score:number, ts:number}>}
 */
export function loadRatings(path = RATINGS_PATH) {
  try {
    const st = statSync(path);
    if (_cache && _cacheMtime === st.mtimeMs && _cachePath === path) {
      return _cache;
    }
    const raw = readFileSync(path, "utf8");
    const merged = new Map(); // key: chat_id\0msg_id -> row (last write wins)
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let row;
      try {
        row = JSON.parse(s);
      } catch {
        continue;
      }
      const key = `${row.chat_id}\0${row.msg_id}`;
      merged.set(key, row);
    }
    const rated = [];
    for (const row of merged.values()) {
      if (row.score == null || row.model == null) continue;
      rated.push({
        model: row.model,
        prompt_class: row.prompt_class ?? null,
        score: Number(row.score),
        ts: Number(row.ts) || 0,
      });
    }
    rated.sort((a, b) => a.ts - b.ts);
    _cache = rated;
    _cacheMtime = st.mtimeMs;
    _cachePath = path;
  } catch {
    if (!_cache || _cachePath !== path) {
      _cache = [];
      _cachePath = path;
      _cacheMtime = -1;
    }
    // else: keep last good cache
  }
  return _cache;
}

/**
 * Mean score + sample count for a given (model, promptClass) over the most
 * recent `window` rated rows. promptClass=null aggregates across classes.
 *
 * @param {string} model
 * @param {string|null} promptClass
 * @param {{path?:string, window?:number}} [opts]
 * @returns {{n:number, mean:number}}
 */
export function modelStats(model, promptClass = null, opts = {}) {
  const path = opts.path || RATINGS_PATH;
  const window = opts.window || DEFAULT_WINDOW;
  let rows = loadRatings(path);
  if (window > 0 && rows.length > window) rows = rows.slice(-window);
  let n = 0;
  let sum = 0;
  for (const r of rows) {
    if (r.model !== model) continue;
    if (promptClass != null && r.prompt_class !== promptClass) continue;
    n += 1;
    sum += r.score;
  }
  return { n, mean: n ? sum / n : 0 };
}

/**
 * Derive a short, STABLE prompt-class bucket from a classifier result's signals.
 * Used so the router keys ratings by the same bucket the heuristic implies.
 *
 * @param {{role?:string, signals?:string[]}} result
 * @returns {string}
 */
export function promptClassFromResult(result) {
  const signals = (result && result.signals) || [];
  if (signals.includes("image")) return "vision";
  if (signals.includes("code-fence") || signals.includes("hard-verb")) return "code";
  if (signals.includes("reasoning-cue")) return "reasoning";
  if (signals.includes("agentic")) return "agentic";
  if (signals.some((s) => s.startsWith("long("))) return "long";
  return "general";
}

/**
 * Apply a bounded empirical nudge on top of a heuristic classification.
 *
 * @param {{role:string, reason:string, signals:string[]}} baseResult
 *   The pure-heuristic result from classifyDifficulty().
 * @param {object} [opts]
 * @param {string}   [opts.promptClass]   Prompt-class bucket (see promptClassFromResult).
 * @param {object}   [opts.config]        Registry `auto:` block; reads `config.empirical`.
 * @param {string}   [opts.ratingsPath]   Ratings file path (test override).
 * @param {(role:string)=>string|null} [opts.resolveModel]
 *   Maps a logical role ("sk-default"/"sk-heavy") to its CONCRETE model name so
 *   ratings (keyed by concrete model) can be looked up. Returns null if unknown.
 * @returns {{role:string, reason:string, signals:string[]}}
 *   The base result unchanged, or a NEW object with the role adjusted + a
 *   `empirical:...` signal appended.
 */
export function adjustWithEmpirical(baseResult, opts = {}) {
  if (!baseResult) return baseResult;
  // Never override structural roles (vision, or anything that isn't the
  // default↔heavy pair the empirical layer is allowed to shift).
  if (baseResult.role !== DEFAULT_ROLE && baseResult.role !== HEAVY_ROLE) {
    return baseResult;
  }

  const cfg = (opts.config && opts.config.empirical) || {};
  const minSamples =
    typeof cfg.min_samples === "number" ? cfg.min_samples : DEFAULT_MIN_SAMPLES;
  const lowThreshold =
    typeof cfg.low_threshold === "number" ? cfg.low_threshold : DEFAULT_LOW_THRESHOLD;
  const goodThreshold =
    typeof cfg.good_threshold === "number" ? cfg.good_threshold : DEFAULT_GOOD_THRESHOLD;
  const window = typeof cfg.window === "number" ? cfg.window : DEFAULT_WINDOW;
  const path = opts.ratingsPath || RATINGS_PATH;
  const promptClass = opts.promptClass != null ? opts.promptClass : null;

  const resolveModel = typeof opts.resolveModel === "function" ? opts.resolveModel : null;
  const defaultModel = resolveModel ? resolveModel(DEFAULT_ROLE) : null;
  if (!defaultModel) {
    // Can't map sk-default to a concrete model → no empirical basis.
    return baseResult;
  }

  const stats = modelStats(defaultModel, promptClass, { path, window });
  if (stats.n < minSamples) {
    return baseResult; // not enough signal
  }

  const meanStr = stats.mean.toFixed(2);

  // ── ESCALATE: heuristic said DEFAULT but that model scores poorly here ──
  if (baseResult.role === DEFAULT_ROLE && stats.mean < lowThreshold) {
    return {
      role: HEAVY_ROLE,
      reason: `${baseResult.reason} + empirical escalate (${defaultModel} mean=${meanStr} n=${stats.n} < ${lowThreshold})`,
      signals: [
        ...baseResult.signals,
        `empirical:escalate(${defaultModel} mean=${meanStr} n=${stats.n})`,
      ],
    };
  }

  // ── DE-ESCALATE: heuristic said HEAVY but the default model scores fine ──
  if (baseResult.role === HEAVY_ROLE && stats.mean >= goodThreshold) {
    return {
      role: DEFAULT_ROLE,
      reason: `${baseResult.reason} + empirical de-escalate (${defaultModel} mean=${meanStr} n=${stats.n} >= ${goodThreshold})`,
      signals: [
        ...baseResult.signals,
        `empirical:de-escalate(${defaultModel} mean=${meanStr} n=${stats.n})`,
      ],
    };
  }

  return baseResult;
}

export default adjustWithEmpirical;
