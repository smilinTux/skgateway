/**
 * capabilities.mjs (card P3.1): derive the per-model capability vector the
 * ranker (P3.2) scores against (design doc 4.1 `capabilities` block / 6.1
 * "capability dimensions and their honest provenance").
 *
 * Pure function, no I/O of its own beyond what it delegates to two EXISTING,
 * already-cached modules (do not reimplement either):
 *   - `empirical.mjs`'s `modelStats()` for the reasoning/coding priors +
 *     ratings mean per `prompt_class` (reuses its own mtime cache on
 *     ratings.jsonl; `opts.ratings` is forwarded to it as-is so tests/callers
 *     can point at a fixture path without touching the real file).
 *   - `local-failover.mjs`'s `isLocalUrl()` for the sovereignty tier.
 *
 * Everything else (`metrics`) is injected, never read live from here: this
 * module has no idea metrics.db (`src/metrics/collector.mjs`) exists. The
 * caller (P3.2's ranker, or its own caller) is responsible for resolving a
 * per-model `{latency_p50_ms, success_rate}` snapshot and passing it in,
 * same read-time-injection discipline as `rank.mjs` is specified to follow
 * (design 6.2: "no daemon, no precomputed leaderboard").
 *
 * Basis honesty (design 6.1, non-negotiable): a capability's `basis` names
 * WHERE the score came from. `tool_use`/`reasoning`/`coding` are the three
 * dimensions that carry a `{score, basis}` pair (design 4.1's `capabilities`
 * sketch groups exactly these three that way; `ctx_tokens`/`latency_p50_ms`/
 * `success_rate`/`vision`/`sovereignty` are plain facts/measurements, not
 * quality judgments, so they are not wrapped). `reasoning`/`coding` NEVER
 * carry `basis: 'card'`: no provider card declares reasoning or coding
 * quality (design 6.1: "not card-derivable"); they are `'ratings'` (real
 * empirical signal from `ratings.jsonl` via `modelStats()`) or `'prior'`
 * (an id-family guess, used only when there is no rated signal yet).
 *
 * @module ranking/capabilities
 */

import { modelStats } from '../classifiers/empirical.mjs';
import { isLocalUrl } from '../proxy/local-failover.mjs';

