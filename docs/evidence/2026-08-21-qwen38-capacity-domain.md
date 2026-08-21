# Qwen3.8 shared admission domain — 2026-08-21

This is bounded implementation evidence for card `8b64febc`. It does not claim
deployment, restart, or a new call to a live model service.

## Invariant

The direct `chiap08-qwen38` route and registry materialization `reg:qwen38`
reach the same llama.cpp process on chiap08 `:11439`. They now consume one
stable `chiap08-qwen38` capacity domain with four active slots, a four-request
FIFO queue, and a 30-second queue SLA. `maxQueue: 0` is explicitly fail-fast.

Admission rejection is structured and terminal at the gateway:

- full queue: retryable `503 capacity_exceeded` plus `Retry-After`;
- expired waiter: retryable `503 queue_timeout` plus `Retry-After`; and
- queued client disconnect: `499 client_closed`, immediate waiter removal,
  no upstream attempt, and no failover.

`GET /queue` reports the shared domain's members, `active`, `queued`, limits,
and cumulative processed, timeout, drop, and cancellation counters. The
configured domain is visible with zero counters before first traffic and its
four slots contribute to total capacity exactly once.

Each acquisition returns a unique, pool-owned, frozen object ticket. Release
consumes that exact object once. A duplicate, copied/forged, foreign-pool, or
legacy string release is inert, so none can decrement `active`, promote a
waiter, or under-report saturation. The discovery probe caller was migrated to
retain and release the issued ticket as well.

## Hermetic evidence

The focused suite uses a local holding HTTP server and a temporary skmodels
registry. It exercises mixed direct/registry traffic, four combined holders,
FIFO promotion, full and timeout outcomes, AbortSignal cleanup, `maxQueue: 0`,
no-failover cancellation, single-use/foreign ticket attacks, idle-domain
visibility, bounded stats lookup, and zero terminal active/queued counts
without contacting a fleet service. The fixture registers a process-level
cleanup hook for its temporary registry and restores the prior environment:

```bash
node --test --import ./tests/_setup.mjs \
  tests/connection-pool-admission.test.mjs \
  tests/qwen-capacity-domain.test.mjs \
  tests/provider-route-assertion.test.mjs \
  tests/anthropic-spof.test.mjs \
  tests/probe.test.mjs
```

Observed in the implementation worktree on 2026-08-21:

- focused gate: 69 passed, 0 failed;
- full `npm test`: 1,325 passed, 0 failed; and
- SK Standards documentation checks: tiers 1, 2, and 3 passed.

## Deferred live gate

The task explicitly prohibited deployment, restart, and live model calls, so
the fifth acceptance criterion's post-deploy observation is not represented as
passed. After the source change is deployed through the normal release path:

1. verify `/queue` exposes only `chiap08-qwen38` for both route ids;
2. hold four bounded mixed direct/`sk-creative` requests and confirm `active: 4`;
3. submit excess mixed requests and confirm a fifth waits while a ninth returns
   structured `503 capacity_exceeded` in less than 60 seconds;
4. leave one waiter queued past 30 seconds and confirm `503 queue_timeout`;
5. cancel one queued request and confirm `499`, no upstream attempt, and an
   incremented `totalCancelled`; and
6. release/cancel every holder and require `active: 0` and `queued: 0`.

Record the deployed commit, config hash, timestamps, response headers/bodies,
and before/peak/after `/queue` snapshots. Do not raise the four-slot ceiling or
change llama.cpp parallelism as part of this gate.
