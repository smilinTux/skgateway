/**
 * buckets.mjs: address a POOL by what the work is, not by naming a model.
 *
 * Card 2ba73bf9 / C9. Every rot problem in the 767adc4e epic came from
 * something naming a specific model id that then went stale: the static nvidia
 * list, the hardcoded local-failover model, registry roles pinned to one
 * backend, `local_fallback` down to a single entry. A bucket cannot rot. Only
 * its MEMBERSHIP changes, and membership is derived rather than written down.
 * This turns a maintenance problem into a scheduling problem.
 *
 * A BUCKET IS (model_class, sensitivity), both taken verbatim from the
 * canonical grade vocabulary mirrored at docs/specs/joule-grade-vocabulary.json:
 *
 *   model_class  S/M/L/XL, the capability FLOOR for the work. The grader has
 *                already computed it as CLASS[max(size_rank, risk_rank)], so
 *                the bucket layer consumes a grade and never re-grades.
 *                Floor is HARD (never route below it). Ceiling is SOFT (a
 *                bigger model is allowed, and records an escalation_reason).
 *   sensitivity  public/internal/secret, DATA EXPOSURE, explicitly independent
 *                of blast radius. Resolves to a trust-zone ceiling via
 *                policy/sensitivity.mjs (card 45d7a30b / N1).
 *
 * TWO THINGS NAMED S/M/L/XL, AND THEY ARE NOT THE SAME THING. The Joule `size`
 * axis (and therefore `model_class`) is about the WORK: "XL: Architecture,
 * changes contracts others depend on". Card f942d93b (N2) also produced a
 * `size_class` on each model card, and that one is MODEL PARAMETER COUNT: a 9B
 * is M, a 550B-a55b is XL. Parameter size is a useful PRIOR for whether a model
 * can meet a capability floor. It is not the same claim, and conflating them
 * would let a large-but-weak model satisfy an XL floor purely by being large.
 * Every function here says which axis it means.
 *
 * ADDRESSING: a bucket is a MODEL ID. `sk-xl-secret`, `sk-l-internal`,
 * `sk-s-public`. Every OpenAI-compatible client already sends a model string,
 * so a harness configures one value and nothing else changes. This is a
 * generalization of a mechanism that already exists: `sk-default`, `sk-heavy`
 * and `sk-auto` are exactly this, except each resolves to a single pinned
 * backend. A bucket replaces the pin with a live pool.
 *
 * @module policy/buckets
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

import { resolveZoneCeiling, isZoneAllowed, TRUST_ZONES } from './sensitivity.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The mirrored canonical vocabulary. Consumed, never retyped. */
export const GRADE_VOCABULARY_PATH = resolvePath(
  __dirname, '..', '..', 'docs', 'specs', 'joule-grade-vocabulary.json',
);

let _vocab = null;

/**
 * Load the canonical enums. Fail-soft with the same values the mirror holds,
 * because a missing docs file must not take routing down, and
 * tests/grade-vocabulary.test.mjs already fails CI if the mirror drifts.
 */
export function gradeVocabulary(path = GRADE_VOCABULARY_PATH) {
  if (_vocab) return _vocab;
  try {
    _vocab = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    _vocab = {
      model_class: { values: ['S', 'M', 'L', 'XL'] },
      size: { ranks: { S: 0, M: 1, L: 2, XL: 3 } },
      sensitivity: { values: ['public', 'internal', 'secret'] },
    };
  }
  return _vocab;
}

/** Rank of a model_class letter. Higher means more capable is required. */
export function classRank(cls, vocab = gradeVocabulary()) {
  const ranks = vocab?.size?.ranks || { S: 0, M: 1, L: 2, XL: 3 };
  const r = ranks[String(cls || '').toUpperCase()];
  return typeof r === 'number' ? r : null;
}

/** Bucket ids look like `sk-<class>-<sensitivity>`, case-insensitive. */
const BUCKET_RE = /^sk-(s|m|l|xl)-(public|internal|secret)$/i;

