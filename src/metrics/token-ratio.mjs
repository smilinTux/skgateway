/**
 * token-ratio.mjs — measure bytes-per-token per model from live traffic.
 *
 * The context guard in sanitizer.mjs budgets by BYTES (max_body_bytes) as a
 * stand-in for tokens, using a hardcoded ~4 bytes/token. That ratio is a guess,
 * it is wrong by model (CJK, code and prose differ), and nothing has ever
 * checked it. Backends already report exact prompt token counts; the gateway
 * simply never recorded the matching byte size, so the two could not be joined.
 *
 * This pairs them. Phase 1 only measures. Applying the measured ratio to the
 * budget is a separate decision once there is data to justify it.
 *
 * @module token-ratio
 */

/**
 * @param {{model: string, bodyBytes: number, usage: object}} args
 * @returns {{model:string, body_bytes:number, prompt_tokens:number,
 *            bytes_per_token:number}|null} null when there is nothing to measure
 */
export function sampleTokenRatio({ model, bodyBytes, usage } = {}) {
  if (typeof model !== "string" || !model) return null;
  if (!Number.isFinite(bodyBytes) || bodyBytes <= 0) return null;
  // OpenAI shape is prompt_tokens; Anthropic Messages is input_tokens.
  //
  // Anthropic's input_tokens counts ONLY the uncached portion of the prompt;
  // prompt-cached content is reported separately in cache_read_input_tokens
  // and cache_creation_input_tokens (also present, additively, on requests
  // that write to the cache). Counting input_tokens alone on a heavily
  // cache-hit request understates the true prompt size by orders of
  // magnitude (e.g. 500 reported vs. 200000 actual bytes), which inflates
  // bytes_per_token by the same factor. Sum all three so the sample reflects
  // the full prompt regardless of how much of it was cached. Fields absent
  // from usage (OpenAI responses, or Anthropic responses with no caching)
  // contribute 0, so this is a strict superset of the old behavior.
  const base = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  const cacheRead = Number(usage?.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(usage?.cache_creation_input_tokens ?? 0);
  const tokens = (Number.isFinite(base) ? base : 0)
    + (Number.isFinite(cacheRead) ? cacheRead : 0)
    + (Number.isFinite(cacheWrite) ? cacheWrite : 0);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  return {
    model,
    body_bytes: bodyBytes,
    prompt_tokens: tokens,
    bytes_per_token: bodyBytes / tokens,
  };
}
