/**
 * rank.mjs (card P3.2): the ranker (design doc 6.2, "The ranker (pure
 * function, unit-testable)").
 *
 * `rankModels(catalog, requirements, opts) -> RankedCandidate[]`. Pure and
 * read-time: no I/O, no clock/rand of its own (a caller-injected `opts.now`
 * is accepted only for interface stability with the rest of this codebase's
 * mtime/TTL clock convention, same as capabilities.mjs's unused `opts.now`;
 * it does not affect the output). Same inputs always produce the same
 * output, in the same order.
 *
 * Catalog entries are the design 4.1 ModelCard record shape: at minimum
 * `{ id, free, lifecycle: {state}, capabilities }`, where `capabilities` is
 * whatever `deriveCapabilities()` (P3.1, src/ranking/capabilities.mjs)
 * produced for that model. This module does not call deriveCapabilities()
 * itself: assembling the catalog (discovery cards + capability derivation)
 * is the caller's job, matching the design's "no daemon, no precomputed
 * leaderboard; scores are computed from the catalog + metrics caches on
 * demand" read-time discipline at the layer above this one.
 *
 * Pipeline (design 6.2):
 *   1. Hard filters: lifecycle state must be 'active' (never rank
 *      suspect/eol/dead: the ranker only picks confidently-live models,
 *      unlike the router's broader `isRoutable()` admit of active|suspect),
 *      the `require` block, the allowlist, and backend availability.
 *   2. Sovereignty tiering: partition survivors into buckets by the role's
 *      `tier` ladder (design 4.3's registry example: `[local, free-remote,
 *      paid-cloud]`). A candidate whose sovereignty is not on the ladder is
 *      excluded outright (this is how a role like `sk-cheap-fast`'s
 *      `tier: [local, free-remote]` "never escalates to paid").
 *   3. Weighted score within a tier only: a normalized sum over the
 *      `prefer` dimensions, each weighted by BOTH its position in `prefer`
 *      (earlier = more decisive, "ordered tie-breakers" per the registry
 *      comment) and its basis weight (`BASIS_WEIGHTS`: eval > ratings >
 *      card > prior), so empirical signal dominates guesses by
 *      construction. Tier boundaries are never crossed by score: a
 *      candidate in a higher-priority tier always outranks every candidate
 *      in a lower one, no matter how good the lower tier's score is.
 *   4. The ordered chain: 1-based `rank` assigned tier-by-tier, ties broken
 *      by catalog order (stable sort), with a per-model `breakdown` for
 *      observability (mirrors the classifier's `signals` array).
 *
 * Excluded candidates are returned too (not dropped), each with a non-null
 * `excluded_reason` and `score`/`rank`/`tier`/`breakdown` all `null`, so
 * callers (the future suggest-only API, card P3.3) can show *why* a model
 * did not make the chain.
 *
 * @module ranking/rank
 */

import { LIFECYCLE_STATES } from '../discovery/lifecycle.mjs';

/**
 * Basis weights (design 6.2): empirical signal outweighs priors by
 * construction. `eval` (the micro-eval harness, P3.5) is the strongest
 * signal; `ratings` (real human Telegram ratings via `modelStats()`) is
 * next; `card` (a provider's own declared metadata, or a plain measured
 * fact like latency/success_rate) is a real but unweighted-by-humans
 * signal; `prior` (an id-family guess, P3.1's `priorScore()`) is weakest.
 */
const BASIS_WEIGHTS = { eval: 1.0, ratings: 0.8, card: 0.6, prior: 0.3 };

/** Weight for a `prefer` dimension whose basis this module does not recognize. */
const DEFAULT_BASIS_WEIGHT = BASIS_WEIGHTS.card;

/**
 * Default sovereignty ladder when a role declares no `tier`: sovereign-first
 * (matches the fleet-wide stance in local-failover.mjs) while still leaving
 * paid-cloud reachable as a last resort, rather than silently excluding it.
 * A role that truly must never escalate declares its own `tier` without
 * `paid-cloud` (design 4.3's `sk-cheap-fast` example).
 */
const DEFAULT_TIER = ['local', 'free-remote', 'paid-cloud'];

/**
 * Latency-to-score normalization baseline (design 6.1's `latency_p50_ms` is
 * a plain empirical fact, not pre-normalized). 10s is a deliberately
 * generous ceiling for a free/local fleet dominated by small models; a
 * `latency_p50_ms` at or above this floors the "latency" prefer-dim score
 * at 0 rather than going negative.
 */
