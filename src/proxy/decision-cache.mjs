/**
 * decision-cache.mjs — tiny TTL + LRU cache for sk-auto routing decisions.
 *
 * The sk-auto router classifies each request (heuristic now; a small-LLM tier
 * later — see the cascade roadmap). Identical/repeated prompts should not be
 * re-assessed every time. This caches the resolved decision keyed by a cheap
 * fingerprint of the request text + a config epoch, so a registry `auto:` edit
 * (which bumps the epoch) transparently invalidates every entry.
 *
 * Cheap by design: FNV-1a fingerprint, Map-based LRU (insertion-order eviction
 * with get-touch), lazy TTL expiry. No deps.
 *
 * @module decision-cache
 */

/** FNV-1a 32-bit hash of a string → 8-char hex. Fast, non-crypto (cache key only). */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Build a decision-cache key for a chat request. The routing decision depends on
 * the USER-ask text (signal/keyword scoring) and the TOTAL prompt size (context
 * guard), plus the active config epoch — so the key folds all three.
 *
 * @param {Array<{role?:string, content?:*}>} messages
 * @param {number|string} epoch  Config epoch (e.g. registry mtime).
 * @returns {string}
 */
export function decisionKey(messages, epoch) {
  const msgs = Array.isArray(messages) ? messages : [];
  let userLen = 0;
  let totalLen = 0;
  const userParts = [];
  for (const m of msgs) {
    if (!m) continue;
    const c = m.content;
    let t = "";
    if (typeof c === "string") t = c;
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (typeof p === "string") t += p;
        else if (p && typeof p.text === "string") t += p.text;
      }
    }
    totalLen += t.length;
    if (m.role === "user") { userParts.push(t); userLen += t.length; }
  }
  // Fingerprint the user text (drives scoring); bucket total size (drives the
  // context guard) so near-identical sizes share an entry.
  return `${epoch}:${totalLen}:${userLen}:${fnv1a(userParts.join("\n"))}`;
}

/**
 * @param {{ttlMs?:number, maxEntries?:number}} [opts]
 * @returns {{get:Function, set:Function, size:number, hits:number, misses:number, clear:Function}}
 */
export function createDecisionCache({ ttlMs = 60_000, maxEntries = 500 } = {}) {
  /** @type {Map<string,{value:any, exp:number}>} */
  const map = new Map();
  let hits = 0;
  let misses = 0;

  return {
    /** @returns {any|null} */
    get(key) {
      const e = map.get(key);
      if (!e) { misses++; return null; }
      if (e.exp < Date.now()) { map.delete(key); misses++; return null; }
      // LRU touch: re-insert so it becomes most-recently-used.
      map.delete(key);
      map.set(key, e);
      hits++;
      return e.value;
    },
    /** @param {string} key @param {any} value @param {number} [ttl] */
    set(key, value, ttl) {
      const life = typeof ttl === "number" && ttl > 0 ? ttl : ttlMs;
      map.set(key, { value, exp: Date.now() + life });
      if (map.size > maxEntries) {
        // Evict the oldest (first inserted / least-recently-used).
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    },
    get size() { return map.size; },
    get hits() { return hits; },
    get misses() { return misses; },
    clear() { map.clear(); hits = 0; misses = 0; },
  };
}
