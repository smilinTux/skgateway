/**
 * embedders/mxbai.mjs — mxbai-embed-large adapter for the semantic cache.
 *
 * mxbai-embed-large is the live default embedder across the SK stack (dim 1024).
 * Served OpenAI /v1/embeddings-style at http://192.168.0.100:11438/v1/embeddings.
 * Returns an async `embed(text) => number[]` for createSemanticCache().
 *
 * @module embedders/mxbai
 */

/**
 * @param {object} [opts]
 * @param {string} [opts.url]        Embeddings endpoint (OpenAI /v1/embeddings shape).
 * @param {string} [opts.model]      Model id.
 * @param {number} [opts.timeoutMs]  Per-call timeout.
 * @param {number} [opts.maxChars]   Truncate input (mxbai ctx ~512 tok ≈ 1100 chars).
 * @returns {(text:string)=>Promise<number[]>}
 */
export function createMxbaiEmbedder({
  url = "http://192.168.0.100:11438/v1/embeddings",
  model = "mxbai-embed-large",
  timeoutMs = 5000,
  maxChars = 1100,
} = {}) {
  return async function embed(text) {
    const input = String(text || "").slice(0, maxChars);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`mxbai embed ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const j = await res.json();
    const vec = j?.data?.[0]?.embedding;
    if (!Array.isArray(vec)) throw new Error("mxbai embed: no embedding in response");
    return vec;
  };
}
