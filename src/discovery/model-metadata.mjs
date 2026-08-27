/*
 * Family and economic-cost metadata for model cards.
 *
 * These fields answer WHO a model is related to and WHAT its use costs. They
 * are deliberately independent of sovereignty, retention, and trust_zone,
 * which remain owned by ranking/capabilities.mjs's deriveTrustZone().
 */

export const COST_TIERS = Object.freeze({
  FREE: 'FREE',
  LOCAL: 'LOCAL',
  SUBSCRIPTION: 'SUBSCRIPTION',
  PAID: 'PAID',
  UNKNOWN: 'UNKNOWN',
});

const FAMILY_RULES = Object.freeze([
  [/^claude(?:[-_/]|$)/i, 'claude'],
  [/^(?:gpt-|codex(?:[-_/]|$))/i, 'codex'],
  [/^(?:kimi|moonshot)(?:[-_/]|$)/i, 'kimi'],
  [/^glm(?:[-_/]|$)/i, 'glm'],
  [/^ornith(?:[-_/]|$)/i, 'ornith'],
  [/^(?:qwen|huihui)(?=\d|[-_/]|$)/i, 'qwen'],
]);

/**
 * Return a stable product family, or null plus a machine-readable reason.
 * Provider adapters can carry arbitrary new ids, so the fallback strips the
 * organisation namespace and version/size suffix rather than maintaining a
 * stale closed-world allowlist.
 */
export function resolveFamily(model = {}) {
  const id = typeof model.id === 'string' ? model.id.trim().toLowerCase() : '';
  if (!id) return { family: null, basis: null, unfamilied_reason: 'model id is absent or non-string' };
  const product = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
  // Canonical fleet families win over adapters' more granular architecture
  // labels such as qwen3.5. This is what makes "qwen" address the whole set.
  for (const [pattern, family] of FAMILY_RULES) {
    if (pattern.test(product)) return { family, basis: 'id-pattern', unfamilied_reason: null };
  }

  const declared = model?.card?.family;
  if (typeof declared === 'string' && declared.trim()) {
    return { family: declared.trim().toLowerCase(), basis: 'declared', unfamilied_reason: null };
  }

  const fallback = product
    .replace(/:free$/i, '')
    .replace(/[-_]v?\d+(?:\.\d+)*(?:b)?(?:[-_].*)?$/i, '')
    .replace(/[-_](?:instruct|chat|thinking|reasoning|coder|free)$/i, '')
    .replace(/^[-_]+|[-_]+$/g, '');
  if (fallback) return { family: fallback, basis: 'id-prefix', unfamilied_reason: null };
  return { family: null, basis: null, unfamilied_reason: `no stable family token in model id ${id}` };
}

/** Economic tier only. This function must never inspect retention or zones. */
export function resolveCostTier(model = {}) {
  const declared = model?.card?.cost_tier ?? model?.cost_tier;
  if (Object.values(COST_TIERS).includes(declared)) return declared;
  const sovereigntyTier = model?.card?.tier ?? model?.tier;
  if (sovereigntyTier === 'local') return COST_TIERS.LOCAL;
  if (sovereigntyTier === 'free-remote' || model.free === true) return COST_TIERS.FREE;
  if (sovereigntyTier === 'paid-cloud' || model.free === false) return COST_TIERS.SUBSCRIPTION;
  return COST_TIERS.UNKNOWN;
}

/** Ensure every catalog entry has a card with explicit family coverage. */
export function attachFamilyAndCost(model = {}) {
  const family = resolveFamily(model);
  const card = {
    ...(model.card || {}),
    family: family.family,
    family_basis: family.basis,
    cost_tier: resolveCostTier(model),
  };
  if (family.unfamilied_reason) card.unfamilied_reason = family.unfamilied_reason;
  else delete card.unfamilied_reason;
  return { ...model, card };
}
