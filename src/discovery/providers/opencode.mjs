/**
 * opencode.mjs (card 6cc8aac3 / C8): the OpenCode Zen provider adapter.
 *
 * Re-verified live 2026-08-15 before writing this (all MEASURED, not assumed
 * from the card):
 *   GET  https://opencode.ai/zen/v1/models          -> 200, 62 models, no auth
 *   POST https://opencode.ai/zen/v1/chat/completions -> a real call against
 *     big-pickle returned 429 FreeUsageLimitError during this session (the
 *     card's own warning that unauthenticated access can be rate limited
 *     without notice, observed live, not hypothetical).
 *   https://models.dev/api.json -> 200, 3.8MB, the `opencode` key carries 91
 *     model records, of which 27 are zero-cost; exactly 7 of those 27 are
 *     currently live on Zen: big-pickle, deepseek-v4-flash-free, hy3-free,
 *     laguna-s-2.1-free, mimo-v2.5-free, nemotron-3-ultra-free,
 *     nemotron-3.5-lightning-free. big-pickle carries NO `-free` suffix.
 *
 * THIS PROVIDER NEEDS TWO SOURCES, unlike nvidia.mjs or openrouter.mjs. Zen's
 * `/v1/models` returns only `{id, object, created, owned_by}`: no pricing, no
 * context length, no capability data at all. So liveness and the model card
 * come from different places:
 *
 *   https://opencode.ai/zen/v1/models  -> WHICH models are served right now
 *   https://models.dev/api.json        -> WHAT each model is (the `opencode`
 *                                          key: cost, limit, tool_call,
 *                                          reasoning, modalities)
 *
 * fetch() below joins them: Zen is authoritative for availability, models.dev
 * is authoritative for the card. The two fetches are independently fail-soft
 * in different directions (see fetch()'s doc comment). normalize() is pure:
 * a captured `{zen, modelsDev}` payload in, a ModelCard[] out.
 *
 * Card C13: the chat-capability test lives in discovery/classify.mjs, not a
 * fourth hand-synced copy of the old regex list.
 *
 * @module discovery/providers/opencode
 */

import { isChatCapable } from '../classify.mjs';

const ZEN_MODELS_URL = 'https://opencode.ai/zen/v1/models';
const MODELS_DEV_URL = 'https://models.dev/api.json';

/**
 * GET the Zen `/v1/models` liveness list. Measured 2026-08-15: HTTP 200 to a
 * bare GET with no headers at all, no auth required. `apiKey`, when given, is
 * sent as an optional bearer (`OPENCODE_API_KEY`, documented by the provider
 * at https://opencode.ai/docs/zen): unauthenticated access works today, but
 * the provider can rate-limit it without notice (confirmed live during this
 * session: a chat-completions call returned 429), so a caller holding a key
 * gets to use it. No other headers are added. Measured: a bare POST to the
 * chat endpoint with only `content-type: application/json` returns 200, and
 * adding `user-agent: opencode/1.17.20` plus `x-title: skgateway` also
 * returns 200 and changes nothing observable, so neither is invented here.
 *
 * Throws `Error("opencode <status>")` on a non-ok response, matching every
 * other adapter's `fetch()` contract in this directory: discoverCatalog's
 * fail-soft/cache-fallback handling relies on a thrown error meaning "this
 * provider is down this cycle."
 *
 * @param {string} [apiKey]
 * @returns {Promise<object>}
 */
export async function fetchZenModels(apiKey) {
  const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : undefined;
  const r = await globalThis.fetch(ZEN_MODELS_URL, headers ? { headers } : undefined);
  if (!r.ok) throw new Error(`opencode ${r.status}`);
  return r.json();
}

/**
 * GET the models.dev registry (the whole cross-provider registry, ~185
 * providers; this adapter reads only the `opencode` key out of it). This is
 * the model-card source, since Zen's own catalog carries no capability or
 * pricing data. A separate function from fetchZenModels on purpose, so the
 * two can fail independently (see fetch()).
 *
 * Throws `Error("models.dev <status>")` on a non-ok response.
 *
 * @returns {Promise<object>}
 */
export async function fetchModelsDevRegistry() {
  const r = await globalThis.fetch(MODELS_DEV_URL);
  if (!r.ok) throw new Error(`models.dev ${r.status}`);
  return r.json();
}

