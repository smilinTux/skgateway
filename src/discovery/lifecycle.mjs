/**
 * lifecycle.mjs — model-granular lifecycle state machine (pure).
 *
 * The model-granular shadow of the existing backend-granular health machine
 * (see docs/specs/2026-08-08-model-ranking-routing-intelligence-arch.md,
 * section 4.2). It does NOT touch backend health, and it has no I/O and no
 * clock of its own: every caller passes `now` and, where relevant, an
 * injected `thresholds` object, so these functions stay pure and testable.
 *
 * States: active -> suspect -> eol -> dead, with eol->active recovery on
 * catalog reappearance (given a prior verification) and dead->suspect
 * recovery for ids that return after the 30-day tombstone window.
 *
 * Promotion is not the mirror image of "any live signal wins": condemning a
 * record needs `eolErrorThreshold` CONSECUTIVE failures, so trusting a
 * non-active record again needs `promotionSuccessThreshold` CONSECUTIVE
 * successes (card fb747d52 / C12). A brand-new id is exempt: it starts
 * `active` in `defaultLifecycle()` and has no history to distrust, so this
 * threshold only ever gates a record that has already lost trust.
 */

export const LIFECYCLE_STATES = {
  ACTIVE: 'active',
  SUSPECT: 'suspect',
  EOL: 'eol',
  DEAD: 'dead',
};

export const THRESHOLDS = {
  // consecutive 404/410 completions before a model flips active/suspect -> eol.
  eolErrorThreshold: 3,
  // consecutive absent-from-catalog cycles before active -> suspect, per
  // provider (openrouter's free tier churns daily, so it gets more slack).
  // Card C8: opencode gets the same slack as openrouter, not more. Measured
  // 2026-08-15, 20 of 27 zero-cost models in models.dev's opencode registry
  // have already rotated out of Zen's live /v1/models (74 percent), which
  // sounds like it argues for a HIGHER threshold than openrouter's 2. It does
  // not: that 74 percent is registry-level attrition observed over an
  // unknown, possibly weeks-long window, not a measurement of how often a
  // given hourly discovery cycle sees a currently-live id blip out and back.
  // No such cycle-to-cycle flakiness was observed or claimed. Overriding on
  // an unmeasured guess would be the same mistake this epic exists to fix
  // (a hand-tuned number nobody re-derives). `default: 1` is right for a
  // stable catalog; opencode is not stable, so it inherits openrouter's
  // already-justified "churny free tier" value instead of the 1-cycle
  // default. If real operation shows single-cycle disappear/reappear
  // flapping specific to opencode, raise this with a measured number, the
  // same way openrouter's 2 was arrived at.
  absentSuspectThreshold: { default: 1, openrouter: 2, opencode: 2 },
  // consecutive absent-from-catalog cycles (total, not reset on the
  // active->suspect flip) before suspect -> eol.
  absentEolThreshold: 3,
  // consecutive real-evidence successes (a 2xx completion or, per-provider,
  // whatever the caller wires in) required before a non-active record earns
  // its way back to `active`. Mirrors eolErrorThreshold: three strikes to
  // condemn, N passes to acquit, not one. Per-provider like
  // absentSuspectThreshold, in case a noisier provider's catalog should need
  // more evidence before a comeback is trusted.
  promotionSuccessThreshold: { default: 2 },
  // how long a model stays a tombstone (eol) before it ages into dead.
  deadAfterMs: 30 * 24 * 60 * 60 * 1000,
};

/** A fresh lifecycle record for a newly-seen model id. */
export function defaultLifecycle() {
  return {
    state: LIFECYCLE_STATES.ACTIVE,
    last_verified_at: null,
    consecutive_permanent_errors: 0,
    consecutive_successes: 0,
    absent_cycles: 0,
    eol_reason: null,
    eol_at: null,
  };
}

/**
 * Feed the outcome of an actual completion request for this model.
 *
 * A 404/410 is a permanent-error signal: after `eolErrorThreshold`
 * consecutive occurrences, flip to eol. A 2xx is a live signal, but it is
 * graded by how much trust the record has already lost (card fb747d52 / C12):
 *
 *   - Already `active`: a first-sighting id, or one that never lost trust,
 *     is not held back. It stays active. But a lone 2xx does NOT erase an
 *     in-progress error streak either (see below); that is what let an
 *     intermittently-succeeding model dodge `eolErrorThreshold` forever.
 *   - Not `active` (suspect/eol/dead): one success is not enough to re-earn
 *     full trust. It moves the record to `suspect` (still routable, flagged,
 *     the same state catalog presence already uses for weak evidence) and
 *     only flips to `active` once `promotionSuccessThreshold` consecutive
 *     2xx responses have landed.
 *
 * `consecutive_permanent_errors` is only cleared to 0 once the SAME
 * `promotionSuccessThreshold` run of consecutive successes is reached, never
 * by a single 2xx. The threshold that erases the error streak is the same
 * threshold that earns promotion, on purpose: whatever is strong enough to
 * trust the model again is also strong enough to forgive its past failures,
 * and nothing weaker is.
 *
 * A 404/410 breaks any in-progress success streak back to 0 (it is direct
 * counter-evidence), and a 2xx breaks any in-progress error streak's
 * decisive-clear countdown the same way (each failure interrupts the run).
 *
 * Any other status (429 included, see card 9e28de88: free tiers rate-limit
 * constantly and a 429 says nothing about whether the model works; backend
 * failures are handled by the separate backend-health machine) is not a
 * lifecycle signal and leaves the record, and both counters, untouched.
 */
