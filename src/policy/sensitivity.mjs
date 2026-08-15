/**
 * sensitivity.mjs: job sensitivity to model trust-zone ceiling (card 45d7a30b / N1).
 *
 * Two axes that must not be conflated, which is the whole reason this is its
 * own module:
 *
 *   JOB sensitivity   public / internal / secret. A property of the WORK: how
 *                     bad is it if this content leaves our hardware. Distinct
 *                     from the Joule Economy's size x risk grade, which
 *                     measures blast radius if the work goes WRONG. A tiny
 *                     prompt containing a private key is low blast radius and
 *                     maximum sensitivity.
 *
 *   MODEL trust zone  0 sovereign local, 1 paid-contractual cloud, 2
 *                     free-remote. A property of WHERE the work would run.
 *                     Derived in ranking/capabilities.mjs from the provider's
 *                     data-retention posture, not asserted here.
 *
 * The mapping between them is policy, so it lives in the registry
 * (`sensitivity_policy`) and this module only resolves and enforces it.
 *
 * WHY THE ZONES ARE ORDERED THIS WAY, and why it inverts the cost ladder.
 * The existing cost tier ladder prefers free-remote over paid-cloud, because
 * free is cheaper. That ladder measures COST. This one measures TRUST, and on
 * that axis free-remote is the WORST option available: verified 2026-08-15
 * from provider terms, nvidia, openrouter and opencode all train on submitted
 * content, while Anthropic's commercial terms prohibit training on Customer
 * Content. Free is not a discount, it is a different payment method, and the
 * payment is the data. Both ladders are correct about different questions and
 * both stay. Do not "reconcile" them.
 *
 * FAIL CLOSED. When no model satisfies the ceiling the request fails with 503.
 * It never falls back across a zone. That is the entire point: sk-default
 * silently failing over from a dead local backend to cloud is the incident
 * this card exists to make impossible, and a fallback that quietly downgrades
 * sovereignty looks healthy right up until someone reads the logs.
 *
 * @module policy/sensitivity
 */

/** Job sensitivity levels, ordered least to most sensitive. */
export const SENSITIVITY_LEVELS = ['public', 'internal', 'secret'];

/** Trust zones, ordered most to least trusted. Mirrors capabilities.mjs. */
export const TRUST_ZONES = {
  SOVEREIGN_LOCAL: 0,
  PAID_CONTRACTUAL: 1,
  FREE_REMOTE: 2,
};

/**
 * Default ceiling per sensitivity: the HIGHEST trust-zone number a job of that
 * sensitivity may run in. Higher zone number means less trusted, so a lower
 * ceiling is stricter.
 *
 *   public    2  anything, including free-remote
 *   internal  1  paid-contractual or sovereign; never a provider that trains
 *   secret    0  sovereign local only; never leaves hardware we own
 *
 * Overridable per deployment via registry `sensitivity_policy`, because what
 * counts as "internal" is a business judgement, not a property of the gateway.
 */
export const DEFAULT_SENSITIVITY_POLICY = Object.freeze({
  public: TRUST_ZONES.FREE_REMOTE,
  internal: TRUST_ZONES.PAID_CONTRACTUAL,
  secret: TRUST_ZONES.SOVEREIGN_LOCAL,
});

/** True for a value this module recognizes as a sensitivity level. */
export function isSensitivity(value) {
  return typeof value === 'string' && SENSITIVITY_LEVELS.includes(value);
}

/**
 * Resolve the trust-zone ceiling for a job sensitivity.
 *
 * An UNRECOGNIZED sensitivity resolves to the STRICTEST ceiling, not the most
 * permissive and not a pass-through. A typo like `sensitivty: secret` or a
 * value from a newer caller than this gateway must never widen what is
 * allowed. This is the same fail-closed discipline card a4f5558e (C5) applied
 * to unknown require keys, for the same reason: a control that quietly admits
 * everything is worse than no control, because people stop checking.
 *
 * @param {string} sensitivity
 * @param {Record<string, number>} [policy] registry sensitivity_policy
 * @returns {{ceiling: number, recognized: boolean}}
 */
