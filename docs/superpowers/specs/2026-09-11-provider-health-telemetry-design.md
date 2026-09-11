# SKGateway Provider Health and Telemetry Design

Status: Approved design

Card: `3981db0d`

Source baseline: `fd7e19a7e7852cf5cdbfe6f850009563426506cf`

Date: 2026-09-11

## Purpose

SKGateway needs a provider-neutral health plane that keeps routing useful work
when one subscription, account, backend, or model becomes unavailable. The
health plane must detect account-specific failures without spending tokens in
steady state, quarantine only the affected scope, recover it automatically,
and expose enough safe telemetry to explain which logical bucket selected
which provider and model.

The design covers Qwen3.8, Codex, Kimi, Z.ai/GLM, Cursor, and OpenRouter.
The source baseline still enables legacy OpenRouter backend, discovery, and
probe switches. The first rollout gate must disable every such switch and
prove zero OpenRouter DNS, HTTP, and inference calls. OpenRouter activation is
outside this rollout and remains subject to its existing qualification and
human gates.

## Goals

- Preserve metrics, audit, health, capacity, and semantic-cache state across
  immutable runtime switches.
- Use zero-token monitoring for steady-state checks.
- Permit one minimal inference canary only at startup or during recovery when
  passive evidence is stale or cannot prove model serving.
- Automatically quarantine and restore provider, account, backend, or model
  scopes without routine human intervention.
- Continue through another policy-eligible provider when one scope is
  quarantined.
- Prevent retry storms, long gateway waits, and agent sessions that appear to
  hang.
- Distinguish provider failures from gateway admission, queue, and cooldown
  decisions.
- Expose safe, versioned provider, model, bucket, route, error, and cache
  statistics for future SKDashboard integration.
- Keep semantic cache enabled in shadow mode.
- Add no new database, message broker, resident provider daemon, or scheduled
  generation loop.

## Non-goals

- Serving semantic-cache results.
- Automatically activating a configured disabled or monitor-only provider.
- Reconstructing or splicing a response after a stream has emitted bytes.
- Sending credentials to a third-party monitoring service.
- Enabling OpenRouter traffic in the initial rollout.
- Qualifying Cursor inference before its SKGateway transport is implemented.
- Replacing the durable workflow scheduler with an HTTP request queue.

## Architecture

The existing gateway request observations, provider catalogs, local service
checks, account endpoints, quota endpoints, credential metadata, and queue
state feed small provider-specific adapters. Each adapter emits the same
normalized observation. SKGateway appends observations to its existing SQLite
store and maintains a bounded current snapshot. Routing, operator endpoints,
alerts, and command-line reports read that snapshot.

```text
provider and local signals
          |
          v
provider-specific adapters
          |
          v
normalized observations
          |
          v
SQLite observations and current snapshots
          |
          +--> routing circuit breaker
          +--> operator metrics API
          +--> skgw-lanes
          +--> transition alerts
```

Status reads never contact a provider. Rendering a dashboard or running a
report consumes no model tokens.

## Provider lifecycle and circuit state

Every provider has one `configured_mode`:

- `disabled`: no provider network calls, routing, or recovery probes.
- `monitor_only`: zero-token credential, account, catalog, and quota checks;
  never eligible for inference.
- `canary`: excluded from ordinary routing but eligible for bounded
  qualification probes.
- `active`: eligible for ordinary routing when health and policy allow it.

Circuit state is independent and has the values `closed`, `open`, and
`half_open`. Ordinary routing eligibility requires all of:

- `configured_mode=active`
- `circuit_state=closed`
- current policy eligibility
- a healthy matching provider, account, backend, and model scope

An internal qualification probe requires `configured_mode=canary` plus
explicit probe authorization. An internal recovery probe requires
`configured_mode=active` or `canary`, `circuit_state=half_open`, and an
exact-scope lease. `disabled` and `monitor_only` never admit inference.

Recovery may close a circuit but never changes `configured_mode`. Availability
is a status projection and never grants routing eligibility.