export function applyCompletionOutcome(lc, { status, now, provider, thresholds = THRESHOLDS }) {
  const promotionThreshold =
    thresholds.promotionSuccessThreshold[provider] ?? thresholds.promotionSuccessThreshold.default;

  if (status >= 200 && status < 300) {
    const consecutive_successes = (lc.consecutive_successes || 0) + 1;
    const earnedClear = consecutive_successes >= promotionThreshold;

    if (lc.state === LIFECYCLE_STATES.ACTIVE) {
      // eol_reason/eol_at are already null on an active record (only an
      // eol transition sets them), so nothing to clear here beyond the
      // error counter itself.
      return {
        ...lc,
        state: LIFECYCLE_STATES.ACTIVE,
        consecutive_successes,
        consecutive_permanent_errors: earnedClear ? 0 : lc.consecutive_permanent_errors,
        last_verified_at: now,
      };
    }

    if (earnedClear) {
      return {
        ...lc,
        state: LIFECYCLE_STATES.ACTIVE,
        consecutive_successes,
        consecutive_permanent_errors: 0,
        eol_reason: null,
        eol_at: null,
        last_verified_at: now,
      };
    }

    return {
      ...lc,
      state: LIFECYCLE_STATES.SUSPECT,
      consecutive_successes,
      last_verified_at: now,
    };
  }

  if (status === 404 || status === 410) {
    const consecutive_permanent_errors = lc.consecutive_permanent_errors + 1;
    if (consecutive_permanent_errors >= thresholds.eolErrorThreshold) {
      return {
        ...lc,
        state: LIFECYCLE_STATES.EOL,
        consecutive_permanent_errors,
        consecutive_successes: 0,
        eol_reason: 'provider_410',
        eol_at: now,
      };
    }
    return { ...lc, consecutive_permanent_errors, consecutive_successes: 0 };
  }

  return { ...lc };
}

/**
 * Feed one discovery cycle's catalog-presence signal for this model.
 * `present` false increments `absent_cycles` and demotes active -> suspect
 * once the per-provider threshold is met, then suspect -> eol once the
 * absolute `absentEolThreshold` is met. `present` true resets `absent_cycles`
 * to 0 and, for an id that is currently `eol`, may promote it, but ONLY as
 * far as the strength of the evidence allows (card fb747d52 / C12, extending
 * the affa0aac / C2 rule below):
 *
 *   - `eol_reason === 'dropped_from_catalog'` means the provider simply
 *     stopped listing it. A reappearance is a DIRECT rebuttal of that, so if
 *     the record was ever verified (`last_verified_at != null`) it is
 *     trusted straight back to `active`; if it was never verified, presence
 *     alone still only earns `suspect` (see the affa0aac / C2 note below).
 *   - `eol_reason === 'provider_410'` or `'probe_failed'` means something
 *     STRONGER than catalog membership condemned it: a real completion or an
 *     active probe. Catalog presence is demonstrably weaker evidence (NVIDIA
 *     lists 102 models and 47 of them answer 404 to a real completion), so it
 *     must not be able to overturn that verdict, not even as far as
 *     `suspect` (still routable, so nudging it there would itself be a
 *     promotion). This applies regardless of `last_verified_at`: a model that
 *     once worked and later broke is not rescued just because the provider
 *     still lists it. It is a complete no-op; only a real completion or a
 *     probe can move it again, under `applyCompletionOutcome` /
 *     `applyProbeOutcome`.
 *
 * A `dead` id that reappears is not trusted with any of this: it re-enters
 * as `suspect` regardless of reason, since 30 days of silence is itself
 * additional doubt.
 */