/**
 * Combined fetch for discoverCatalog(): Zen for WHICH models are live,
 * models.dev for WHAT each one is. The two failure modes are handled
 * differently on purpose:
 *
 *   - Zen failing IS a full outage of this provider. The error propagates
 *     out of this function uncaught, so discoverCatalog()'s try/catch treats
 *     it exactly like the existing `if (nvidiaOk)` / `if (openrouterOk)`
 *     guards at the call site: fall back to the discovery cache, mark the
 *     cycle `stale`, and never let it count toward a model's absent_cycles.
 *   - models.dev failing is NOT a Zen outage. Zen is still authoritative for
 *     availability, we just lose the card this cycle. Caught and swallowed
 *     here so normalize() still receives Zen's id list and can serve it with
 *     a null card, instead of an unrelated third-party site's bad day taking
 *     the whole provider down.
 *
 * @param {string} [apiKey] OPENCODE_API_KEY, optional
 * @returns {Promise<{zen: object, modelsDev: object|null}>}
 */
export async function fetch(apiKey) {
  const zen = await fetchZenModels(apiKey);
  let modelsDev = null;
  try {
    modelsDev = await fetchModelsDevRegistry();
  } catch {
    modelsDev = null;
  }
  return { zen, modelsDev };
}

/**
 * Free means `cost.input === 0 && cost.output === 0` from models.dev. Never
 * an id-suffix test: big-pickle is free and carries no `-free` suffix, and it
 * is the model this adapter exists to add. Six of the seven models
 * currently live on Zen do end in `-free`; big-pickle is the counterexample
 * that proves a suffix filter would have silently dropped exactly the model
 * Chef asked for.
 *
 * @param {object|null} entry the models.dev registry entry for this id, or null
 * @returns {boolean|null} true/false when cost is known; null when it is not
 *   known (models.dev unreachable this cycle, or this one id has no registry
 *   entry) -- deliberately never guessed either way.
 */
function isFreeByCost(entry) {
  const cost = entry && entry.cost;
  if (!cost || typeof cost.input !== 'number' || typeof cost.output !== 'number') return null;
  return cost.input === 0 && cost.output === 0;
}

/**
 * Build the ModelCard `card` block from a models.dev registry entry. Richer
 * than NVIDIA's heuristic card: context/output limits, tool_call and
 * reasoning are provider-declared here, not guessed. Tagged
 * `source: 'models.dev'`, which discovery.mjs's `_FRESH_PROVIDER_SOURCES`
 * treats as a live authoritative card (same protection openrouter's card
 * gets from the manual overlay in config/model-cards.overrides.yaml never
 * clobbering it).
 *
 * Card N1 (trust zones): unauthenticated free inference to a third party is
 * the least private tier available to this gateway. The data itself is the
 * payment, and we are not even identified to the provider. That is recorded
 * explicitly here (`tier`, `trust_zone`, `sensitivity_max`) rather than left
 * for a future reader to infer from the word "free". `tier: 'free-remote'`
 * is read directly by `deriveSovereignty()` in ranking/capabilities.mjs
 * (it checks `card.tier` before falling back to inferring from `free`), so
 * this is functional today, not just documentation for N1 to build later.
 *
 * @param {object} entry models.dev registry entry
 * @param {number} fetched_at
 */
