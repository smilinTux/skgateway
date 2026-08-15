/**
 * Pure energy arithmetic. No I/O, no config, no clock.
 *
 * Every function here returns null rather than guessing. An energy ledger that
 * mixes measured numbers with invented ones is worse than one with gaps,
 * because the gaps are visible and the inventions are not.
 */

/**
 * Energy of the window between two meter reads.
 * @param {{counter_j:number}|null} before
 * @param {{counter_j:number}|null} after
 * @returns {number|null} joules, or null if unknowable
 */
export function marginalJoules(before, after) {
  if (!before || !after) return null;
  const a = Number(before.counter_j);
  const b = Number(after.counter_j);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const delta = b - a;
  // A counter that went backwards means the meter restarted mid-request.
  if (delta < 0) return null;
  return delta;
}

/**
 * Estimate joules from token counts for backends we cannot meter.
 * @param {{input_tokens?:number, output_tokens?:number}} tokens
 * @param {{j_per_input_token?:number, j_per_output_token?:number}|null} coeffs
 * @returns {number|null}
 */
export function imputeJoules(tokens, coeffs) {
  if (!coeffs) return null;
  const inTok = Number(tokens?.input_tokens ?? 0) || 0;
  const outTok = Number(tokens?.output_tokens ?? 0) || 0;
  const inC = Number(coeffs.j_per_input_token ?? 0) || 0;
  const outC = Number(coeffs.j_per_output_token ?? 0) || 0;
  return inTok * inC + outTok * outC;
}

/**
 * Which of the three bases produced a number. Always recorded alongside it.
 */
export function resolveBasis({ metered, backendIsLocal }) {
  if (metered) return 'measured_gpu';
  return backendIsLocal ? 'imputed_local' : 'imputed_cloud';
}

/**
 * Exact match first, then LONGEST matching prefix.
 *
 * Deliberately NOT the same rule as getPricing() in src/config.mjs, which is
 * first-match-wins over key order. Longest-prefix is the correct rule for a
 * coefficient table: with both "ornith" and "ornith-1.0-9b" configured, the
 * specific coefficient must win over the family one no matter which order the
 * YAML happened to list them in, because key order in a config file is not a
 * statement of intent. Do not "fix" this to match getPricing().
 */
export function coeffsForModel(model, table) {
  if (!table || !model) return null;
  if (Object.prototype.hasOwnProperty.call(table, model)) return table[model];
  let best = null;
  let bestLen = -1;
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = table[key];
      bestLen = key.length;
    }
  }
  return best;
}

/**
 * Find the meter endpoint for a backend.
 *
 * Backends carry no node identity (spec 4.5): BackendConfig has no hostname
 * and no node concept, and registry routing invents synthetic ids of the form
 * "reg:<backend>" that no operator would ever type into a config file. A
 * lookup on the exact backend id alone therefore misses the main routing path,
 * which is the exact traffic (sk-default) the spec's motivating incident is
 * about, and misses it SILENTLY: the request just falls through to imputation
 * while the config looks wired.
 *
 * Resolution order, first hit wins:
 *   1. the exact backend id            ("local", "reg:ornith")
 *   2. the other synthetic-id form     ("local" <-> "reg:local")
 *   3. the backend URL's host:port     ("192.168.0.100:8082")
 *   4. the backend URL's hostname      ("192.168.0.100")
 *
 * host:port before bare host, because two backends on one box (llama-server on
 * :8082, something else on :8083) may well be different devices, and the more
 * specific configured key is the one the operator meant.
 *
 * Never throws: a malformed URL costs the host-based fallbacks, nothing else.
 *
 * @param {Record<string,string>|null|undefined} meters
 * @param {string|null|undefined} backendId
 * @param {string|null|undefined} backendUrl
 * @returns {string|null}
 */
export function resolveMeterUrl(meters, backendId, backendUrl) {
  if (!meters || typeof meters !== "object") return null;
  const has = (k) => (k && Object.prototype.hasOwnProperty.call(meters, k) ? meters[k] : null);

  const exact = has(backendId);
  if (exact) return exact;

  if (backendId) {
    const alt = backendId.startsWith("reg:") ? backendId.slice(4) : `reg:${backendId}`;
    const synthetic = has(alt);
    if (synthetic) return synthetic;
  }

  if (backendUrl) {
    let u = null;
    try {
      u = new URL(backendUrl);
    } catch {
      return null;
    }
    return has(u.host) ?? has(u.hostname) ?? null;
  }
  return null;
}

