# Provider-Neutral Health and Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a provider-neutral, token-free steady-state health and telemetry plane that automatically quarantines and recovers failed provider scopes while preserving routing, audit, metrics, and semantic-cache shadow state across immutable releases.

**Architecture:** Extend SKGateway's existing SQLite metrics, SIEM audit, discovery adapters, capacity state, and router with one normalized observation contract and independent configured-mode and circuit-state controls. Provider adapters collect only qualified zero-token evidence in steady state; exact-scope startup and recovery canaries are bounded exceptions. Authenticated operator endpoints and `skgw-lanes` read durable snapshots and never contact providers.

**Tech Stack:** Node.js ESM, built-in `node:test`, SQLite through the existing metrics collector, YAML configuration, JSONL SIEM, Bash, systemd user units, and existing SKGateway dependencies only.

**Spec:** `docs/superpowers/specs/2026-09-11-provider-health-telemetry-design.md`

## Global Constraints

- Use canonical providers `local`, `codex`, `kimi`, `zai`, `cursor`, and `openrouter`; GLM is a Z.ai model family.
- OpenRouter starts with `configured_mode=disabled`, and all legacy OpenRouter backend, discovery, capability-battery, and probe switches must produce zero provider calls.
- Steady-state monitoring consumes zero inference tokens.
- A token canary is allowed only at startup or exact-scope half-open recovery when no recent exact-scope valid response exists.
- `configured_mode` and `circuit_state` are independent; health never changes configured mode.
- Ordinary inference requires active mode, closed circuit, policy eligibility, and a healthy exact scope.
- Disabled and monitor-only providers never receive inference.
- The gateway never sleeps between attempts and never reroutes after response bytes are emitted.
- Interactive routes use no long gateway queue; durable scheduling owns long waits.
- SQLite observations and snapshots are authoritative; JSON health state is rebuildable projection only.
- Mutable state uses provider-neutral XDG paths and never lives in an immutable release directory.
- Metrics and audit contain no credentials, account identifiers, prompts, responses, raw headers, or raw provider bodies.
- Semantic cache target state is enabled shadow mode; it never serves responses or changes routing.
- Do not add a database, broker, monitoring framework, or resident provider daemon.
- Every task receives its own SKCapstone card, isolated worktree, exact review, and completion evidence.
- Deployment, provider activation, OpenRouter traffic, and semantic-cache serving require separate explicit gates.

## File Structure

New focused modules:

- `src/state/paths.mjs`: resolve and validate provider-neutral XDG paths.
- `src/health/schema.mjs`: validate and sanitize normalized observations.
- `src/health/fold.mjs`: deterministically fold observations into snapshots.
- `src/health/store.mjs`: persist observations and snapshots through SQLite.
- `src/health/failure.mjs`: normalize upstream and gateway failures.
- `src/health/monitor.mjs`: execute due zero-token checks and exact-scope leases.
- `src/health/providers/*.mjs`: provider-specific evidence adapters.
- `src/operator/metrics-http.mjs`: authenticated snapshot-only metrics endpoints.
- `scripts/migrate-provider-state.mjs`: crash-safe XDG state inventory and reconciliation.
- `scripts/provider-monitor.mjs`: systemd oneshot entry point.
- `scripts/skgateway-provider-monitor.service`: hardened oneshot unit.
- `scripts/skgateway-provider-monitor.timer`: one jittered timer.

Existing integration points:

- `src/config.mjs`: normalize modes, paths, cadence, and thresholds.
- `src/index.mjs`: construct shared store, monitor, router, and operator handlers.
- `src/metrics/collector.mjs`: apply health schema migration using the existing SQLite lifecycle.
- `src/metrics/provider-usage.mjs`: emit passive normalized quota evidence.
- `src/discovery/capacity_store.mjs`: project circuit decisions without becoming health truth.
- `src/proxy/router.mjs`: consume effective eligibility and normalized failures.
- `src/proxy/retry.mjs`: enforce request and deadline budgets.
- `src/proxy/semantic-cache-shadow.mjs`: persist sanitized shadow observations.
- `src/operator/http.mjs`: dispatch authenticated metrics routes.
- `scripts/skgw-lanes`: discover effective state paths and report correct windows.
- `scripts/semantic-cache-report.mjs`: read bounded durable cache observations.
- `scripts/install.sh`: install XDG directories, monitor units, and stable wrappers.
- `config/skgateway.yaml` and examples: provider-neutral production defaults.

---

### Task 1: Provider Modes and Complete OpenRouter Disablement

**Files:**

- Modify: `src/config.mjs`
- Modify: `src/index.mjs`
- Modify: `config/skgateway.yaml`
- Modify: `config/skgateway.yaml.example`
- Test: `tests/provider-mode-config.test.mjs`
- Test: `tests/startup-disablement.test.mjs`

**Interfaces:**

