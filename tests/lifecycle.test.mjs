/**
 * lifecycle.test.mjs — model-granular lifecycle state machine (pure).
 *
 * Covers docs/specs/2026-08-08-model-ranking-routing-intelligence-arch.md
 * section 4.2: active <-> suspect <-> eol -> dead, plus eol->active recovery.
 * All functions are pure (no clock, no I/O, no env read inside); every call
 * below injects `now` and `thresholds` explicitly.
 *
 * Run with:  node --test tests/lifecycle.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIFECYCLE_STATES,
  THRESHOLDS,
  defaultLifecycle,
  applyCompletionOutcome,
  applyCatalogPresence,
  applyProbeOutcome,
  ageDeadModels,
  isRoutable,
} from '../src/discovery/lifecycle.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = 1786500000000;

test('defaultLifecycle() shape', () => {
  const lc = defaultLifecycle();
  assert.deepEqual(lc, {
    state: 'active',
    last_verified_at: null,
    consecutive_permanent_errors: 0,
    consecutive_successes: 0,
    // Added with probe-failure escalation: without a counter here, a probe
    // timeout demoted to suspect and stopped, leaving a model that answers
    // nothing advertised forever.
    consecutive_probe_failures: 0,
    absent_cycles: 0,
    eol_reason: null,
    eol_at: null,
  });
});

test('LIFECYCLE_STATES enum', () => {
  assert.deepEqual(LIFECYCLE_STATES, {
    ACTIVE: 'active',
    SUSPECT: 'suspect',
    EOL: 'eol',
    DEAD: 'dead',
    NOT_CHAT: 'not_chat',
  });
});

test('3 consecutive 410s: active -> eol with eol_reason provider_410', () => {
  let lc = defaultLifecycle();
  lc = applyCompletionOutcome(lc, { status: 410, now: T0 });
  assert.equal(lc.state, 'active');
  assert.equal(lc.consecutive_permanent_errors, 1);

  lc = applyCompletionOutcome(lc, { status: 410, now: T0 + 1000 });
  assert.equal(lc.state, 'active');
  assert.equal(lc.consecutive_permanent_errors, 2);

  lc = applyCompletionOutcome(lc, { status: 410, now: T0 + 2000 });
  assert.equal(lc.state, 'eol');
  assert.equal(lc.eol_reason, 'provider_410');
  assert.equal(lc.eol_at, T0 + 2000);
  assert.equal(lc.consecutive_permanent_errors, 3);
});

test('2 x 410 then a single 200: stays active, but does NOT wipe the error streak', () => {
  // Card fb747d52 / C12: this test used to assert a single 2xx zeroed
  // consecutive_permanent_errors outright. That was the bug. A model
  // succeeding one request in four never accumulates eolErrorThreshold (3)
  // CONSECUTIVE failures under that rule, because every intermittent success
  // erases the run, so it parks in `active` forever. The counter now needs
  // the same promotionSuccessThreshold (2) consecutive successes to clear
  // that eolErrorThreshold (3) needs consecutive failures to condemn.
  let lc = defaultLifecycle();
  lc = applyCompletionOutcome(lc, { status: 410, now: T0 });
  lc = applyCompletionOutcome(lc, { status: 410, now: T0 + 1000 });
  assert.equal(lc.consecutive_permanent_errors, 2);

  lc = applyCompletionOutcome(lc, { status: 200, now: T0 + 2000 });
  assert.equal(lc.state, 'active', 'already active, and a first success does not need to wait');
  assert.equal(
    lc.consecutive_permanent_errors,
    2,
    'one success is not enough evidence to forgive two prior failures',
  );
  assert.equal(lc.consecutive_successes, 1);
  assert.equal(lc.last_verified_at, T0 + 2000, 'the success itself is still recorded');
  assert.equal(lc.eol_reason, null);

  // A second CONSECUTIVE success clears it: the same threshold that promotes
  // also forgives.
  lc = applyCompletionOutcome(lc, { status: 200, now: T0 + 3000 });
  assert.equal(lc.state, 'active');
  assert.equal(lc.consecutive_permanent_errors, 0);
  assert.equal(lc.consecutive_successes, 2);
});

// ─── C12: promotion needs consecutive passes, not one lucky 2xx ──────────────

test('a first-sighting id is not held cold: defaultLifecycle() starts active, one 2xx keeps it active', () => {
  // Card fb747d52 acceptance criterion: a brand-new id must not be made to
  // wait. Free tiers rotate ids roughly 74 percent between cycles; requiring
  // 2 passes before a new id could serve traffic would leave those tiers
  // permanently cold.
  let lc = defaultLifecycle();
  assert.equal(lc.state, 'active');
  lc = applyCompletionOutcome(lc, { status: 200, now: T0 });
  assert.equal(lc.state, 'active', 'a record that was never demoted does not need to earn promotion');
});

test('a non-active record needs promotionSuccessThreshold consecutive 2xx to reach active, and sits in suspect until then', () => {
  let lc = { ...defaultLifecycle(), state: 'eol', eol_reason: 'provider_410', eol_at: T0 - 1 };

  lc = applyCompletionOutcome(lc, { status: 200, now: T0 });
  assert.equal(lc.state, 'suspect', 'one success is real evidence, so it is routable again, but not yet trusted');
  assert.equal(lc.consecutive_successes, 1);

  lc = applyCompletionOutcome(lc, { status: 200, now: T0 + 1000 });
  assert.equal(lc.state, 'active', 'the second CONSECUTIVE success meets the default threshold of 2');
  assert.equal(lc.consecutive_successes, 2);
  assert.equal(lc.consecutive_permanent_errors, 0);
  assert.equal(lc.eol_reason, null);
});

test('a 404 in between breaks the success streak back to 0', () => {
  let lc = { ...defaultLifecycle(), state: 'suspect' };
  lc = applyCompletionOutcome(lc, { status: 200, now: T0 });
  assert.equal(lc.consecutive_successes, 1);

  lc = applyCompletionOutcome(lc, { status: 404, now: T0 + 1000 });
  assert.equal(lc.consecutive_successes, 0, 'a failure interrupts an in-progress promotion run');

  lc = applyCompletionOutcome(lc, { status: 200, now: T0 + 2000 });
  assert.equal(lc.state, 'suspect', 'the streak restarted, so one success still is not enough');
  assert.equal(lc.consecutive_successes, 1);
});

test('a 429 advances neither counter (card 9e28de88: rate limits are not pass or fail)', () => {
  let lc = defaultLifecycle();
  lc = applyCompletionOutcome(lc, { status: 404, now: T0 });
  assert.equal(lc.consecutive_permanent_errors, 1);

  lc = applyCompletionOutcome(lc, { status: 429, now: T0 + 1000 });
  assert.equal(lc.consecutive_permanent_errors, 1, '429 must not add to the error streak');
  assert.equal(lc.consecutive_successes, 0, '429 must not add to the success streak either');
  assert.equal(lc.state, 'active');

  // and it must not interrupt an in-progress success streak either
  let lc2 = { ...defaultLifecycle(), state: 'suspect' };
  lc2 = applyCompletionOutcome(lc2, { status: 200, now: T0 });
  assert.equal(lc2.consecutive_successes, 1);
  lc2 = applyCompletionOutcome(lc2, { status: 429, now: T0 + 1000 });
  assert.equal(lc2.consecutive_successes, 1, '429 must not reset a success streak in progress');
  lc2 = applyCompletionOutcome(lc2, { status: 200, now: T0 + 2000 });
  assert.equal(lc2.state, 'active', 'the 429 in between did not cost the streak its second success');
});

test('promotionSuccessThreshold is a THRESHOLDS entry, tunable per provider like absentSuspectThreshold', () => {
  const customThresholds = {
    ...THRESHOLDS,
    promotionSuccessThreshold: { default: 2, flaky_provider: 4 },
  };
  let lc = { ...defaultLifecycle(), state: 'eol', eol_reason: 'provider_410' };
  lc = applyCompletionOutcome(lc, {
    status: 200,
    now: T0,
    provider: 'flaky_provider',
    thresholds: customThresholds,
  });
  lc = applyCompletionOutcome(lc, {
    status: 200,
    now: T0 + 1000,
    provider: 'flaky_provider',
    thresholds: customThresholds,
  });
  assert.equal(lc.state, 'suspect', '2 successes must not be enough when this provider needs 4');
  assert.equal(lc.consecutive_successes, 2);
});

test('MANDATORY NEGATIVE CONTROL: a model alternating 2xx/404 forever does not stay active indefinitely', () => {
  // This is the exact bug card fb747d52 describes: a model that succeeds one
  // request in four never accumulates eolErrorThreshold (3) CONSECUTIVE
  // failures, because every intermittent success used to reset the counter
  // to 0, so it parked in `active` forever and kept being advertised. This
  // scenario passes on the pre-fix code (a bare `applyCompletionOutcome`
  // with no consecutive-success gate).
  let lc = defaultLifecycle();
  let sawEol = false;
  let sawActiveAfterEol = false;

  for (let i = 0; i < 60; i++) {
    const status = i % 2 === 0 ? 200 : 404;
    lc = applyCompletionOutcome(lc, { status, now: T0 + i * 1000 });
    if (lc.state === 'eol') sawEol = true;
    if (sawEol && lc.state === 'active') sawActiveAfterEol = true;
  }

  assert.ok(sawEol, 'the alternating pattern must eventually condemn the record at least once');
  assert.notEqual(
    lc.state,
    'active',
    'a model that never lands two CONSECUTIVE successes must not settle back into active',
  );
  assert.equal(
    sawActiveAfterEol,
    false,
    'once condemned, a strictly-alternating pattern (never 2 successes in a row) must never regain active',
  );
});

test('MANDATORY NEGATIVE CONTROL variant: pattern starting with a success, same result', () => {
  let lc = defaultLifecycle();
  for (let i = 0; i < 60; i++) {
    const status = i % 2 === 0 ? 404 : 200;
    lc = applyCompletionOutcome(lc, { status, now: T0 + i * 1000 });
  }
  assert.notEqual(lc.state, 'active');
});

test('absent 1 cycle, default provider: active -> suspect', () => {
  let lc = defaultLifecycle();
  lc = applyCatalogPresence(lc, {
    present: false,
    provider: 'nvidia',
    now: T0,
    thresholds: THRESHOLDS,
  });
  assert.equal(lc.state, 'suspect');
  assert.equal(lc.absent_cycles, 1);
});

test('openrouter honors its 2-cycle suspect rule via the provider arg', () => {
  let lc = defaultLifecycle();
  lc = applyCatalogPresence(lc, {
    present: false,
    provider: 'openrouter',
    now: T0,
    thresholds: THRESHOLDS,
  });
  assert.equal(lc.state, 'active', 'first absent cycle alone must not demote openrouter');
  assert.equal(lc.absent_cycles, 1);

  lc = applyCatalogPresence(lc, {
    present: false,
    provider: 'openrouter',
    now: T0 + 1000,
    thresholds: THRESHOLDS,
  });
  assert.equal(lc.state, 'suspect');
  assert.equal(lc.absent_cycles, 2);
});

test('absent 3 cycles (default provider): suspect -> eol with dropped_from_catalog', () => {
  let lc = defaultLifecycle();
  for (let i = 1; i <= 3; i++) {
    lc = applyCatalogPresence(lc, {
      present: false,
      provider: 'nvidia',
      now: T0 + i * 1000,
      thresholds: THRESHOLDS,
    });
  }
  assert.equal(lc.state, 'eol');
  assert.equal(lc.eol_reason, 'dropped_from_catalog');
  assert.equal(lc.absent_cycles, 3);
  assert.equal(lc.eol_at, T0 + 3000);
});

test('reappear in catalog with a prior probe: eol -> active', () => {
  // lc previously verified (last_verified_at set) then dropped out of the
  // catalog until it hit eol via absence.
  let lc = { ...defaultLifecycle(), last_verified_at: T0 - 10000 };
  for (let i = 1; i <= 3; i++) {
    lc = applyCatalogPresence(lc, {
      present: false,
      provider: 'nvidia',
      now: T0 + i * 1000,
      thresholds: THRESHOLDS,
    });
  }
  assert.equal(lc.state, 'eol');

  lc = applyCatalogPresence(lc, {
    present: true,
    provider: 'nvidia',
    now: T0 + 5000,
    thresholds: THRESHOLDS,
  });
  assert.equal(lc.state, 'active');
  assert.equal(lc.absent_cycles, 0);
  assert.equal(lc.eol_reason, null);
  assert.equal(lc.eol_at, null);
});

test('applyProbeOutcome ok:true promotes toward active', () => {
  let lc = {
    ...defaultLifecycle(),
    state: 'eol',
    eol_reason: 'provider_410',
    eol_at: T0,
    consecutive_permanent_errors: 3,
  };
  lc = applyProbeOutcome(lc, { ok: true, status: 200, now: T0 + 9000 });
  assert.equal(lc.state, 'active');
  assert.equal(lc.eol_reason, null);
  assert.equal(lc.consecutive_permanent_errors, 0);
  assert.equal(lc.last_verified_at, T0 + 9000);
});

test('applyProbeOutcome a 410 sets eol with eol_reason probe_failed', () => {
  let lc = defaultLifecycle();
  lc = applyProbeOutcome(lc, { ok: false, status: 410, now: T0 });
  assert.equal(lc.state, 'eol');
  assert.equal(lc.eol_reason, 'probe_failed');
  assert.equal(lc.eol_at, T0);
});

test('eol for 31 days: -> dead; a returning id from dead becomes suspect, not active', () => {
  let lc = {
    ...defaultLifecycle(),
    state: 'eol',
    eol_reason: 'provider_410',
    eol_at: T0,
  };
  lc = ageDeadModels(lc, { now: T0 + 31 * DAY_MS, deadAfterMs: THRESHOLDS.deadAfterMs });
  assert.equal(lc.state, 'dead');

  lc = applyCatalogPresence(lc, {
    present: true,
    provider: 'nvidia',
    now: T0 + 40 * DAY_MS,
    thresholds: THRESHOLDS,
  });
  assert.equal(lc.state, 'suspect');
  assert.notEqual(lc.state, 'active');
});

test('ageDeadModels leaves eol alone before the 30-day mark', () => {
  let lc = { ...defaultLifecycle(), state: 'eol', eol_reason: 'provider_410', eol_at: T0 };
  lc = ageDeadModels(lc, { now: T0 + 29 * DAY_MS, deadAfterMs: THRESHOLDS.deadAfterMs });
  assert.equal(lc.state, 'eol');
});

test('ageDeadModels is a no-op for non-eol states', () => {
  const active = defaultLifecycle();
  assert.equal(
    ageDeadModels(active, { now: T0 + 1000 * DAY_MS, deadAfterMs: THRESHOLDS.deadAfterMs }).state,
    'active',
  );
});

test('isRoutable: true for active/suspect, false for eol/dead/not_chat', () => {
  assert.equal(isRoutable({ state: 'active' }), true);
  assert.equal(isRoutable({ state: 'suspect' }), true);
  assert.equal(isRoutable({ state: 'eol' }), false);
  assert.equal(isRoutable({ state: 'dead' }), false);
  assert.equal(isRoutable({ state: 'not_chat' }), false);
});

// ─── C14 (f9e8002b): not_chat, a third disposition, probe-driven only ────────

test('a probe 400 flips an active model to not_chat (nvidia/nemotron-parse shape)', () => {
  let lc = defaultLifecycle();
  lc = applyProbeOutcome(lc, { ok: false, status: 400, now: T0 });
  assert.equal(lc.state, 'not_chat');
  assert.equal(lc.eol_reason, 'not_chat');
  assert.equal(lc.eol_at, T0);
});

test('MANDATORY: a USER-traffic 400 (applyCompletionOutcome) produces NO lifecycle change at all', () => {
  // The trap the card calls out by name: conflating a request-shape 400 from
  // arbitrary user traffic with the probe's controlled 400 would let one
  // malformed caller condemn a healthy model. applyCompletionOutcome must
  // leave the record byte-for-byte untouched.
  let lc = defaultLifecycle();
  const before = { ...lc };
  lc = applyCompletionOutcome(lc, { status: 400, now: T0, provider: 'nvidia' });
  assert.deepEqual(lc, before, 'a completion-path 400 must be a complete no-op');
  assert.notEqual(lc.state, 'not_chat', 'user traffic must never be able to set not_chat');

  // Same record, hit with a 400 from user traffic 10 times in a row: still
  // nothing. Unlike 404/410, there is no threshold that ever gets there,
  // because the completion path does not look at 400 at all.
  for (let i = 0; i < 10; i++) {
    lc = applyCompletionOutcome(lc, { status: 400, now: T0 + i, provider: 'nvidia' });
  }
  assert.deepEqual(lc, before);
});

test('MANDATORY: a probe 429 produces NO disposition change at all, not not_chat and not eol', () => {
  // Card 9e28de88 landed making 429 a failover condition; a probe hitting a
  // free-tier rate limit means alive and throttled, nothing else.
  let lc = defaultLifecycle();
  const before = { ...lc };
  lc = applyProbeOutcome(lc, { ok: false, status: 429, now: T0 });
  assert.deepEqual(lc, before, 'a probe 429 must be a complete no-op, unlike a probe 410/400/timeout');

  // Also true starting from a non-active state: a 429 must not even soften
  // an eol record toward suspect the way a bare timeout/5xx would from active.
  let lc2 = { ...defaultLifecycle(), state: 'eol', eol_reason: 'provider_410', eol_at: T0 - 1 };
  const before2 = { ...lc2 };
  lc2 = applyProbeOutcome(lc2, { ok: false, status: 429, now: T0 });
  assert.deepEqual(lc2, before2);
});

test('MANDATORY: a probe 500 does NOT produce not_chat (thinkingmachines/inkling shape)', () => {
  // inkling IS a listed chat model (models.dev text->text); its 500 is an
  // availability problem, not evidence it is the wrong kind of model. A probe
  // 500 must fall to the same weak-evidence path as a timeout: demote an
  // active record to suspect, never to not_chat.
  let lc = defaultLifecycle();
  lc = applyProbeOutcome(lc, { ok: false, status: 500, now: T0 });
  assert.notEqual(lc.state, 'not_chat');
  assert.equal(lc.state, 'suspect', 'a probe 500 is weak evidence, same as a timeout: active -> suspect only');

  // And it must never ESCALATE a record that already needs investigation,
  // same rule as every other non-410/400/429 probe failure.
  let lc2 = { ...defaultLifecycle(), state: 'suspect' };
  lc2 = applyProbeOutcome(lc2, { ok: false, status: 500, now: T0 });
  assert.equal(lc2.state, 'suspect');
  assert.notEqual(lc2.state, 'not_chat');
});

test('MANDATORY: a not_chat model is excluded from routing (isRoutable false)', () => {
  const lc = { ...defaultLifecycle(), state: 'not_chat', eol_reason: 'not_chat', eol_at: T0 };
  assert.equal(isRoutable(lc), false);
});

test('MANDATORY: a later successful probe recovers a not_chat model to active', () => {
  let lc = defaultLifecycle();
  lc = applyProbeOutcome(lc, { ok: false, status: 400, now: T0 });
  assert.equal(lc.state, 'not_chat');

  // A provider adding chat support to an existing endpoint: the next probe
  // succeeds. Recovery is unconditional and immediate, same as eol -> active.
  lc = applyProbeOutcome(lc, { ok: true, status: 200, now: T0 + 1000 });
  assert.equal(lc.state, 'active');
  assert.equal(lc.eol_reason, null);
  assert.equal(lc.eol_at, null);
  assert.equal(lc.last_verified_at, T0 + 1000);
});

test('not_chat does not age into dead (ageDeadModels only acts on eol)', () => {
  const lc = { ...defaultLifecycle(), state: 'not_chat', eol_reason: 'not_chat', eol_at: T0 };
  const aged = ageDeadModels(lc, { now: T0 + 1000 * DAY_MS, deadAfterMs: THRESHOLDS.deadAfterMs });
  assert.equal(aged.state, 'not_chat', 'not_chat is not a tombstone; it must not follow the eol->dead clock');
});

test('a probe 400 unconditionally overrides a prior suspect/eol disposition, same as 410 does', () => {
  // Consistent with the existing unconditional-promotion design (an ok probe
  // already overrides any prior state): a controlled probe request is
  // stronger evidence than whatever put the record in its current state.
  let lc = { ...defaultLifecycle(), state: 'eol', eol_reason: 'provider_410', eol_at: T0 - 1 };
  lc = applyProbeOutcome(lc, { ok: false, status: 400, now: T0 });
  assert.equal(lc.state, 'not_chat');
  assert.equal(lc.eol_reason, 'not_chat');
});

test('thresholds are injected, not read from env or a module-level clock', () => {
  const customThresholds = {
    ...THRESHOLDS,
    absentSuspectThreshold: { default: 5, openrouter: 5 },
  };
  let lc = defaultLifecycle();
  lc = applyCatalogPresence(lc, {
    present: false,
    provider: 'nvidia',
    now: T0,
    thresholds: customThresholds,
  });
  assert.equal(lc.state, 'active', 'custom threshold of 5 must not demote after 1 absent cycle');
});

// ── repeated probe failures must eventually retire a model ──────────────────
//
// Before this, a probe timeout demoted active -> suspect and then stopped
// forever. `suspect` is still routable and still advertised, so a model that
// answered nothing on every sweep stayed in the catalog indefinitely: an id
// nothing could ever retire, which is the same shape as the bug this whole
// epic exists to close. Measured 2026-08-16, six NVIDIA ids timed out on every
// verification run and would have sat suspect forever.
describe('probe failures escalate, but only after ambiguity is exhausted', () => {
  const now = 1_800_000_000_000;
  const fail = (lc, status = null) => applyProbeOutcome(lc, { ok: false, status, now });

  test('a single timeout demotes to suspect, not eol', () => {
    const r = fail(defaultLifecycle());
    assert.equal(r.state, LIFECYCLE_STATES.SUSPECT, 'one ambiguous failure is not a retirement');
    assert.equal(r.consecutive_probe_failures, 1);
  });

  test('repeated failures eventually reach eol, with a distinct reason', () => {
    let lc = defaultLifecycle();
    for (let i = 0; i < THRESHOLDS.probeFailureEolThreshold; i++) lc = fail(lc);
    assert.equal(lc.state, LIFECYCLE_STATES.EOL);
    assert.equal(
      lc.eol_reason,
      'probe_unresponsive',
      'distinct from probe_failed (a 410) so an operator can tell "answers nothing" from "provider says gone"',
    );
  });

  test('NEGATIVE CONTROL: it does not stop at suspect forever', () => {
    // The bug. Twenty consecutive failures must not leave it routable.
    let lc = defaultLifecycle();
    for (let i = 0; i < 20; i++) lc = fail(lc);
    assert.notEqual(lc.state, LIFECYCLE_STATES.SUSPECT);
    assert.equal(isRoutable(lc), false, 'a model that answers nothing must stop being routable');
  });

  test('one good probe clears the streak outright', () => {
    let lc = defaultLifecycle();
    lc = fail(lc); lc = fail(lc);
    assert.equal(lc.consecutive_probe_failures, 2);
    lc = applyProbeOutcome(lc, { ok: true, now });
    assert.equal(lc.consecutive_probe_failures, 0);
    assert.equal(lc.state, LIFECYCLE_STATES.ACTIVE);
  });

  test('an intermittent model never accumulates enough to be retired', () => {
    // Alternating fail/succeed is a slow or flaky model, not a dead one. It
    // must stay usable, which is why the streak must be CONSECUTIVE.
    let lc = defaultLifecycle();
    for (let i = 0; i < 30; i++) {
      lc = fail(lc);
      lc = applyProbeOutcome(lc, { ok: true, now });
    }
    assert.equal(lc.state, LIFECYCLE_STATES.ACTIVE);
  });

  test('a 429 still advances nothing, not even the failure streak', () => {
    // Throttled means alive and popular. Retiring for it would evict the models
    // we use most.
    let lc = defaultLifecycle();
    for (let i = 0; i < 20; i++) lc = fail(lc, 429);
    assert.equal(lc.state, LIFECYCLE_STATES.ACTIVE);
    assert.equal(lc.consecutive_probe_failures || 0, 0);
  });

  test('a 410 still retires immediately, without waiting for the streak', () => {
    const r = fail(defaultLifecycle(), 410);
    assert.equal(r.state, LIFECYCLE_STATES.EOL);
    assert.equal(r.eol_reason, 'probe_failed', 'the provider stating it is gone is stronger evidence');
  });

  test('a 400 still means not_chat, not unresponsive', () => {
    const r = fail(defaultLifecycle(), 400);
    assert.equal(r.state, LIFECYCLE_STATES.NOT_CHAT);
  });
});
