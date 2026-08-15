/**
 * classify.mjs: is this discovered model usable as a CHAT model?
 *
 * Card 8274b20b / C13. This replaces a hardcoded id-regex denylist that was
 * duplicated in src/discovery.mjs and src/discovery/providers/openrouter.mjs,
 * each carrying a comment asking humans to keep the two copies in sync. They
 * live here now: a leaf module with no imports, so neither caller creates the
 * circular dependency that motivated the duplication in the first place.
 *
 * WHY THE OLD FILTER FAILED. It matched keywords in the model NAME
 * (embed / rerank / guard / ocr / ...), so anything whose id lacked a known
 * keyword was assumed to be a chat model. Measured on the live catalog
 * 2026-08-15, these were all advertised as chat models and all failed on use:
 *
 *   nvidia/nemotron-parse                400   (a document parser)
 *   nvidia/ai-synthetic-video-detector    500   (a video classifier)
 *   thinkingmachines/inkling              500
 *
 * and OpenRouter's free tier carried google/lyria-3-pro-preview and
 * google/lyria-3-clip-preview, which are MUSIC models. Those two answer 200 to
 * a chat-shaped request, which is worse than failing: they get ranked and
 * routed as if they were general models.
 *
 * WHAT ACTUALLY WORKS, and what does not, measured before writing this:
 *
 *   OpenRouter publishes `architecture.output_modalities`. lyria-3 reports
 *   `["text","audio"]`. So a real capability test catches it. Use it.
 *
 *   NVIDIA publishes NOTHING. Its /v1/models entries carry exactly
 *   {id, object, created, owned_by}. There is no modality, no capability, no
 *   description. Cross-referencing models.dev does not rescue this: 59 of
 *   NVIDIA's 102 live ids are absent from models.dev entirely, and of the 43
 *   present, ZERO have a non-text output modality. So for NVIDIA this module
 *   can only fall back to the denylist.
 *
 * WHY UNKNOWN IS ADMITTED RATHER THAN REJECTED. Failing closed is the right
 * instinct and it is wrong here. "Unknown capability" describes 59 NVIDIA
 * models including yi-large, dbrx, starcoder2, granite, codellama and
 * deepseek-coder, which are ordinary chat models. Rejecting unknowns would
 * delete most of the free fleet to remove three bad entries. The honest
 * position is that a provider which publishes no capability data cannot be
 * classified from metadata, and the only real test is an active probe: a model
 * that returns 400 to a well-formed minimal chat completion is not a chat
 * model. That is a probe-sweep concern (card 1f65cf45 / C3) and a distinct
 * lifecycle disposition from `eol`, tracked separately. It deliberately does
 * NOT belong here, because inferring it from arbitrary user traffic would let
 * one malformed user request condemn a healthy model.
 *
 * @module discovery/classify
 */

/**
 * Name-based backstop. Kept because it is the ONLY signal available for
 * providers that publish no capability data, and because some genuinely
 * text-to-text models are still not chat models: a content-safety classifier
 * reports `text+image->text` and would pass every modality check while being
 * useless as a conversational model.
 *
 * Single source of truth. Previously duplicated across two modules by hand.
 */
export const NON_CHAT_ID_PATTERNS = [
  /embed/i,
  /\bbge\b/i,
  /rerank/i,
  /content-safety/i,
  /guard/i,
  /\bfuyu\b/i,
  /\bocr\b/i,
  /vision-embed/i,
  /moderation/i,
  // Added by card C13 from measured live failures. These are structural
  // non-chat models whose ids carry no previously-known keyword.
  /\bparse\b/i,
  /detector/i,
  /\bnvclip\b/i,
  /\bdeplot\b/i,
];

/** Backwards-compatible name test. True when the id does not look non-chat. */
export function isChatModelId(id) {
  if (!id || typeof id !== 'string') return false;
  return !NON_CHAT_ID_PATTERNS.some((re) => re.test(id));
}

/**
 * Normalize whatever a provider gave us into an output-modality list, or null
 * when the provider published nothing.
 *
 * Handles OpenRouter's two shapes: the structured
 * `architecture.output_modalities` array, and the older `architecture.modality`
 * string ("text+image->text+audio"), whose right-hand side is the output side.
 *
 * @param {object} raw a provider's raw model entry
 * @returns {string[]|null}
 */
export function outputModalities(raw) {
  const arch = raw?.architecture;
  if (Array.isArray(arch?.output_modalities) && arch.output_modalities.length) {
    return arch.output_modalities.map(String);
  }
  if (typeof arch?.modality === 'string' && arch.modality.includes('->')) {
    const out = arch.modality.split('->').pop();
    if (out) return out.split('+').map((s) => s.trim()).filter(Boolean);
  }
  // models.dev shape, used when a provider's own catalog is capability-free.
  const mod = raw?.modalities?.output;
  if (Array.isArray(mod) && mod.length) return mod.map(String);
  return null;
}

/**
 * Can this model serve a chat completion?
 *
 * Order matters. Capability evidence beats the name, and the name is only
 * consulted when there is no capability evidence to consult, or as a veto for
 * text-to-text models that still are not conversational.
 *
 * @param {object} raw provider's raw model entry (must carry an `id`)
 * @returns {{chat: boolean, reason: string|null, basis: 'modality'|'id'|'unknown'}}
 */
export function classifyChatCapability(raw) {
  const id = raw?.id;
  if (!id || typeof id !== 'string') {
    return { chat: false, reason: 'no id', basis: 'unknown' };
  }

  const out = outputModalities(raw);
  if (out) {
    // A chat model emits text and only text. lyria-3 emits ["text","audio"],
    // an image generator emits ["image"]. Both are excluded here, on evidence.
    const textOnly = out.length === 1 && out[0].toLowerCase() === 'text';
    if (!textOnly) {
      return { chat: false, reason: `output modality ${out.join('+')}`, basis: 'modality' };
    }
  }

  if (!isChatModelId(id)) {
    return { chat: false, reason: 'non-chat id pattern', basis: 'id' };
  }

  return { chat: true, reason: null, basis: out ? 'modality' : 'unknown' };
}

/** Convenience predicate for the adapters' filter chains. */
export function isChatCapable(raw) {
  return classifyChatCapability(raw).chat;
}