- Produces: `normalizeProviderMode(value) -> "disabled" | "monitor_only" | "canary" | "active"`
- Produces: `providerNetworkPermission(mode, purpose) -> boolean`, where purpose is `monitor`, `qualification`, `recovery`, or `inference`
- Consumes: existing `config.backends`, `config.discovery.providers`, `probe_providers`, and capability-provider configuration.

- [ ] **Step 1: Add failing mode and zero-call tests**

```js
test("disabled OpenRouter blocks every network purpose", async () => {
  const calls = [];
  const cfg = loadConfig(disabledOpenRouterYaml());
  const fetchSpy = async (...args) => { calls.push(args); throw new Error("called"); };
  await startDiscoveryForTest(cfg, { openrouterFetch: fetchSpy });
  assert.equal(cfg.providers.openrouter.configured_mode, "disabled");
  assert.deepEqual(calls, []);
  for (const purpose of ["monitor", "qualification", "recovery", "inference"])
    assert.equal(providerNetworkPermission("disabled", purpose), false);
});
```

- [ ] **Step 2: Run tests and confirm the legacy switches call OpenRouter**

Run: `node --test tests/provider-mode-config.test.mjs tests/startup-disablement.test.mjs`

Expected: FAIL because no common configured mode exists and at least one legacy OpenRouter path remains callable.

- [ ] **Step 3: Implement the minimal mode gate**

```js
export function normalizeProviderMode(value = "disabled") {
  const mode = String(value).toLowerCase();
  if (!["disabled", "monitor_only", "canary", "active"].includes(mode))
    throw new Error(`invalid provider configured_mode: ${value}`);
  return mode;
}

export function providerNetworkPermission(mode, purpose) {
  if (mode === "disabled") return false;
  if (mode === "monitor_only") return purpose === "monitor";
  if (mode === "canary") return purpose !== "inference";
  return true;
}
```

Normalize every provider into `providers.<id>.configured_mode`. Before constructing OpenRouter discovery or probes, require the common permission function. Remove OpenRouter from default `probe_providers` and capability-battery defaults. Set all committed OpenRouter defaults to disabled without deleting its adapter or model-card policy.

- [ ] **Step 4: Verify all OpenRouter gates and ordinary provider parsing**

Run: `node --test tests/provider-mode-config.test.mjs tests/startup-disablement.test.mjs tests/providers-openrouter.test.mjs tests/config-backend-removal.test.mjs`

Expected: PASS with zero OpenRouter spy calls in disabled mode and unchanged adapter fixture parsing.

- [ ] **Step 5: Run configuration and secret checks**

Run: `node scripts/parity-check.mjs && git diff --check && gitleaks detect --no-banner --redact --source .`

Expected: all commands exit 0 and no secret is reported.

- [ ] **Step 6: Commit the independently reviewable mode gate**

```bash
git add src/config.mjs src/index.mjs config/skgateway.yaml config/skgateway.yaml.example tests/provider-mode-config.test.mjs tests/startup-disablement.test.mjs
git commit -m "fix(config): gate provider network activity by mode"
```

### Task 2: Provider-Neutral XDG State and Crash-Safe Migration

**Files:**

- Create: `src/state/paths.mjs`
- Create: `scripts/migrate-provider-state.mjs`
- Modify: `src/config.mjs`
- Modify: `src/index.mjs`
- Modify: `src/discovery/capacity_store.mjs`
- Modify: `src/siem/file.mjs`
- Modify: `scripts/install.sh`
- Test: `tests/state-paths.test.mjs`
- Test: `tests/provider-state-migration.test.mjs`

**Interfaces:**

- Produces: `resolveStatePaths({ env, uid, home }) -> StatePaths`
- Produces: `validateStateRoot(path, { uid }) -> void`
- Produces: `buildMigrationManifest(inventory) -> MigrationManifest`
- Produces: `migrateProviderState({ sources, target, crashAt }) -> MigrationResult`
- Consumes: provider modes from Task 1 and existing metrics, SIEM, capacity, lifecycle, discovery, registry, model-card, audit, and cache sources.

- [ ] **Step 1: Write failing XDG safety tests**

```js
test("state paths are provider-neutral and absolute", () => {
  const paths = resolveStatePaths({
    env: { XDG_CONFIG_HOME: "/tmp/u/config", XDG_STATE_HOME: "/tmp/u/state" },
    uid: process.getuid(), home: "/tmp/u",
  });
  assert.equal(paths.configRoot, "/tmp/u/config/skgateway");
  assert.equal(paths.metricsDb, "/tmp/u/state/skgateway/metrics.db");
  assert.equal(paths.auditLog, "/tmp/u/state/skgateway/audit.jsonl");
});

test("symlinked or wrong-owner roots fail closed", () => {
  assert.throws(() => validateStateRoot(symlinkRoot, { uid: process.getuid() }), /symlink/);
  assert.throws(() => validateStateRoot(foreignRoot, { uid: process.getuid() }), /owner/);
});
```

- [ ] **Step 2: Write failing migration collision and crash tests**

