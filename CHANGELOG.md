# Changelog

All notable changes to SKGateway are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- SKGateway now serves its own operator facet on the daemon's existing port:
  `GET /operator/v1/{healthz,readyz,explain,observe}` and a reserved
  `POST /operator/v1/act` that always returns 501. This fixes the dead-`spec.cli`
  problem (the `skgateway` binary is not on the control-plane node's PATH) without
  waiting for the node move, and makes that later move a one-field endpoint update.
  Conditions come from in-process state, never a self-HTTP probe: `UpstreamServing`
  from the live per-backend health table, `PoolHealthy` from quarantine flags plus
  real queue/capacity numbers, and `CatalogFresh` from the discovery cache. Every
  condition renders only True/False/Unknown with a specific reason code; a
  cold-start backend yields `Unknown (NoObservedTraffic)` rather than a fabricated
  healthy, and one failing data source degrades only its own condition.

### Fixed

- Made a declared `backends` mapping authoritative instead of deep-merging
  omitted built-in backends back into service. Operators can also use the
  schema-valid `enabled: false` tombstone. Removed backends are excluded from
  discovery, advertisement, and bucket inputs, while orphan direct or
  `reg:<backend>` pooling references now fail startup validation.

- Cost-rank bucket members only after capability and trust eligibility, rotate
  equal-cost peers, and bound bucket completion liveness so a listed but hung
  backend fails over instead of holding the route. The fleet has no declared
  S-class model, so `sk-s-*` remains explicitly a capability floor pool.

- Honor dashboard and metrics disablement during startup. Disabled qualification
  configurations no longer create the dashboard listener, initialize the metrics
  database, expose the dashboard redirect, permit a forced discovery refresh, or
  forward events when SIEM is explicitly disabled.

### Documentation

- Documented least-privilege GitHub authentication bootstrap for headless fleet
  nodes, including repository-local credential isolation, secret-handling rules,
  verification, and the required rotation of broad break-glass PATs.
- Reworked the SOP into the complete graded-routing runbook: card grade to
  `skharness` override to SKGateway bucket pool, live membership/failover,
  Ornith 1.5's verified 32768 context, custom-alias lifecycle semantics,
  GitHub-only fleet rollout, duplicate-listener diagnosis, and hermetic drift
  checks for the new surfaces.

### Added

- Added `scripts/sync-pi-models.mjs` and `npm run sync:pi-models` to
  synchronize Pi's `skgateway` provider from the live `/v1/models` catalog.
  The tool includes bucket aliases, preserves unrelated Pi configuration,
  refuses empty catalogs, supports dry-run, and writes atomically.

- Added the GitHub-tracked `.100` Ornith 1.5 launcher and user unit, pinning the
  verified model alias, model path, port, 32768 context, CUDA settings, and
  restart backoff so the backend is reproducible by clone/pull rather than an
  untracked script in the third-party inference checkout.

### Fixed

- SKGateway now consumes the authenticated `claude-code-api` model catalog as
  an authoritative Anthropic discovery source. Newly available Claude IDs are
  advertised and routable automatically, retired IDs accrue lifecycle absence,
  and wrapper outages retain the last-good catalog.
  Cold-start YAML entries are replaced after a successful refresh and cannot
  leak a retired alias back into the cache or `/v1/models`.

- Bound the direct `chiap08-qwen38` route and registry-backed `reg:qwen38`
  route to one explicit four-slot admission domain. The domain has a bounded
  four-request FIFO queue and a 30-second queue SLA; full and expired queues
  now return distinct retryable `503` responses with `Retry-After`, while a
  queued client disconnect is removed immediately and remains a no-failover
  `499`. `/queue` exposes active, queued, timeout, drop, and cancellation
  counters for the shared domain, including its zeroed idle state. Admission
  tickets are unique, pool-owned, and single-use, so duplicate, forged,
  foreign-pool, or legacy string releases cannot under-report active work or
  promote a queued request early.
- Made the qwen38 SOP invariant runnable in the dependency-free documentation
  job while retaining the full YAML-aware regression in the normal test suite.
- Aligned the checked-in chiap08 Qwen3.8 declaration with the model actually
  served by `llama-qwen38.service`: `qwen3.8-27b-huihui-abliterated-q4_k_m` is
  now the canonical first model, while the former UD-Q5 id, short id, and
  `qwen38-abliterated` are explicitly documented compatibility aliases. All
  four ids now share truthful Huihui Q4_K_M model cards and the qualified 256K
  sanitizer limits, with a hermetic source-config regression test.
- Propagated downstream client disconnects to the active model request. The
  router now cancels upstream generation immediately, releases its pool slot,
  records a distinct `499/client_closed` outcome, and deliberately skips
  failover, backend-health penalties, and model-lifecycle mutation.

- Qualified and deployed three parallel Ornith slots on `.100`, each retaining
  the full 65,536-token window (`--parallel 3 --ctx-size 196608`). Three-way
  32K/48K concurrency, direct cancellation, and bounded restart gates passed;
  a fourth slot is intentionally rejected for insufficient VRAM headroom.
- Qualified Ornith 1.5 on node `.100` at a 65,536-token live context with
  successful 32K, 48K, and 60K prompt-generation gates and more than 6GB VRAM
  headroom; updated its card, sanitizer limits, launcher, and operator SOP.
- Added a distinct `auto.context_role` for oversized conversations so context
  overflow can route to a long-context backend without changing ordinary hard
  prompt routing. This prevents 32K Ornith from receiving large Hermes DMs.
- **T-shirt sizing buckets are now visible and truthful end to end.** When
  `routing.buckets_enabled` is on, `/v1/models` advertises all 12 canonical
  `sk-<class>-<sensitivity>` addresses and `/admin/buckets` evaluates the same
  serving-config/discovery union, provider postures, lifecycle state and
  claimer-aware gate as the request path. This fixes internal/secret pools
  appearing empty while routable local and Anthropic models existed.
- **A bucket now fails over across members, not only across doors for one
  member.** Rotation chooses the first member, then 402/429/5xx and
  bucket-scoped 404/410 advance through the remaining eligible members without
  changing concrete-model semantics. Responses expose `x-sk-bucket` and
  `x-sk-bucket-member` from the serving attempt.

- **A backend's declaration of a model id now beats a lifecycle verdict the
  declaration's provider never produced** (incident `inc-2026-08-18-qwen38-eol`
  / problem `prob-2026-08-18-model-discovery-validation`). `qwen38-abliterated`,
  declared under the local `chiap08-qwen38` backend (llama.cpp serves it
  name-agnostically, verified 200), was condemned to `eol/provider_410` by
  404/410s from NON-claiming backends in a fail-over spray — nvidia answers
  404 to an alias it does not host — and the EOL record then gated the healthy
  local door in `candidatesFor()`'s matched branch (card C4), so every request
  404'd while chiap08 served it fine. Four coordinated changes:
  1. `isEffectivelyRoutable()` (`src/discovery/lifecycle.mjs`), now used by
     the router's gate in BOTH `candidatesFor()` branches: a non-routable
     record only preempts a claim when it is attributed to the claiming side
     (provider tag set and equal to every claimer's name — the card C4 shape:
     nvidia 410'd the id and nvidia is the only claimer). An unattributed
     record (completion-path records carry no provider tag) or a verdict
     against a different provider does not overrule a claim — multi-provider
     ids stay routable while any other claimer survives, and a locally-served
     alias is never gated by a foreign catalog's say-so. No claimers: exactly
     the card P1.6 behavior.
  2. `recordModelOutcome()` (`src/discovery/model_catalog_store.mjs`) is
     claimer-aware: the router now passes whether the attempted backend
     DECLARES the model, and a 404/410 from a non-claiming door no longer
     accumulates toward the model's EOL (a 2xx always counts; no claimers at
     all counts, so card P1.6's spray-avoidance for unclaimed ids is intact).
     Genuinely dead on the only claimer is still condemned by the claimer's
     own 410s.
  3. The provider probe sweep skips ids another backend declares
     (`selectProbeCandidates`/`probeModels` `excludedIds`, computed from the
     live config by `declaredModelsElsewhere()` in `src/discovery.mjs`), so
     nvidia's 410 during a sweep cannot retire a locally-served or
     multi-provider id — "only EOL if ALL providers fail."
  4. `applyLifecycleView()` (`src/index.mjs`) uses the same claim-aware rule
     with per-id claimers (`modelClaimersFor()`), so the advertised
     `/v1/models` catalog and the routable set cannot disagree: a model that
     routes is advertised, one that does not route is not. `reconcile: hide`
     still omits anything with no available serving backend on top of that.

  Verified end to end on the live node: with a residual EOL record seeded for
  `qwen38-abliterated`, `POST /v1/chat/completions` resolves 200 through the
  gateway onto chiap08 (content `alive`, served id
  `qwen3.8-27b-huihui-abliterated-q4_k_m`), then recovers eol → suspect →
  active under the normal promotion thresholds; a claimer-attributed EOL id
  (`qwen/qwen3.5-122b-a10b`, nvidia-tagged, nvidia-claimed) still answers a
  clean 404 + `eol_reason` with no upstream attempt. New suite
  `tests/model-claimer-lifecycle.test.mjs` (23 tests) plus the two new
  `tests/router-eol-gate.test.mjs` scenarios; 1305/1305 passing.

- **Registry-routed doors (`reg:<name>`) now appear in `getHealth()`.** They
  live in the module-level `_regBackends` map rather than the router's
  configured `backends`, and `getHealth()` only walked the latter, so the path
  that serves most traffic recorded outcomes into objects nothing ever read. A
  request through `sk-default` records against `reg:ornith` while `/health`
  reported on `local` / `ollama` / `anthropic`, sets that never intersect. That
  is why those two sat at `lastCheck: 0` indefinitely and a hard-down machine
  read as healthy on 2026-08-16. The outcomes were recorded correctly the whole
  time; they were never reported. Configured backends win on an id collision, so
  a `reg:` door can never shadow a declared backend's health.

### Added

- **`request_log.model_served`: the model the upstream actually answered with**
  (card 316dd167 / A8). No table in `metrics.db` carried a served-model column.
  `request_log.model` and `token_usage.model` are both the model the CALLER
  ASKED FOR, and across all 1,445 joined rows on the live database they never
  once disagreed, because they are copies of one value. So the gateway was
  throwing away the only fact that distinguishes a silent substitution from an
  ordinary call: a backend that quietly answered with something else wrote a row
  identical to one that served exactly what was requested. The value is read
  from the response body already parsed at the metrics call site
  (`src/index.mjs`), so this adds zero parsing and zero network. Verified live
  before implementing: a request for `sk-default` came back naming
  `ornith-1.0-9b`, and one for `sk-m-internal` came back naming
  `claude-sonnet-5`.

  **NULL means UNOBSERVED and never "same as requested."** When the body is SSE
  or non-JSON the parsed body is already null, so the column is naturally NULL
  on exactly those paths with no special-casing, the same discipline
  `energyHeaders()` follows ("individually absent, never empty, for any field we
  do not know"). Defaulting it to the requested id would make every request look
  like it got what it asked for, turning an absence of evidence into fabricated
  evidence of a match. Two negative controls in
  `tests/served-model-and-agent.test.mjs` pin that against the live gateway.

  This is a DIFFERENT fact from the `x-sk-model-served` header added by card
  3351d25b, which carries `result.servedModel`, the model id the ROUTER
  dispatched. That echoes the request whenever no rewrite happened. Measured
  against a stub upstream answering with a different id, the header said
  `a8-model` (what was asked for) while the body said `stub-substituted-9b`
  (what answered). Only the column can expose a substitution.

- **A schema-migration path for `metrics.db`, which had none.** The whole schema
  was a single `CREATE TABLE IF NOT EXISTS` block, which is exactly the
  statement that does nothing to a table that already exists, so any column
  added to the DDL after a node's first boot landed only on databases created
  fresh afterwards and silently never reached the live one. `ensureColumn()` /
  `migrate()` in `src/metrics/collector.mjs` run on every collector
  construction, are idempotent, and are additive only: SQLite's `ALTER TABLE ADD
  COLUMN` rewrites no rows, so it is safe against the live 8,199-row file. There
  is still no version counter and no down-migration; this is the smallest thing
  that makes one additive column land, not a general migration framework, and it
  is flagged as such in the code.

  **Existing rows are NOT backfilled.** `model_served` reads NULL on every row
  written before this change, which is the correct value: history is not
  retroactively attributed on this fleet.

- **Regression cover for the `request_log.agent_id` write path**, which was
  NULL on all 8,199 rows on the live database and had never once been populated.
  Measured against unmodified `main` while writing these tests: the write path
  itself is CORRECT today, and a caller sending `X-Agent-Id` is attributed all
  the way through `request_log`, `token_usage` and `cost_log`. The column is
  empty because no live caller sends any identity at all, not because the
  gateway drops one. There was no test asserting it ever lands, which is how it
  stayed empty across a call-site rewrite; there is now.

- **Attribution response headers on every `/v1/*` reply: `x-sk-req-id`,
  `x-sk-backend`, `x-sk-model-served`** (card 3351d25b / A6.2). The gateway has
  always written `(id, agent_id, model, backend, session_id, ...)` into
  `request_log` and returned none of it, so a caller holding a response had no
  key to look its own request up by: it could see that the gateway answered and
  could not see which row that answer was. The three headers ride the same
  merge path as the existing `x-sk-energy-*` headers, so streaming is covered
  by construction (`SSEWriter`'s `extraHeaders`), and they follow the same two
  rules. Unknown fields are ABSENT, never empty, because a header that is
  always present proves nothing: an EOL-gated 404 or an
  all-candidates-throttled 429 has no serving backend and says so by not
  claiming one. And they describe the SERVING attempt only, never a blend
  across a failover, matching the ruling the energy headers already carry.
  `routeAndSend()` now returns `servedModel` (the model the winning door
  actually served, which differs from the requested id for `@match`,
  cloud-fallback and registry candidates).

### Fixed

- **Two canonicalisers for one agent id, so the same caller could be attributed
  twice** (card 316dd167 / A8). `extractIdentity()` has always applied
  `.trim().toLowerCase()` to `X-Agent-Id`, while the inline identity object
  `src/index.mjs` builds when `identity.enabled` is false used the raw header.
  The same caller was therefore recorded as `Lumina` or `lumina` purely
  depending on a config flag, and `getTokenUsage()` / `getCosts()` filter with
  `agent_id = @agentId`, an exact match, so one agent's spend would split
  silently across two keys that no query joins back together.
  `normalizeAgentId()` in `src/identity/capauth.mjs` is now the single
  definition and both paths call it.

  It also maps the literal `anonymous` to null. `ANONYMOUS_AGENT_ID` is the
  value the resolver returns to mean "nobody identified themselves", so storing
  it would make unattributed traffic aggregate under what looks like a real
  agent. **Behaviour change worth a reviewer's eye:** because `extractIdentity`
  now returns `method: 'anonymous'` for that header, the opt-in
  `require_agent_id` auth gate rejects it where it previously passed, i.e. the
  gate could be satisfied by typing the sentinel that means "I am not
  identified". That gate is OFF by default and OFF on this fleet, so nothing
  live changes.

  For the record on the rest of `agent_id`: the write path itself was already
  correct, and none of the current live callers sends any identity at all.
  skcode / Claude Code sends `Authorization: Bearer sk-local`, `user-agent:
  claude-cli/...` and `x-app: cli`; skos, skcapstone, skchat and the Hermes
  provider send `Content-Type` and nothing else. That bearer literal is shared
  verbatim by skcode, the pi adapter and the opencode adapter, so it names a
  class of caller rather than an agent, and a user-agent names client software.
  Deriving an agent from either would be inventing one, so on those paths the
  gateway records NULL and the call site now documents exactly what it looked at
  and why. Attribution for them is a client-side change (send `X-Agent-Id`).

- **`request_log.backend` is NULL on every row written since 2026-08-15, and the
  table has never held one complete row.** Measured on the live database: 6,638
  of 8,130 rows DO carry a backend, and those are exactly the rows whose
  `status_code` and `total_ms` are null. The complement is exact. Before the
  cutover a row carried the serving backend and no outcome; after it, the
  outcome and no backend. `recordRequest` was moved to run BEFORE dispatch, where
  the backend genuinely is not yet known, and the post-response `UPDATE` never
  touched that column (it dates to the table's creation), so nothing filled it
  back in. The code comment saying `// not chosen yet; overridden on response`
  asserts an override the SQL does not perform. `token_usage`, `cost_log` and
  `latency_log` beside it all record the backend correctly from the same
  close-time data, which is what localised the bug to this one statement. Found
  while proving the new `x-sk-backend` header joins to its row: the header named
  `stub` and the row it pointed at named nothing. The update now sets
  `backend = COALESCE(@backend, backend)`, so a known serving backend lands and
  an unknown one leaves whatever is already there. NOTE for anyone reading the
  historical data: do NOT discard the pre-2026-08-15 rows as empty, they are the
  only rows that carry a trustworthy backend.

- **A never-probed backend reports `status: "unknown"`, not `"up"`.** Backend
  health is derived from observed request outcomes, never from active probing,
  so `BackendState` is constructed at the optimistic `"up"` and keeps it until
  something fails. A backend nobody had called was therefore indistinguishable
  from a healthy one. On 2026-08-16 the machine hosting `local`
  (`192.168.0.100:8082`, ornith) and `ollama` (`192.168.0.100:11434`) was hard
  down for over an hour while `/health` reported both as `up` with
  `errorRate: 0` and `lastCheck: 0`, and `sk-default` failed over to a cloud
  model and answered perfectly. `getHealth()` now also returns `observed`, so
  "0 errors out of 0 requests" cannot read as a clean bill of health. Selection
  is deliberately unchanged: `isAvailable()` still admits an unobserved
  backend, because the failover behaved correctly and treating unknown as down
  would refuse every backend at boot.

### Added

- Model cards for `claude-opus-5` (size_class XL) and `claude-sonnet-5`
  (size_class L). Without an overlay entry these arrive with `size_class` null,
  clear only capability floor S, and are silently ineligible for `sk-l-internal`
  and every bucket above S. Present in the catalog but unusable is worse than
  absent, because it looks like it works. `size_class` is curated for the same
  reason as `claude-opus-4-8`: parameter counts are unpublished and irrelevant
  for a hosted static model, so the class is a declared floor rather than a
  derived one. Sonnet 5 is L rather than XL, mirroring Sonnet 4.6, so that
  `sk-xl-*` work cannot land on a mid-tier model through a generous label.

### Fixed

- `npm test` no longer overwrites the production model catalog cache. `saveCache()`
  defaulted to the production path with no env override and no guard, while the
  reader has honored `SKGATEWAY_MODEL_CATALOG_CACHE_PATH` since P4.2. The reader
  honored the variable and the writer ignored it. Running the suite silently
  emptied the sovereign and Anthropic tiers on a live node, leaving a fresh mtime
  the whole time, so every freshness check passed. Fresh-and-wrong is harder to
  notice than stale-and-wrong. Guarded with an env override, an `_setup.mjs`
  default, and `assertNotProductionCacheInTest()`.
- The match catalog is now the union of the discovery cache and the configured
  serving backends, built in `buildServingCatalog()` upstream of
  `applyCardOverlays`. Placement matters: `buildMatchCatalog()` never calls
  `applyCardOverlays`, so a union added in `router.mjs` would arrive with no
  `size_class`, clear only floor S, and still fail `sk-l-secret` while appearing
  present in the catalog. Discovery wins on every field it carries; serving
  config supplies existence only. `provider` deliberately keeps the discovered
  value, so an id reachable both remotely and via a local declaration retains its
  `trains` posture rather than being relabelled sovereign.
- Note for future readers: the union is NOT the fix for the missing sovereign and
  Anthropic rows. The cache guard is. The union alone would have masked the
  corruption by restoring exactly the rows the clobber removed.
- Provider trust-zone postures are now wired into the capability catalog build.
  `loadProviderPostures()` existed but was called from nowhere in `src/`, so
  `deriveTrustZone()` returned zone 2 for every non-local model including
  Anthropic. Because `internal` has ceiling 1 and contractual-zero is Anthropic
  only, `sk-*-internal` admitted local models only and the internal tier was
  inert. It failed safe, which is why it went unnoticed. Behavioral change worth
  noting: `internal` buckets widen from local-only to local plus Anthropic.
  `secret` stays sovereign-only and no training provider moves.
- The bucket routing path could not execute at all. `resolveBucketCandidates()`
  referenced `emitSiem`, a const declared inside `routeAndSend`, from a
  module-level function, so every bucket resolution threw `ReferenceError`
  before reaching the fail-closed 503. It also never awaited the async
  `router.route()`, so the Promise was wrapped as a candidate and threw a
  `TypeError`. The documented `bucket_no_eligible_member` 503 body was therefore
  unreachable code. A valid bucket id failed exactly as hard as a typo.
- A mistyped bucket id no longer falls through to `defaults.role`. Previously
  `sk-xl-secrets` failed the bucket regex, was still caught by
  `isRegistryRouted()`, and resolved via `sk-auto`, returning 200 from an
  arbitrary model with no sensitivity ceiling enforced. It now returns 400
  `invalid_bucket_id`, because the address is wrong and retrying cannot fix it.
  Registry-defined ids such as `sk-default`, `sk-auto` and `sk-heavy` are
  exempt and still route.

### Added

- Integration tests for the bucket and sensitivity paths, which previously had
  none: `tests/` had zero references to `buckets_enabled` or
  `sensitivity_enforced`. Both 503 contracts are now asserted field by field,
  and the shadow-versus-enforce toggle uses the identical request on both sides
  of the flag so it cannot pass while the flag is ignored.
- Documented in the config example that `routing.sensitivity_enforced` is inert
  without `routing.match_enabled`, since only the latter populates
  `request.requirements`. Enabling sensitivity first yields a gate that looks
  enforced and enforces nothing.

## [0.6.0] - 2026-08-15

### Fixed

- **The advertised catalog was INVERTED, not merely stale** (card `767adc4e`). 83 models
  live in a provider's catalog were marked `eol` and hidden, while 7 the provider had
  retired were marked `active` and advertised; 6 of 16 advertised ids returned 410 Gone.
  OpenRouter was a total blackout: 21 of 21 records `eol` with zero advertised, while the
  provider healthily returned 16 models every hour. Two independent causes.
- **`sliceByProvider` was blind to config-declared models.** Presence reconciliation was
  scoped to store entries already carrying a `provider` tag, and completion-path records
  never get one. A model declared in `backends.<provider>.models` but absent from every
  live fetch could not accumulate `absent_cycles`, so it was structurally immune to the
  mechanism built to retire it. Its only death path was three consecutive real-caller
  410s, which bills a user a failed request per increment.
- **The test suite wrote to the production lifecycle store.** Records were found stamped
  with injected test clocks (`eol_at` 1000/4000/10000) and synthetic fixture ids. One
  model's `absent_cycles` moved 24 to 36 to 60 in a single session purely because the
  suite ran. Fixed in two layers: `tests/_setup.mjs` preloaded via `node --test --import`
  redirects the path before any module loads, and a guard throws if anything still
  reaches the live path.
- **An `eol` record with no prior verification could never recover.** Catalog presence
  now promotes such a record to `suspect` (routable and flagged), gated on
  `eol_reason: dropped_from_catalog`, since the provider listing it again contradicts why
  it was retired. A `probe_failed` record is not overturned by mere membership.
- **The eol gate gave a dead model up to an hour of live routing**, because it was only
  consulted when no backend claimed the id and `Backend.models` is an hourly snapshot.
- **Unrecognized `require` keys failed OPEN**, silently admitting every candidate. A
  `require: {sensitivity: secret}` would have been a placebo.
- **The probe sweep was unreachable, not merely disabled.** `refreshCatalog` never
  forwarded its options, so setting `discovery.probe_seconds` did nothing.
- **Promotion needed only one lucky 2xx** while demotion needed three consecutive
  failures, so a model succeeding one request in four parked permanently in `active`.
- **The non-chat filter was an id-regex denylist that failed open**, in three hand-synced
  copies. A document parser, a video detector and two music models were advertised as
  chat models.
- **A caller's `authorization` header was forwarded to third-party providers** whenever a
  backend's `api_key_env` was unset. Reproduced live: a request with a bearer came back
  with OpenCode's own `AuthError`, proving the relay. Client credential headers are now
  stripped before backend auth is merged, and internal control headers no longer leak our
  topology upstream.
- **A 429 counted as success**, so the router never failed over from a throttled free
  model. 429 and 402 are now failover-worthy with model-granular cooldowns; 403 stays
  terminal.
- **A discovery provider could be advertised but unroutable.** `providerBackend` hardcoded
  two names, so enabling a third provider put 7 models on `/v1/models` that all 404'd.

### Added

- **OpenCode Zen as a free-model provider**, including `big-pickle` and a 1M-context
  `nemotron-3-ultra-free`. Liveness comes from Zen, the model card from models.dev, and
  free is decided by cost rather than an id suffix (big-pickle is free and has no `-free`
  suffix).
- **Bucket pools** (`sk-<model_class>-<sensitivity>`): address the work, not a model. A
  bucket cannot rot; only its membership changes. Fails closed with a 503 listing what was
  excluded and why, and rotates across members rather than hammering the favourite.
- **Trust-zone sovereignty gating.** Job sensitivity (public/internal/secret) maps to a
  model trust-zone ceiling (0 sovereign, 1 paid-contractual, 2 free-remote), enforced in
  the ranker AND in the failover path. Deliberately inverts the cost ladder: verified from
  provider terms, nvidia, openrouter and opencode all train on submitted content. Ships
  OFF behind `routing.sensitivity_enforced`, shadow-logging first.
- **Capability assessment**: measure tool calling, structured output, instruction
  following and the minimum `max_tokens` at which a reasoning model returns content.
  Measurement can only LOWER a class, never raise it.
- **`not_chat` as a third lifecycle disposition**, set only by the probe sweep. 400 and
  500 remain excluded from the eol path.
- **Model metadata**: `params_b`/`active_params_b` (MoE-aware), `size_class`,
  `latency_class`, `min_output_tokens`, plus dated per-provider data-retention postures.
- **Host namespacing** (`chiap08::qwen3.8-27b`), additive, with the single-slash form
  resolved by lookup rather than by syntax.
- **A daily catalog verification job** with per-provider liveness, provider representation
  (the check that would have caught the OpenRouter blackout), count divergence, and
  failover redundancy alarming below 2 live entries.
- **A reproducible lifecycle-store repair script.**

### Notes

- `discovery.probe_seconds` remains unset, so the probe sweep is wired but not running.
  Enabling it is a deliberate operator decision: the first sweep makes real calls against
  roughly 100 models and that quota is shared with live traffic.
- Bucket pools, trust-zone enforcement and capability assessment all ship OFF.


### Documentation

- **SOP: the `0.0.0.0` bind is now stated as a DEVIATION, not as compliance.** §2's
  exposure subsection previously read "Bind: `server.bind` (127.0.0.1 or tailnet); never
  expose a raw public port", which restated `UNIFIED_INGRESS_STANDARD` as though it were
  met. It is not: `src/config.mjs:81` defaults to `0.0.0.0` (all interfaces, broader than
  the tailnet) and both fleet nodes are live on `0.0.0.0:18780` / `0.0.0.0:18781`. The
  blast radius is now scoped accurately as LAN + tailnet, with the reasoning: no public
  interface on either node, and Tailscale Funnel publishes only `:443` / `:8443` /
  `:10000`, none of which reach the gateway.
- **SOP: documented the Anthropic-compatible `POST /v1/messages` front end**
  (`src/index.mjs:1347`), matched by **pathname** so Claude Code's `?beta=true` still
  hits it, and the default logical role `sk-default`.
- ~~**SOP §4: added an explicit "CI cannot fail" gap.**~~ Superseded within this same
  Unreleased block: the gap is closed under "Added" and "Fixed" below. The finding was
  that no `ci.yml` existed and the only test invocation was `npm test 2>/dev/null || true`
  inside a tags-only `publish.yml`, with `continue-on-error: true` on the job and
  `if: always()` on the publisher, so a green check certified only that a tag was pushed.
  Owned by card `62a5256d`. §4 now documents the working gate and keeps the history.
- **SOP §5/§6: documented the EFFECTIVE `ExecStart`.** The `config-path.conf` drop-in
  clears `ExecStart=` and re-declares it without `--config`, so the service loads the
  Syncthing-synced `~/.skcapstone/gateway/skgateway.yaml`, not the in-repo config. Also
  recorded that `ExecStart` runs source directly out of the shared working checkout
  `~/clawd/skcapstone-repos/skgateway`, so an uncommitted edit there is live behaviour.
- **SOP §9: stopped quoting a stale version.** `package.json` and the hardcoded
  `src/index.mjs:962` `/status` string both still say `0.1.0` while the newest release tag
  is far past it, and `publish-npm` overwrites `package.json` from the tag anyway. The SOP
  now says where the version comes from and warns that `/status` is not a version oracle.
- **SOP §7: completed the route table** (`/v1/messages`, `/v1/models/<id>`, `/healthz`,
  `/.well-known/skworld-module.json`, `/admin/models*`).
- **README: flagged the same `0.0.0.0` deviation** at the config sample, plus the config
  precedence order.

### Added

- **`.github/workflows/ci.yml`: the repo's first real test gate (card `62a5256d`).**
  Runs `npm ci` then `npm test` on every push and pull request to `main`/`master`,
  across a Node 20 and 22 matrix. No shell success-guard, no output redirection, no
  job-level failure tolerance: a red suite fails the run.
- `docs-evidence` block at the end of `SOP.md`: 11 hermetic, repo-local checks pinning the
  documented ports and `0.0.0.0` bind default, the pathname match for `/v1/messages`, the
  MIT licence (this repo is private and is NOT relicensed to GPL), the four CI facts
  (ci.yml swallows nothing, publish is gated on a failable test job, neither test job
  installs with `--ignore-scripts`, the test bootstrap pins `SKMODELS_REGISTRY`), the
  health/self-description routes, the config precedence chain, `sk-default`, and the
  stale `/status` version. Every check was negative-tested.
- `.github/workflows/docs-check.yml`, now running tiers 1, 2 and 3 on push and
  pull_request, so the evidence block is executed rather than merely present.

### Fixed

- **`publish.yml` could publish to npm from a fully red suite (card `62a5256d`).**
  Removed `2>/dev/null || true` and `continue-on-error: true` from the `test` job, and
  removed `if: always()` from `publish-npm`, so `needs: test` is now a real edge.
- **`publish.yml`'s test job installed with `--ignore-scripts`**, which skips
  better-sqlite3's native binding install. That alone fails 19 metrics, energy and SIEM
  tests with `Could not locate the bindings file`, so even the swallowed test run was
  testing a broken install. Both test jobs now use plain `npm ci`.
- **`tests/siem-live-hook.test.mjs` reached a live LAN backend.** `src/proxy/registry.mjs`
  binds `REGISTRY_PATH` at module load from `$SKMODELS_REGISTRY`, defaulting to the real
  per-node `~/.skcapstone/models/registry.yaml`. Twelve test files override it; this one
  did not, so on a node with a populated registry the router registry-routed the test's
  fake model `m` to ornith at `http://192.168.0.100:8082/v1` and the assertion
  `backend === "fake"` failed with `reg:ornith` after an 8.7 second LAN round trip. It
  passed on a bare CI runner (no registry file), which is the worst kind of split.
  `tests/_setup.mjs` now defaults `SKMODELS_REGISTRY` to a nonexistent path for every
  test process, the same belt-and-braces pattern already used for
  `SKGATEWAY_MODEL_CATALOG_STORE_PATH`. A suite that needs a registry still assigns the
  variable itself before importing `registry.mjs`. Suite goes from 1147 pass / 1 fail to
  **1148 pass / 0 fail**, and total runtime from 27s to 16s.
- Metrics collector double config dereference (card `7e739811`). `index.mjs`
  initialises the collector with `createMetricsCollector(config.metrics || {})`
  (the already-extracted metrics slice), but the factory dereferenced
  `config.metrics` a second time, so the internal `cfg` was `undefined` and
  `cfg.enabled` threw a `TypeError`. The error was swallowed as "optional", so
  metrics silently never recorded and `/status` reported `metrics: null`. The
  factory now normalises with `const cfg = config?.metrics ?? config ?? {}`,
  accepting both call shapes (the extracted slice `config.metrics` and the full
  gateway config), so a caller that dereferences one level too many or too few
  can no longer silently disable metrics. Added `tests/metrics-collector.test.mjs`
  exercising the exact production call shapes so this class of wiring bug cannot
  recur silently.

## [0.1.0] - 2026-07-08

### Added

- Initial SKGateway release: transparent auditing AI inference proxy on
  `:18780` (OpenAI-compatible) with a real-time SOC dashboard on `:18781`.
- Multi-backend routing across Anthropic, NVIDIA NIM, Ollama, OpenAI-compatible,
  and custom vLLM backends, selected by model name and priority with retry and
  circuit-breaker fallback.
- Identity plane: CapAuth PGP identity verification, agent registry, session
  tracking, and per-agent reputation scoring.
- Classifier plane: prompt intent classification, 0-10 risk scoring, jailbreak
  detection, prompt-injection detection, and DLP/PII scanning.
- Policy engine: YAML-driven, hot-reloadable rules with allow / deny / transform
  / rate_limit / alert actions and per-agent and per-model rate limits.
- Semantic tool reduction that trims a large tool set to a scored budget while
  always preserving a guaranteed set.
- Metrics plane: token, cost, and P50/P95/P99 latency tracking persisted in
  SQLite (`better-sqlite3`), with configurable retention.
- SIEM event bus emitting structured events (ArcSight CEF, JSONL, syslog RFC
  5424) across the request lifecycle.
- File-based integration with the SKCapstone stack (PubSub alert bus + job tree)
  with a standalone fallback when `~/.skcapstone/` is absent.
- Hot-reload of `config/skgateway.yaml` and `config/policies.yaml` on `SIGHUP`.

[Unreleased]: https://github.com/smilinTux/skgateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/smilinTux/skgateway/releases/tag/v0.1.0
