/**
 * model-size.mjs (card N2, coordination id f942d93b): parameter-count and
 * size-class helpers shared by the provider adapters (`discovery/providers/
 * nvidia.mjs`, `openrouter.mjs`) that parse a model id string.
 *
 * `SIZE_CLASSES` is the Joule Economy's S/M/L/XL enum, taken VERBATIM (design
 * doc 2026-08-14-model-metadata-risk-job-matching-arch.md 4.1, "size_class").
 * The Joule Economy design (skcapstone
 * docs/superpowers/specs/2026-08-14-joule-economy-design.md 3.1/3.3,
 * `size_rank = {S:0, M:1, L:2, XL:3}`) is a design doc only as of this card,
 * not yet a shared code package skgateway can import cross-repo, so the four
 * strings are duplicated here rather than invented independently. Do not add
 * a fifth value or rename one: that would silently break comparability with
 * `meta.grade.size` on a coordination card.
 *
 * @module discovery/model-size
 */

/** The Joule Economy size enum, verbatim. Never invent a parallel vocabulary. */
export const SIZE_CLASSES = Object.freeze(['S', 'M', 'L', 'XL']);

// Same two regexes nvidia.mjs's parseHeuristicId already proved out for the
// NVIDIA bare-id case; generalized here so openrouter.mjs's id strings (which
// carry the identical "-<N>b" / "-a<N>b" convention, e.g.
// "nvidia/nemotron-3-ultra-550b-a55b:free") can reuse the same parse instead
// of a second hand-rolled copy. Accepts an optional "org/" prefix and an
// optional ":free"-style suffix; boundaries are "-", "_", ":", or end/start
// of string so a version fragment like "3.5" never false-matches as a param
// count.
const ACTIVE_PARAMS_RE = /[-_]a(\d+(?:\.\d+)?)b(?:[-_:]|$)/i;
const TOTAL_PARAMS_RE_G = /(?:^|[-_])(\d+(?:\.\d+)?)b(?:[-_:]|$)/gi;

/**
 * Parse dense/total and MoE active param counts (in billions) out of a raw
 * model id string. Pure string parsing, best-effort: an id with no
 * parseable size token yields `{params_b: null, active_params_b: null}`
 * rather than a guess (design 6.1 basis honesty: null beats a wrong number).
 *
 * MoE honesty (design N2 ADD list): "a 397b-a17b is a ~17B workload at
 * inference, not a 397B one". `params_b` is always the TOTAL/dense count;
 * `active_params_b` is the MoE active count when the id declares one, else
 * null (a dense model has no active-vs-total distinction to make).
 *
 * @param {string} id e.g. "nvidia/nemotron-3-ultra-550b-a55b:free" or
 *   "qwen/qwen3.5-397b-a17b"
 * @returns {{params_b: number|null, active_params_b: number|null}}
 */
export function parseParamsFromId(id) {
  if (typeof id !== 'string' || !id) return { params_b: null, active_params_b: null };
  const rest = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;

  const activeMatch = rest.match(ACTIVE_PARAMS_RE);
  const active_params_b = activeMatch ? Number(activeMatch[1]) : null;

  let params_b = null;
  for (const m of rest.matchAll(TOTAL_PARAMS_RE_G)) {
    if (activeMatch && m[0] === activeMatch[0]) continue;
    params_b = Number(m[1]);
    break;
  }
  return { params_b, active_params_b };
}

// Provider-authored prose sometimes states the MoE split in plain English
// where the id itself does not (measured 2026-08-15: OpenRouter's live
// "nvidia/nemotron-3.5-lightning:free" carries no size token in its id at
// all, unlike the sibling NVIDIA raw id "nemotron-3.5-lightning-30b-a3b",
// but its OpenRouter `description` reads "an open mixture-of-experts model
// from NVIDIA, with 3B active parameters out of 30B total"). This is a real
// provider-declared fact (the same live card's own text), not a second
// guess layered on the first.
const DESCRIPTION_PARAMS_RE = /(\d+(?:\.\d+)?)\s*b\s+active\s+parameters?\s+out\s+of\s+(\d+(?:\.\d+)?)\s*b\s+total/i;

/**
 * Fallback parse of dense/total + MoE active param counts out of a provider
 * `description` string, for the case where the id carries no size token at
 * all (id-pattern parsing already tried and failed). Only recognizes the one
 * explicit "<N>B active parameters out of <N>B total" phrasing; anything
 * else yields `{params_b: null, active_params_b: null}` rather than a
 * broader, riskier free-text guess.
 *
 * @param {string|null|undefined} description
 * @returns {{params_b: number|null, active_params_b: number|null}}
 */
export function parseParamsFromDescription(description) {
  if (typeof description !== 'string' || !description) return { params_b: null, active_params_b: null };
  const m = description.match(DESCRIPTION_PARAMS_RE);
  if (!m) return { params_b: null, active_params_b: null };
  return { params_b: Number(m[2]), active_params_b: Number(m[1]) };
}

/**
 * Default heuristic size_class from a TOTAL param count (design 4.1's
 * "derived from params_b + family (default thresholds)"; the spec names the
 * section but never fixes the numbers, so these are this card's documented
 * judgment call, always overridable by the manual overlay which wins per
 * `applyCardOverlay`, `src/discovery.mjs:268`).
 *
 * Classed by TOTAL params, never active (design doc Q4, resolved: "class by
 * TOTAL, it prices like a big model in quality terms; record active_params_b
 * for honesty, let ratings correct the class over time via the overlay").
 *
 * Anchored against the spec's own worked overlay example (4.2): a 9B dense
 * model (ornith-1.0-9b) is curated `M`, a 35B dense model (ornith-1.0-35b)
 * is curated `L`, and a 675B dense model (mistral-large-3-675b) is curated
 * `XL`. The thresholds below reproduce those three anchor points and place
 * the S/M boundary low, since nothing in the live fleet today is small
 * enough to earn S; a future embedding-scale or draft model would.
 *
 *   S:  <= 4B    (not yet represented in the live fleet)
 *   M:  <= 20B   (ornith-1.0-9b, nemotron-nano-9b-v2 anchor at 9B)
 *   L:  <= 100B  (ornith-1.0-35b anchor at 35B; nemotron-3.5-lightning's
 *                 30B TOTAL anchor, despite its 3B active count)
 *   XL: > 100B   (mistral-large-3-675b, nemotron-3-ultra's 550B TOTAL anchor)
 *
 * @param {number|null|undefined} paramsB total/dense params in billions
 * @returns {'S'|'M'|'L'|'XL'|null}
 */
export function deriveSizeClassFromParams(paramsB) {
  if (typeof paramsB !== 'number' || !Number.isFinite(paramsB) || paramsB <= 0) return null;
  if (paramsB <= 4) return 'S';
  if (paramsB <= 20) return 'M';
  if (paramsB <= 100) return 'L';
  return 'XL';
}

export default {
  SIZE_CLASSES,
  parseParamsFromId,
  parseParamsFromDescription,
  deriveSizeClassFromParams,
};
