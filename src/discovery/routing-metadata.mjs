/**
 * Routing preference metadata shared by discovery adapters.
 *
 * Family is a broad, stable caller preference, not a vendor SKU. Unknown
 * naming schemes stay explicitly unfamilied rather than being guessed.
 */
const FAMILY_PREFIXES = Object.freeze([
  [/^(?:claude)(?:[-_/]|$)/i, 'claude'],
  [/^(?:gpt-|openai\/gpt-|codex)/i, 'codex'],
  [/^(?:glm)(?:[-_/]|$)/i, 'glm'],
  [/^(?:ornith)(?:[-_/]|$)/i, 'ornith'],
  [/^(?:qwen|qwen\/|huihui\/|qwen3)/i, 'qwen'],
  [/^(?:moonshotai\/kimi|kimi)(?:[-_/]|$)/i, 'kimi'],
  [/^(?:meta\/llama|llama)(?:[-_/]|$)/i, 'llama'],
  [/^(?:nvidia\/.*nemotron|nemotron)(?:[-_/]|$)/i, 'nemotron'],
  [/^(?:mistralai\/|mistral)/i, 'mistral'],
  [/^(?:deepseek-ai\/|deepseek)(?:[-_/]|$)/i, 'deepseek'],
  [/^(?:minimaxai\/|minimax)/i, 'minimax'],
  [/^(?:google\/gemma|gemma)(?:[-_/]|$)/i, 'gemma'],
  [/^(?:zai-org\/|z-ai\/)/i, 'glm'],
]);

/** Return an explicit family declaration, or an explicit absence with reason. */
export function familyMetadataForId(id) {
  const value = typeof id === 'string' ? id.trim() : '';
  for (const [pattern, family] of FAMILY_PREFIXES) {
    if (pattern.test(value)) return { family };
  }
  return {
    family: null,
    unfamilied_reason: 'No reviewed broad-family mapping exists for this catalog id',
  };
}

function providerRecord(model, providers) {
  const name = model?.provider;
  if (!providers || typeof providers !== 'object' || typeof name !== 'string') return null;
  if (providers[name]) return providers[name];
  if (name === 'anthropic-direct') return providers.anthropic || null;
  if (/ornith|qwen38|^local$|^ollama$/i.test(name)) return providers.local || null;
  return null;
}

/**
 * Declare routing metadata for every live row. Cost is read only from a model
 * or provider declaration. It is never inferred from retention or trust zone.
 */
export function declareRoutingMetadata(model, providers) {
  const card = model?.card || {};
  const reviewedFamily = familyMetadataForId(model?.id);
  const family = reviewedFamily.family !== null
    ? reviewedFamily
    : (typeof card.family === 'string' ? { family: card.family } : reviewedFamily);
  const provider = providerRecord(model, providers);
  const cost_tier = typeof card.cost_tier === 'string'
    ? card.cost_tier
    : (typeof provider?.cost_tier === 'string' ? provider.cost_tier : null);
  return {
    ...model,
    card: {
      ...card,
      ...family,
      cost_tier,
      ...(cost_tier === null
        ? { cost_tier_reason: 'No model or provider cost declaration exists' }
        : {}),
    },
  };
}
