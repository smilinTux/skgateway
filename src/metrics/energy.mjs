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
  // A meter that has never observed a sample has no power source on that node.
  // It reports metering "unavailable" and omits counter_j precisely so this
  // cannot be read as a measured zero. Treat it as unknowable, not as free.
  // Found by deploying skmeter to a node with no GPU: the old payload sent
  // counter_j 0.0, the delta came out 0, and real work was recorded as
  // joules 0 with basis measured_gpu.
  if (before.metering === "unavailable" || after.metering === "unavailable") {
    return null;
  }
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
/**
 * ENERGY ANCHOR, and where every derived number comes from.
 *
 * Measured on 2026-08-15, node .100, NVIDIA RTX 5060 Ti, ornith-1.0-9b served
 * by llama-server: 600 output tokens cost 1713 J marginal (idle baseline
 * 8.96 W subtracted), which is 2.85 J per output token. Re-run it with
 * scripts/skmeter-validate.sh in skcapstone; the gate reproduces the figure.
 *
 *   2.85 J/token / 9B params = 0.317 J per token per billion params
 *
 * That is a consumer card. Datacenter accelerators are meaningfully more
 * efficient per token, so cloud is discounted by DATACENTER_EFFICIENCY. The
 * discount is the single softest number here and it is a judgment call, not a
 * measurement; it is isolated as one constant so it can be corrected in one
 * place when better data arrives.
 *
 * Sanity check: the commonly cited "0.3 Wh per query" works out near 2 J per
 * token for a typical response, which sits beside our measured 2.85. Model
 * size and datacenter efficiency roughly cancel for mid-size models, so the
 * anchor is not wildly off.
 *
 * KNOWN UNCERTAINTY, roughly 3x either way. Do not present these as precise:
 *   - the anchor model is NVFP4 quantized; quantization changes energy a lot
 *   - batching, which a busy provider does and we did not
 *   - MoE routing overhead beyond raw active-parameter count
 *   - prefill vs decode split (see INPUT_TOKEN_RATIO)
 * Any aggregate mixing measured and imputed rows must report the mix, per
 * spec 4.2. `energy_log.basis` is what makes that possible.
 */
export const MEASURED_J_PER_TOKEN_PER_B = 0.317;
export const DATACENTER_EFFICIENCY = 3.0;
export const CLOUD_J_PER_TOKEN_PER_B = MEASURED_J_PER_TOKEN_PER_B / DATACENTER_EFFICIENCY;

/**
 * Prefill is far cheaper per token than decode: it is parallel across the
 * prompt, where decode is sequential and memory-bandwidth bound. A tenth is a
 * documented estimate, not a measurement. Note our own anchor folded a short
 * 51-token prompt into the output figure, so for long prompts this
 * under-counts rather than over-counts.
 */
export const INPUT_TOKEN_RATIO = 0.1;

/**
 * Pull parameter counts out of a model id.
 *
 * Most ids in this fleet carry their own size: "-9b", "-70b", "-30b-a3b",
 * "-550b-a55b", "122b-a10b". The "aNNb" suffix is the ACTIVE parameter count
 * of a mixture-of-experts model, and compute (therefore energy) tracks active
 * params, not total. A static coefficient table would go stale immediately
 * here because discovery keeps adding free models, so deriving from the id is
 * what keeps this honest without hand maintenance.
 *
 * @returns {{total_b:number, active_b:number}|null} null when unparseable,
 *   which is deliberate: an unknown size yields no estimate rather than a
 *   guessed one.
 */
export function paramsFromModelId(model) {
  if (!model || typeof model !== 'string') return null;
  const id = model.toLowerCase();
  // active params first: "-a17b", "-a3b"
  const active = id.match(/[-_]a(\d+(?:\.\d+)?)b(?![a-z0-9])/);
  // total params: the LAST plain "<n>b" that is not the active marker
  const totals = [...id.matchAll(/(?:^|[-_/])(\d+(?:\.\d+)?)b(?![a-z0-9])/g)];
  if (!totals.length) return null;
  const total_b = parseFloat(totals[totals.length - 1][1]);
  if (!Number.isFinite(total_b) || total_b <= 0) return null;
  const active_b = active ? parseFloat(active[1]) : total_b;
  if (!Number.isFinite(active_b) || active_b <= 0) return null;
  return { total_b, active_b: Math.min(active_b, total_b) };
}

/**
 * Derive per-token coefficients for a model whose id encodes its size.
 * Returns null when the size cannot be read, so the ledger records "unknown"
 * rather than an invented number.
 */
export function derivedCoeffs(model, jPerTokenPerB = CLOUD_J_PER_TOKEN_PER_B) {
  const p = paramsFromModelId(model);
  if (!p) return null;
  const out = p.active_b * jPerTokenPerB;
  return {
    j_per_output_token: out,
    j_per_input_token: out * INPUT_TOKEN_RATIO,
    basis_note: `derived from ${p.active_b}B active params`,
  };
}

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
  // A curated entry always wins. Only when none matches do we derive from the
  // parameter count encoded in the id, which is what keeps a fleet that
  // discovers new free models continuously from filling up with null rows.
  return best ?? derivedCoeffs(model);
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