The first migration gate sets OpenRouter to `disabled` and disables every
legacy OpenRouter backend, discovery, capability-battery, and probe switch.
Network and inference spies must prove zero calls before the common monitor is
enabled. When later moved to `monitor_only`, its
adapter may read catalog metadata but may not infer. When moved to `canary`,
one minimal tool-call probe may qualify an explicitly allowlisted free model.
OpenRouter must never silently select a paid model, a model outside the
allowlist, or a model without qualified tool support.

## Durable provider-neutral paths

Configuration and mutable state use SKGateway-specific XDG paths. The config
root is `${XDG_CONFIG_HOME}/skgateway`, defaulting to
`~/.config/skgateway` only when `XDG_CONFIG_HOME` is unset or invalid. The
state root is `${XDG_STATE_HOME}/skgateway`, defaulting to
`~/.local/state/skgateway` only when `XDG_STATE_HOME` is unset or invalid.

```text
~/.config/skgateway/
  skgateway.yaml
  model-cards.overrides.yaml
  registry.yaml

~/.local/state/skgateway/
  metrics.db
  capacity-state.json
  provider-health.json
  semantic-cache/
  audit.jsonl
```

Immutable `skgateway-runtime-<revision>` directories contain code and package
metadata only. Provider names and client names do not appear in common state
paths.

All runtime paths are absolute after configuration expansion. Startup fails
closed when required state paths are missing, unsafe, or unwritable. SQLite
uses WAL mode, bounded retention, and periodic checkpointing. JSON projections
use atomic replacement. Persistence failures are visible health failures and
must not be silently swallowed.

Directories are owned by the service user with mode `0700`. Configuration
files are `0600` unless a reviewed read-only group requires `0640`. Mutable
files are `0600`. Startup rejects symlinked roots, wrong-owner paths,
group-writable files, world-accessible files, relative configured paths, and
paths that escape their resolved XDG roots.

SQLite observations and snapshots are authoritative. `provider-health.json`
is an atomic, rebuildable compatibility projection and never an independent
source of truth.

Every durable observation carries the runtime revision, configuration
revision, gateway instance ID, boot ID, and schema version.

## Migration from legacy locations

The migration inventories and preserves all known state sources, including:

- `~/skgateway-codex/data/metrics.db`
- `~/skgateway-runtime-4e47ef80/data/metrics.db`
- active SKCapstone gateway configuration and registry sources
- legacy and runtime audit files
- discovery, lifecycle, capacity, and health state
- any durable semantic-cache state

Components that exist only in process memory are recorded as having no
migration source. The migration does not invent durable history for them.

The migration creates XDG targets with restrictive permissions and stages
copies on the same filesystem. It quiesces gateway writes, checkpoints each
WAL, captures hashes, row counts, schema versions, and time bounds, then
verifies SQLite integrity. Each table defines its own stable migration key and
conflict rule. Request ID applies only to request tables. Conflicting records
are retained with source provenance unless a table-specific rule proves exact
identity.

Audit events with stable event IDs are deduplicated by ID and verified hash.
ID-less events are retained with source path, source hash, and import sequence;
whole-record deduplication is forbidden because repeated identical events may
be legitimate. Configuration sources are reconciled by explicit precedence
and recorded hashes, never by directory replacement.

The reconciled store is installed atomically from crash-safe staging. The
manifest records every input and output hash, schema version, count, and time
bound. A crash before activation leaves the old service paths authoritative.
Schema changes require compatibility checks and a down-migration or a proven
old-runtime read path.

The gateway service, monitor, and operator tools switch together to the new
absolute paths. Legacy paths remain untouched during qualification. Temporary
compatibility links may be added only for a named consumer and are removed in
a later cleanup after every consumer is verified.

Rollback restores the previous service and configuration bytes while leaving
verified legacy sources intact. Events written after cutover are replayable
into either a corrected roll-forward store or a compatible rolled-back store.
A rollback must not delete or rewrite the new state store.

## Normalized health contract

The durable model has two records:

