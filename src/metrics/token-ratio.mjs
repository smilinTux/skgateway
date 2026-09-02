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
  const tokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  return {
    model,
    body_bytes: bodyBytes,
    prompt_tokens: tokens,
    bytes_per_token: bodyBytes / tokens,
  };
}