/**
 * Parse a model id as a bucket address, or null when it is an ordinary id.
 *
 * Deliberately strict: a near-miss like `sk-xl-secrets` must NOT resolve to
 * something permissive. But strictness here is only half the job, and the
 * comment that used to sit at this spot claimed the other half was already
 * done. It said a near miss "gets today's not-found behavior, which is loud".
 * THAT WAS FALSE, and measuring it is what produced `looksLikeBucketAttempt()`
 * below: returning null merely means "not a bucket", and every `sk-*` id is
 * then swallowed by `isRegistryRouted()` and resolved through the registry's
 * `defaults.role`, which on this fleet is `sk-auto`, a difficulty classifier.
 * So `sk-xl-secrets` did not 404 and did not 503. It returned 200 from
 * whatever model the classifier picked, with no capability floor and no trust
 * zone ceiling applied. One transposed letter discarded every guarantee the
 * bucket layer exists to provide, silently. A comment that overstates a
 * guarantee is how that survived, so it is corrected rather than softened.
 *
 * This function's own contract is unchanged (strict parse or null). The loud
 * behaviour lives in `looksLikeBucketAttempt()` and its caller.
 *
 * @param {string} id
 * @returns {{bucket: string, model_class: string, sensitivity: string}|null}
 */
export function parseBucketId(id) {
  if (typeof id !== 'string') return null;
  const m = BUCKET_RE.exec(id.trim());
  if (!m) return null;
  return {
    bucket: `sk-${m[1].toLowerCase()}-${m[2].toLowerCase()}`,
    model_class: m[1].toUpperCase(),
    sensitivity: m[2].toLowerCase(),
  };
}

/** True when this model id addresses a bucket rather than a model. */
export function isBucketId(id) {
  return parseBucketId(id) !== null;
}

/**
 * An id shaped like `sk-<a>-<b>` and nothing more. Three dash-separated parts,
 * the first literally `sk`. `sk-default` has two parts and never matches;
 * `sk-code-review-fast` has four and never matches.
 */
const BUCKET_SHAPE_RE = /^sk-([^-]*)-([^-]*)$/i;

/**
 * Did the caller MEAN to address a bucket and get it wrong?
 *
 * The dangerous case is not an unrecognized id. It is an id that is one
 * character away from a sovereignty boundary and silently routes as if no
 * boundary had been asked for. So this answers a narrower question than
 * "is this unknown": it answers "does this look like somebody aiming at a
 * bucket and missing".
 *
 * CONSERVATIVE ON PURPOSE, because a false positive here 503s live traffic.
 * Three conditions must all hold:
 *
 *   1. the id is not already a VALID bucket (that case is handled upstream);
 *   2. the id has the exact `sk-<a>-<b>` shape, which no role in the live
 *      registry has: `sk-default`, `sk-auto`, `sk-heavy`, `sk-synth`,
 *      `sk-code`, `sk-vision`, `sk-creative`, `sk-embed` are all two-part, and
 *      `ornith-tiny` does not start with `sk-` at all;
 *   3. at least one of the two segments is a REAL token from the canonical
 *      grade vocabulary, either a model_class letter in the first position or
 *      a sensitivity word in the second.
 *
 * Condition 3 is what keeps this from becoming a generic `sk-a-b` ban. A
 * future role called `sk-code-review` has neither a class letter first nor a
 * sensitivity word second, so it is not an attempt and routes untouched.
 * `sk-xl-secrets` (class letter, misspelled sensitivity) and `sk-xxl-secret`
 * (bad class letter, real sensitivity) both are.
 *
 * The vocabulary is read through `classRank()` and `gradeVocabulary()`, the
 * same functions the rest of this module uses. There is deliberately no second
 * copy of the S/M/L/XL or public/internal/secret lists here: a policy check
 * that keeps its own copy of the vocabulary is how two gates end up
 * disagreeing.
 *
 * Detection only. Whether an attempt is fatal is the caller's decision, since
 * only the caller knows whether bucket routing is armed and whether the
 * registry explicitly defines this id.
 *
 * @param {string} id
 * @param {object} [vocab]
 * @returns {{attempted: boolean, reason: string|null}}
 */
export function looksLikeBucketAttempt(id, vocab = gradeVocabulary()) {
  if (typeof id !== 'string') return { attempted: false, reason: null };
  const trimmed = id.trim();
  if (parseBucketId(trimmed)) return { attempted: false, reason: null };
  const m = BUCKET_SHAPE_RE.exec(trimmed);
  if (!m) return { attempted: false, reason: null };

  const classPart = m[1].toLowerCase();
  const sensPart = m[2].toLowerCase();
  const sensValues = vocab?.sensitivity?.values || ['public', 'internal', 'secret'];
  const classOk = classRank(classPart, vocab) !== null;
  const sensOk = sensValues.map((s) => String(s).toLowerCase()).includes(sensPart);

  if (classOk && !sensOk) {
    return {
      attempted: true,
      reason: `model_class "${classPart.toUpperCase()}" is valid but sensitivity "${sensPart}" is not`,
    };
  }
  if (sensOk && !classOk) {
    return {
      attempted: true,
      reason: `sensitivity "${sensPart}" is valid but model_class "${classPart}" is not`,
    };
  }
  // Neither half is vocabulary, so this is an ordinary three-part id, not a
  // missed bucket. (Both halves valid is impossible here: parseBucketId would
  // have matched.)
  return { attempted: false, reason: null };
}