1. `ProviderObservation`, append-only evidence from a real response, catalog
   poll, account poll, credential check, local service check, or admission
   decision.
2. `ProviderSnapshot`, one current materialized record per gateway instance,
   provider, backend, opaque account reference, and optional model scope.

Required identity fields are:

- schema version and observation ID
- observed and expiry timestamps
- gateway instance, boot, runtime, and configuration revisions
- canonical provider ID
- backend ID and optional model ID
- scope: provider, account, backend, or model
- stable opaque account reference defined by configuration
- evidence basis: real request, catalog poll, account poll, credential
  metadata, or local control
- probe cost: zero, token, or unknown
- configured mode and circuit state
- exact quarantine scope and normalized reason
- last observation, success, and error timestamps
- evidence expiry and next due timestamps
- consecutive success and failure counts
- provider reset time and persisted backoff step
- a nonsecret opaque credential generation from the credential owner
- half-open lease owner and expiry

Health dimensions remain independent:

- transport: unknown, available, degraded, unavailable
- auth: unknown, ready, near_expiry, expired, missing, rejected
- entitlement: unknown, fresh, stale, denied
- quota: not_applicable, unknown, available, low, throttled, exhausted
- capacity: unknown, available, saturated, quarantined
- inference: unknown, available, degraded, unavailable

An overall projection uses this precedence:

1. Configured off becomes `disabled`.
2. Missing, expired, or rejected auth; denied entitlement; or unavailable
   transport becomes `unavailable`.
3. Throttled or exhausted quota, saturated capacity, or quarantine becomes
   `throttled`.
4. Stale or partial evidence, elevated errors, or near-expiry auth becomes
   `degraded`.
5. Fresh supporting evidence with no blocking dimension becomes `available`.
6. Everything else remains `unknown`.

Missing evidence never becomes zero or healthy.

Deterministic defaults remove ambiguous health transitions:

- `fresh`: evidence age is no greater than its configured cadence plus jitter.
- `recent inference`: a valid matching response within 15 minutes.
- `confirmed terminal failure`: one adapter-owned 401, 403, 402, explicit quota
  exhaustion code, or credential-owner missing/expired result.
- `sustained transport failure`: three consecutive failures across at least
  two monitor cycles.
- `elevated request errors`: at least five matching failures and at least 20
  percent of a minimum 20 matching requests in five minutes.
- `partial evidence`: at least one required dimension is unknown or stale.
- successful recovery: one exact-scope valid inference after the zero-token
  evidence for the failed dimension succeeds.
- monitor request timeout: 6 seconds by default and 8 seconds hard maximum.

Thresholds are versioned configuration with these defaults. Missing samples
do not satisfy a minimum sample threshold.

## Secret and data minimization

Observations and snapshots may include only allowlisted provider IDs, model
IDs, normalized state, timestamps, bounded latency, status class, reviewed
provider error codes, catalog count and hash, numeric quota windows, reset
time, attempt counts, and routing attribution.

They must never contain credentials, authorization headers, refresh tokens,
capabilities, token hashes, raw provider headers, raw error bodies, prompts,
responses, user or account identifiers, session identifiers, credential
paths, private URLs, or physical host details in the dashboard projection.

Provider adapters parse responses into allowlisted fields and discard the raw
body. Logging complete provider responses is forbidden. Operator endpoints
require operator authentication and return only the sanitized projection.

## Provider adapters and zero-token evidence

Each adapter is limited to four small responsibilities:

- `credentialMetadata()`
- optional `pollZeroToken()`
- `parseResponseEvidence()`
- `classifyError()`

Provider behavior:

| Provider | Steady-state zero-token evidence | Recovery inference |
| --- | --- | --- |
| Qwen3.8 | Local service state, `/health`, `/v1/models`, queue and capacity | One minimal request after startup or quarantine when no recent valid response exists |
| Codex | Credential metadata and authenticated model catalog | One minimal request only at startup or half-open recovery, and only without a recent exact-scope valid response |
| Kimi | Credential metadata and authenticated coding catalog | One minimal request after quarantine |
| Z.ai/GLM | Credential metadata, catalog, quota limit, and model usage | One minimal request after reset or quarantine |
| Cursor | Credential metadata and qualified usable-model catalog | None until the inference transport is qualified |
| OpenRouter | Catalog and free-model allowlist only in monitor-only mode | One minimal tool-call qualification in canary mode |

