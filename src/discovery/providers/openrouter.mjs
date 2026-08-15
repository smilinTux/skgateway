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
 * Card N2 (coordination id f942d93b) surfaces two more provider-declared
 * booleans that were already in `supported_parameters` and discarded
 * (`reasoning`, `structured_outputs`), plus a best-effort `params_b` /
 * `active_params_b` / `size_class` parsed from the id string (OpenRouter
 * itself never declares a parameter count; see `discovery/model-size.mjs`).
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

// Card C13: the non-chat test lives in discovery/classify.mjs now. It used to
// be a copy of discovery.mjs's list, kept in sync by hand with a comment asking
// humans to remember. classify.mjs is a leaf module with no imports, so using
// it here creates none of the circular dependency that motivated the copy.
//
// The upgrade that matters for THIS provider: OpenRouter publishes
// architecture.output_modalities, so google/lyria-3-* (music models reporting
// ["text","audio"]) are now excluded on capability evidence rather than slipping
// through because their ids contain no known keyword.
import { isChatCapable } from '../classify.mjs';
import { parseParamsFromId, parseParamsFromDescription, deriveSizeClassFromParams } from '../model-size.mjs';

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
    .filter(isChatCapable)
    .map((m) => {
      const supported = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
      // params_b/active_params_b/size_class (card N2): OpenRouter's own card
      // never declares a structured parameter count. Two fallbacks, tried in
      // order, both kept OUT of `card.source` (which stays 'openrouter', a
      // real provider-declared card) and instead tagged with their own
      // `params_basis` so a reader can tell these three fields are a
      // best-effort read even though the rest of the card is not:
      //   1. id-pattern: many ids follow NVIDIA's own "-<N>b"/"-a<N>b"
      //      convention (e.g. "nvidia/nemotron-3-ultra-550b-a55b:free").
      //   2. description prose: some live ids carry NO size token at all
      //      (measured 2026-08-15: "nvidia/nemotron-3.5-lightning:free" has
      //      none) but their `description` states it in English ("with 3B
      //      active parameters out of 30B total"). See model-size.mjs.
      // null/null/null when neither yields anything, never invented further.
      let { params_b, active_params_b } = parseParamsFromId(m.id);
      let params_basis = params_b != null ? 'id-pattern' : null;
      if (params_b == null) {
        const fromDescription = parseParamsFromDescription(m.description);
        if (fromDescription.params_b != null) {
          params_b = fromDescription.params_b;
          active_params_b = fromDescription.active_params_b;
          params_basis = 'description';
        }
      }
      const size_class = deriveSizeClassFromParams(params_b);
      return {
        id: m.id,
        provider: 'openrouter',
        free: true,
        card: {
          context_length: typeof m.context_length === 'number' ? m.context_length : null,
          max_output_tokens: typeof m.top_provider?.max_completion_tokens === 'number'
            ? m.top_provider.max_completion_tokens
            : null,
          modality: typeof m.architecture?.modality === 'string' ? m.architecture.modality : null,
          supported_parameters: supported,
          // reasoning/structured_outputs (card N2): OpenRouter already
          // declares these in supported_parameters and it was being
          // discarded. Real provider declaration, so no extra basis tag
          // needed (same trust level as tool_use's card-basis check).
          reasoning: supported.includes('reasoning'),
          structured_outputs: supported.includes('structured_outputs'),
          params_b,
          active_params_b,
          size_class,
          params_basis,
          description: typeof m.description === 'string' ? m.description : null,
          pricing: m.pricing && typeof m.pricing === 'object' ? m.pricing : null,
          source: 'openrouter',
          fetched_at,
        },
      };
    });
}