/**
 * Every bucket address the taxonomy defines. Used by /admin/buckets and to
 * advertise buckets on /v1/models so a picker can offer them.
 */
export function allBuckets(vocab = gradeVocabulary()) {
  const classes = vocab?.model_class?.values || ['S', 'M', 'L', 'XL'];
  const sens = vocab?.sensitivity?.values || ['public', 'internal', 'secret'];
  const out = [];
  for (const c of classes) {
    for (const s of sens) {
      out.push({ bucket: `sk-${String(c).toLowerCase()}-${s}`, model_class: String(c).toUpperCase(), sensitivity: s });
    }
  }
  return out;
}


/**
 * What the MEASURED capabilities cap a model's class at.
 *
 * Card 2ba73bf9 (C9) says membership must rest on what a model demonstrably
 * does. Card C9's assessment half produces `measured_capabilities` on the
 * lifecycle record: tool_call, structured_output, instruction_following,
 * min_output_tokens, each `pass` / `fail` / `unmeasured`.
 *
 * MEASUREMENT CAN ONLY LOWER A CLASS, NEVER RAISE IT. This is the honest
 * constraint and it is easy to get wrong. Passing a tool-call assertion proves
 * a model can emit a well-formed tool_call; it proves nothing about whether it
 * can do architecture-level reasoning, which is what an XL floor claims. So a
 * measured PASS is not evidence for a high class, it is only the absence of
 * evidence against one. A measured FAIL is strong evidence against, because a
 * model that cannot hold a tool call cannot do agentic work at any size.
 *
 * `unmeasured` caps nothing. A model throttled during assessment (429) or one
 * we simply have not got to yet must not be demoted for being popular or new.
 * That is the same distinction the assessment half draws between "unmeasured"
 * and "incapable", and losing it here would undo it.
 *
 * @param {object} measured `measured_capabilities` from the lifecycle record
 * @returns {{cap: string|null, reason: string|null}} cap is a class letter
 */
export function measuredClassCeiling(measured) {
  if (!measured || typeof measured !== 'object') return { cap: null, reason: null };
  const status = (k) => measured?.[k]?.status || null;

  // Cannot hold a tool call: no amount of parameters makes this agent-capable.
  if (status('tool_call') === 'fail') {
    return { cap: 'S', reason: 'measured tool_call fail' };
  }
  // Cannot honor a schema or follow an exact instruction: usable for prose,
  // not for work that another system has to consume.
  if (status('structured_output') === 'fail' || status('instruction_following') === 'fail') {
    return { cap: 'M', reason: 'measured structured_output/instruction_following fail' };
  }
  return { cap: null, reason: null };
}

/**
 * Fold the declared prior with the measured ceiling into one effective class.
 *
 * @param {string|null} declared parameter-size class (card f942d93b), a PRIOR
 * @param {object} measured measured_capabilities
 * @returns {{cls: string|null, basis: string}}
 */
export function effectiveClass(declared, measured) {
  const { cap, reason } = measuredClassCeiling(measured);
  if (!declared) {
    // No prior. A measured cap still tells us the model is at most `cap`, but
    // with nothing to fold it into we only know an upper bound, not a value.
    return cap ? { cls: cap, basis: `measured-ceiling (${reason})` } : { cls: null, basis: 'unknown' };
  }
  if (!cap) return { cls: declared, basis: 'declared-size-prior' };
  const dRank = classRank(declared);
  const cRank = classRank(cap);
  if (dRank === null || cRank === null) return { cls: declared, basis: 'declared-size-prior' };
  return cRank < dRank
    ? { cls: cap, basis: `measured-ceiling (${reason}) below declared ${declared}` }
    : { cls: declared, basis: 'declared-size-prior' };
}

