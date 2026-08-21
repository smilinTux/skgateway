/**
 * probe.mjs: EOL probe sweep (card P2.3, design doc
 * docs/specs/2026-08-08-model-ranking-routing-intelligence-arch.md, section
 * 5.2). Automates the manual "warm one-word probe" prune Chef previously did
 * by hand with curl.
 *
 * Off the request path, budgeted, and rate-limited: only models with no live
 * traffic in `trafficWindowMs` (default 7 days, judged by lifecycle.mjs's
 * `last_verified_at`, the same field completion outcomes and catalog
 * reappearance already keep fresh for actively-used models) are probed, at
 * most `budget` (default ~20) per sweep, through the caller's connection
 * pool so a sweep can never exceed the NVIDIA 20-concurrent limit alongside
 * live traffic. Every outcome feeds `lifecycle.applyProbeOutcome` so a 410
 * flips the model `eol`, a 400 flips it `not_chat` (card f9e8002b / C14: the
 * probe sends a minimal well-formed chat completion, so a 400 is evidence
 * about the model, not the request), a 429 leaves it untouched (alive and
 * throttled, card 9e28de88), and a successful probe records
 * `last_verified_at` and promotes toward `active` regardless of which of
 * those dispositions it was in before, exactly like every other lifecycle
 * signal in this codebase.
 *
 * Pure-ish and fully injectable for testing: `runProbe` (the actual
 * completion call) and `pool` (concurrency gate) are both passed in, so
 * `probeModels()` never touches the network itself and unit tests never
 * need a live endpoint. Production wiring (src/discovery.mjs) supplies the
 * real implementations.
 *
 * @module discovery/probe
 */

import { defaultLifecycle, applyProbeOutcome, LIFECYCLE_STATES } from './lifecycle.mjs';
import {
  livenessFromProbeOutcome,
  applyCapabilityMeasurement,
  runCapabilityAssessment,
  selectCapabilityCandidates,
  DEFAULT_CAPABILITY_BUDGET,
  DEFAULT_CAPABILITY_INTERVAL_MS,
  DEFAULT_CAPABILITY_TIMEOUT_MS,
} from './capability-assessment.mjs';

/** Default cap on probes per sweep (design 5.2: "max ~20/cycle"). */
export const DEFAULT_PROBE_BUDGET = 20;

/** Default per-probe timeout (design 5.2: "15s timeout"). */
export const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

/** Default long-tail window: only probe models with no live traffic in 7 days. */
export const DEFAULT_TRAFFIC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Default probe completion size (design 5.2: "one-word max_tokens: 4 completion"). */
export const DEFAULT_MAX_TOKENS = 4;

/** Default connection-pool bucket the sweep acquires against (NVIDIA's 20-concurrent limit). */
export const DEFAULT_POOL_BACKEND_ID = 'nvidia';

/** Default sweep cadence: once a day (design 5.2: "default daily"). `0` disables the sweep. */
export const DEFAULT_PROBE_SECONDS = 24 * 60 * 60;