Catalog success proves only transport, authentication, and catalog access. It
does not prove inference quota, concurrency, tool execution, or full workload
compatibility. A real successful routed request is valid passive inference
evidence.

Kimi credential ownership must have one writer. The intended contract is that
the Kimi CLI owns refresh and the gateway consumes a synchronized read-only
copy. Existing gateway refresh behavior must be reconciled before health logic
depends on Kimi credential state.

## Monitoring cadence and overhead

One systemd oneshot timer wakes every 60 seconds with up to 15 seconds of
jitter. The script checks each adapter's persisted `next_due_at`; it does not
poll every provider on every wake.

- Local process, queue, and Qwen checks: 60 seconds.
- Credential metadata: 60 seconds, local filesystem only.
- Z.ai quota: 5 minutes with jitter.
- External provider catalogs: 15 minutes by default.
- Model usage statistics: 30 minutes.
- Recovery: provider reset time when known; otherwise 30 seconds, 2 minutes,
  5 minutes, then a 15-minute cap with 20 percent jitter.
- Maximum concurrent external checks: two.
- Check timeout: 6 seconds by default and 8 seconds hard maximum.
- Retries inside one monitor cycle: zero.
- Scheduled steady-state inference canaries: zero.

A successful recent exact-scope real request suppresses unnecessary startup
and recovery inference.
Only one minimal half-open request is admitted per provider scope.

## Quarantine and automatic recovery

Confirmed auth rejection, entitlement denial, quota exhaustion, or sustained
transport failure quarantines only the proven provider, account, backend, or
model scope. Other policy-eligible providers continue serving traffic.

The circuit sequence is:

```text
closed -> open -> half_open -> closed
                   |
                   +-------> open
```

Quarantine is the affected scope and reason attached to an open circuit. It is
not a configured mode or a separate circuit state.

Zero-token evidence is evaluated first. A successful check moves the scope to
half-open only when it proves the failed dimension recovered. One persisted,
expiring half-open lease admits one minimal inference request bound to the
exact provider, opaque account reference, backend, and canonical model under
recovery. It uses no bucket, alias substitution, fallback, or failover. A
successful request through any other scope cannot recover this scope. Success
closes the circuit; failure reopens it with persisted bounded backoff.

No health transition requires routine manual re-addition. Configuration and
human approval still control whether a provider may ever enter active mode.

## Error taxonomy

Observed upstream status, client-facing status, and typed operational meaning
remain separate. Every terminal result contains `client_status`, nullable
`upstream_status`, `origin`, `reason`, `retryable`, nullable `retry_at`, request
ID, gateway attempt count, and `upstream_attempted`. A provider 401 or 403 is
never represented as failed caller authentication.

| Condition | Observed upstream status | Client status and reason | Health action |
| --- | --- | --- | --- |
| Observed upstream rate limit | `429` | `429 rate_limited` | Quarantine proven scope until reset |
| Confirmed quota exhaustion | provider-owned `402`, `403`, or `429` | `429 quota_exhausted` | Quarantine provider account until reset |
| Local cooldown | none | `503 cooldown_active` | Skip locally and try another eligible provider |
| Queue rejection or timeout | none | `503 capacity_saturated` | Reroute or fail immediately |
| Malformed upstream response | normally `200` | `502 malformed_response` | Fence exact claim and try one eligible alternate |
| Provider authentication rejected | `401` or adapter-owned `403` | `503 provider_auth_unavailable` | Quarantine until credential generation changes |
| Provider entitlement denied | adapter-owned `403` | `503 provider_entitlement_unavailable` | Quarantine affected scope |
| Caller authentication rejected | none | `401/403 caller_auth_rejected` | No provider penalty |
| Invalid request | `400/422` when provider-attributed, otherwise none | `400 request_invalid` | No retry and no provider penalty |
| Client cancellation | none | `499 cancelled` | No provider penalty |
| Absolute deadline exhausted | nullable | `504 deadline_exhausted` | Stop attempts |

