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
 *
 * Ordered oldest-verified-first (never-verified ids sort before any
 * previously-verified one) so a budget-limited sweep works through the true
 * long tail before repeating anyone; ties break on id for determinism. Pure,
 * synchronous, no I/O.
 *
 * @param {Record<string, object>} store
 * @param {{budget?: number, now: number, trafficWindowMs?: number, provider?: string}} opts
 * @returns {string[]}
 */
export function selectProbeCandidates(
  store,
  { budget = DEFAULT_PROBE_BUDGET, now, trafficWindowMs = DEFAULT_TRAFFIC_WINDOW_MS, provider } = {},
) {
  if (!(budget > 0)) return [];

  const entries = Object.entries(store || {})
    .filter(([, lc]) => lc && lc.state !== LIFECYCLE_STATES.DEAD)
    .filter(([, lc]) => (provider ? lc.provider === provider : true))
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
 * (`pool.acquire(backendId)` / `pool.release(backendId)`, mirroring
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
 * @param {Record<string, object>} store
 * @param {object} opts
 * @param {number} [opts.budget]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.trafficWindowMs]
 * @param {string} [opts.provider]
 * @param {{acquire: Function, release: Function}} [opts.pool]
 * @param {string} [opts.poolBackendId]
 * @param {number|(() => number)} [opts.now]
 * @param {(id: string, o: {timeoutMs: number, maxTokens: number}) => Promise<{ok: boolean, status?: number}>} [opts.runProbe]
 * @returns {Promise<Record<string, object>>} a NEW store map; entries not
 *   selected this sweep are carried over unchanged, selected entries carry
 *   their post-probe lifecycle record.
 */
export async function probeModels(store, opts = {}) {
  const {
    budget = DEFAULT_PROBE_BUDGET,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    maxTokens = DEFAULT_MAX_TOKENS,
    trafficWindowMs = DEFAULT_TRAFFIC_WINDOW_MS,
    provider,
    pool,
    poolBackendId = DEFAULT_POOL_BACKEND_ID,
    now = Date.now,
    runProbe,
  } = opts;

  const safeStore = store || {};
  const nowMs = typeof now === 'function' ? now() : now;

  if (typeof runProbe !== 'function') {
    return { ...safeStore };
  }

  const candidates = selectProbeCandidates(safeStore, { budget, now: nowMs, trafficWindowMs, provider });
  if (candidates.length === 0) {
    return { ...safeStore };
  }

  const next = { ...safeStore };
  const canPool = pool && typeof pool.acquire === 'function' && typeof pool.release === 'function';

  await Promise.all(
    candidates.map(async (id) => {
      if (canPool) {
        try {
          await pool.acquire(poolBackendId);
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
        next[id] = applyProbeOutcome(lc, {
          ok: Boolean(outcome && outcome.ok),
          status: outcome && outcome.status,
          now: nowMs,
        });
      } finally {
        if (canPool) pool.release(poolBackendId);
      }
    }),
  );

  return next;
}
