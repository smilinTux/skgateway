/**
 * semantic-cache-shadow.mjs — SC stage 2, SHADOW half.
 *
 * Wraps the stage-1 engine so the live path can ask "would a cached answer have
 * matched?" and get a yes/no WITHOUT ever receiving the cached answer itself.
 * The engine's lookup() returns the response on a hit; this deliberately drops
 * it. That is the whole safety property of shadow mode, so it is enforced here,
 * in one place, rather than trusted to every call site.
 *
 * Everything is fail-open. The cache is an observer on the request path and a
 * thrown error here would turn a working request into a failed one, which is a
 * strictly worse outcome than not measuring.
 *
 * @module semantic-cache-shadow
 */
import { createSemanticCache, createMemoryStore } from "./semantic-cache.mjs";
import { createMxbaiEmbedder } from "./embedders/mxbai.mjs";

/**
 * @param {object} cfg  config.semantic_cache (see config.mjs normalizeSemanticCache)
 * @param {{emit: (evt:object)=>void, embed?: (t:string)=>Promise<number[]>,
 *          store?: object}} deps  embed/store are injected by tests
 */
export function createShadowRecorder(cfg, { emit, embed, store } = {}) {
  const eligibleSet = new Set(cfg.categories || []);
  const embedFn = embed || createMxbaiEmbedder({
    url: cfg.embed_url,
    model: cfg.embed_model,
    timeoutMs: cfg.embed_timeout_ms,
  });
  const backing = store || createMemoryStore({ maxEntries: cfg.max_entries });
  const engine = createSemanticCache({
    embed: embedFn,
    store: backing,
    threshold: cfg.threshold,
    ttlMs: (cfg.ttl_seconds ?? 3600) * 1000,
  });
  const counters = { observed: 0, wouldHit: 0, errors: 0 };

  const safeEmit = (evt) => { try { emit?.(evt); } catch { /* never break the path */ } };

  return {
    /** Is this prompt category one we are allowed to measure? */
    eligible(category) {
      return typeof category === "string" && eligibleSet.has(category);
    },

    /**
     * Record whether a cached answer WOULD have matched. Never returns the
     * cached response: shadow mode's guarantee lives on this line.
     * @returns {Promise<{hit: boolean, similarity: number, ms: number}>}
     */
    async observe({ text, agent, category } = {}) {
      const started = Date.now();
      try {
        counters.observed++;
        const res = await engine.lookup(text, { agent, category });
        const ms = Date.now() - started;
        if (res.hit) counters.wouldHit++;
        safeEmit({
          ts: new Date().toISOString(),
          event: "semantic_cache.shadow",
          hit: Boolean(res.hit),
          similarity: Number(res.similarity ?? 0),
          agent_id: agent,
          category,
          embed_ms: ms,
          observed: counters.observed,
          would_hit: counters.wouldHit,
        });
        // Deliberately drops res.response.
        return { hit: Boolean(res.hit), similarity: Number(res.similarity ?? 0), ms };
      } catch (err) {
        counters.errors++;
        safeEmit({
          ts: new Date().toISOString(),
          event: "semantic_cache.error",
          phase: "observe",
          message: String(err?.message || err).slice(0, 200),
        });
        return { hit: false, similarity: 0, ms: Date.now() - started };
      }
    },

    /** Store a completed prompt/response so later prompts can match it. */
    async record({ text, response, agent, category } = {}) {
      try {
        await engine.put(text, response, { agent, category });
      } catch (err) {
        counters.errors++;
        safeEmit({
          ts: new Date().toISOString(),
          event: "semantic_cache.error",
          phase: "record",
          message: String(err?.message || err).slice(0, 200),
        });
      }
    },

    stats() {
      return { ...counters, size: backing.size ?? 0 };
    },
  };
}