export function resolveZoneCeiling(sensitivity, policy = DEFAULT_SENSITIVITY_POLICY) {
  if (!isSensitivity(sensitivity)) {
    return { ceiling: TRUST_ZONES.SOVEREIGN_LOCAL, recognized: false };
  }
  const configured = policy && Object.prototype.hasOwnProperty.call(policy, sensitivity)
    ? policy[sensitivity]
    : DEFAULT_SENSITIVITY_POLICY[sensitivity];
  // A non-numeric or out-of-range policy entry is a misconfiguration. Clamp to
  // the strictest rather than trusting it: a bad config must not be a way to
  // widen the gate.
  if (typeof configured !== 'number' || !Number.isFinite(configured)) {
    return { ceiling: TRUST_ZONES.SOVEREIGN_LOCAL, recognized: true };
  }
  const clamped = Math.max(
    TRUST_ZONES.SOVEREIGN_LOCAL,
    Math.min(TRUST_ZONES.FREE_REMOTE, Math.trunc(configured)),
  );
  return { ceiling: clamped, recognized: true };
}

/**
 * May a model in `zone` serve a job with this ceiling?
 *
 * An UNKNOWN zone (null/undefined, e.g. a model whose provider posture we
 * could not resolve) is treated as the LEAST trusted, not skipped and not
 * assumed safe. "We do not know where this runs" must never satisfy a
 * sovereignty requirement. N2 measured that a large fraction of the fleet has
 * incomplete metadata, so this case is common rather than theoretical.
 *
 * @param {number|null|undefined} zone
 * @param {number} ceiling
 * @returns {boolean}
 */
export function isZoneAllowed(zone, ceiling) {
  const effective = typeof zone === 'number' && Number.isFinite(zone)
    ? zone
    : TRUST_ZONES.FREE_REMOTE;
  return effective <= ceiling;
}

/**
 * Filter candidates to those a job of this sensitivity may use.
 *
 * Returns the kept list AND the rejected ones with reasons, because the
 * shadow-log soak (routing.sensitivity_enforced off) needs to report exactly
 * what enforcement WOULD have changed, and an operator reviewing a 503 needs
 * to see what was excluded rather than an empty list with no explanation.
 *
 * @param {Array<object>} candidates each with a `zoneOf`-resolvable zone
 * @param {number} ceiling
 * @param {(c: object) => number|null|undefined} zoneOf
 * @returns {{allowed: Array<object>, rejected: Array<{candidate: object, zone: number|null, reason: string}>}}
 */
export function filterByZone(candidates, ceiling, zoneOf) {
  const allowed = [];
  const rejected = [];
  for (const c of candidates || []) {
    const zone = zoneOf(c);
    if (isZoneAllowed(zone, ceiling)) allowed.push(c);
    else {
      rejected.push({
        candidate: c,
        zone: typeof zone === 'number' ? zone : null,
        reason: typeof zone === 'number'
          ? `trust_zone ${zone} exceeds ceiling ${ceiling}`
          : `trust_zone unknown, treated as least trusted, exceeds ceiling ${ceiling}`,
      });
    }
  }
  return { allowed, rejected };
}

/**
 * Read the deployment's sensitivity policy out of a resolved registry object.
 * Missing block means the defaults above, which are already the strict ones.
 *
 * @param {object} [registry]
 * @returns {Record<string, number>}
 */
export function policyFromRegistry(registry) {
  const raw = registry?.sensitivity_policy;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SENSITIVITY_POLICY };
  const out = { ...DEFAULT_SENSITIVITY_POLICY };
  for (const level of SENSITIVITY_LEVELS) {
    if (Object.prototype.hasOwnProperty.call(raw, level)) out[level] = raw[level];
  }
  return out;
}