/**
 * Select up to `budget` long-tail model ids from `store` (a plain map of
 * model id -> lifecycle record, the same shape `model_catalog_store.mjs` and
 * `discovery.mjs`'s `reconcilePresence()` already use) that are eligible for
 * a probe this sweep:
 *
 * - No live traffic within `trafficWindowMs`: `last_verified_at` is `null`
 *   (never verified) or older than the window. `last_verified_at` is set by
 *   any 2xx completion (router.mjs -> `recordModelOutcome`), catalog
 *   reappearance, or a prior successful probe, so this is exactly "nobody
 *   has routed to (or successfully probed) this model recently".
 * - Never `dead`: a tombstone is only revived by catalog reappearance
 *   (`lifecycle.applyCatalogPresence`), not by a probe; spending sweep
 *   budget re-probing a 30-day-confirmed-dead id would starve the actual
 *   long tail of its share of the budget for no operational benefit.
 *   `not_chat` (card f9e8002b / C14) is deliberately NOT excluded here the
 *   way `dead` is: unlike a tombstone, it is only ever cleared by another
 *   probe (`lifecycle.applyProbeOutcome`'s `ok` branch), so a not_chat id
 *   must stay eligible for reselection or it could never recover.
 * - Optionally scoped to one `provider` (the production sweep is NVIDIA-only
 *   per design 5.2, since it must go through the NVIDIA connection pool;
 *   left generic here so tests, and any future multi-provider sweep, are not
 *   hardcoded to one provider name).
 * - `excludedIds` (a Set, incident inc-2026-08-18-qwen38-eol / problem
 *   prob-2026-08-18-model-discovery-validation): ids another backend
 *   DECLARES are excluded from this provider's sweep. The sweep's probes hit
 *   ONE provider's endpoint, so a 410 from that provider is evidence about
 *   THAT provider only; a model a different backend claims and serves (a
 *   local llama.cpp alias, or a multi-provider id still live on the other
 *   provider) must not be retired on one provider's say-so — "only EOL if
 *   ALL providers fail". Production computes the set from the config (see
 *   `declaredModelsElsewhere()` in discovery.mjs); left generic here so
 *   tests inject it directly.
 *
 * Ordered oldest-verified-first (never-verified ids sort before any
 * previously-verified one) so a budget-limited sweep works through the true
 * long tail before repeating anyone; ties break on id for determinism. Pure,
 * synchronous, no I/O.
 *
 * @param {Record<string, object>} store
 * @param {{budget?: number, now: number, trafficWindowMs?: number, provider?: string, excludedIds?: Set<string>}} opts
 * @returns {string[]}
 */
