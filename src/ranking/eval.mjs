/**
 * eval.mjs (card P3.5): the on-demand micro-eval harness.
 *
 * The BATTERY is not here. It already existed in
 * `src/discovery/capability-assessment.mjs` (card C9's measurement half:
 * tool_call, structured_output, instruction_following, min_output_tokens, all
 * graded by deterministic string/shape match, never LLM-judged). Duplicating
 * it here would have given this fleet two definitions of "can it hold a tool
 * call", which is exactly the drift card C7 was written to stop.
 *
 * What was missing was everything AROUND it, and the absence was total:
 *
 *   1. probe.mjs takes `chatComplete` as an injected option and silently
 *      disables tier 2 when it is absent. No production caller ever passed
 *      one, so the battery had never produced a single fact on this node.
 *   2. `deriveToolUse()` read only the provider card, so even a measured
 *      result would not have reached `capabilities.tool_use`, which is what
 *      rank.mjs and resolveBucket's tool gate consume. The evidence channel
 *      was write-only.
 *
 * This module closes both: a real loopback `chatComplete`, an explicit
 * single-model entry point, and persistence onto the lifecycle record that
 * `catalog.mjs` now threads back into the capability vector as `basis:'eval'`.
 *
 * DELIBERATELY NOT AUTOMATIC. Nothing here is wired to the refresh loop or the
 * hot path (design 6.3: "Never runs in the hot path or refresh loop"). It runs
 * when an operator asks, via `POST /admin/models/eval?model=...`. Real
 * completions cost real tokens and real latency; making that implicit is how a
 * smoke test quietly becomes a benchmark nobody authorised.
 *
 * @module ranking/eval
 */

import {
  runCapabilityAssessment,
  applyCapabilityMeasurement,
  DEFAULT_CAPABILITY_TIMEOUT_MS,
} from '../discovery/capability-assessment.mjs';
import {
  getLifecycle,
  recordCapabilityMeasurement,
  STORE_PATH,
} from '../discovery/model_catalog_store.mjs';

/** Sovereignty tiers this harness is allowed to spend completions against. */
export const EVAL_ELIGIBLE_TIERS = Object.freeze(['local', 'free-remote']);

/**
 * May we run a battery against this model?
 *
 * Design 6.3 scopes the harness to "free/local models only". An UNKNOWN tier
 * is not eligible: the whole point of this module is to stop treating absence
 * of information as a fact, and billing someone's paid account to find out
 * would be the most expensive possible way to repeat that mistake.
 *
 * @param {{capabilities?: {sovereignty?: string}}|null} entry catalog entry
 * @returns {boolean}
 */
export function isEvalEligible(entry) {
  const tier = entry?.capabilities?.sovereignty;
  return EVAL_ELIGIBLE_TIERS.includes(tier);
}

/**
 * Build a `chatComplete` that runs the battery THROUGH THIS GATEWAY.
 *
 * Going through the proxy rather than straight to a provider is the point: it
 * exercises the same auth, routing, tool plumbing and sanitizer the real
 * traffic uses, so a pass means "this model works here", not "this model works
 * somewhere". A transport failure is returned, never thrown, because
 * `classifyTransport()` distinguishes a 429 or a timeout (unmeasured, no
 * conclusion drawn) from a 4xx rejection (a real fail), and that distinction
 * is lost if the call blows up instead.
 *
 * @param {{port?: number, host?: string, fetchImpl?: Function}} [opts]
 * @returns {(id: string, req: object, o?: {timeoutMs?: number}) => Promise<{ok: boolean, status: number|null, json: object|null}>}
 */
export function createLoopbackChatComplete({ port = 18780, host = '127.0.0.1', fetchImpl = fetch } = {}) {
  return async function loopbackChatComplete(id, req, { timeoutMs = DEFAULT_CAPABILITY_TIMEOUT_MS } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`http://${host}:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...req, model: id }),
        signal: ac.signal,
      });
      let json = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      return { ok: res.ok, status: res.status, json };
    } catch {
      // Aborted or network-level failure. `status: null` is what
      // classifyTransport() reads as 'timeout_or_network' -> unmeasured.
      return { ok: false, status: null, json: null };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Run the full battery against one model and persist the result.
 *
 * Merges onto whatever was measured before rather than replacing it, so a run
 * that could only determine some assertions (a 429 mid-battery) keeps the
 * earlier determinate values instead of erasing them; that merge rule lives in
 * `applyCapabilityMeasurement`, not here.
 *
 * @param {string} modelId
 * @param {object} [opts]
 * @param {Function} [opts.chatComplete] injected runner (defaults to loopback)
 * @param {string} [opts.storePath] lifecycle store path
 * @param {number} [opts.timeoutMs]
 * @param {number|(() => number)} [opts.now]
 * @returns {Promise<{model: string, measured_capabilities: object}>}
 */
export async function runModelEval(modelId, opts = {}) {
  if (!modelId) throw new Error('runModelEval: modelId is required');
  const {
    chatComplete = createLoopbackChatComplete(),
    storePath = STORE_PATH,
    timeoutMs = DEFAULT_CAPABILITY_TIMEOUT_MS,
    now = Date.now,
  } = opts;

  const nowMs = typeof now === 'function' ? now() : now;
  const battery = await runCapabilityAssessment(modelId, { chatComplete, timeoutMs, now: nowMs });

  const prev = getLifecycle(modelId, storePath)?.measured_capabilities;
  const merged = applyCapabilityMeasurement(prev, battery, { now: nowMs, full: true });
  recordCapabilityMeasurement(modelId, merged, storePath);

  return { model: modelId, measured_capabilities: merged };
}