Use temporary SQLite fixtures containing overlapping request rows, ID-less duplicate audit events, WAL files, lifecycle JSON, capacity JSON, configuration hashes, and a memory-only cache declaration. Assert table-specific request deduplication, preservation of repeated ID-less audit events, manifest hashes/counts/time bounds, and old-path authority after injected pre-activation failure.

- [ ] **Step 3: Run the focused tests and verify failure**

Run: `node --test tests/state-paths.test.mjs tests/provider-state-migration.test.mjs`

Expected: FAIL because path resolution, validation, manifest, and migration interfaces do not exist.

- [ ] **Step 4: Implement XDG resolution and strict validation**

```js
export function resolveStatePaths({ env = process.env, home = homedir() } = {}) {
  const configBase = validAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  const stateBase = validAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : join(home, ".local", "state");
  const configRoot = join(configBase, "skgateway");
  const stateRoot = join(stateBase, "skgateway");
  return {
    configRoot, stateRoot,
    metricsDb: join(stateRoot, "metrics.db"),
    capacityState: join(stateRoot, "capacity-state.json"),
    providerHealth: join(stateRoot, "provider-health.json"),
    semanticCache: join(stateRoot, "semantic-cache"),
    auditLog: join(stateRoot, "audit.jsonl"),
  };
}
```

Reject relative overrides, symlinks, wrong owners, group-write, world access, and resolved paths outside the XDG root. Create directories as `0700` and files as `0600`.

- [ ] **Step 5: Implement staged reconciliation**

Inventory active SKCapstone configuration, registry/model cards, legacy and runtime metrics, audit, discovery, lifecycle, capacity, health, and durable cache sources. Record memory-only components as `no_source`. Quiesce writes, checkpoint WAL, copy into same-filesystem staging, validate each source, merge with per-table keys, retain ID-less audit repeats with source/hash provenance, write the manifest, fsync, and atomically rename the target.

Support `--inventory`, `--stage`, `--verify`, `--activate`, and `--rollback` so deployment can stop between gates. `--activate` refuses a manifest whose input hashes changed.

- [ ] **Step 6: Point runtime integrations to resolved absolute paths**

Pass resolved paths into metrics, SIEM, capacity, health, and cache constructors. Remove current-working-directory defaults from production configuration while retaining explicit temporary paths in tests.

- [ ] **Step 7: Verify migration, crash recovery, permissions, and existing persistence tests**

Run: `node --test tests/state-paths.test.mjs tests/provider-state-migration.test.mjs tests/metrics-collector.test.mjs tests/siem-live-hook.test.mjs tests/codex-capacity-lifecycle.test.mjs`

Expected: PASS, including rollback-forward replay of events written after activation.

- [ ] **Step 8: Commit XDG state and migration tooling**

```bash
git add src/state/paths.mjs scripts/migrate-provider-state.mjs src/config.mjs src/index.mjs src/discovery/capacity_store.mjs src/siem/file.mjs scripts/install.sh tests/state-paths.test.mjs tests/provider-state-migration.test.mjs
git commit -m "feat(state): persist gateway data in neutral XDG paths"
```

### Task 3: Normalized Health Observations and Durable Snapshots

**Files:**

- Create: `src/health/schema.mjs`
- Create: `src/health/fold.mjs`
- Create: `src/health/store.mjs`
- Modify: `src/metrics/collector.mjs`
- Modify: `src/metrics/provider-usage.mjs`
- Modify: `src/index.mjs`
- Test: `tests/provider-health-schema.test.mjs`
- Test: `tests/provider-health-store.test.mjs`
- Test: `tests/provider-health-fold.test.mjs`

**Interfaces:**

- Produces: `normalizeObservation(input) -> ProviderObservation`
- Produces: `foldProviderSnapshot(previous, observation, thresholds) -> ProviderSnapshot`
- Produces: `createProviderHealthStore({ db, projectionPath, clock })`
- Store methods: `append(observation)`, `snapshot(filter)`, `listObservations(query)`, `rebuildProjection()`
- Consumes: XDG metrics and projection paths from Task 2.

- [ ] **Step 1: Write failing schema and redaction tests**

```js
test("observation rejects forbidden data", () => {
  assert.throws(() => normalizeObservation({ ...validObservation, prompt: "secret" }), /forbidden/);
  assert.throws(() => normalizeObservation({ ...validObservation, headers: { authorization: "x" } }), /forbidden/);
});

test("unknown evidence never folds to healthy", () => {
  const snapshot = foldProviderSnapshot(null, unknownObservation, DEFAULT_THRESHOLDS);
  assert.equal(snapshot.overall, "unknown");
  assert.equal(snapshot.quota, "unknown");
});
```

- [ ] **Step 2: Write failing restart, projection, and threshold tests**

Assert persisted configured mode, circuit state, quarantine scope/reason, observation expiry, consecutive counters, last success/error, reset and next-due times, backoff step, opaque credential generation, and half-open lease. Close and reopen SQLite, rebuild JSON, and assert exact snapshot parity.