// Rating rows are 1..5 (telegram_ratings). Normalize to a 0..1 score so every
// capability dimension in the vector shares the same scale as tool_use's 0/1.
function normalizeRatingMean(mean) {
  const v = (mean - 1) / 4;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// Id-family prior baseline + boost when the id/card signals a relevant
// variant (design 5.1's NVIDIA heuristic parser already extracts these into
// `card.variant`/`card.variants`; OpenRouter ids are scanned directly since
// their cards carry no such field). Deliberately modest: this is a guess,
// not a measurement, hence the low weight `rank.mjs`'s basis-weighted sum
// (design 6.2) is specified to give `basis: 'prior'` (0.3 vs `'ratings'` 0.8).
const PRIOR_BASE = 0.5;
const PRIOR_BOOST = 0.15;

const VARIANT_TOKENS = ['thinking', 'reasoning', 'coder', 'code', 'instruct', 'chat'];

function tokenBoundaryRe(token) {
  return new RegExp(`(?:^|[-_/])${token}(?:[-_]|$)`, 'i');
}

/** Collect variant-ish tokens from the card's heuristic fields + a scan of the raw id. */
function idSignalTokens(modelCard) {
  const card = (modelCard && modelCard.card) || {};
  const tokens = new Set();
  if (Array.isArray(card.variants)) {
    for (const v of card.variants) tokens.add(v === 'code' ? 'coder' : v);
  }
  if (typeof card.variant === 'string') {
    tokens.add(card.variant === 'code' ? 'coder' : card.variant);
  }
  const id = String((modelCard && modelCard.id) || '').toLowerCase();
  for (const t of VARIANT_TOKENS) {
    if (tokenBoundaryRe(t).test(id)) tokens.add(t === 'code' ? 'coder' : t);
  }
  return tokens;
}

function priorScore(tokens, boostTokens) {
  const boosted = boostTokens.some((t) => tokens.has(t));
  return boosted ? PRIOR_BASE + PRIOR_BOOST : PRIOR_BASE;
}

/**
 * `tool_use`: declared support only (design 6.1 splits "supported" from
 * "reliable"; reliability needs the eval harness, design 6.3, out of scope
 * here). `card.supported_parameters` containing `'tools'` is a real
 * provider declaration => `basis: 'card'` whether that yields 1 or 0. When
 * the card itself is a guess (`card.source === 'heuristic'`, e.g. NVIDIA's
 * bare-id parse which never populates `supported_parameters`, per
 * discovery/providers/nvidia.mjs), a 0 there is not a confirmed absence, so
 * it is tagged `basis: 'heuristic'` instead of falsely claiming `'card'`.
 *
 * @param {object} card modelCard.card
 * @returns {{score:0|1, basis:'card'|'heuristic'}}
 */
function deriveToolUse(card) {
  const declared = Array.isArray(card.supported_parameters)
    && card.supported_parameters.includes('tools');
  if (declared) return { score: 1, basis: 'card' };
  return { score: 0, basis: card.source === 'heuristic' ? 'heuristic' : 'card' };
}

/**
 * `vision`: modality/registry-declared fact, not a score. Accepts either a
 * direct boolean (registry backend blocks / NVIDIA heuristic overlay style)
 * or an OpenRouter-style `"text+image->text"` modality string (only the
 * INPUT side, left of `->`, counts: an image-OUTPUT model is not vision-input
 * capable).
 *
 * @param {object} card modelCard.card
 * @returns {boolean}
 */
function deriveVision(card) {
  if (typeof card.vision === 'boolean') return card.vision;
  const modality = typeof card.modality === 'string' ? card.modality : '';
  const inputSide = modality.split('->')[0] || modality;
  return /image|vision|\bvl\b/i.test(inputSide);
}

/**
 * `ctx_tokens`: plain fact off the card (design 5.1: OpenRouter direct,
 * NVIDIA via the manual overlay/heuristic, local backends via the registry
 * `ctx` field). `null` when nothing declares it, never guessed.
 *
 * @param {object} card modelCard.card
 * @returns {number|null}
 */
function deriveCtxTokens(card) {
  if (typeof card.context_length === 'number') return card.context_length;
  if (typeof card.ctx === 'number') return card.ctx;
  return null;
}

/**
 * `reasoning`/`coding`: reuses `empirical.mjs`'s `modelStats()` (no
 * reimplementing ratings parsing, per the card). `promptClass` matches the
 * SAME bucket names `promptClassFromResult()` already produces (`'code'`,
 * `'reasoning'`) so this reads the identical rows the router's empirical
 * nudge does. `n > 0` => real rated signal, `basis: 'ratings'`. `n === 0` =>
 * fall back to the id-family prior, `basis: 'prior'`, NEVER `'card'`: no
 * card declares reasoning/coding quality (design 6.1).
 *
 * @param {object} modelCard
 * @param {'reasoning'|'code'} promptClass
 * @param {string[]} boostTokens variant tokens that bump the prior
 * @param {object} ratingsOpts forwarded to modelStats() as-is
 * @returns {{score:number, basis:'ratings'|'prior'}}
 */
function deriveQualityDim(modelCard, promptClass, boostTokens, ratingsOpts) {
  const stats = modelStats(modelCard.id, promptClass, ratingsOpts);
  if (stats.n > 0) {
    return { score: normalizeRatingMean(stats.mean), basis: 'ratings' };
  }
  return { score: priorScore(idSignalTokens(modelCard), boostTokens), basis: 'prior' };
}

/**
 * `sovereignty`: `isLocalUrl()` (local-failover.mjs) on the serving backend
 * url, folded with the card's `free` tag so a paid model tunnelled through a
 * loopback wrapper (e.g. the claude-code-api local Anthropic wrapper,
 * design 4.3/proxy/anthropic-adapter.mjs) is never misreported as sovereign
 * `'local'` compute just because the network hop happens to be loopback.
 * `free` already folds in that Anthropic-family detection upstream
 * (`tagLocalModels()`), so this stays a plain two-fact combination, no new
 * provider-name special-casing here.
 *
 * @param {object} modelCard
 * @returns {'local'|'free-remote'|'paid-cloud'}
 */
const _SOVEREIGNTY_TIERS = new Set(['local', 'free-remote', 'paid-cloud']);

function deriveSovereignty(modelCard) {
  // An explicit curated tier wins. A static model (local ornith, the claude
  // fleet) has no serving url on its catalog entry, so isLocalUrl() cannot see
  // it and every one would fall through to 'free-remote'. The operator-declared
  // tier in the overlay card is authoritative when present, so the sovereignty
  // ladder (local-first) actually orders our own models correctly.
  const declared = (modelCard.card && modelCard.card.tier) || modelCard.tier;
  if (_SOVEREIGNTY_TIERS.has(declared)) return declared;
  const url = modelCard.url || (modelCard.card && modelCard.card.url) || null;
  const local = url ? isLocalUrl(url) : false;
  const paid = modelCard.free === false;
  if (local) return paid ? 'paid-cloud' : 'local';
  return paid ? 'paid-cloud' : 'free-remote';
}

/**
 * Derive the full capability vector for one model (design 4.1 `capabilities`
 * block). Pure aside from the two delegated reads (`modelStats()`'s own
 * mtime-cached file read, gated entirely by the `ratings` opt so a caller
 * can point it at a fixture); everything else here is arithmetic over the
 * arguments given.
 *
 * @param {object} modelCard a merged-catalog entry: `{id, provider, free,
 *   url?, card}` (design 4.1's ModelCard record; `card` is the raw-ish
 *   provider metadata block from the P2.1 adapters / registry / overlay).
 * @param {object} [opts]
 * @param {{latency_p50_ms?:number, success_rate?:number}} [opts.metrics]
 *   Pre-resolved metrics.db snapshot for THIS model (14-day window, design
 *   6.1). Injected, never read live from here.
 * @param {{path?:string, window?:number}} [opts.ratings]
 *   Forwarded verbatim to `modelStats()` as its `opts` (e.g. a fixture
 *   `path` in tests). Omit to use empirical.mjs's real ratings.jsonl.
 * @param {() => number} [opts.now] Reserved for future recency-weighting
 *   (unused today; accepted for interface stability with the rest of this
 *   codebase's mtime/TTL clock convention).
 * @returns {{
 *   tool_use: {score:0|1, basis:'card'|'heuristic'},
 *   vision: boolean,
 *   ctx_tokens: number|null,
 *   latency_p50_ms: number|null,
 *   success_rate: number|null,
 *   reasoning: {score:number, basis:'ratings'|'prior'},
 *   coding: {score:number, basis:'ratings'|'prior'},
 *   sovereignty: 'local'|'free-remote'|'paid-cloud',
 * }}
 */
export function deriveCapabilities(modelCard, opts = {}) {
  const card = (modelCard && modelCard.card) || {};
  const metrics = opts.metrics || {};
  const ratingsOpts = opts.ratings || {};

  return {
    tool_use: deriveToolUse(card),
    vision: deriveVision(card),
    ctx_tokens: deriveCtxTokens(card),
    latency_p50_ms: typeof metrics.latency_p50_ms === 'number' ? metrics.latency_p50_ms : null,
    success_rate: typeof metrics.success_rate === 'number' ? metrics.success_rate : null,
    reasoning: deriveQualityDim(modelCard, 'reasoning', ['thinking', 'reasoning'], ratingsOpts),
    coding: deriveQualityDim(modelCard, 'code', ['coder'], ratingsOpts),
    sovereignty: deriveSovereignty(modelCard),
  };
}

export default deriveCapabilities;