function buildCard(entry, fetched_at) {
  const limit = entry.limit || {};
  const modalities = entry.modalities || {};
  const cost = entry.cost || null;
  const supported_parameters = [
    ...(entry.tool_call ? ['tools', 'tool_choice'] : []),
    ...(entry.reasoning ? ['reasoning'] : []),
    ...(entry.structured_output ? ['structured_outputs'] : []),
  ];
  // reasoning/structured_outputs (card N2): models.dev declares these
  // directly (`entry.reasoning`, `entry.structured_output`), real
  // provider-declared facts, not a guess. Surfaced as booleans on the card
  // (not just folded into supported_parameters) so callers don't have to
  // re-scan an array for them, matching openrouter.mjs's card N2 shape.
  const reasoning = entry.reasoning === true;
  const structured_outputs = entry.structured_output === true;
  // params_b/active_params_b (card N2): models.dev's `opencode` registry
  // carries no parameter-count field at all (verified 2026-08-15 against
  // big-pickle/nemotron-3-ultra-free/nemotron-3.5-lightning-free: no `size`,
  // `params`, or similar key), and Zen's ids (e.g. "big-pickle",
  // "nemotron-3-ultra-free") carry no size token either, unlike NVIDIA's own
  // raw ids. So there is no source to derive from here; left null rather
  // than cross-referencing a sibling NVIDIA id by name similarity inside
  // this adapter (that cross-reference, where it is safe to make, lives as
  // a dated, explicit manual overlay entry in
  // config/model-cards.overrides.yaml instead, not a silent guess in code).
  const inputMod = Array.isArray(modalities.input) && modalities.input.length
    ? modalities.input.join('+')
    : 'text';
  const outputMod = Array.isArray(modalities.output) && modalities.output.length
    ? modalities.output.join('+')
    : null;

  return {
    context_length: typeof limit.context === 'number' ? limit.context : null,
    max_output_tokens: typeof limit.output === 'number' ? limit.output : null,
    modality: outputMod ? `${inputMod}->${outputMod}` : null,
    supported_parameters,
    reasoning,
    structured_outputs,
    params_b: null,
    active_params_b: null,
    size_class: null,
    description: typeof entry.description === 'string'
      ? entry.description
      : (typeof entry.name === 'string' ? entry.name : null),
    pricing: cost ? { prompt: String(cost.input), completion: String(cost.output) } : null,
    source: 'models.dev',
    fetched_at,
    tier: 'free-remote',
    trust_zone: 2,
    // Never eligible for `require: {sensitivity: secret}` (card N1 will be
    // the enforcement point; this is the metadata it needs to consume).
    sensitivity_max: 'public',
  };
}

/**
 * Normalize a combined `{zen, modelsDev}` payload into ModelCard[] (design
 * doc 4.1). Zen is authoritative for WHICH ids exist; models.dev supplies
 * WHAT each one is and, critically, whether it is free. Pure and fail-soft: a
 * malformed/empty payload yields `[]` rather than throwing.
 *
 * Free filtering happens here, not in fetch(): a models.dev entry with
 * nonzero cost (e.g. claude-opus-5, gpt-5, both served by Zen but not free)
 * is EXCLUDED (`free === false`). An id whose cost is unknown (`free ===
 * null`, either because models.dev is unreachable this cycle, or -
 * theoretically - this one id has no registry entry even though models.dev
 * as a whole answered) is KEPT rather than dropped: per the card, a
 * models.dev outage must not silently empty this provider. Measured
 * 2026-08-15: there is currently zero gap between Zen's 62 live ids and
 * models.dev's opencode registry, so in practice this only fires during an
 * actual models.dev outage. A caller reading `free: null` downstream gets
 * neither the free-ranking bonus (ranking/rank.mjs's `entry.free ? 1 : 0`)
 * nor the paid flag (ranking/capabilities.mjs's `modelCard.free === false`
 * check) - the honest answer is that we do not know, not a guess in either
 * direction.
 *
 * @param {{zen: object, modelsDev: object|null}} json
 * @param {{now?: () => number}} [opts]
 * @returns {Array<{id:string, provider:'opencode', free:(boolean|null), card:(object|null)}>}
 */
export function normalize(json, opts = {}) {
  const clock = opts.now || Date.now;
  const fetched_at = clock();
  const zenData = (json && json.zen && Array.isArray(json.zen.data)) ? json.zen.data : [];
  const registry = (json && json.modelsDev && json.modelsDev.opencode
    && json.modelsDev.opencode.models && typeof json.modelsDev.opencode.models === 'object')
    ? json.modelsDev.opencode.models
    : null;

  return zenData
    .filter((m) => m && typeof m.id === 'string')
    .map((m) => {
      const entry = registry ? (registry[m.id] || null) : null;
      return {
        id: m.id,
        provider: 'opencode',
        free: isFreeByCost(entry),
        card: entry ? buildCard(entry, fetched_at) : null,
        // classify.mjs's raw shape: it reads `.modalities.output` (the
        // models.dev shape, checked after OpenRouter's `.architecture`
        // shape, which opencode never has). No entry -> no modality
        // evidence -> classify.mjs falls back to its id-pattern backstop,
        // the same degraded path NVIDIA is always on.
        _raw: entry ? { id: m.id, modalities: entry.modalities } : { id: m.id },
      };
    })
    .filter((m) => m.free !== false)
    .filter((m) => isChatCapable(m._raw))
    .map(({ _raw, ...rest }) => rest);
}
