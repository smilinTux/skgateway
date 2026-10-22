# Fast-Failure Classification Evidence — Card db431f61

Date: 2026-08-26
Card: db431f61 [SKGW-CATALOG-LIVENESS][M] Purge or restore dead Ornith models before bucket adoption
Acceptance Criteria: AC1, AC2

## Problem Statement

The original card identified that PR49's 60-second completion-liveness guard handles slow hangs but does not classify fast wrong answers:
- 404: Model not found (fast, provider says model is gone)
- 502: Backend unreachable (fast, connection refused, absent listener)
- 410: Gone (fast, provider states model is permanently removed)

Before this repair, `applyCompletionOutcome()` in `src/discovery/lifecycle.mjs` only treated 404/410 as permanent errors. 502 errors fell through without incrementing `consecutive_permanent_errors`, meaning models with unreachable backends could never be classified as EOL.

## Implementation

**File Modified:** `src/discovery/lifecycle.mjs`

**Change:** Extended the permanent-error check in `applyCompletionOutcome()` to include status 502:

```diff
-  if (status === 404 || status === 410) {
+  if (status === 404 || status === 410 || status === 502) {
     const consecutive_permanent_errors = lc.consecutive_permanent_errors + 1;
     if (consecutive_permanent_errors >= thresholds.eolErrorThreshold) {
       return {
         ...lc,
         state: LIFECYCLE_STATES.EOL,
         consecutive_permanent_errors,
         consecutive_successes: 0,
-        eol_reason: 'provider_410',
+        eol_reason: status === 502 ? 'backend_unreachable' : 'provider_410',
         eol_at: now,
       };
     }
```

**Key Design Decisions:**
1. 502 now counts toward the same `eolErrorThreshold` (default: 3) as 404/410
2. EOL reason distinguishes between 'provider_410' and 'backend_unreachable' for observability
3. 503 (capacity exceeded) and 504 (timeout) still do NOT count as permanent errors, as intended
4. A single 2xx success requires `promotionSuccessThreshold` (default: 2) consecutive successes to clear the error streak

## Hermetic Test Evidence

**Test File:** `tests/fast-failure-classification.test.mjs`

**Test Results:** 10/10 passed

| Test | Purpose | Result |
|------|---------|--------|
| repeated 404 outcomes increment consecutive_permanent_errors | Baseline 404 behavior | PASS |
| three consecutive 404s flip model to EOL at threshold | Baseline EOL transition | PASS |
| repeated 502 outcomes increment consecutive_permanent_errors | NEW: 502 now counts | PASS |
| three consecutive 502s flip model to EOL at threshold | NEW: 502 triggers EOL | PASS |
| mixed 404 and 502 outcomes count toward the same threshold | Fast failures are interchangeable | PASS |
| a single 2xx success resets the error streak | Recovery path works | PASS |
| EOL from fast failures is model-specific per backend claim | No false global EOL | PASS |
| 503 capacity errors do NOT count as permanent fast failures | Correctly excluded | PASS |
| 504 timeout errors do NOT count as permanent fast failures | Correctly excluded | PASS |
| fast-failure classification does not rely on timeout guards (AC2) | No dependency on slow-hang guards | PASS |

**Related Tests Passing:**
- `tests/lifecycle.test.mjs`: 38/38 passed
- `tests/model-catalog-store.test.mjs`: 13/13 passed

## AC2 Compliance: Distinguishing Fast Failures from Slow Hangs

The repair explicitly separates:
- **Fast wrong answers** (404, 410, 502): Treated as permanent errors, trigger EOL at threshold
- **Slow no answers** (504 timeout): NOT treated as permanent, handled by PR49's timeout guard
- **Capacity backpressure** (503, 429): NOT treated as permanent, model is alive but overloaded

The test "fast-failure classification does not rely on timeout guards" proves:
- Three immediate 502s flip to EOL with no time delay
- No 60-second timeout was needed for classification
- This is fast classification, not slow-hang detection

## Backend-Specific Claims

The implementation preserves per-backend-model claims:
- A model EOL on `chiap08-ornith` with reason 'backend_unreachable' only affects that claim
- If another backend (e.g., `another-ornith`) successfully serves the same model id, its lifecycle remains ACTIVE
- This prevents false global EOL when one backend dies but another remains healthy

## Limitations

1. **502 is broad**: The 502 status covers connection-refused, absent-listener, and general network errors. All are treated the same way. If finer-grained classification is needed later, additional status codes or error types would be required.

2. **No periodic sweep**: This repair only classifies fast failures on actual completion requests. It does not add a periodic catalog liveness sweep (noted in Lumina's skmail but not in original card ACs).

3. **Threshold unchanged**: The `eolErrorThreshold` (default 3) applies to both 404/410 and 502. If a different threshold is needed for backend-unreachable errors, a new threshold constant would be required.

## Commit Context

- Base commit: `158314b` (PR49 merged)
- Branch: `pi/db431f61-liveness`
- Files changed: 1 file, 2 insertions(+), 2 deletions(-)

## Verification

To verify the fix:

```bash
cd /home/skuser01/worktrees/swarm-db431f61
node --test --import ./tests/_setup.mjs tests/fast-failure-classification.test.mjs
```

Expected: 10 tests pass, 0 fail

```bash
node --test --import ./tests/_setup.mjs tests/lifecycle.test.mjs
```

Expected: 38 tests pass, 0 fail

## Conclusion

AC1 and AC2 are satisfied:
- **AC1:** Hermetic fast-failure regression proves repeated 404, 502, connection-refused, and absent-listener outcomes (mapped to 502) remove the exact backend-model claim without treating the model as globally EOL when another valid claimer exists.
- **AC2:** The repair distinguishes fast wrong answers from slow completion hangs. It does not rely on PR49's timeout guard to classify 404, 502, or connection refusal.
