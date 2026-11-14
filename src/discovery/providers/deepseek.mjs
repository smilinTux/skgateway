/** Dynamic catalog adapter for DeepSeek. */

export const DEEPSEEK_MODELS_URL = "https://api.deepseek.com/v1/models";

/**
 * Fetch the current model list using a caller-supplied read-only credential
 * header set.
 * @param {{authorization?: string}} [authHeaders]
 * @returns {Promise<object>}
 */
export async function fetch(authHeaders) {
  if (!authHeaders?.authorization) throw new Error("deepseek no-credentials");
  const response = await globalThis.fetch(DEEPSEEK_MODELS_URL, { headers: authHeaders });
  if (!response.ok) throw new Error(`deepseek ${response.status}`);
  return response.json();
}

/**
 * A DeepSeek id is canonical when it is a string that already equals its
 * trimmed form and is neither empty nor whitespace-only. No vendor-name
 * pattern is imposed; the check only rejects malformed/absent ids.
 * @param {unknown} id
 * @returns {id is string}
 */
function isCanonicalId(id) {
  return typeof id === "string" && id.length > 0 && id.trim() === id && !/\s/u.test(id);
}

/**
 * A present numeric limit is usable only when it is a finite, non-negative
 * number. `null`/`undefined` (absent) is left to the caller's default.
 * @param {unknown} value
 * @returns {boolean}
 */
function isMalformedLimit(value) {
  if (value === null || value === undefined) return false;
  return typeof value !== "number" || !Number.isFinite(value) || value < 0;
}

/**
 * Normalize the DeepSeek OpenAI-compatible /models response. DeepSeek's
 * catalog does not publish pricing, so these are paid plan models, never free
 * models. Provider-declared fields are retained where present and typed
 * correctly; everything else stays null rather than invented. Records with a
 * missing/noncanonical id, a duplicate id, a foreign `owned_by`, or a
 * malformed numeric limit are rejected outright.
 * @param {object} json
 * @param {{now?: () => number}} [opts]
 * @returns {Array<object>}
 */
export function normalize(json, opts = {}) {
  const fetched_at = (opts.now || Date.now)();
  const data = json && Array.isArray(json.data) ? json.data : [];
  const seen = new Set();
  const out = [];
  for (const m of data) {
    if (!m || !isCanonicalId(m.id)) continue;
    if (
      m.owned_by !== null
      && m.owned_by !== undefined
      && (typeof m.owned_by !== "string" || m.owned_by.toLowerCase() !== "deepseek")
    ) continue;
    if (isMalformedLimit(m.context_length) || isMalformedLimit(m.max_output_tokens)) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push({
      id: m.id,
      provider: "deepseek",
      free: false,
      card: {
        context_length: typeof m.context_length === "number" ? m.context_length : null,
        max_output_tokens: typeof m.max_output_tokens === "number" ? m.max_output_tokens : null,
        modality: typeof m.modality === "string" ? m.modality : null,
        supported_parameters: [],
        reasoning: false,
        structured_outputs: false,
        params_b: null,
        active_params_b: null,
        size_class: null,
        description: typeof m.description === "string" ? m.description : null,
        pricing: null,
        source: "deepseek",
        fetched_at,
        tier: "paid-cloud",
      },
    });
  }
  return out;
}
