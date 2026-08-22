/**
 * codex.mjs: the OpenAI Codex (ChatGPT subscription) provider adapter.
 *
 * The Codex backend publishes its live model catalog at
 *   GET https://chatgpt.com/backend-api/codex/models?client_version=<v>
 * with the same auth headers as /responses (bearer access token plus
 * chatgpt-account-id). This is the endpoint the Codex CLI itself caches at
 * ~/.codex/models_cache.json; measured live 2026-08-22 it returns the slug
 * list with per-model context windows, reasoning levels, visibility and
 * supported_in_api flags. There is no pricing data (the catalog is an
 * entitlement list for the signed-in subscription, not a store), so `free`
 * here is always false: subscription inference draws down a paid plan.
 *
 * KEPT IDs (normalize()): `visibility !== 'hide'` AND `supported_in_api !==
 * false`. Measured on the live account: gpt-5.3-codex-spark carries
 * supported_in_api:false (a CLI-only model the /responses endpoint rejects)
 * and codex-auto-review carries visibility:'hide' (an internal auto-review
 * slug). Serving either through the gateway would advertise a model that
 * 400s on first use, exactly the dead-id rot the lifecycle layer exists to
 * police; better never to admit them.
 *
 * The card carries only what the provider declares (context_window,
 * reasoning levels, plan availability). Capability/size curation stays in
 * config/model-cards.overrides.yaml, which applies AFTER this card (the
 * overlay is not blocked for source 'codex', only for live openrouter /
 * models.dev cards), so curated size_class entries for the gpt-5.x family
 * can make these models eligible for bucket pools.
 *
 * `fetch()` is the network call; `normalize()` is pure (captured payload in,
 * ModelCard[] out). No I/O beyond the optional injected clock.
 *
 * @module discovery/providers/codex
 */

import { CODEX_BASE_URL, CODEX_CLI_VERSION } from '../../proxy/codex-adapter.mjs';

/**
 * GET the Codex /models catalog. `authHeaders` is the header set built from
 * the backend's Codex CLI credentials file ({authorization,
 * chatgpt-account-id}; see readCodexAuthHeaders in codex-adapter.mjs).
 *
 * client_version is a REQUIRED query parameter (measured: without it the
 * endpoint 400s with missing field 'client_version'). It must be a plausible
 * Codex CLI version or the request is not treated as a Codex client.
 *
 * Throws `Error("codex <status>")` on a non-ok response, matching every
 * other adapter's fetch() contract: discoverCatalog's fail-soft handling
 * treats a throw as "provider down this cycle" and falls back to the cache.
 *
 * @param {{authorization?: string, "chatgpt-account-id"?: string}} [authHeaders]
 * @returns {Promise<object>}
 */
export async function fetch(authHeaders) {
  const headers = {};
  if (authHeaders?.authorization) headers.authorization = authHeaders.authorization;
  if (authHeaders?.["chatgpt-account-id"]) headers["chatgpt-account-id"] = authHeaders["chatgpt-account-id"];
  if (!headers.authorization) throw new Error('codex no-credentials');
  const r = await globalThis.fetch(
    `${CODEX_BASE_URL}/models?client_version=${CODEX_CLI_VERSION}`,
    { headers },
  );
  if (!r.ok) throw new Error(`codex ${r.status}`);
  return r.json();
}

/**
 * Normalize a captured Codex /models payload into ModelCard[] (design doc
 * 4.1). Pure and fail-soft: a malformed/empty payload yields [] rather than
 * throwing. A missing authHeaders on the fetch side surfaces here as an
 * empty cycle via the throw above, never as a guessed catalog.
 *
 * @param {object} json Codex /models response, `{ models: [...] }`
 * @param {{now?: () => number}} [opts]
 * @returns {Array<{id:string, provider:'codex', free:false, card:object}>}
 */
export function normalize(json, opts = {}) {
  const clock = opts.now || Date.now;
  const data = (json && Array.isArray(json.models)) ? json.models : [];
  const fetched_at = clock();

  return data
    .filter((m) => m && typeof m.slug === 'string')
    .filter((m) => m.visibility !== 'hide')
    .filter((m) => m.supported_in_api !== false)
    .map((m) => {
      const levels = Array.isArray(m.supported_reasoning_levels)
        ? m.supported_reasoning_levels.map((l) => (typeof l === 'string' ? l : l?.effort)).filter(Boolean)
        : [];
      // modality from the provider's own input_modalities (measured: the
      // gpt-5.6/5.5/5.4 family declares ['text','image'], codex-spark
      // text-only), never guessed.
      const inputMods = Array.isArray(m.input_modalities) ? m.input_modalities : ['text'];
      const modality = inputMods.includes('image')
        ? 'text+image->text'
        : (inputMods.length ? inputMods.join('+') + '->text' : null);
      return {
        id: m.slug,
        provider: 'codex',
        // Subscription inference is paid (draws down a ChatGPT plan); there
        // is no free tier of this backend to detect, so the flag is constant
        // rather than derived from data that does not exist.
        free: false,
        card: {
          context_length: typeof m.context_window === 'number' ? m.context_window : null,
          max_output_tokens: null,
          modality,
          supported_parameters: [
            'tools',
            'tool_choice',
            ...(levels.length ? ['reasoning'] : []),
          ],
          reasoning: levels.length > 0,
          structured_outputs: false,
          params_b: null,
          active_params_b: null,
          size_class: null,
          params_basis: null,
          description: typeof m.description === 'string' ? m.description : null,
          pricing: null,
          source: 'codex',
          fetched_at,
          tier: 'paid-cloud',
        },
      };
    });
}