export function selectProbeCandidates(
  store,
  { budget = DEFAULT_PROBE_BUDGET, now, trafficWindowMs = DEFAULT_TRAFFIC_WINDOW_MS, provider, excludedIds } = {},
) {
  if (!(budget > 0)) return [];

  const entries = Object.entries(store || {})
    .filter(([, lc]) => lc && lc.state !== LIFECYCLE_STATES.DEAD)
    .filter(([, lc]) => (provider ? lc.provider === provider : true))
    .filter(([id]) => !excludedIds || !excludedIds.has(id))
    .filter(([, lc]) => {
      const lastVerified = lc.last_verified_at;
      return lastVerified == null || now - lastVerified >= trafficWindowMs;
    })
    .sort((a, b) => {
      const av = a[1].last_verified_at;
      const bv = b[1].last_verified_at;
      if (av == null && bv == null) return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
      if (av == null) return -1;
      if (bv == null) return 1;
      if (av !== bv) return av - bv;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

  return entries.slice(0, budget).map(([id]) => id);
}

/**
 * Run one probe sweep: select long-tail candidates (`selectProbeCandidates`),
 * run a one-word completion for each through the injected pool, and fold
 * every outcome into that model's lifecycle via `lifecycle.applyProbeOutcome`.
 *
 * `runProbe(id, {timeoutMs, maxTokens}) -> Promise<{ok:boolean, status?:number}>`
 * is the actual completion call. It is required to do anything: with no
 * `runProbe` supplied (or a `budget`/selection of zero candidates), this is a
 * no-op that returns `store` unchanged. The disable path (`probe_seconds: 0`
 * at the caller) short-circuits before ever reaching here, but this function
 * is safe to call with nothing wired up regardless.
 *
 * `pool` gates concurrency the same way the router already does
 * (`ticket = pool.acquire(backendId)` / `pool.release(ticket)`, mirroring
 * src/proxy/connection-pool.mjs) so a sweep can never fan out past the
 * pool's concurrency limit alongside live traffic. A pool is optional (tests
 * may omit it); when present, a failed `acquire` (queue full/timeout) skips
 * that id for this sweep rather than probing unbounded: it is retried next
 * cycle, and a pool failure is never treated as evidence the model is dead.
 *
 * Never throws: a `runProbe` rejection is treated as a failed (non-410)
 * probe outcome, which, per `applyProbeOutcome`, only demotes an `active`
 * model to `suspect` and never escalates a model that already needs
 * investigation.
 *
 * MEASUREMENT (card 2ba73bf9 / C9, "MEMBERSHIP IS MEASURED, NOT DECLARED"):
 * this sweep is also where the capability battery rides, exactly as the card
 * requires ("ride the existing probe sweep, do not build a second
 * scheduler"). Two tiers, both bolted onto the SAME per-candidate loop below
 * rather than a separate pass, so a capability battery never draws an extra
 * pool slot beyond what the liveness probe already acquired for that id:
 *
 *   Tier 1 (cheap, every eligible candidate, unchanged cost): the existing
 *   one-word liveness probe above. Its outcome is now ALSO folded into
 *   `measured_capabilities.liveness` on the same lifecycle record
 *   (livenessFromProbeOutcome), at zero extra network cost.
 *
 *   Tier 2 (expensive, rare): a full tool-calling / structured-output /
 *   instruction-following / min-output-tokens battery
 *   (capability-assessment.mjs's runCapabilityAssessment), gated three ways
 *   so it can never dominate the shared budget real traffic also draws from:
 *     - only offered `runCapabilityAssessment` is supplied (undefined by
 *       default, same opt-in discipline as `runProbe`);
 *     - only for ids selected by `selectCapabilityCandidates` out of this
 *       sweep's OWN tier-1 candidate list (never a superset): first sighting
 *       (no `measured_capabilities` at all) is always eligible, an
 *       already-assessed id is only due again after `capabilityIntervalMs`
 *       (default 30 days, rare), and both are capped by `capabilityBudget`
 *       (default 3, small on purpose: up to 7 sequential calls per model
 *       versus the liveness probe's 1);
 *     - only when this sweep's liveness probe for that id actually
 *       succeeded: there is no reason to spend a multi-call battery probing
 *       capability detail on a model tier 1 just found dead or throttled.
 *   A 429 anywhere inside the battery aborts the REST of the battery for
 *   that model immediately (see runCapabilityAssessment's doc comment):
 *   free-tier throttling is shared across a model's endpoints, so continuing
 *   to probe would almost certainly just collect more 429s while spending
 *   real budget, exactly the "measuring costs the same scarce resource as
 *   using" failure the card calls out (two of seven free models hit
 *   FreeUsageLimitError from capability probing alone on 2026-08-14).
 *
 * @param {Record<string, object>} store
 * @param {object} opts
 * @param {number} [opts.budget]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.trafficWindowMs]
 * @param {string} [opts.provider]
 * @param {Set<string>} [opts.excludedIds] ids claimed by another backend,
 *   excluded from this provider's sweep (see selectProbeCandidates' doc).
 * @param {{acquire: Function, release: Function}} [opts.pool]
 * @param {string} [opts.poolBackendId]
 * @param {number|(() => number)} [opts.now]
 * @param {(id: string, o: {timeoutMs: number, maxTokens: number}) => Promise<{ok: boolean, status?: number}>} [opts.runProbe]
 * @param {(id: string, o: {chatComplete: Function, timeoutMs: number, now: number|(() => number)}) => Promise<object>} [opts.runCapabilityAssessment]
 *   Tier-2 battery runner (capability-assessment.mjs's `runCapabilityAssessment`
 *   by default when `chatComplete` is supplied; pass a different function to
 *   fully stub tier 2 in tests). Undefined/no `chatComplete` disables tier 2
 *   entirely: tier 1 (liveness) is unaffected either way.
 * @param {(id: string, req: object, o: {timeoutMs?: number}) => Promise<object>} [opts.chatComplete]
 *   The actual network call tier 2's assertions issue. Required to run tier 2
 *   at all; production has no default (mirrors `runProbe`/`nvidiaFetch`
 *   elsewhere in this codebase: every real call site must supply one, no
 *   silent network default for something this budget-sensitive).
 * @param {number} [opts.capabilityBudget]
 * @param {number} [opts.capabilityIntervalMs]
 * @param {number} [opts.capabilityTimeoutMs]
 * @returns {Promise<Record<string, object>>} a NEW store map; entries not
 *   selected this sweep are carried over unchanged, selected entries carry
 *   their post-probe lifecycle record plus an updated `measured_capabilities`.
 */
export async function probeModels(store, opts = {}) {
  const {
    budget = DEFAULT_PROBE_BUDGET,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    maxTokens = DEFAULT_MAX_TOKENS,
    trafficWindowMs = DEFAULT_TRAFFIC_WINDOW_MS,
    provider,
    excludedIds,
    pool,
    poolBackendId = DEFAULT_POOL_BACKEND_ID,
    now = Date.now,
    runProbe,
    chatComplete,
    runCapabilityAssessment: runCapabilityAssessmentOpt,
    capabilityBudget = DEFAULT_CAPABILITY_BUDGET,
    capabilityIntervalMs = DEFAULT_CAPABILITY_INTERVAL_MS,
    capabilityTimeoutMs = DEFAULT_CAPABILITY_TIMEOUT_MS,
  } = opts;

  const safeStore = store || {};
  const nowMs = typeof now === 'function' ? now() : now;

  if (typeof runProbe !== 'function') {
    return { ...safeStore };
  }

  const candidates = selectProbeCandidates(safeStore, { budget, now: nowMs, trafficWindowMs, provider, excludedIds });
  if (candidates.length === 0) {
    return { ...safeStore };
  }

  const assessBattery = typeof chatComplete === 'function'
    ? (runCapabilityAssessmentOpt || runCapabilityAssessment)
    : null;
  const capabilityIds = assessBattery
    ? new Set(selectCapabilityCandidates(safeStore, candidates, { budget: capabilityBudget, now: nowMs, intervalMs: capabilityIntervalMs }))
    : new Set();

  const next = { ...safeStore };
  const canPool = pool && typeof pool.acquire === 'function' && typeof pool.release === 'function';

  await Promise.all(
    candidates.map(async (id) => {
      let poolTicket = null;
      if (canPool) {
        try {
          poolTicket = await pool.acquire(poolBackendId);
        } catch {
          // Pool exhausted or queue timeout: not evidence the model is
          // dead, just skip it this sweep and let it come back up next time.
          return;
        }
      }
      try {
        let outcome;
        try {
          outcome = await runProbe(id, { timeoutMs, maxTokens });
        } catch {
          outcome = { ok: false };
        }
        const lc = safeStore[id] || defaultLifecycle();
        const probedLc = applyProbeOutcome(lc, {
          ok: Boolean(outcome && outcome.ok),
          status: outcome && outcome.status,
          now: nowMs,
        });

        let capRecord = applyCapabilityMeasurement(
          lc.measured_capabilities,
          { liveness: livenessFromProbeOutcome(outcome, nowMs) },
          { now: nowMs },
        );

        if (assessBattery && capabilityIds.has(id) && outcome && outcome.ok) {
          try {
            const battery = await assessBattery(id, { chatComplete, timeoutMs: capabilityTimeoutMs, now: nowMs });
            capRecord = applyCapabilityMeasurement(capRecord, battery, { now: nowMs, full: true });
          } catch {
            // A battery-level throw (a bug in the injected chatComplete, an
            // uncaught rejection): fail-soft, same discipline as runProbe's
            // own rejection handling above. Deliberately does NOT advance
            // last_full_assessment_at: nothing was actually measured, so this
            // id must stay eligible for tier 2 next sweep rather than being
            // treated as freshly assessed and going quiet for
            // capabilityIntervalMs.
          }
        }

        next[id] = { ...probedLc, measured_capabilities: capRecord };
      } finally {
        if (poolTicket) pool.release(poolTicket);
      }
    }),
  );

  return next;
}
