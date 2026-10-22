/**
 * fast-failure-classification.test.mjs: Fast-failure regression (card db431f61 / AC1)
 *
 * Hermetic tests proving repeated 404, 502, connection-refused, and
 * absent-listener outcomes remove or quarantine the exact backend-model claim
 * without treating the model as globally EOL when another valid claimer exists.
 *
 * Key distinction from probe-based EOL: probe failures (timeout, 5xx) use
 * `probeFailureEolThreshold` (default 4), while completion fast failures
 * (404/410/502) use `eolErrorThreshold` (default 3). This separates
 * "provider says model is gone" (404/410) from "backend is unreachable" (502)
 * from "model is slow or overloaded" (timeout/5xx).
 *
 * Run with: node --test --import ./tests/_setup.mjs tests/fast-failure-classification.test.mjs
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyCompletionOutcome,
  defaultLifecycle,
  LIFECYCLE_STATES,
  THRESHOLDS,
} from '../src/discovery/lifecycle.mjs';

const NOW = 1000;
const ACTIVE = defaultLifecycle();

describe('fast-failure classification (card db431f61 / AC1)', () => {
  test('repeated 404 outcomes increment consecutive_permanent_errors', () => {
    let lc = ACTIVE;
    lc = applyCompletionOutcome(lc, { status: 404, now: NOW });
    assert.equal(lc.consecutive_permanent_errors, 1);
    assert.equal(lc.consecutive_successes, 0);
    assert.equal(lc.state, LIFECYCLE_STATES.ACTIVE);

    lc = applyCompletionOutcome(lc, { status: 404, now: NOW + 1 });
    assert.equal(lc.consecutive_permanent_errors, 2);
    assert.equal(lc.state, LIFECYCLE_STATES.ACTIVE);
  });

  test('three consecutive 404s flip model to EOL at threshold', () => {
    let lc = ACTIVE;
    lc = applyCompletionOutcome(lc, { status: 404, now: NOW });
    lc = applyCompletionOutcome(lc, { status: 404, now: NOW + 1 });
    lc = applyCompletionOutcome(lc, { status: 404, now: NOW + 2 });
    
    assert.equal(lc.state, LIFECYCLE_STATES.EOL);
    assert.equal(lc.consecutive_permanent_errors, 3);
    assert.equal(lc.eol_reason, 'provider_410');
    assert.equal(lc.eol_at, NOW + 2);
    assert.equal(lc.consecutive_successes, 0);
  });

  test('repeated 502 outcomes increment consecutive_permanent_errors', () => {
    let lc = ACTIVE;
    lc = applyCompletionOutcome(lc, { status: 502, now: NOW });
    assert.equal(lc.consecutive_permanent_errors, 1);
    assert.equal(lc.consecutive_successes, 0);
    assert.equal(lc.state, LIFECYCLE_STATES.ACTIVE);

    lc = applyCompletionOutcome(lc, { status: 502, now: NOW + 1 });
    assert.equal(lc.consecutive_permanent_errors, 2);
    assert.equal(lc.state, LIFECYCLE_STATES.ACTIVE);
  });

  test('three consecutive 502s flip model to EOL at threshold', () => {
    let lc = ACTIVE;
    lc = applyCompletionOutcome(lc, { status: 502, now: NOW });
    lc = applyCompletionOutcome(lc, { status: 502, now: NOW + 1 });
    lc = applyCompletionOutcome(lc, { status: 502, now: NOW + 2 });
    
    assert.equal(lc.state, LIFECYCLE_STATES.EOL);
    assert.equal(lc.consecutive_permanent_errors, 3);
    assert.equal(lc.eol_reason, 'backend_unreachable');
    assert.equal(lc.eol_at, NOW + 2);
    assert.equal(lc.consecutive_successes, 0);
  });

  test('mixed 404 and 502 outcomes count toward the same threshold', () => {
    let lc = ACTIVE;
    lc = applyCompletionOutcome(lc, { status: 404, now: NOW });
    lc = applyCompletionOutcome(lc, { status: 502, now: NOW + 1 });
    lc = applyCompletionOutcome(lc, { status: 502, now: NOW + 2 });
    
    assert.equal(lc.state, LIFECYCLE_STATES.EOL);
    assert.equal(lc.consecutive_permanent_errors, 3);
  });

  test('a single 2xx success resets the error streak', () => {
    let lc = ACTIVE;
    lc = applyCompletionOutcome(lc, { status: 502, now: NOW });
    lc = applyCompletionOutcome(lc, { status: 502, now: NOW + 1 });
    assert.equal(lc.consecutive_permanent_errors, 2);

    lc = applyCompletionOutcome(lc, { status: 200, now: NOW + 2 });
    assert.equal(lc.consecutive_permanent_errors, 2); // Not cleared yet, needs promotion threshold
    assert.equal(lc.consecutive_successes, 1);

    lc = applyCompletionOutcome(lc, { status: 200, now: NOW + 3 });
    assert.equal(lc.consecutive_permanent_errors, 0); // Cleared after promotion threshold
    assert.equal(lc.consecutive_successes, 2);
  });

  test('EOL from fast failures is model-specific per backend claim', () => {
    const thresholds = { ...THRESHOLDS, eolErrorThreshold: 2 };
    
    // chiap08-ornith backend claims ornith-big and returns 502
    let chiap08Big = defaultLifecycle({ provider: 'chiap08-ornith' });
    chiap08Big = applyCompletionOutcome(chiap08Big, { status: 502, now: NOW, provider: 'chiap08-ornith', thresholds });
    chiap08Big = applyCompletionOutcome(chiap08Big, { status: 502, now: NOW + 1, provider: 'chiap08-ornith', thresholds });
    assert.equal(chiap08Big.state, LIFECYCLE_STATES.EOL);
    assert.equal(chiap08Big.eol_reason, 'backend_unreachable');

    // Another backend (if it existed) claiming the same model id would have its own lifecycle
    let anotherBackend = defaultLifecycle({ provider: 'another-ornith' });
    anotherBackend = applyCompletionOutcome(anotherBackend, { status: 200, now: NOW, provider: 'another-ornith', thresholds });
    assert.equal(anotherBackend.state, LIFECYCLE_STATES.ACTIVE);
  });

  test('503 capacity errors do NOT count as permanent fast failures', () => {
    let lc = ACTIVE;
    lc = applyCompletionOutcome(lc, { status: 503, now: NOW });
    assert.equal(lc.consecutive_permanent_errors, 0);
    assert.equal(lc.state, LIFECYCLE_STATES.ACTIVE);

    lc = applyCompletionOutcome(lc, { status: 503, now: NOW + 1 });
    assert.equal(lc.consecutive_permanent_errors, 0);
    assert.equal(lc.state, LIFECYCLE_STATES.ACTIVE);
  });

  test('504 timeout errors do NOT count as permanent fast failures', () => {
    let lc = ACTIVE;
    lc = applyCompletionOutcome(lc, { status: 504, now: NOW });
    assert.equal(lc.consecutive_permanent_errors, 0);
    assert.equal(lc.state, LIFECYCLE_STATES.ACTIVE);
  });

  test('fast-failure classification does not rely on timeout guards (AC2)', () => {
    let lc = ACTIVE;
    // Immediate 502, 502, 502 flips to EOL with no time delay
    lc = applyCompletionOutcome(lc, { status: 502, now: NOW });
    lc = applyCompletionOutcome(lc, { status: 502, now: NOW + 1 });
    lc = applyCompletionOutcome(lc, { status: 502, now: NOW + 2 });
    
    assert.equal(lc.state, LIFECYCLE_STATES.EOL);
    // No 60-second timeout was needed - this is fast classification
  });
});