const LATENCY_BASELINE_MS = 10000;

function excludedCandidate(id, reason) {
  return { id, score: null, rank: null, tier: null, breakdown: null, excluded_reason: reason };
}

/**
 * Evaluate the `require` block against one catalog entry's capabilities.
 * Returns the `excluded_reason` string on failure, or `null` if it passes.
 * An unknown/missing value for a required dimension counts as failure
 * EXCEPT `max_latency_p50_ms`, where "no traffic yet" (`latency_p50_ms ===
 * null`) is given the benefit of the doubt rather than penalizing a model
 * nobody has used.
 *
 * @param {object} entry catalog entry
 * @param {object} require requirements.require block
 * @returns {string|null}
 */
function requireFailureReason(entry, require = {}) {
  const caps = entry.capabilities || {};

  if (require.tool_use === true) {
    const score = caps.tool_use && caps.tool_use.score;
    if (!(score >= 1)) return 'require:tool_use';
  }

  if (typeof require.min_ctx === 'number') {
    if (typeof caps.ctx_tokens !== 'number' || caps.ctx_tokens < require.min_ctx) {
      return 'require:min_ctx';
    }
  }

  if (require.vision === true && caps.vision !== true) {
    return 'require:vision';
  }

  if (typeof require.max_latency_p50_ms === 'number') {
    if (typeof caps.latency_p50_ms === 'number' && caps.latency_p50_ms > require.max_latency_p50_ms) {
      return 'require:max_latency_p50_ms';
    }
  }

  return null;
}

/**
 * Resolve one `prefer` dimension name to `{value, basis}` for a catalog
 * entry. `value` is always normalized to `0..1` (higher is better) so
 * dimensions are directly comparable in the weighted sum.
 *
 * @param {object} entry catalog entry
 * @param {string} dim a name from `requirements.prefer`
 * @returns {{value:number, basis:string}}
 */
function dimValue(entry, dim) {
  const caps = entry.capabilities || {};
  switch (dim) {
    case 'tool_use':
      return caps.tool_use
        ? { value: caps.tool_use.score ? 1 : 0, basis: caps.tool_use.basis }
        : { value: 0, basis: 'prior' };
    case 'reasoning':
      return caps.reasoning
        ? { value: caps.reasoning.score, basis: caps.reasoning.basis }
        : { value: 0, basis: 'prior' };
    case 'coding':
      return caps.coding
        ? { value: caps.coding.score, basis: caps.coding.basis }
        : { value: 0, basis: 'prior' };
    case 'vision':
      return { value: caps.vision ? 1 : 0, basis: 'card' };
    case 'free':
      return { value: entry.free ? 1 : 0, basis: 'card' };
    case 'sovereign':
      if (caps.sovereignty === 'local') return { value: 1, basis: 'card' };
      if (caps.sovereignty === 'free-remote') return { value: 0.5, basis: 'card' };
      return { value: 0, basis: 'card' };
    case 'success_rate':
      return typeof caps.success_rate === 'number'
        ? { value: caps.success_rate, basis: 'eval' }
        : { value: 0.5, basis: 'prior' };
    case 'latency':
      if (typeof caps.latency_p50_ms === 'number') {
        const normalized = 1 - caps.latency_p50_ms / LATENCY_BASELINE_MS;
        return { value: Math.max(0, Math.min(1, normalized)), basis: 'eval' };
      }
      return { value: 0.5, basis: 'prior' };
    default:
      return { value: 0, basis: 'prior' };
  }
}

/**
 * Weighted score for one entry within its tier (design 6.2 step 3). Earlier
 * `prefer` entries carry more positional weight (ordered tie-breakers);
 * every dimension's contribution is additionally scaled by its basis
 * weight so empirical signal dominates priors regardless of position.
 *
 * @param {object} entry catalog entry
 * @param {string[]} prefer requirements.prefer (ordered dimension names)
 * @returns {{score:number, breakdown:object}}
 */