export function applyCatalogPresence(lc, { present, provider, now, thresholds = THRESHOLDS }) {
  if (present) {
    if (lc.state === LIFECYCLE_STATES.DEAD) {
      return {
        ...lc,
        state: LIFECYCLE_STATES.SUSPECT,
        absent_cycles: 0,
        eol_reason: null,
        eol_at: null,
      };
    }

    if (lc.state === LIFECYCLE_STATES.EOL) {
      // An `eol` record with NO prior verification used to be unrecoverable
      // (card affa0aac / C2). It fell straight to the `absent_cycles: 0` reset
      // below, so a model could be re-confirmed present by the provider on every
      // single hourly cycle and stay eol forever. Measured 2026-08-14: all 21
      // openrouter records were in exactly this state, returned by every fetch,
      // and ZERO were advertised. The only escape was a probe sweep that has
      // never run (card 1f65cf45 / C3).
      //
      // Presence is genuinely weaker evidence than a verified completion or
      // probe, so a record condemned by either of THOSE is not moved AT ALL
      // by presence, verified or not (card fb747d52 / C12). Not even to
      // `suspect`: `suspect` is still routable, so nudging it there on
      // catalog membership alone would itself be a promotion of weak
      // evidence over strong. It stays `eol`, a complete no-op here, until a
      // real completion or a probe (the same strength of evidence that
      // condemned it) moves it again. Only `dropped_from_catalog` is a
      // reason presence directly rebuts.
      if (lc.eol_reason !== 'dropped_from_catalog') {
        return { ...lc, absent_cycles: 0 };
      }

      if (lc.last_verified_at != null) {
        return {
          ...lc,
          state: LIFECYCLE_STATES.ACTIVE,
          absent_cycles: 0,
          consecutive_permanent_errors: 0,
          consecutive_successes: 0,
          eol_reason: null,
          eol_at: null,
          last_verified_at: now,
        };
      }

      // Presence is genuinely weaker evidence than a verified completion, so it
      // does NOT earn `active`. It earns `suspect`: routable again, and flagged
      // as such on /v1/models, where real traffic or a probe can settle it.
      return {
        ...lc,
        state: LIFECYCLE_STATES.SUSPECT,
        absent_cycles: 0,
        eol_reason: null,
        eol_at: null,
      };
    }

    return { ...lc, absent_cycles: 0 };
  }

  // absent this cycle
  const absent_cycles = lc.absent_cycles + 1;
  const suspectThreshold =
    thresholds.absentSuspectThreshold[provider] ?? thresholds.absentSuspectThreshold.default;

  if (lc.state === LIFECYCLE_STATES.ACTIVE || lc.state === LIFECYCLE_STATES.SUSPECT) {
    if (absent_cycles >= thresholds.absentEolThreshold) {
      return {
        ...lc,
        state: LIFECYCLE_STATES.EOL,
        absent_cycles,
        eol_reason: 'dropped_from_catalog',
        eol_at: now,
      };
    }
    if (lc.state === LIFECYCLE_STATES.ACTIVE && absent_cycles >= suspectThreshold) {
      return { ...lc, state: LIFECYCLE_STATES.SUSPECT, absent_cycles };
    }
    return { ...lc, absent_cycles };
  }

  return { ...lc, absent_cycles };
}

/**
 * Feed the outcome of an off-request-path probe sweep (5.2). A successful
 * probe is unconditional evidence the model is alive: promote to active.
 * A 410 is unconditional evidence it is gone: flip to eol immediately
 * (`probe_failed`, distinct from `provider_410`/`dropped_from_catalog` so the
 * source of the EOL call is visible in `/admin/models`). Any other failure
 * (timeout, 5xx) is weaker evidence and only demotes an active model to
 * suspect; it never escalates a model that already needs investigation.
 *
 * A probe is deliberately kept as an unconditional, single-shot promotion
 * (unlike `applyCompletionOutcome`'s 2xx, which now needs
 * `promotionSuccessThreshold` consecutive passes once a record has lost
 * trust; card fb747d52 / C12). Probes are the intentional escape hatch for a
 * record stuck by weak catalog-presence evidence (see the affa0aac / C2 note
 * in `applyCatalogPresence`), off the request path and not something a
 * flaky model's live traffic pattern can influence, so treating one ok as
 * sufficient does not reopen the "one lucky response" hole this card closes.
 */
export function applyProbeOutcome(lc, { ok, status, now }) {
  if (ok) {
    return {
      ...lc,
      state: LIFECYCLE_STATES.ACTIVE,
      consecutive_permanent_errors: 0,
      consecutive_successes: 0,
      absent_cycles: 0,
      eol_reason: null,
      eol_at: null,
      last_verified_at: now,
    };
  }

  if (status === 410) {
    return {
      ...lc,
      state: LIFECYCLE_STATES.EOL,
      eol_reason: 'probe_failed',
      eol_at: now,
    };
  }

  if (lc.state === LIFECYCLE_STATES.ACTIVE) {
    return { ...lc, state: LIFECYCLE_STATES.SUSPECT };
  }
  return { ...lc };
}

/**
 * Age a lifecycle record: an `eol` model that has stayed `eol` for more than
 * `deadAfterMs` becomes `dead` (tombstoned). Every other state is a no-op.
 */
export function ageDeadModels(lc, { now, deadAfterMs = THRESHOLDS.deadAfterMs }) {
  if (lc.state !== LIFECYCLE_STATES.EOL || lc.eol_at == null) {
    return { ...lc };
  }
  if (now - lc.eol_at >= deadAfterMs) {
    return { ...lc, state: LIFECYCLE_STATES.DEAD };
  }
  return { ...lc };
}

/** true for active|suspect (still eligible as a route candidate), false for eol|dead. */
export function isRoutable(lc) {
  return lc.state === LIFECYCLE_STATES.ACTIVE || lc.state === LIFECYCLE_STATES.SUSPECT;
}