A cooldown-only request has origin `gateway`, no observed upstream status, and
`upstream_attempted=false`. It must never be labeled `provider_429`.

`Retry-After` is emitted only when a credible next eligibility time exists.
Provider values accept delta seconds or HTTP date and are bounded by the
request deadline and policy. A malformed 502 has no `Retry-After` because its
recovery time is unknown.

Before output begins, transport failures, timeouts, 429, 502, 503, and 529 may
try another independent eligible provider when the request is replay-safe and
the absolute deadline and attempt budget permit it. Request-invalid, policy,
caller-authentication, provider-authentication, and entitlement failures are
terminal for the affected request unless another already-authorized provider
can serve without repeating a prohibited operation. Model-missing responses
may continue only within the original logical bucket and policy.

After mixed failures, the final response uses the most actionable observed
terminal condition in this order: caller or policy error, confirmed auth or
entitlement denial, quota exhaustion with reset, absolute deadline, local
capacity or cooldown, then upstream transport or malformed response. Audit
retains every attempted condition even when the final response represents a
different one. `Retry-After` is returned only for the selected terminal
condition and only when its retry time is credible.

## Request and session failover

The gateway keeps its existing pre-output request failover and hardens its
boundaries:

- one attempt per candidate
- no more than three upstream attempts per request
- one absolute deadline across admission, upstream calls, and failover
- reroute only before response bytes are emitted
- reroute only to a policy-eligible independent capacity domain
- never retry request-policy, authentication, or entitlement failures blindly
- never sleep inside the gateway between attempts

Budgets do not multiply implicitly. A gateway request allows no more than
three upstream attempts total. An interactive client allows one new gateway
request after the original. The durable scheduler allows two new gateway
requests for batch work and disables the interactive retry layer. Thus an
interactive operation has at most two gateway requests and a durable batch
operation at most three, each with its own maximum of three upstream attempts
and all bounded by one operation deadline carried across layers. If a known
retry time exceeds that remaining deadline, the request fails or is deferred
instead of waiting.

The client owns conversation history and resends it on the next turn. The
gateway may serve consecutive turns through different providers while keeping
route and served-model attribution. It does not store conversation content.

After SSE headers or bytes are emitted, the HTTP status cannot change. A
provider failure emits one terminal SSE `error` event with request ID, origin,
reason, retryability, and attempt count, then closes the stream. The audit row
records `partial_stream_failed`. The gateway never splices another provider's
output onto the partial response because that could duplicate tool calls or
corrupt the answer.

Interactive agent routes default to no gateway queue. Long waits belong in a
durable scheduler. Any explicitly enabled batch queue is bounded by depth,
remaining deadline, cancellation, and a short wait limit.

## Semantic cache shadow

The source baseline has semantic cache disabled. The target state is
`semantic_cache.enabled: true` with `mode: shadow`, activated only after stable
state paths, policy-first classification, tenant isolation, redaction, and
failure isolation pass their gates. Shadow observations do not serve responses
or alter routing.

Persisted statistics include observed, would-hit, would-miss, similarity
distribution, embedding latency, estimated avoided tokens, model and route
compatibility, exclusions, and freshness. Reports calculate statistics within
the requested time window instead of displaying an old cumulative event.

Cache failure is independent of provider health and fails open to ordinary
routing. Classification, tenant, and policy checks run before embedding. A
durable shadow record contains only an embedding or nonreversible fingerprint,
sanitized compatibility metadata, bounded similarity, outcome counters, and
timing. It contains no prompt or response payload, credential, protected
content, or raw cache key. Current process-memory shadow entries have no
migration source and are explicitly recorded as such.

