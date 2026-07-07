/**
 * semantic-cache.mjs — SC stage 1: the semantic-cache ENGINE (backend-agnostic).
 *
 * Recognizes when a new prompt MEANS the same as a previously-answered one (even
 * if worded differently) and returns the cached response, skipping the LLM. This
 * is the single biggest cost/latency lever for repeated/FAQ-style traffic.
 *
 * Design: the engine is decoupled from its embedder and vector store via two
 * injected interfaces, so it can be unit-tested with mocks and later backed by
 * mxbai + skmem-pg pgvector without touching this file:
 *   embed:  async (text) => number[]                       (see embedders/mxbai.mjs)
 *   store:  { search(vec, {ns, topK}) => [{response, sim}], insert({vec, ns, text, response, ttlMs}) }
 *
 * Namespace = `${agent}:${category}` → per-agent + category-aware isolation, so
 * agent A's cache never serves agent B, and a "code" answer never serves a "chat"
 * query. (Matches the roadmap: category-aware, per-agent namespace.)
 *
 * ⚠️ Stage 1 is NOT wired into the live request path. Stage 2 adds the pgvector
 * store, wires lookup/put into routeAndSend behind a config flag, and decides
 * which categories are cache-eligible (idempotent/FAQ-style only — never
 * memory-grounded conversational turns).
 *
 * @module semantic-cache
 */

/** Cosine similarity of two equal-length numeric vectors. Returns 0 on bad input. */
export function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * In-memory vector store (stage-1 default + the test backend). Cosine search
 * with namespace filtering, lazy TTL expiry, and insertion-order eviction.
 * The pgvector store (stage 2) implements the same {search, insert} contract.
 *
 * @param {{maxEntries?:number}} [opts]
 */
export function createMemoryStore({ maxEntries = 2000 } = {}) {
  /** @type {Array<{vec:number[], ns:string, text:string, response:any, exp:number}>} */
  let entries = [];

  return {
    /** @returns {Promise<Array<{response:any, text:string, sim:number}>>} */
    async search(vec, { ns, topK = 1 } = {}) {
      const now = Date.now();
      entries = entries.filter((e) => e.exp > now); // drop expired
      const scored = [];
      for (const e of entries) {
        if (e.ns !== ns) continue;
        scored.push({ response: e.response, text: e.text, sim: cosineSim(vec, e.vec) });
      }
      scored.sort((a, b) => b.sim - a.sim);
      return scored.slice(0, topK);
    },

    async insert({ vec, ns, text, response, ttlMs = 3_600_000 }) {
      entries.push({ vec, ns, text, response, exp: Date.now() + ttlMs });
      if (entries.length > maxEntries) entries.shift(); // evict oldest
    },

    get size() { return entries.length; },
    clear() { entries = []; },
  };
}

/**
 * @param {object} cfg
 * @param {(text:string)=>Promise<number[]>} cfg.embed   Embedding function.
 * @param {{search:Function, insert:Function}} cfg.store  Vector store.
 * @param {number} [cfg.threshold=0.92]   Min cosine similarity to count as a hit.
 * @param {number} [cfg.ttlMs=3600000]    Default entry TTL.
 */
export function createSemanticCache({ embed, store, threshold = 0.92, ttlMs = 3_600_000 }) {
  if (typeof embed !== "function") throw new Error("semantic-cache: embed function required");
  if (!store || typeof store.search !== "function" || typeof store.insert !== "function") {
    throw new Error("semantic-cache: store with {search, insert} required");
  }
  const ns = (agent, category) => `${agent || "default"}:${category || "default"}`;

  return {
    /**
     * @returns {Promise<{hit:boolean, response?:any, similarity?:number, matchedText?:string}>}
     */
    async lookup(text, { agent, category } = {}) {
      if (!text) return { hit: false };
      const vec = await embed(text);
      const hits = await store.search(vec, { ns: ns(agent, category), topK: 1 });
      if (hits.length && hits[0].sim >= threshold) {
        return { hit: true, response: hits[0].response, similarity: hits[0].sim, matchedText: hits[0].text };
      }
      return { hit: false, similarity: hits[0]?.sim ?? 0 };
    },

    async put(text, response, { agent, category, ttlMs: t } = {}) {
      if (!text) return;
      const vec = await embed(text);
      await store.insert({ vec, ns: ns(agent, category), text, response, ttlMs: t ?? ttlMs });
    },

    get threshold() { return threshold; },
  };
}