/**
 * Does this model meet the bucket's capability FLOOR?
 *
 * The floor is HARD per the vocabulary: never route graded work to a model
 * below its class. Evidence order matters:
 *
 *   1. a MEASURED capability class, when an assessment has produced one
 *   2. otherwise the model's declared parameter size_class as a PRIOR
 *   3. otherwise unknown, which does NOT satisfy any floor above S
 *
 * Unknown failing the floor is the same discipline as N1's unknown trust zone.
 * A model we have never assessed and whose size we cannot read is not evidence
 * of capability, and treating absence as sufficient is how a bucket ends up
 * promising XL work and delivering a model that cannot hold a tool call.
 *
 * @param {object} entry merged catalog entry with `capabilities` and `card`
 * @param {string} floorClass required model_class
 * @returns {{ok: boolean, basis: string, modelClass: string|null}}
 */
export function meetsClassFloor(entry, floorClass) {
  const need = classRank(floorClass);
  if (need === null) return { ok: false, basis: 'unknown-floor', modelClass: null };

  const caps = entry?.capabilities || {};

  // PRIOR, not proof. size_class here is PARAMETER SIZE (card f942d93b), a
  // different axis from the work-difficulty class this floor is expressed in.
  // It correlates well enough to be useful and is explicitly labelled a prior
  // so nobody later mistakes it for an assessment.
  const declared = caps.size_class || entry?.card?.size_class || null;
  const measured = entry?.lifecycle?.measured_capabilities || entry?.measured_capabilities || null;

  const { cls, basis } = effectiveClass(declared, measured);
  if (!cls) {
    // S is the floor everything clears; anything higher needs actual evidence.
    return { ok: need === 0, basis: 'unknown', modelClass: null };
  }
  const have = classRank(cls);
  return { ok: have !== null && have >= need, basis, modelClass: cls };
}

/**
 * Resolve a bucket to its eligible members, with the rejects and why.
 *
 * Returns rejects because an empty pool must produce a 503 an operator can act
 * on. "No models available" with no reasons is an outage report; "3 excluded,
 * 2 below the L floor and 1 in trust zone 2" is a decision.
 *
 * @param {object} args
 * @param {{model_class:string, sensitivity:string}} args.bucket
 * @param {Array<object>} args.catalog merged catalog entries
 * @param {Record<string,number>} [args.sensitivityPolicy]
 * @param {(e:object)=>boolean} [args.isRoutable] lifecycle gate, injected
 * @returns {{members: Array<object>, rejected: Array<object>, ceiling: number}}
 */
export function resolveBucket({ bucket, catalog = [], sensitivityPolicy, isRoutable = () => true }) {
  const { ceiling } = resolveZoneCeiling(bucket.sensitivity, sensitivityPolicy);
  const members = [];
  const rejected = [];

  for (const entry of catalog) {
    if (!isRoutable(entry)) {
      rejected.push({ id: entry.id, reason: 'not routable (lifecycle)' });
      continue;
    }
    const zone = entry?.capabilities?.trust_zone;
    if (!isZoneAllowed(zone, ceiling)) {
      rejected.push({
        id: entry.id,
        reason: typeof zone === 'number'
          ? `trust_zone ${zone} exceeds ceiling ${ceiling} for sensitivity=${bucket.sensitivity}`
          : `trust_zone unknown, treated as least trusted (${TRUST_ZONES.FREE_REMOTE})`,
      });
      continue;
    }
    const floor = meetsClassFloor(entry, bucket.model_class);
    if (!floor.ok) {
      rejected.push({
        id: entry.id,
        reason: `class ${floor.modelClass || 'unknown'} (${floor.basis}) below floor ${bucket.model_class}`,
      });
      continue;
    }
    members.push({ id: entry.id, class_basis: floor.basis, model_class: floor.modelClass, trust_zone: zone ?? null });
  }

  return { members, rejected, ceiling };
}

/**
 * Pick which member serves THIS request.
 *
 * Ranking decides who is ELIGIBLE. Rotation decides who SERVES. Always taking
 * the top-ranked member hammers one model into a rate limit while the rest of
 * the pool idles, and on a free fleet throttling is the normal operating
 * condition rather than an edge case (card 9e28de88). Spreading load is how a
 * free pool stays usable, not a nicety.
 *
 * Deterministic round-robin over a caller-supplied counter, so it is testable
 * and so two gateway processes do not need to agree on anything.
 *
 * @param {Array<object>} members
 * @param {number} counter monotonically increasing per bucket
 * @returns {object|null}
 */
export function selectMember(members, counter = 0) {
  if (!Array.isArray(members) || members.length === 0) return null;
  const i = Math.abs(Math.trunc(counter)) % members.length;
  return members[i];
}