- [ ] **Step 3: Run tests and verify missing interfaces**

Run: `node --test tests/provider-health-schema.test.mjs tests/provider-health-store.test.mjs tests/provider-health-fold.test.mjs`

Expected: FAIL because the health modules and tables do not exist.

- [ ] **Step 4: Add SQLite tables through the existing collector migration path**

```sql
CREATE TABLE provider_observation (
  observation_id TEXT PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  backend_id TEXT,
  account_ref TEXT NOT NULL,
  model_id TEXT,
  scope TEXT NOT NULL,
  source TEXT NOT NULL,
  probe_cost TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE provider_snapshot (
  snapshot_key TEXT PRIMARY KEY,
  updated_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
```

Index observations by time, provider, backend, model, source, and expiry. Use prepared statements and the collector's existing serialized write boundary.

- [ ] **Step 5: Implement deterministic normalization and folding**

Use the exact dimensions and defaults in the spec. Reject unknown top-level keys at the trust boundary. Permit only reviewed provider error codes. Fold terminal auth/entitlement evidence immediately, transport failure after three consecutive failures across two cycles, and elevated errors only after five failures and 20 requests within five minutes.

- [ ] **Step 6: Persist passive quota observations**

Change `provider-usage.mjs` so its existing allowlisted response-header parser emits a normalized observation to the store as well as the current in-process compatibility snapshot. Do not persist raw headers.

- [ ] **Step 7: Verify persistence and current metrics boundaries**

Run: `node --test tests/provider-health-schema.test.mjs tests/provider-health-store.test.mjs tests/provider-health-fold.test.mjs tests/provider-usage.test.mjs tests/metrics-wiring-e2e.test.mjs`

Expected: PASS with exact projection rebuild parity after process restart.

- [ ] **Step 8: Commit the health evidence core**

```bash
git add src/health/schema.mjs src/health/fold.mjs src/health/store.mjs src/metrics/collector.mjs src/metrics/provider-usage.mjs src/index.mjs tests/provider-health-schema.test.mjs tests/provider-health-store.test.mjs tests/provider-health-fold.test.mjs
git commit -m "feat(health): persist normalized provider observations"
```

### Task 4: Failure Classification, Circuit Admission, and Bounded Failover

**Files:**

- Create: `src/health/failure.mjs`
- Modify: `src/proxy/router.mjs`
- Modify: `src/proxy/retry.mjs`
- Modify: `src/proxy/response-contract.mjs`
- Modify: `src/discovery/capacity_store.mjs`
- Test: `tests/provider-failure-classification.test.mjs`
- Test: `tests/router-rate-limit-failover.test.mjs`
- Test: `tests/circuit-recovery.test.mjs`
- Test: `tests/sse-tool-call-contract.test.mjs`

**Interfaces:**

- Produces: `normalizeFailure(input) -> FailureEnvelope`
- `FailureEnvelope` fields: `clientStatus`, `upstreamStatus`, `origin`, `reason`, `retryable`, `retryAt`, `requestId`, `attemptCount`, `upstreamAttempted`
- Produces: `effectiveInferenceEligibility({ mode, circuit, policy, scope }) -> boolean`
- Produces: `selectTerminalFailure(attempts, operationDeadline) -> FailureEnvelope`
- Consumes: durable snapshots from Task 3 and existing bucket continuation from merged PR153.

- [ ] **Step 1: Add failing classification tests**

```js
test("local cooldown is 503 and not provider 429", () => {
  const failure = normalizeFailure({ origin: "gateway", reason: "cooldown_active", upstreamAttempted: false });
  assert.equal(failure.clientStatus, 503);
  assert.equal(failure.upstreamStatus, null);
  assert.equal(failure.reason, "cooldown_active");
});

test("provider auth rejection is not caller auth rejection", () => {
  const failure = normalizeFailure({ origin: "upstream", upstreamStatus: 401, providerCode: "AUTH_REJECTED" });
  assert.equal(failure.clientStatus, 503);
  assert.equal(failure.reason, "provider_auth_unavailable");
});
```

- [ ] **Step 2: Add failing attempt, deadline, and SSE tests**

Assert no more than three upstream attempts, no duplicate capacity-domain attempt, one absolute operation deadline, no gateway sleep, no reroute after stream bytes, and one terminal SSE `error` event followed by close with `partial_stream_failed` audit state.

- [ ] **Step 3: Run focused tests and verify current false 429 behavior**

Run: `node --test tests/provider-failure-classification.test.mjs tests/router-rate-limit-failover.test.mjs tests/circuit-recovery.test.mjs tests/sse-tool-call-contract.test.mjs`

Expected: FAIL where a locally skipped cooldown still becomes `429 provider_429` and the new envelope is absent.

- [ ] **Step 4: Implement one canonical failure normalizer**

