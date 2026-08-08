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
import { test } from 'node:test';
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

test('2 x 410 then a 200: counter resets, stays active', () => {
  let lc = defaultLifecycle();
  lc = applyCompletionOutcome(lc, { status: 410, now: T0 });
  lc = applyCompletionOutcome(lc, { status: 410, now: T0 + 1000 });
  assert.equal(lc.consecutive_permanent_errors, 2);

  lc = applyCompletionOutcome(lc, { status: 200, now: T0 + 2000 });
  assert.equal(lc.state, 'active');
  assert.equal(lc.consecutive_permanent_errors, 0);
  assert.equal(lc.last_verified_at, T0 + 2000);
  assert.equal(lc.eol_reason, null);
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

test('isRoutable: true for active/suspect, false for eol/dead', () => {
  assert.equal(isRoutable({ state: 'active' }), true);
  assert.equal(isRoutable({ state: 'suspect' }), true);
  assert.equal(isRoutable({ state: 'eol' }), false);
  assert.equal(isRoutable({ state: 'dead' }), false);
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