/**
 * The energy rows to write for one completed request.
 *
 * Meter reads are per attempt, so writes are too. A local metered attempt that
 * burned real joules and then failed over to cloud must still get its own row:
 * dropping it means the ledger shows the failover's cost and not the cost that
 * was actually paid, which is a gap that looks like a number. energy_log
 * already permits multiple rows per req_id.
 *
 * Falls back to the single `energy` field when no per-attempt list is present,
 * so the ordinary one-attempt request keeps writing exactly one row and the
 * disabled path (neither field set) still writes none.
 *
 * @param {{energy?:object, energyAttempts?:object[]}|null|undefined} result
 * @returns {object[]}
 */
export function energyRowsFrom(result) {
  const attempts = result?.energyAttempts;
  if (Array.isArray(attempts) && attempts.length > 0) return attempts;
  return result?.energy ? [result.energy] : [];
}

/**
 * Response headers that hand a caller the energy its request cost (spec 4.5).
 *
 * Only what was actually computed. A header is ABSENT rather than empty when
 * the value is unknown, because "x-sk-energy-joules: " reads as a measurement
 * of nothing and an absent header reads as what it is: we do not know. The
 * basis header still ships when joules is null, since "we tried to meter this
 * and could not" is itself the fact a client needs to interpret the gap.
 *
 * @param {{joules?:number|null, basis?:string|null, node?:string|null}|null|undefined} energy
 * @returns {Record<string,string>}
 */
export function energyHeaders(energy) {
  if (!energy) return {};
  const out = {};
  const j = energy.joules;
  if (typeof j === "number" && Number.isFinite(j)) out["x-sk-energy-joules"] = String(j);
  if (typeof energy.basis === "string" && energy.basis) out["x-sk-energy-basis"] = energy.basis;
  if (typeof energy.node === "string" && energy.node) out["x-sk-energy-node"] = energy.node;
  return out;
}

/**
 * Extract token usage from a buffered SSE body.
 *
 * The gateway buffers streamed responses whole, but extractUsage() in
 * router.mjs JSON.parses the body and throws on SSE, so streamed requests
 * would impute zero joules and silently under-count the busiest paths.
 * Returns null rather than zero, because "no tokens" and "unknown tokens"
 * are different facts.
 *
 * @param {string|Buffer|null} body
 * @returns {{input_tokens:number, output_tokens:number}|null}
 */
export function usageFromSSE(body) {
  if (!body) return null;
  const text = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  if (!text.includes("data:")) return null;
  // Scan backwards: usage rides on the last chunk that carries it.
  const lines = text.split("\n").filter((l) => l.startsWith("data:"));
  for (let i = lines.length - 1; i >= 0; i--) {
    const payload = lines[i].slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const obj = JSON.parse(payload);
      if (obj?.usage) {
        return {
          input_tokens: Number(obj.usage.prompt_tokens ?? obj.usage.input_tokens ?? 0) || 0,
          output_tokens: Number(obj.usage.completion_tokens ?? obj.usage.output_tokens ?? 0) || 0,
        };
      }
    } catch {
      // partial or non-JSON chunk; keep scanning
    }
  }
  return null;
}

/**
 * Split metered energy across requests that shared the device in the window.
 *
 * Exact at concurrency 1, approximate above it, which spec 4.6 documents
 * rather than hides. When totals are unknown, attribute the whole amount:
 * over-attributing to one request is safer than losing the energy entirely.
 *
 * NOT YET WIRED IN. Nothing in router.mjs or index.mjs calls this. P0 only
 * records concurrency_n on the energy row so calibration can filter for
 * clean single-tenant measurements; it does not split energy across
 * overlapping tenants. This function is the primitive spec 4.6 describes,
 * kept here implemented and tested for whoever wires up that split later.
 * Do not read its presence as concurrency attribution being live today.
 *
 * @param {number} joules
 * @param {number} ownOutputTokens
 * @param {number} totalOutputTokens
 * @returns {number}
 */
export function attributeShare(joules, ownOutputTokens, totalOutputTokens) {
  const own = Number(ownOutputTokens) || 0;
  const total = Number(totalOutputTokens) || 0;
  if (total <= 0 || own <= 0) return joules;
  return joules * (own / total);
}