Future serving eligibility must bind tenant, classification, policy revision,
logical route, model family, prompt revision, schema revision, and tool
compatibility. Tool-bearing requests remain ineligible unless a separate
tool-safe cache contract is approved. Serving mode requires separate human
approval, measured answer quality, isolation and invalidation tests, exact
rollback, and source/version safety.

## Operator metrics API

The initial versioned, read-only operator metrics surface is:

- `GET /operator/v1/status`
- `GET /operator/v1/providers`
- `GET /operator/v1/models`
- `GET /operator/v1/buckets`
- `GET /operator/v1/routes`
- `GET /operator/v1/cache`
- `GET /operator/v1/errors`

These authenticated metrics routes are distinct from the existing public
`/operator/v1/healthz`, `/operator/v1/readyz`, `/operator/v1/explain`, and
`/operator/v1/observe` facet. They require the dedicated
`skgateway.metrics.read` capability and the local-operator route
classification. A separate, more privileged `skgateway.backends.read`
capability may include backend IDs in a local projection. Ordinary metrics
responses omit them.

Every endpoint returns this envelope:

```json
{
  "schema_version": "1",
  "generated_at": "RFC3339 timestamp",
  "fresh_until": "RFC3339 timestamp or null",
  "stale": false,
  "window_seconds": 3600,
  "next_cursor": null,
  "data": [],
  "errors": []
}
```

Timestamp fields are UTC RFC3339. Unknown values are `null`, never zero or an
empty success. `errors` contains only typed projection or freshness errors and
never provider bodies. The default window is 3600 seconds and the maximum is
86400 seconds. Default page size is 100 and maximum page size is 500. Cursors
are opaque, stable only for the query and snapshot revision, and expire after
15 minutes. Current-state endpoints may omit window and cursor fields by
setting them to `null`.

Endpoint projections are:

- `status`: runtime, configuration, schema and boot revisions, uptime,
  persistence readiness, observation freshness, and overall availability.
- `providers`: configured mode, circuit state, transport, auth, entitlement,
  quota, capacity, inference, quarantine scope and reason, retry time, quota
  windows, last success and error, and evidence freshness.
- `models`: canonical and requested model IDs, provider, qualification state,
  tool support, context and size classes, recent latency and errors, and
  effective eligibility.
- `buckets`: logical bucket, ordered original members, canonical targets,
  eligibility or exclusion reason, selected provider and model, failovers,
  and recent outcomes.
- `routes`: aggregated logical route, bucket, original member, canonical
  model, provider, served model, status, latency, and failover chain.
- `cache`: shadow observations, would-hit and would-miss counts, similarity
  distribution, embedding latency, exclusions, freshness, and estimated
  avoided tokens.
- `errors`: client and upstream status, origin, reason, provider, model,
  bucket, retryability, retry time, attempts, queue time, cooldown, and
  deadline outcomes.

The route chain preserves:

```text
logical route
  -> bucket
  -> original bucket member
  -> canonical model
  -> provider
  -> backend and capacity domain
  -> served model
  -> status, latency, failover, and retry outcome
```

Endpoints use bounded time windows and pagination. Current snapshots are
pre-aggregated for fast refresh. SQLite indexes cover time, provider, bucket,
model, and status. Request IDs belong in audit and drill-down results, not
metric labels.

The dashboard projection excludes private URLs, backend IDs, and physical
resource names. The separately authorized local backend projection may expose
backend IDs but still excludes credentials, private URLs, and host secrets.

## Alerts

Alerts fire on transitions or sustained conditions, not every failed request.

Critical conditions:

- audit or metrics persistence unavailable for governed traffic
- credential missing or expired on the sole eligible provider
- all policy-eligible providers unavailable
- secret-redaction invariant failure

Warnings:

- auth rejected or entitlement denied
- provider-wide quota exhaustion
- local capacity continuously saturated for two minutes
- a circuit opens
- two failed monitor polls or evidence older than twice its cadence
- provider-reported quota at or below 10 percent remaining
- repeated malformed response and cooldown cycles

Alert identity is provider, opaque account reference, health dimension, and
reason code. Duplicate alerts are suppressed for six hours. Recovery emits one
resolved event after the required successful evidence.

