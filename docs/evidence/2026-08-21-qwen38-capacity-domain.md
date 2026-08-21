# Qwen3.8 shared admission domain — 2026-08-21

This is implementation and bounded post-deploy qualification evidence for card
`8b64febc`.

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

## Live AC5 qualification on `.41`

The live gate ran against `http://localhost:18780` on
`cbrd21-laptop12thgenintelcore` without changing gateway/model configuration,
restarting services, or changing llama.cpp parallelism.

- run id: `ac5-8b64febc-1787349857924`
- run interval: `2026-08-21T22:04:17.924Z`–`2026-08-21T22:04:48.615Z`
- deployed commit/tag: `95ac1bd011e041df21d808f2d0674a0f5c7004ff` / `v0.7.10`
- config SHA-256: `558bafbcc4c8317ee15a44dcf078525d229b5674c423f865ad7d19bb9ca4c11b`
- service state before and after: `active`

The idle snapshot at `2026-08-21T22:04:18.155Z` exposed the configured domain
before traffic:

```json
{"pool":{"totalActive":0,"totalQueued":0,"totalCapacity":4,"utilization":0},"backends":{"chiap08-qwen38":{"capacityDomain":"chiap08-qwen38","members":["chiap08-qwen38","reg:qwen38"],"active":0,"queued":0,"max":4,"maxQueue":4,"queueTimeoutMs":30000,"totalProcessed":0,"totalDropped":0,"totalTimedOut":0,"totalCancelled":0,"peakActive":0,"peakQueue":0}},"timestamp":"2026-08-21T22:04:18.155Z"}
```

Four bounded holders—two direct `qwen3.8-27b` and two `sk-creative`—produced
`active: 4`, `queued: 0`, and `totalProcessed: 4` at
`2026-08-21T22:04:18.397Z`. Four further mixed requests filled the FIFO queue:

```json
{"pool":{"totalActive":4,"totalQueued":4,"totalCapacity":4,"utilization":1},"backends":{"chiap08-qwen38":{"capacityDomain":"chiap08-qwen38","members":["chiap08-qwen38","reg:qwen38"],"active":4,"queued":4,"max":4,"maxQueue":4,"queueTimeoutMs":30000,"totalProcessed":4,"totalDropped":0,"totalTimedOut":0,"totalCancelled":0,"peakActive":4,"peakQueue":4}},"timestamp":"2026-08-21T22:04:18.634Z"}
```

The ninth request (`648ed235-70dc-4073-a044-548f04e33b87`) requested
`sk-creative` and failed in 25 ms at `2026-08-21T22:04:18.665Z`. Its redacted
response was HTTP 503 with `Content-Type: application/json`, `Retry-After: 30`,
and `x-sk-backend: reg:qwen38`:

```json
{"error":{"message":"Capacity domain chiap08-qwen38 queue is full.","code":"capacity_exceeded","backend":"reg:qwen38","capacity_domain":"chiap08-qwen38","retryable":true,"retry_after_seconds":30}}
```

The client then explicitly aborted queued direct request
`0479857a-e923-4283-a14a-4532197205e2`. At
`2026-08-21T22:04:18.687Z`, the domain showed `active: 4`, `queued: 3`,
`totalCancelled: 1`, and an unchanged `totalProcessed: 4`, proving the queued
request was removed without an upstream attempt. The gateway audit independently
recorded HTTP 499, `cancelled: true`, `failover: false`, and 256 ms queue wait.

Queued role request `f05dc716-aa59-4989-8e38-9afbd099edc2` returned at
`2026-08-21T22:04:48.437Z` after 30,028 ms. Its redacted response was HTTP 503
with `Content-Type: application/json`, `Retry-After: 30`, and
`x-sk-backend: reg:qwen38`:

```json
{"error":{"message":"Capacity domain chiap08-qwen38 queue wait timed out.","code":"queue_timeout","backend":"reg:qwen38","capacity_domain":"chiap08-qwen38","retryable":true,"retry_after_seconds":30}}
```

The direct holder request ids were
`0d303cb4-5bf3-4c8f-a5e3-2a2b24c7b149` and
`87e559b1-86d5-4965-b57d-7f10a0f4509e`; role holder request ids were
`23a0e2b1-3ace-4719-957e-2c7339839d97` and
`fe1cdfce-1a05-4ffc-b752-fe4de547e542`. Gateway audit resolved the role to
`qwen3.8-27b-huihui-abliterated-q4_k_m` on `reg:qwen38`; direct requests used
`chiap08-qwen38`. No successful generation was awaited, so there is deliberately
no completion response or `x-sk-model-served` response header to claim.

Finally, all client controllers were cancelled and every process was reaped.
The terminal snapshot proved all permits and waiters were released:

```json
{"pool":{"totalActive":0,"totalQueued":0,"totalCapacity":4,"utilization":0},"backends":{"chiap08-qwen38":{"capacityDomain":"chiap08-qwen38","members":["chiap08-qwen38","reg:qwen38"],"active":0,"queued":0,"max":4,"maxQueue":4,"queueTimeoutMs":30000,"totalProcessed":4,"totalDropped":1,"totalTimedOut":3,"totalCancelled":1,"peakActive":4,"peakQueue":4}},"timestamp":"2026-08-21T22:04:48.612Z"}
```

A second post-run check at `2026-08-21T22:05:22.144Z` again reported
`active: 0` and `queued: 0`, the same commit/tag/config hash, an active gateway,
and no remaining qualification driver. This satisfies the fifth acceptance
criterion while keeping the test bounded and cancellable.
