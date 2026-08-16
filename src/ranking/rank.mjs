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
import { resolveZoneCeiling, isZoneAllowed } from '../policy/sensitivity.mjs';
// meetsClassFloor is the ONE hard-floor comparison over the S/M/L/XL grade
// vocabulary (design doc, joule-grade-vocabulary.json). Card P2 review round
// 1 caught this module reimplementing that comparison by hand and disagreeing
// with it (size_class read as work-difficulty class instead of the labelled
// parameter-size PRIOR it actually is, and no fold-in of measured capability
// evidence). Delegated here rather than aligned, because two copies of one
// rule is the defect: aligning them today only means they drift apart later.
import { meetsClassFloor } from '../policy/buckets.mjs';

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
 * The only `require` block keys this ranker knows how to enforce (card C5,
 * design 4.3's four documented dimensions). Anything else in the block is
 * unimplemented, not merely unmatched, and must never be allowed to fall
 * through to `return null` (pass): that fell-through-to-pass shape is
 * exactly card C5's bug, where `require: {sensitivity: secret}` looked
 * enforced and enforced nothing. See `requireFailureReason()` below for how
 * an unknown key is handled instead.
 */
const KNOWN_REQUIRE_KEYS = new Set([
  'tool_use',
  'min_ctx',
  'vision',
  'max_latency_p50_ms',
  // Card 45d7a30b / N1. `sensitivity` states what the JOB is, and the ranker
  // turns that into a trust-zone ceiling. It is listed here because card C5
  // made unrecognized keys fail closed, so a key that is genuinely implemented
  // has to be declared or it would exclude every candidate. That ordering was
  // deliberate: the gate had to fail closed BEFORE anything relied on it.
  'sensitivity',
  // Escape hatch for a caller that wants to name the ceiling directly rather
  // than go through a sensitivity label.
  'max_trust_zone',
  // Card P2 (Joule Economy): the capability FLOOR for a graded card. The
  // gateway does not grade work; it only enforces a floor a caller declares
  // (registry role, `require=` query spec, or `x-sk-require` header, all the
  // same grammar). See requireFailureReason() below for the enforcement.
  'min_class',
]);

/**
 * Evaluate the `require` block against one catalog entry's capabilities.
 * Returns the `excluded_reason` string on failure, or `null` if it passes.
 * An unknown/missing value for a required dimension counts as failure
 * EXCEPT `max_latency_p50_ms`, where "no traffic yet" (`latency_p50_ms ===
 * null`) is given the benefit of the doubt rather than penalizing a model
 * nobody has used. That exception is a considered choice about ONE known
 * dimension's semantics; it is not the same thing as ignoring a key this
 * module does not implement at all (see the unknown-key check just below).
 *
 * Card C5: a `require` key outside `KNOWN_REQUIRE_KEYS` fails CLOSED
 * (excludes the candidate) rather than falling through unmatched. Before
 * this fix every key past the four handled below silently returned `null`
 * (pass), so an unimplemented requirement admitted every candidate instead
 * of rejecting or flagging it: a caller writing `require: {sensitivity:
 * secret}` for the incoming trust-zone/sensitivity gating work (card N1)
 * got a filter that looked enforced and enforced nothing, i.e. a
 * sovereignty control that is a placebo. Checked here (fail closed, one
 * excluded candidate at rank time) rather than rejecting the whole
 * requirements block at parse time in src/index.mjs's `parseRequireSpec()`/
 * `parseSkRequireHeader()`: those are documented (P4.3, design 7.1) as
 * deliberately fail-soft so a caller typo degrades the spec instead of
 * 500ing the route, so a hard parse-time rejection is not reachable from
 * there without reversing that design decision. This module is where the
 * requirements block is actually enforced, so it is where "unknown"
 * becomes "denied".
 *
 * @param {object} entry catalog entry
 * @param {object} require requirements.require block
 * @returns {string|null}
 */
function requireFailureReason(entry, require = {}, sensitivityPolicy = undefined) {
  const caps = entry.capabilities || {};

  for (const key of Object.keys(require)) {
    if (!KNOWN_REQUIRE_KEYS.has(key)) return `require:unknown:${key}`;
  }

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

  // Card N1: sovereignty. Resolve a ceiling from whichever form the caller
  // used, then hold the candidate's trust zone to it.
  //
  // Note the asymmetry with `max_latency_p50_ms` directly above, which gives an
  // unmeasured model the benefit of the doubt. This one does the opposite: an
  // UNKNOWN trust zone is treated as the least trusted and excluded. Latency is
  // a performance guess where being wrong costs a slow response; a trust zone
  // is a confidentiality claim where being wrong costs the content. N2 measured
  // that a large share of the fleet has incomplete provider metadata, so
  // "unknown" is the common case here, not an edge one.
  let ceiling = null;
  if (require.sensitivity !== undefined) {
    const resolved = resolveZoneCeiling(require.sensitivity, sensitivityPolicy);
    if (!resolved.recognized) return `require:sensitivity:unrecognized:${require.sensitivity}`;
    ceiling = resolved.ceiling;
  }
  if (typeof require.max_trust_zone === 'number') {
    // Both given: take the stricter. A caller cannot widen a sensitivity
    // ceiling by also naming a laxer zone.
    ceiling = ceiling === null ? require.max_trust_zone : Math.min(ceiling, require.max_trust_zone);
  } else if (require.max_trust_zone !== undefined) {
    return 'require:max_trust_zone:not_a_number';
  }

  if (ceiling !== null && !isZoneAllowed(caps.trust_zone, ceiling)) {
    const z = typeof caps.trust_zone === 'number' ? caps.trust_zone : 'unknown';
    return `require:sensitivity:trust_zone_${z}_exceeds_${ceiling}`;
  }

  // Card P2: `min_class` is the HARD capability floor for a graded card
  // (joule-grade-vocabulary.json's `model_class = CLASS[max(size_rank,
  // risk_rank)]`, "Floor is HARD: never route graded work to a model below
  // its class"). The gateway does not grade work (that is the job side's
  // job, and section 11 of the model-metadata spec is explicit that
  // "graders grade, dispatchers map, the gateway matches and gates"); it
  // only enforces a `min_class` a caller already declared.
  //
  // Delegates entirely to `meetsClassFloor()` (policy/buckets.mjs) rather
  // than comparing `caps.size_class` directly, because `size_class` is
  // model PARAMETER SIZE, a labelled PRIOR for the work-difficulty class a
  // floor is expressed in, not the same axis (buckets.mjs's own module
  // comment: "TWO THINGS NAMED S/M/L/XL, AND THEY ARE NOT THE SAME THING").
  // `meetsClassFloor` also folds in any measured capability ceiling ahead of
  // the declared prior, so a model whose measured behavior contradicts its
  // advertised size is judged on the measurement. Round 1 review found this
  // module hand-rolling that comparison and disagreeing with the existing
  // function; this replaces the hand-roll rather than aligning it, so the
  // two can never drift apart again.
  if (require.min_class !== undefined) {
    const floor = meetsClassFloor(entry, require.min_class);
    if (!floor.ok) {
      // basis 'unknown-floor' means `require.min_class` itself was not a
      // recognized S/M/L/XL letter: a caller error, not a fact about the
      // model, so it gets the same `unrecognized:` shape as the sensitivity
      // check above rather than being read as a class name.
      if (floor.basis === 'unknown-floor') {
        return `require:min_class:unrecognized:${require.min_class}`;
      }
      // Otherwise the model failed to meet the floor. `floor.basis` explains
      // why: 'declared-size-prior' (the card's own claim, including an
      // invalid value like "XXL", which still fails to rank), a
      // 'measured-ceiling (...)' override, or 'unknown' when there is no
      // declared size_class AND no measured evidence at all. Surfaced
      // verbatim, same diagnostic discipline as the other require reasons.
      // At an S floor this branch is never reached for an unknown class:
      // `meetsClassFloor` treats "no evidence" as clearing the lowest floor
      // (classRank('S') is 0, tests/buckets.test.mjs's own "UNKNOWN
      // capability clears only the S floor"), so `floor.ok` is already true
      // there and this `if` does not run. M/L/XL are where unknown
      // genuinely fails.
      const cls = floor.modelClass || 'unknown';
      return `require:min_class:${floor.basis}:${cls}_below_${require.min_class}`;
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

    const requireFail = requireFailureReason(entry, require, opts.sensitivityPolicy);
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