## Reporting

`skgw-lanes` discovers effective configured state and audit paths. It reports
stale or split telemetry explicitly and never equates a missing lane with a
healthy or broken lane.

For the selected window it summarizes providers, logical routes, buckets,
models, canonical served models, errors by origin, failovers, quarantines,
queue activity, deadlines, and semantic-cache shadow behavior. Cache audit
fallback parsing applies the same requested time window.

## Testing

Required automated evidence includes:

- normalized classification for every error row in this specification
- a malformed response becoming 502 without provider-rate-limit attribution
- a cooldown-only request making no upstream call and returning typed 503
- observed upstream 429 retaining its exact origin and bounded reset
- automatic quarantine, half-open admission, recovery, and re-quarantine
- disabled and monitor-only providers receiving no inference traffic
- OpenRouter rejecting paid, non-allowlisted, or tool-unqualified models
- alias canonicalization and bucket continuation after quarantined members
- no reroute after streamed bytes
- attempt and wall-clock limits under sequential failures
- queue rejection, timeout, cancellation, and slot release
- runtime replacement preserving state paths and history
- idempotent reconciliation of both existing metrics databases
- operator endpoint schemas, authentication, bounds, and redaction
- secret scanning of source, fixtures, logs, audit, and evidence
- semantic-cache shadow isolation, time-window accuracy, and fail-open behavior
- migration and rollback rehearsal with exact hashes
- zero-token proof using network and inference spies
- zero OpenRouter calls across every legacy switch while disabled
- exact-scope, no-fallback recovery canaries
- concurrent half-open lease exclusion
- configured-mode and circuit-state independence
- persisted backoff across restart
- XDG environment, default, relative-path rejection, ownership, permission,
  and symlink safety
- migration collision, crash, restart, all-artifact, rollback, and roll-forward
  recovery
- provider-health projection rebuild and SQLite parity
- tool-call qualification for every enabled model that claims tool support

Focused tests run before the full SKGateway suite. Deployment requires an
independent review tied to the exact candidate revision and immutable evidence.

## Rollout

1. Force OpenRouter `configured_mode=disabled`, disable all legacy OpenRouter
   backend, discovery, capability-battery, and probe switches, and prove zero
   DNS, HTTP, and inference calls.
2. Confirm the merged S/M quarantined-member bucket repair with live canaries.
3. Introduce provider-neutral XDG paths and reconcile existing state.
4. Repair `skgw-lanes` path discovery, windows, and error signals.
5. Add normalized error semantics and bounded failover.
6. Persist passive provider observations and current snapshots.
7. Add qualified zero-token provider adapters.
8. Enable automatic quarantine and recovery by provider mode.
9. Enable semantic cache with `enabled: true`, `mode: shadow` after its
   persistence, classification, isolation, and redaction gates pass.
10. Add authenticated operator metrics endpoints.
11. Validate the disabled OpenRouter adapter offline without activation.
12. Run controlled provider canaries, independent review, deployment, and
    rollback verification.

Each rollout step receives its own claimable card and acceptance evidence.
No step may silently expand provider activation or external traffic.

## SKGateway documentation updates

Implementation completion requires updates to the existing SKGateway
documentation structure for:

- architecture and provider-health contract
- configuration and provider lifecycle modes
- error, retry, and automatic recovery semantics
- operator metrics API schemas
- monitoring and alert runbook
- XDG state migration and rollback
- semantic-cache shadow operation
- provider onboarding and qualification
- security and redaction requirements
- troubleshooting for 429, 502, cooldown, quota, and stale telemetry
- changelog and exact completion evidence

## References

- Z.ai official GLM usage plugin:
  <https://github.com/zai-org/zai-coding-plugins/tree/main/plugins/glm-plan-usage>
- Z.ai Coding Plan documentation: <https://docs.z.ai/devpack/overview>
- Kimi Code documentation: <https://www.kimi.com/code/docs/en/>
- Cursor authentication documentation:
  <https://docs.cursor.com/en/cli/reference/authentication>