function scoreWithinTier(entry, prefer) {
  const dims = prefer && prefer.length ? prefer : ['success_rate', 'reasoning', 'coding', 'tool_use'];
  let weightedTotal = 0;
  let positionWeightSum = 0;
  const breakdown = {};

  // Normalize by the SUM OF POSITION WEIGHTS ONLY (not basis weights): the
  // basis weight must survive into the final score as a multiplier on each
  // dimension's contribution, so empirical signal (basis eval/ratings)
  // outscores a prior-only guess at the same raw value, even with a single
  // `prefer` dimension. Normalizing by weight*basis instead would cancel
  // the basis factor back out (a weighted average collapses to the raw
  // value when there is only one term), defeating the whole point.
  dims.forEach((dim, index) => {
    const positionWeight = 1 / (index + 1);
    const { value, basis } = dimValue(entry, dim);
    const basisWeight = BASIS_WEIGHTS[basis] ?? DEFAULT_BASIS_WEIGHT;
    const weight = positionWeight * basisWeight;
    weightedTotal += weight * value;
    positionWeightSum += positionWeight;
    breakdown[dim] = { value, basis, weight };
  });

  return { score: positionWeightSum > 0 ? weightedTotal / positionWeightSum : 0, breakdown };
}

/**
 * Rank a catalog of models against a role's requirements (design 6.2).
 * Pure: the same `catalog`/`requirements`/`opts` always produce the same
 * output. Does not mutate `catalog`.
 *
 * @param {Array<object>} catalog model catalog entries (design 4.1 shape:
 *   `{id, free, lifecycle:{state}, capabilities}`).
 * @param {{require?:object, prefer?:string[], tier?:string[]}} [requirements]
 *   registry `@match` role requirement block (design 4.3).
 * @param {object} [opts]
 * @param {string[]} [opts.allowlist] operator advertise allowlist ids;
 *   empty/absent means "everyone allowed" (mirrors `applyAllowlist()`'s
 *   semantics in src/advertise.mjs so a freshly-configured role is never
 *   silently empty).
 * @param {(id:string)=>boolean} [opts.isModelAvailable] backend-availability
 *   check, injected so this module never touches the router directly (fail
 *   open when omitted, matching `isModelAvailable()`'s own no-router
 *   fail-open behavior in src/proxy/advertise.mjs).
 * @param {()=>number} [opts.now] accepted for interface stability only
 *   (this ranker has no time-dependent behavior); see module doc comment.
 * @returns {Array<{id:string, score:number|null, rank:number|null,
 *   tier:string|null, breakdown:object|null, excluded_reason:string|null}>}
 */
export function rankModels(catalog, requirements = {}, opts = {}) {
  const require = requirements.require || {};
  const prefer = requirements.prefer || [];
  const tierLadder = requirements.tier && requirements.tier.length ? requirements.tier : DEFAULT_TIER;

  const allowlist = opts.allowlist;
  const allowSet = allowlist && allowlist.length ? new Set(allowlist) : null;
  const isModelAvailable = typeof opts.isModelAvailable === 'function' ? opts.isModelAvailable : () => true;

  const excluded = [];
  const byTier = new Map(tierLadder.map((t) => [t, []]));

  for (const entry of catalog) {
    const lc = entry.lifecycle || {};
    if (lc.state !== LIFECYCLE_STATES.ACTIVE) {
      excluded.push(excludedCandidate(entry.id, `lifecycle:${lc.state || 'unknown'}`));
      continue;
    }

    const requireFail = requireFailureReason(entry, require);
    if (requireFail) {
      excluded.push(excludedCandidate(entry.id, requireFail));
      continue;
    }

    if (allowSet && !allowSet.has(entry.id)) {
      excluded.push(excludedCandidate(entry.id, 'not_allowlisted'));
      continue;
    }

    if (!isModelAvailable(entry.id)) {
      excluded.push(excludedCandidate(entry.id, 'unavailable'));
      continue;
    }

    const sovereignty = (entry.capabilities && entry.capabilities.sovereignty) || 'free-remote';
    const bucket = byTier.get(sovereignty);
    if (!bucket) {
      excluded.push(excludedCandidate(entry.id, 'tier:not_in_ladder'));
      continue;
    }

    const { score, breakdown } = scoreWithinTier(entry, prefer);
    bucket.push({ id: entry.id, score, tier: sovereignty, breakdown });
  }

  const chain = [];
  let rank = 1;
  for (const tier of tierLadder) {
    const bucket = byTier.get(tier) || [];
    bucket.sort((a, b) => b.score - a.score);
    for (const candidate of bucket) {
      chain.push({ ...candidate, rank, excluded_reason: null });
      rank++;
    }
  }

  return [...chain, ...excluded];
}

export default rankModels;