Map only observed upstream 429 to `rate_limited`. Map adapter-proven quota to `quota_exhausted`. Map local cooldown and capacity to 503. Preserve malformed 2xx as 502 without `Retry-After`. Map provider auth/entitlement to provider-unavailable 503 while leaving caller auth 401/403 distinct.

- [ ] **Step 5: Integrate independent configured mode and circuit state**

Ordinary routing requires active plus closed. Qualification requires canary plus explicit authorization. Recovery requires active or canary plus an exact-scope half-open lease. Disabled and monitor-only always reject inference before any network construction.

- [ ] **Step 6: Enforce failover and mixed-terminal selection**

Permit pre-output reroute for replay-safe transport failure, timeout, rate limit, 502, 503, and 529 only. Select the final condition using the spec precedence. Return `Retry-After` only for the selected condition when a credible time exists and is within the remaining operation deadline.

- [ ] **Step 7: Verify exact wire and audit behavior**

Run: `node --test tests/provider-failure-classification.test.mjs tests/router-rate-limit-failover.test.mjs tests/circuit-recovery.test.mjs tests/sse-tool-call-contract.test.mjs tests/bucket-routing-integration.test.mjs tests/queue-inflight.test.mjs tests/retry.test.mjs`

Expected: PASS with upstream status, client status, origin, reason, retry, attempts, and upstream-attempted fields in both wire and audit evidence.

- [ ] **Step 8: Commit bounded failure handling**

```bash
git add src/health/failure.mjs src/proxy/router.mjs src/proxy/retry.mjs src/proxy/response-contract.mjs src/discovery/capacity_store.mjs tests/provider-failure-classification.test.mjs tests/router-rate-limit-failover.test.mjs tests/circuit-recovery.test.mjs tests/sse-tool-call-contract.test.mjs
git commit -m "fix(router): normalize failures and bound failover"
```

### Task 5: Zero-Token Provider Monitor and Automatic Recovery

**Files:**

- Create: `src/health/monitor.mjs`
- Create: `src/health/providers/local.mjs`
- Create: `src/health/providers/codex.mjs`
- Create: `src/health/providers/kimi.mjs`
- Create: `src/health/providers/zai.mjs`
- Create: `src/health/providers/cursor.mjs`
- Create: `src/health/providers/openrouter.mjs`
- Create: `scripts/provider-monitor.mjs`
- Create: `scripts/skgateway-provider-monitor.service`
- Create: `scripts/skgateway-provider-monitor.timer`
- Modify: `scripts/install.sh`
- Modify: `src/index.mjs`
- Test: `tests/provider-monitor.test.mjs`
- Test: `tests/provider-health-adapters.test.mjs`
- Test: `tests/half-open-lease.test.mjs`

**Interfaces:**

- Produces adapter methods: `credentialMetadata(ctx)`, `pollZeroToken(ctx)`, `parseResponseEvidence(response)`, `classifyError(error)`
- Produces: `runDueChecks({ adapters, store, now, maxConcurrent: 2 }) -> MonitorSummary`
- Produces: `acquireHalfOpenLease(scopeKey, { now, ttlMs }) -> Lease | null`
- Consumes: provider modes from Task 1, XDG state from Task 2, store from Task 3, and circuit admission from Task 4.

- [ ] **Step 1: Write failing adapter contract and no-token tests**

```js
test("steady-state checks never invoke inference", async () => {
  let inferenceCalls = 0;
  await runDueChecks({
    adapters: testAdapters({ inference: async () => { inferenceCalls++; } }),
    store, now: 1_000_000, maxConcurrent: 2,
  });
  assert.equal(inferenceCalls, 0);
});
```

Use HTTP spies to prove disabled providers make zero DNS/HTTP calls, monitor-only providers perform only allowlisted zero-token calls, and no adapter logs raw request or response objects.

- [ ] **Step 2: Write failing exact-scope lease and restart tests**

Assert two concurrent recovery attempts yield one persisted lease. Assert the canary request names one exact provider, account reference, backend, and canonical model with no bucket, alias, fallback, or failover. Assert a success through another provider does not close the circuit. Restart the store and verify the lease and backoff step remain enforced.

- [ ] **Step 3: Run tests and verify the monitor is absent**

Run: `node --test tests/provider-monitor.test.mjs tests/provider-health-adapters.test.mjs tests/half-open-lease.test.mjs`

Expected: FAIL because adapter, scheduler, and lease modules do not exist.

- [ ] **Step 4: Implement the shared due-check scheduler**

Use one 60-second systemd wake with 15-second randomized delay. Persist `next_due_at`. Limit external checks to two concurrent promises. Apply 6-second default and 8-second hard timeout with no same-cycle retry. Persist backoff sequence 30 seconds, 2 minutes, 5 minutes, and 15 minutes with 20 percent deterministic jitter.

- [ ] **Step 5: Implement qualified provider adapters**

