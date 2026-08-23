/** Dynamic catalog adapter for the z.ai ZCode Coding Plan. */

export const ZAI_MODELS_URL = "https://api.z.ai/api/coding/paas/v4/models";

/**
 * Fetch the current model entitlement list using a caller-supplied read-only
 * credential header set.
 * @param {{authorization?: string}} [authHeaders]
 * @returns {Promise<object>}
 */
export async function fetch(authHeaders) {
  if (!authHeaders?.authorization) throw new Error("zai no-credentials");
  const response = await globalThis.fetch(ZAI_MODELS_URL, { headers: authHeaders });
  if (!response.ok) throw new Error(`zai ${response.status}`);
  return response.json();
}

/**
 * Normalize the z.ai OpenAI-compatible /models response. ZCode's catalog is
 * an entitlement list and does not publish pricing, so these are paid plan
 * models, never free models. Provider-declared fields are retained where
 * present; model-specific cards stay in the curated overlay.
 * @param {object} json
 * @param {{now?: () => number}} [opts]
 * @returns {Array<object>}
 */
export function normalize(json, opts = {}) {
  const fetched_at = (opts.now || Date.now)();
  const data = json && Array.isArray(json.data) ? json.data : [];
  return data
    .filter((m) => m && typeof m.id === "string")
    .map((m) => ({
      id: m.id,
      provider: "zai",
      free: false,
      card: {
        context_length: typeof m.context_length === "number" ? m.context_length : null,
        max_output_tokens: typeof m.max_output_tokens === "number" ? m.max_output_tokens : null,
        modality: null,
        supported_parameters: [],
        reasoning: false,
        structured_outputs: false,
        params_b: null,
        active_params_b: null,
        size_class: null,
        description: typeof m.description === "string" ? m.description : null,
        pricing: null,
        source: "zai",
        fetched_at,
        tier: "paid-cloud",
      },
    }));
}
