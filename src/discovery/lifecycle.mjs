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
  absentSuspectThreshold: { default: 1, openrouter: 2 },
  // consecutive absent-from-catalog cycles (total, not reset on the
  // active->suspect flip) before suspect -> eol.
  absentEolThreshold: 3,
  // how long a model stays a tombstone (eol) before it ages into dead.
  deadAfterMs: 30 * 24 * 60 * 60 * 1000,
};

/** A fresh lifecycle record for a newly-seen model id. */
export function defaultLifecycle() {
  return {
    state: LIFECYCLE_STATES.ACTIVE,
    last_verified_at: null,
    consecutive_permanent_errors: 0,
    absent_cycles: 0,
    eol_reason: null,
    eol_at: null,
  };
}

/**
 * Feed the outcome of an actual completion request for this model.
 * A 2xx is a live signal: promote to active and clear the permanent-error
 * counter. A 404/410 is a permanent-error signal: after `eolErrorThreshold`
 * consecutive occurrences, flip to eol. Any other status is not a lifecycle
 * signal (backend-level failures are handled by the existing backend health
 * machine) and leaves the record unchanged.
 */
export function applyCompletionOutcome(lc, { status, now }) {
  if (status >= 200 && status < 300) {
    return {
      ...lc,
      state: LIFECYCLE_STATES.ACTIVE,
      consecutive_permanent_errors: 0,
      eol_reason: null,
      eol_at: null,
      last_verified_at: now,
    };
  }

  if (status === 404 || status === 410) {
    const consecutive_permanent_errors = lc.consecutive_permanent_errors + 1;
    if (consecutive_permanent_errors >= THRESHOLDS.eolErrorThreshold) {
      return {
        ...lc,
        state: LIFECYCLE_STATES.EOL,
        consecutive_permanent_errors,
        eol_reason: 'provider_410',
        eol_at: now,
      };
    }
    return { ...lc, consecutive_permanent_errors };
  }

  return { ...lc };
}

/**
 * Feed one discovery cycle's catalog-presence signal for this model.
 * `present` false increments `absent_cycles` and demotes active -> suspect
 * once the per-provider threshold is met, then suspect -> eol once the
 * absolute `absentEolThreshold` is met. `present` true resets `absent_cycles`
 * to 0 and, for an id that is currently `eol` with a prior verification (it
 * dropped out of the catalog rather than dying on completions), promotes it
 * straight back to `active`. A `dead` id that reappears is not trusted with
 * that shortcut: it re-enters as `suspect`.
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
    if (lc.state === LIFECYCLE_STATES.EOL && lc.last_verified_at != null) {
      return {
        ...lc,
        state: LIFECYCLE_STATES.ACTIVE,
        absent_cycles: 0,
        consecutive_permanent_errors: 0,
        eol_reason: null,
        eol_at: null,
        last_verified_at: now,
      };
    }

    // An `eol` record with NO prior verification used to be unrecoverable
    // (card affa0aac / C2). It fell straight to the `absent_cycles: 0` reset
    // below, so a model could be re-confirmed present by the provider on every
    // single hourly cycle and stay eol forever. Measured 2026-08-14: all 21
    // openrouter records were in exactly this state, returned by every fetch,
    // and ZERO were advertised. The only escape was a probe sweep that has
    // never run (card 1f65cf45 / C3).
    //
    // Presence is genuinely weaker evidence than a verified completion, so it
    // does NOT earn `active`. It earns `suspect`: routable again, and flagged
    // as such on /v1/models, where real traffic or a probe can settle it.
    //
    // Gated on `dropped_from_catalog` on purpose. That reason means "the
    // provider stopped listing it", and the provider now listing it again is a
    // DIRECT contradiction of the evidence that retired it. A `provider_410` or
    // `probe_failed` record was condemned by something stronger (an actual
    // request that failed), and mere catalog membership must not overturn that.
    // A provider catalog demonstrably lists ids it will not serve: NVIDIA's
    // lists 102 and 47 of them answered 404 to a real completion.
    if (
      lc.state === LIFECYCLE_STATES.EOL &&
      lc.eol_reason === 'dropped_from_catalog'
    ) {
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
 * probe is unconditional evidence the model is alive: promote toward active.
 * A 410 is unconditional evidence it is gone: flip to eol immediately
 * (`probe_failed`, distinct from `provider_410`/`dropped_from_catalog` so the
 * source of the EOL call is visible in `/admin/models`). Any other failure
 * (timeout, 5xx) is weaker evidence and only demotes an active model to
 * suspect; it never escalates a model that already needs investigation.
 */
export function applyProbeOutcome(lc, { ok, status, now }) {
  if (ok) {
    return {
      ...lc,
      state: LIFECYCLE_STATES.ACTIVE,
      consecutive_permanent_errors: 0,
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
