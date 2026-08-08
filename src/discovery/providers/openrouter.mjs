/**
 * openrouter.mjs (card P2.1): the OpenRouter provider adapter.
 *
 * OpenRouter's `/models` response already carries the full ModelCard (design
 * doc 4.1/5.1: `context_length`, `supported_parameters` including
 * `tools`/`tool_choice`/`reasoning`/`structured_outputs`, `architecture.
 * modality`, `pricing`, `top_provider.max_completion_tokens`, `description`,
 * `created`). This adapter's only job is to keep that card instead of
 * discarding it (the pre-P2.1 `parseOpenRouterFree()` in discovery.mjs threw
 * everything but `id` on the floor). The free filter and the non-chat filter
 * (embeddings/rerank/safety/guard ids) are preserved unchanged.
 *
 * `fetch()` is the network call (kept identical to the pre-P2.1
 * `fetchOpenRouter()` in discovery.mjs, which now delegates here).
 * `normalize()` is pure: a captured `/models` JSON payload in, a
 * `ModelCard[]` out. No I/O, no clock of its own beyond the optional
 * injected `now` (defaults to `Date.now`, matching the mtime/TTL-cache clock
 * convention used across this codebase, e.g. model_catalog_store.mjs).
 *
 * @module discovery/providers/openrouter
 */

// Same non-chat filter as discovery.mjs's isChatModel/NON_CHAT (kept in sync
// deliberately, not imported, to avoid a circular import between this module
// and discovery.mjs while discovery.mjs itself now imports this module).
const NON_CHAT = [
  /embed/i, /\bbge\b/i, /rerank/i, /content-safety/i, /guard/i,
  /\bfuyu\b/i, /\bocr\b/i, /vision-embed/i, /moderation/i,
];

function isChatModel(id) {
  if (!id || typeof id !== 'string') return false;
  return !NON_CHAT.some((re) => re.test(id));
}

function isFree(m) {
  if (String(m.id || '').endsWith(':free')) return true;
  const p = m.pricing || {};
  return String(p.prompt) === '0' && String(p.completion) === '0';
}

/**
 * GET https://openrouter.ai/api/v1/models and return the parsed JSON.
 * Throws `Error("openrouter <status>")` on a non-ok response, matching the
 * pre-P2.1 `fetchOpenRouter()` contract in discovery.mjs (discoverCatalog's
 * fail-soft/cache-fallback handling relies on this shape).
 *
 * @returns {Promise<object>}
 */
export async function fetch() {
  const r = await globalThis.fetch('https://openrouter.ai/api/v1/models');
  if (!r.ok) throw new Error(`openrouter ${r.status}`);
  return r.json();
}

/**
 * Normalize a captured OpenRouter `/models` payload into ModelCard[] (design
 * doc 4.1), keeping only free chat models (same filter as the pre-P2.1
 * `parseOpenRouterFree()`). Pure and fail-soft: a malformed/empty payload
 * yields `[]` rather than throwing.
 *
 * @param {object} json OpenRouter `/models` response, `{ data: [...] }`
 * @param {{now?: () => number}} [opts]
 * @returns {Array<{id:string, provider:'openrouter', free:true, card:object}>}
 */
export function normalize(json, opts = {}) {
  const clock = opts.now || Date.now;
  const data = (json && Array.isArray(json.data)) ? json.data : [];
  const fetched_at = clock();

  return data
    .filter((m) => m && typeof m.id === 'string')
    .filter(isFree)
    .filter((m) => isChatModel(m.id))
    .map((m) => ({
      id: m.id,
      provider: 'openrouter',
      free: true,
      card: {
        context_length: typeof m.context_length === 'number' ? m.context_length : null,
        max_output_tokens: typeof m.top_provider?.max_completion_tokens === 'number'
          ? m.top_provider.max_completion_tokens
          : null,
        modality: typeof m.architecture?.modality === 'string' ? m.architecture.modality : null,
        supported_parameters: Array.isArray(m.supported_parameters) ? m.supported_parameters : [],
        description: typeof m.description === 'string' ? m.description : null,
        pricing: m.pricing && typeof m.pricing === 'object' ? m.pricing : null,
        source: 'openrouter',
        fetched_at,
      },
    }));
}
