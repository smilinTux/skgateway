# skgateway Bulletproof Deployment Plan

Date: 2026-07-09
Repo: `~/clawd/skcapstone-repos/skgateway` (main @ 014e542)
Definition of bulletproof: reproducible from scratch on a new machine, secrets never in git, HA with no single point of failure ("if you need one, get two"), CI-gated, observable, self-recovering, and documented well enough that a cold machine can stand it up.

## 1. Current State

skgateway is a Node ESM routing gateway (~9.8k lines of src) with genuinely strong internals: priority-ordered backend failover with a down/degraded/cooldown state machine, per-backend circuit breakers (5-failure threshold, 30s cooldown), per-backend connection pooling, an mtime-cached skmodels registry bridge with last-good-cache fallback, sk-auto difficulty routing, and a correct Anthropic adapter (tools, images, per-model max_tokens clamp). The test suite is real: 157/157 tests pass in under a second with no external dependencies (verified locally). Git secret hygiene is clean: no credentials tracked, history scan clean, and on .158 secrets arrive via a 0600 skvault-populated EnvironmentFile.

But it is not bulletproof today:

- The two "HA" nodes have drifted. .41 runs cb26360, 4 commits behind .158's 014e542, with a materially different config (still direct api.anthropic.com OAuth, the mode .158 abandoned because it starves the subscription), no `~/.config/skgateway/` secrets at all, and a dirty package-lock.json. Nothing enforces parity.
- CI gates nothing. The only workflow (`.github/workflows/publish.yml`) is tag-triggered npm publish; tests run as `npm test 2>/dev/null || true` with `continue-on-error: true` and publish is `if: always()`. A fully red suite still publishes. No workflow runs on push or PR. (Verified in the workflow file.)
- Production metrics are silently broken. `src/index.mjs:58` passes `config.metrics || {}` into `createMetricsCollector`, but `src/metrics/collector.mjs:349` dereferences `config.metrics` again, so `cfg` is undefined and `cfg.enabled` throws. The error is swallowed as "optional"; /status returns `metrics: null` and `data/` is empty. Verified in source: this is a one-line fix.
- The SIEM/policy/identity pipeline is built but never wired. `src/index.mjs:122` builds `proxyConfig` via `buildConfig`, but the live request path is `routeAndSend(...)` at line ~236, which takes none of it. `logs/audit.jsonl` is 163 bytes, last written 2026-04-24 (verified). README overstates the live data path.
- Deployment is a hand-copied user systemd unit (`scripts/skgateway.service`) with hardcoded `/home/cbrd21` paths, no `EnvironmentFile=` line (the secrets drop-in is a hand-made override that exists only on .158), `Restart=on-failure` rather than `always`, no `WatchdogSec`, no `MemoryMax` (relevant given .41's memory-thrash freeze history), and `WantedBy=default.target` requiring undocumented loginctl lingering. `docs/INSTALL.md` is stale and actively harmful for a cold rebuild (old model names, the abandoned direct-OAuth mode, and a plaintext key in the unit file at line 154).
- On .158, all Anthropic traffic depends on a single local claude-code-api wrapper at 127.0.0.1:18782 that lives outside this repo with no health integration and no fallback backend for claude-* models.
- Health detection is passive only: idle backends report "up" with `lastCheck: 0` until a real request fails. .158's anthropic backend is currently degraded (18% error rate) with no alert.
- Hot reload is partial: SIGHUP only `Object.assign`s the config snapshot (verified at src/index.mjs ~294); backend additions/removals/URL changes do not reach the router without a restart, contradicting the README claim.

## 2. Target: What Bulletproof Means for This Repo

1. **Reproducible from scratch.** One documented path (`scripts/install.sh` plus a rewritten INSTALL.md) takes a bare machine with Node 20 to a running gateway: clone, install, template the unit with correct paths, create the secrets EnvironmentFile from skvault, enable lingering, start, verify /health. No step lives only in Chef's memory or a hand-made override.
2. **Secrets never in git.** Already true for git contents. Extend to: the secrets EnvironmentFile pattern is codified in the repo (documented, templated, permission-checked at install), and a rotation runbook exists so key rotation is a known procedure, not archaeology.
3. **HA, no SPOF.** .158 and .41 run the same commit, an intentionally reviewed config (identical or explicitly documented divergence), and both have working secrets. A parity check makes drift loud. claude-* models on .158 have a fallback path when the :18782 wrapper dies, and the wrapper dependency is documented and health-checked. Clients have a documented failover story between the two nodes.
4. **CI-gated.** Tests run on every push and PR and must pass; publish requires green tests. Broken code cannot merge quietly or ship to npm.
5. **Observable.** Metrics actually record (token/cost/latency per the pricing config), the SIEM audit stream writes, degraded backends raise sk-alert, and /health reflects reality via periodic active probes rather than only passive failure marking.
6. **Self-recovering.** systemd unit uses `Restart=always`, sane RestartSec, `MemoryMax` guardrail, and the gateway's existing circuit breakers and registry last-good-cache continue to contain blast radius.
7. **Documented.** INSTALL.md matches production reality; a runbook captures the two operationally proven gotchas (clients must pin `base_url :18780` or provider resolution wrongly lands on the :18782 wrapper; the anthropic first-party wrapper dependency) plus rotation and node-failover procedures.

## 3. Gap Analysis (severity ordered)

| # | Severity | Area | Gap |
|---|----------|------|-----|
| 1 | Critical | Node parity | .41 is 4 commits behind (missing max_tokens clamp 7eadf63, Accept-Encoding fix 08c9fc7, claude-code-api routing 014e542), runs the abandoned direct-OAuth anthropic config, has no secrets file, and has a dirty lockfile. No mechanism checks or enforces commit/config/secret parity. .41 is a silently worse gateway on the same port number. |
| 2 | High | CI gating | Tests gate nothing: no push/PR workflow, publish proceeds on red (`\|\| true`, `continue-on-error`, `if: always()`). |
| 3 | High | Observability (metrics) | Metrics collector crashes at init (double `config.metrics` dereference, collector.mjs:349 vs index.mjs:58); /status shows `metrics: null`; no token/cost/latency data has ever recorded via the current entrypoint. |
| 4 | High | Observability (SIEM/policy) | `proxyConfig` (siemHook, sanitizer limits, model_limits, tool budgets) is built but never passed into `routeAndSend`; audit.jsonl dead since April; identity/policy/classifier layers advertised in README are not invoked. |
| 5 | High | HA / SPOF | The two gateways are independent instances, not an HA pair: no VIP or client failover, clients pin one node. All .158 Anthropic traffic depends on the unmanaged claude-code-api wrapper at 127.0.0.1:18782 with no health integration and no fallback for claude-* models. |
| 6 | High | Deploy reproducibility | Hardcoded systemd unit, secrets drop-in exists only as a hand-made override on .158 and not in the repo, no install script, `Restart=on-failure`, no MemoryMax or WatchdogSec, undocumented lingering requirement. INSTALL.md is stale and recommends plaintext keys in ~/.bashrc and inline in the unit. |
| 7 | Medium | Credential rotation | Rotating secrets.env requires a full restart (EnvironmentFile is read at start; ExecReload HUP does not re-read it). No rotation runbook. .41 still uses the live OAuth-file path the wrapper was created to retire. |
| 8 | Medium | Health checks | Passive only: no periodic probe loop; idle backends report "up" with lastCheck 0; degraded backends (current 18% anthropic error rate on .158) raise no alert because the SIEM-to-sk-alert path never fires. |
| 9 | Medium | Hot reload | README claims full hot reload; in reality SIGHUP refreshes the config snapshot only. Backend topology changes require a restart. Operator edits + HUP silently do nothing. |
| 10 | Medium | Gotcha documentation | The :18780 base_url pin and the :18782 wrapper dependency live only in commit messages and memory files; a cold rebuild re-hits both. |
| 11 | Low | Dead/duplicated code | `src/proxy/core.mjs` (1127 lines) is a parallel proxy pipeline of which only `buildConfig` is effectively used; `openclaw-plugin/` targets the evicted OpenClaw runtime. Two pipelines invite exactly the config-wiring bugs observed. |

## 4. Remediation Roadmap

### Phase 0: Stop the bleeding (no dependencies, all parallelizable)

- **P0.1 Fix metrics collector crash.** One-line fix plus a regression test that constructs the collector through the same call shape index.mjs uses. Unblocks all cost/latency accounting.
- **P0.2 Restore .41 parity.** Pull .41 to 014e542, reconcile config/skgateway.yaml (decide: mirror .158's claude-code-api routing, or an explicit documented divergence if .41 has no local wrapper), create the 0600 secrets.env from skvault, install the EnvironmentFile drop-in, restart, verify /health and a real claude-* plus NVIDIA request. This is the single most dangerous live gap.
- **P0.3 Make CI gate.** Add a push/PR workflow running `npm test` for real; fix publish.yml to remove `|| true`, `continue-on-error`, and `if: always()` so publish requires green tests.

### Phase 1: Reproducible deploy (parallel with Phase 0 except where noted)

- **P1.1 Deployable unit + install script.** Template the systemd unit (no hardcoded home, `EnvironmentFile=%h/.config/skgateway/secrets.env`, `Restart=always`, `RestartSec`, `MemoryMax`, optional `WatchdogSec`), plus `scripts/install.sh` that renders it, checks/creates the secrets file skeleton with 0600 perms, enables lingering, and enables the service. Commit both.
- **P1.2 Rewrite INSTALL.md + runbook.** Depends on P1.1 (documents the new install path). Kill the plaintext-key advice, document the secrets.env/skvault standard, current model names, the claude-code-api wrapper mode, lingering, and the two proven gotchas (:18780 base_url pin, :18782 wrapper dependency). Add a rotation runbook (rotate in skvault, rewrite secrets.env, restart; note that HUP does not re-read EnvironmentFile).

### Phase 2: Observability and honest health (after P0.1; items parallelizable with each other)

- **P2.1 Wire SIEM into the live path.** Pass the siemHook (and decide the fate of sanitizer/model_limits/tool budgets: wire or explicitly descope) into the routeAndSend flow so audit.jsonl records again; reconcile README with the actual data path. Depends on nothing but is highest-value after P0.1.
- **P2.2 Active health probes + alerting.** Periodic lightweight probe loop so /health reflects reality for idle backends; emit warn+ SIEM events on backend degraded/down so the existing sk-alert forwarding actually fires (depends on P2.1 for the SIEM path).
- **P2.3 Honest hot reload.** Either apply backend topology changes to the router on config-changed, or (cheaper) detect topology diffs on reload, log loudly that a restart is required, and fix the README claim.

### Phase 3: HA hardening (after P0.2)

- **P3.1 claude-code-api SPOF mitigation.** Health-check the :18782 wrapper, add a fallback backend for claude-* models on .158 (direct OAuth as emergency fallback, or route to .41's path), and commit a unit/runbook for the wrapper dependency itself.
- **P3.2 Parity enforcement.** A `scripts/parity-check.sh` (run by cron or CI over ssh) comparing git commit, config hash, secrets file presence/perms, and service state across .158 and .41, alerting via sk-alert on drift. Depends on P0.2 (nodes must first be in a known-good state to enforce against).
- **P3.3 Client failover story.** Document (and where cheap, implement) how clients fail between .158 and .41: at minimum a runbook procedure; optionally registry-level dual-endpoint entries or a keepalived VIP decision recorded as an ADR.

### Phase 4: Cleanup (lowest priority, anytime)

- **P4.1 Consolidate dead pipelines.** Extract what is actually used from `src/proxy/core.mjs`, delete or quarantine the rest, remove `openclaw-plugin/`. Reduces the surface where config-wiring bugs hide.

Parallelization summary: P0.1, P0.2, P0.3, P1.1 can all start immediately in parallel. P1.2 waits on P1.1. P2.1 and P2.3 can start immediately; P2.2 waits on P2.1. P3.1 can start immediately; P3.2 waits on P0.2. P3.3 and P4.1 are independent.

## 5. Task List

1. **skgateway: fix metrics collector double config dereference** (critical). One-line fix in `src/metrics/collector.mjs` plus regression test. No deps.
2. **skgateway: restore .41 to parity with .158** (critical). Update code, reconcile config, install secrets.env + drop-in, verify live. No deps.
3. **skgateway: make CI gate on tests for push, PR, and publish** (high). New test workflow plus publish.yml degating. No deps.
4. **skgateway: commit deployable systemd unit and install script** (high). Templated unit, EnvironmentFile, Restart=always, MemoryMax, install.sh. No deps.
5. **skgateway: wire SIEM hook into the live request path** (high). routeAndSend integration, audit.jsonl alive again, README reconciled. Depends on task 1 (shared entrypoint edits, avoid conflicts).
6. **skgateway: mitigate claude-code-api :18782 single point of failure** (high). Health integration, fallback backend for claude-* models, dependency documented. No deps.
7. **skgateway: rewrite INSTALL.md and add operations runbook** (high). Cold-machine accurate install, secrets standard, rotation procedure, both proven gotchas. Depends on task 4.
8. **skgateway: parity check script with drift alerting** (high). Commit/config/secrets/service comparison across .158 and .41, sk-alert on drift. Depends on task 2.
9. **skgateway: active health probes and degraded-backend alerting** (medium). Periodic probe loop, warn+ SIEM events feed sk-alert. Depends on task 5.
10. **skgateway: honest hot reload for backend topology** (medium). Apply or loudly reject topology changes on SIGHUP; fix README claim. No deps.
11. **skgateway: document and decide the two-node client failover story** (medium). Runbook procedure plus an ADR on VIP versus client-side failover. Depends on task 2.
12. **skgateway: remove dead proxy pipeline and openclaw plugin** (low). Consolidate core.mjs usage down to what the live path needs. Depends on task 5 (wiring decisions determine what is dead).