- Local Qwen reads systemd/service state through injected local checks and calls `/health` and `/v1/models`.
- Codex uses credential metadata and the existing authenticated catalog adapter.
- Kimi uses one read-only synchronized credential generation and its authenticated coding catalog.
- Z.ai uses authenticated catalog, quota limit every five minutes, and model usage every 30 minutes.
- Cursor exposes credential/catalog unknown until its transport qualification is accepted; it cannot infer.
- OpenRouter obeys configured mode and the free-model allowlist; disabled mode creates no fetch function.

Every adapter converts raw results directly into an allowlisted observation and discards raw data.

- [ ] **Step 6: Implement startup and recovery canary admission**

Use recent exact-scope inference within 15 minutes as proof. Otherwise permit one tiny exact-model request at startup or half-open recovery only. Do not attach tools except an explicitly authorized tool qualification. Do not route through a logical bucket.

- [ ] **Step 7: Resolve Kimi credential single-writer behavior**

Keep the Kimi CLI as refresh owner and the gateway as read-only consumer. Remove or disable gateway writes to the Kimi credential. Tests must prove monitor reads cannot alter the credential file or its generation.

- [ ] **Step 8: Harden and install the systemd oneshot**

Use `Type=oneshot`, `TimeoutStartSec=20`, `UMask=0077`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, read-only release/config/credential paths, write access only to the XDG state root, and a 128 MB memory ceiling.

- [ ] **Step 9: Verify adapters, zero-token operation, recovery, and service syntax**

Run: `node --test tests/provider-monitor.test.mjs tests/provider-health-adapters.test.mjs tests/half-open-lease.test.mjs tests/providers-codex.test.mjs tests/providers-zai.test.mjs tests/providers-openrouter.test.mjs && systemd-analyze verify scripts/skgateway-provider-monitor.service scripts/skgateway-provider-monitor.timer`

Expected: PASS with no provider traffic from disabled OpenRouter and no inference from steady-state cycles.

- [ ] **Step 10: Commit monitoring and recovery**

```bash
git add src/health/monitor.mjs src/health/providers scripts/provider-monitor.mjs scripts/skgateway-provider-monitor.service scripts/skgateway-provider-monitor.timer scripts/install.sh src/index.mjs tests/provider-monitor.test.mjs tests/provider-health-adapters.test.mjs tests/half-open-lease.test.mjs
git commit -m "feat(health): monitor and recover provider scopes"
```

### Task 6: Durable Semantic Cache Shadow

**Files:**

- Modify: `src/proxy/semantic-cache-shadow.mjs`
- Modify: `src/proxy/semantic-cache.mjs`
- Modify: `src/config.mjs`
- Modify: `src/index.mjs`
- Modify: `config/skgateway.yaml`
- Modify: `config/skgateway.yaml.example`
- Modify: `scripts/semantic-cache-report.mjs`
- Test: `tests/semantic-cache-shadow.test.mjs`
- Test: `tests/semantic-cache-live-wiring.test.mjs`
- Test: `tests/semantic-cache-report.test.mjs`

**Interfaces:**

- Produces: `recordShadowObservation(store, input) -> Promise<void>`
- Produces: `summarizeShadow({ store, fromMs, toMs, filters }) -> ShadowSummary`
- Consumes: XDG semantic-cache path from Task 2 and authoritative metrics store from Task 3.

- [ ] **Step 1: Add failing policy-first and persistence tests**

Assert classification and tenant policy run before embedding. Assert the durable record contains only fingerprint or embedding, compatibility metadata, similarity, outcome, and timing. Assert prompt, response, raw key, credentials, and protected content are absent. Restart and verify time-bounded summaries.

- [ ] **Step 2: Add failing fail-open and window tests**

Inject classifier, embedder, and store failures and assert ordinary routing continues without provider health changes. Create old and current observations and assert a 60-minute report excludes the old record.

- [ ] **Step 3: Run focused cache tests and verify persistence gaps**

Run: `node --test tests/semantic-cache-shadow.test.mjs tests/semantic-cache-live-wiring.test.mjs tests/semantic-cache-report.test.mjs`

Expected: FAIL because shadow state is process-local or audit-derived and committed config is disabled.

- [ ] **Step 4: Persist sanitized shadow observations**

Write shadow observations through the authoritative metrics store. Treat current memory entries as `no_source` during migration. Keep provider health independent from cache failures.

- [ ] **Step 5: Enable target shadow mode only after prerequisites**

Set `semantic_cache.enabled: true` and `mode: shadow` in production defaults only after classification, isolation, XDG persistence, and redaction tests pass. Add a startup assertion that `mode=serve` remains forbidden without a separate capability and approval revision.

- [ ] **Step 6: Verify cache tests and no-serving behavior**

Run: `node --test tests/semantic-cache-config.test.mjs tests/semantic-cache.test.mjs tests/semantic-cache-shadow.test.mjs tests/semantic-cache-live-wiring.test.mjs tests/semantic-cache-report.test.mjs`

Expected: PASS with shadow metrics durable and zero served cache responses.

