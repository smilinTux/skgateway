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
 * Exact-then-prefix lookup, mirroring getPricing() in src/config.mjs.
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