- [ ] **Step 7: Commit durable shadow mode**

```bash
git add src/proxy/semantic-cache-shadow.mjs src/proxy/semantic-cache.mjs src/config.mjs src/index.mjs config/skgateway.yaml config/skgateway.yaml.example scripts/semantic-cache-report.mjs tests/semantic-cache-shadow.test.mjs tests/semantic-cache-live-wiring.test.mjs tests/semantic-cache-report.test.mjs
git commit -m "feat(cache): persist safe semantic shadow metrics"
```

### Task 7: Authenticated Operator Metrics and Correct Lane Reporting

**Files:**

- Create: `src/operator/metrics-http.mjs`
- Modify: `src/operator/http.mjs`
- Modify: `src/index.mjs`
- Modify: `scripts/skgw-lanes`
- Test: `tests/operator-metrics-http.test.mjs`
- Test: `tests/skgw-lanes.test.mjs`
- Test: `tests/semantic-cache-report.test.mjs`

**Interfaces:**

- Produces: `handleMetricsRequest(req, { store, authorize, now }) -> Response | null`
- Produces routes: `/operator/v1/status`, `/providers`, `/models`, `/buckets`, `/routes`, `/cache`, `/errors`
- Consumes: health store from Task 3, failure fields from Task 4, monitor snapshots from Task 5, and cache observations from Task 6.

- [ ] **Step 1: Write failing capability and no-I/O tests**

```js
test("provider metrics read snapshots without provider I/O", async () => {
  let providerCalls = 0;
  const response = await handleMetricsRequest(request("/operator/v1/providers"), {
    store, authorize: allow("skgateway.metrics.read"), now: () => NOW,
    providerFetch: async () => { providerCalls++; },
  });
  assert.equal(response.status, 200);
  assert.equal(providerCalls, 0);
});
```

Assert unauthenticated access fails, ordinary metrics omit backend IDs, and the separate `skgateway.backends.read` local projection may include only backend IDs, not private URLs or hosts.

- [ ] **Step 2: Write failing envelope, pagination, null, and freshness tests**

Assert schema version, UTC timestamps, null for unknown values, 3600-second default and 86400-second maximum windows, 100 default and 500 maximum page sizes, 15-minute cursor expiry, typed errors, and stale evidence indicators for every endpoint.

- [ ] **Step 3: Write failing `skgw-lanes` effective-path tests**

Use a stale legacy database and a fresh configured XDG database. Assert the script selects the configured database, reports provider/bucket/model/route/error/failover/quarantine/queue/deadline/cache summaries, flags split telemetry, and applies the requested window to audit and cache data.

- [ ] **Step 4: Run focused tests and verify missing metrics routes**

Run: `node --test tests/operator-metrics-http.test.mjs tests/skgw-lanes.test.mjs tests/semantic-cache-report.test.mjs`

Expected: FAIL because the authenticated routes and effective-path reporter are absent.

- [ ] **Step 5: Implement snapshot-only endpoint projections**

Implement the exact fields from the design specification. Keep existing public `/operator/v1/healthz`, `/readyz`, `/explain`, and `/observe` behavior separate. Use indexed bounded queries only. Encode cursors with query, snapshot revision, offset key, and expiry protected by the existing operator integrity mechanism.

- [ ] **Step 6: Repair `skgw-lanes`**

Read effective paths from normalized configuration or the operator status snapshot. Remove the hardcoded `~/skgateway-codex` default. Treat a missing lane as no observed traffic only. Add distinct upstream 429, gateway cooldown, malformed response, capacity, auth, quota, and retry-budget signals.

- [ ] **Step 7: Verify operator and reporting behavior**

Run: `node --test tests/operator-http.test.mjs tests/operator-metrics-http.test.mjs tests/skgw-lanes.test.mjs tests/semantic-cache-report.test.mjs tests/metrics-wiring-e2e.test.mjs`

Expected: PASS, and an endpoint read produces zero provider calls and zero new observations.

- [ ] **Step 8: Commit operator visibility**

```bash
git add src/operator/metrics-http.mjs src/operator/http.mjs src/index.mjs scripts/skgw-lanes tests/operator-metrics-http.test.mjs tests/skgw-lanes.test.mjs tests/semantic-cache-report.test.mjs
git commit -m "feat(operator): expose provider and bucket metrics"
```

### Task 8: Integration, Documentation, Qualification, and Deployment Packet

**Files:**

- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/CONFIGURATION.md`
- Modify: `docs/API.md`
- Modify: `docs/RUNBOOK.md`
- Modify: `docs/SIEM.md`
- Modify: `docs/DASHBOARD.md`
- Modify: `docs/INSTALL.md`
- Modify: `CHANGELOG.md`
- Create: `docs/evidence/provider-health-qualification-template.md`
- Test: `tests/provider-health-integration.test.mjs`
- Test: `tests/provider-tool-qualification.test.mjs`

**Interfaces:**

- Consumes all interfaces from Tasks 1 through 7.
- Produces a source candidate and immutable deployment packet; it does not itself authorize production activation.

- [ ] **Step 1: Add the end-to-end failing integration test**

Construct local fixtures for Qwen, Codex, Kimi, Z.ai, Cursor, and OpenRouter. Assert active healthy providers route; an exhausted subscription opens only its exact circuit; other providers continue; zero-token recovery reaches half-open; one exact canary closes the circuit; disabled OpenRouter receives zero calls; metrics endpoints explain every decision; and shadow cache records without serving.

- [ ] **Step 2: Add tool qualification tests**

For every enabled model card claiming tool support, require a recorded qualified tool-call fixture or an exact provider capability contract plus a bounded canary gate. Assert no model enters tool-bearing buckets from name heuristics alone.

- [ ] **Step 3: Run focused integration and full suite**

Run: `node --test tests/provider-health-integration.test.mjs tests/provider-tool-qualification.test.mjs`

Expected: PASS.

Run: `npm test`

Expected: all SKGateway tests pass with zero skipped health, security, migration, or routing tests.

- [ ] **Step 4: Run static, configuration, documentation, and secret gates**

Run: `npm run lint && node scripts/parity-check.mjs && git diff --check && gitleaks detect --no-banner --redact --source .`

Expected: all commands exit 0, configuration parity passes, and no secret is reported.

- [ ] **Step 5: Update SKGateway documentation**

Document architecture, lifecycle modes, circuit states, XDG paths, migration, failure and retry semantics, automatic recovery, provider adapters, operator endpoint schemas, alerting, shadow cache, provider onboarding, security/redaction, troubleshooting, rollback, and the fact that OpenRouter remains disabled.

- [ ] **Step 6: Build the immutable evidence packet**

Record source commit, tree hash, patch hash, changed paths, test commands and exact results, configuration hashes, schema versions, migration dry-run manifest, rollback manifest, secret-scan result, and acceptance-criteria mapping. Do not include credentials, raw responses, prompts, private URLs, or account identifiers.

- [ ] **Step 7: Commit integration documentation and evidence template**

```bash
git add docs/ARCHITECTURE.md docs/CONFIGURATION.md docs/API.md docs/RUNBOOK.md docs/SIEM.md docs/DASHBOARD.md docs/INSTALL.md docs/evidence/provider-health-qualification-template.md CHANGELOG.md tests/provider-health-integration.test.mjs tests/provider-tool-qualification.test.mjs
git commit -m "docs: qualify provider-neutral health operations"
```

- [ ] **Step 8: Obtain independent source review**

Create a governed review card bound to the exact source commit and evidence SHA256. The reviewer reruns the focused and full suites, validates no provider traffic from disabled OpenRouter, checks the migration and rollback manifests, verifies operator redaction, and returns PASS or exact blockers without modifying the candidate.

- [ ] **Step 9: Create a separate gated deployment card after review PASS**

The deployment card must carry explicit production mutation authorization, exact reviewed commit, active configuration hashes, state inventory manifest, quiesce procedure, migration stages, service switch, rollback commands, and canaries. It must not enable OpenRouter inference or semantic-cache serving.

- [ ] **Step 10: Execute controlled deployment and live qualification**

Under the deployment card only: prove OpenRouter zero-call disablement, quiesce writes, checkpoint WAL, stage and verify migration, activate XDG paths, switch the immutable runtime, restart, verify PID/revision/state continuity, and run one bounded startup canary per enabled provider lacking recent exact-scope evidence.

- [ ] **Step 11: Verify live recovery and observability**

Use simulated provider responses at the gateway test boundary to prove quota exhaustion, auth rejection, malformed response, cooldown, alternate-provider routing, half-open lease, automatic recovery, and bounded deadlines. Read the operator endpoints and `skgw-lanes` to prove provider, model, bucket, route, error, and shadow-cache attribution without creating provider calls.

- [ ] **Step 12: Obtain independent post-deployment review and complete cards**

The reviewer verifies exact live revision, service health, state hashes, migration counts, zero OpenRouter calls, enabled-provider canaries, metrics/audit continuity, rollback artifacts, and alert transitions. Complete source and deployment cards only after exact PASS evidence is linked and read back.

## Dependency and Card Sequence

Implement as reviewable cards in this order:

1. Provider modes and OpenRouter disablement
2. XDG state and migration
3. Health observation store
4. Failure and failover semantics
5. Provider monitor and automatic recovery
6. Semantic-cache shadow persistence and enablement
7. Operator metrics and reporting
8. Integration, documentation, and deployment packet
9. Independent source review
10. Separately authorized deployment and post-deployment review

Tasks 3 and 4 may be developed in parallel after Task 2 but must integrate
against one frozen Task 2 interface. Tasks 5 and 6 require Tasks 2 and 3. Task
7 requires Tasks 3 through 6. Task 8 requires all source tasks.

No worker may modify another task's owned files without an explicit SKMail
handoff and updated card scope.
