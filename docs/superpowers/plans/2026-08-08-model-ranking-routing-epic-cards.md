# Model Ranking + Capability-Aware Routing Epic - Implementation Cards

> **For agentic workers (Sonnet swarm):** Each card below is an independently
> implementable unit. REQUIRED SUB-SKILL: use `superpowers:test-driven-development`
> for every card (failing test first, minimal impl, green, commit) and
> `superpowers:using-git-worktrees` so each agent works in isolation. Steps use
> checkbox (`- [ ]`) syntax. Do NOT start a card until its `Depends` cards are merged.

**Goal:** Make skgateway aware of its ~100-model free fleet: keep catalogs + model
cards fresh, track per-model lifecycle/EOL, score/rank models by capability, and
route by job requirements, all reusing the existing discovery/registry/router
machinery with no new service or DB.

**Architecture:** Two-store split. `registry.yaml` stays the human-owned POLICY
authority (roles gain declarative `@match` requirement blocks). The discovery cache
`~/.config/skgateway/model_catalog_cache.json` evolves into a machine-owned FACTS
store (`model_catalog.json`) holding cards, derived capability vectors, and a
model-granular lifecycle state machine. The difficulty classifier stays the tierer;
a new pure-function ranker becomes the picker; its output feeds the EXISTING
candidate/failover/quarantine loop in `routeAndSend()`.

**Tech Stack:** Node.js ESM (`.mjs`), `node --test` + `node:assert/strict`, existing
modules (`src/discovery.mjs`, `src/proxy/router.mjs`, `src/proxy/registry.mjs`,
`src/index.mjs`, `src/classifiers/empirical.mjs`, `src/metrics/collector.mjs`);
skos Python CLI (`~/clawd/skos/src/skos/models/cli.py`).

**Design doc (READ FIRST, this is the spec):**
`docs/specs/2026-08-08-model-ranking-routing-intelligence-arch.md`.

## Global Constraints (apply to EVERY card)

- No new daemon, service, or database. Extend existing modules; the only new files
  are the provider adapters, the lifecycle module, the ranker, and the capability
  deriver.
- Reuse-not-rebuild: do NOT rebuild `ratings.jsonl`, `metrics.db`, `empirical.mjs`,
  the advertise allowlist, or the router failover/quarantine machinery.
- Routing must never depend on Postgres/network; every store the router reads is a
  local file with an mtime/TTL cache. The catalog store follows that pattern.
- The catalog store is per-node derived state (like `metrics.db`), NOT Syncthing-
  synced. Only `registry.yaml` (policy) is synced. Do not "fix" this with sync.
- No machine writes to `registry.yaml` model picks. The system suggests; humans commit.
- Every capability score carries a `basis` tag (`card|heuristic|manual|prior|ratings|
  eval`); empirical signal outweighs priors by construction. A prior-only score never
  crosses a sovereignty tier boundary.
- Writing style: NO em dashes or en dashes in code, comments, commits, or docs. Use
  commas, parentheses, colons, or a new sentence. Regular hyphens are fine.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Wpn9vTnzrVfh8XpiQGVSVy
  ```
- Tests: `npm test` (runs `node --test tests/*.test.mjs`). A card is DONE only when
  its new tests pass AND the full suite has no NEW failures (the pre-existing
  `SIEM live hook - happy path` failure needs a live endpoint; ignore only that one).
- Deploy after merge: `systemctl --user restart skgateway.service`, then re-probe.

## Locked decisions (were open questions Q1-Q5)

- **Q1:** `sk-heavy` stays pinned to `opus`. Introduce `sk-heavy-free` (`@match`) and
  A/B via ratings BEFORE any hard prompt routes to a free model. (Card P4.4.)
- **Q2:** NVIDIA cards = heuristic family parsing + a committed manual overlay. The
  NGC/build.nvidia.com scrape is a deferred optional spike, NOT a core card.
- **Q3:** `/admin/models/rank` is loopback-only, suggest-only. Consumed by `skmodels`
  CLI and the skdashboard console (card `e7cde8f1`). No public/capauth variant now.
- **Q4:** No change to the `ratings.jsonl` contract. Keep `prompt_class` bucketing;
  capability vectors live in the facts store, ratings are consumed as-is via
  `modelStats()`.
- **Q5:** Per-provider catalog-absence threshold. Default 3 cycles to `eol`;
  OpenRouter requires 2 absent cycles to reach `suspect` (free tier is volatile).

## Dependency graph (swarm scheduling)

```
Phase 1 (bug fix, do first):
  P1.1 lifecycle module  ->  P1.2, P1.3, P1.4, P1.6   (parallel after P1.1)
                             P1.4 -> P1.5
Phase 2 (after P1 merged):
  P2.1 adapters  ->  P2.2, P2.4          P1.1 -> P2.3
Phase 3 (after P2 merged):
  P2.1 -> P3.1 -> P3.2 -> P3.3 -> P3.4        P3.1 -> P3.5 (optional)
Phase 4 (after P3 merged, flag OFF):
  P4.1 -> P4.3;  P4.1 + P3.2 -> P4.2 -> P4.4;  P2.1 -> P4.5 (optional)
```

Phases are sequential (merge a phase before starting the next). Within a phase, cards
sharing no `Depends` edge can run concurrently in separate worktrees.

---

# PHASE 1 - Freshness + EOL pruning (the proper bug fix)

> Supersedes the tactical stopgap already shipped (`ba99c44`: live default model +
> `classifyError(410)->backend_error`). Phase 1 makes EOL model-granular and
> automatic. Leave the stopgap in place until P1.5 lands, then P1.5 removes the
> hardcoded default.

### Card P1.1: Lifecycle state machine module (pure)

**Depends:** none (foundation)
**Files:**
- Create: `src/discovery/lifecycle.mjs`
- Test: `tests/lifecycle.test.mjs`

**Interfaces (Produces):**
- `LIFECYCLE_STATES = { ACTIVE:'active', SUSPECT:'suspect', EOL:'eol', DEAD:'dead' }`
- `defaultLifecycle() -> { state:'active', last_verified_at:null, consecutive_permanent_errors:0, absent_cycles:0, eol_reason:null, eol_at:null }`
- `applyCompletionOutcome(lc, { status, now }) -> lc'` : a 2xx sets `state` back toward
  `active` and resets counters + `last_verified_at`; a 404/410 increments
  `consecutive_permanent_errors` and flips to `eol` at >= `eolErrorThreshold` (default 3).
- `applyCatalogPresence(lc, { present, provider, now, thresholds }) -> lc'` : present
  resets `absent_cycles` (and promotes `eol->active` if it reappears with a prior probe);
  absent increments `absent_cycles` and flips `active->suspect` at the provider threshold
  (openrouter 2, default 1) and `suspect->eol` at `absentEolThreshold` (default 3).
- `applyProbeOutcome(lc, { ok, status, now }) -> lc'` : ok promotes toward active; a 410
  sets `eol` with `eol_reason:'probe_failed'`.
- `ageDeadModels(lc, { now, deadAfterMs }) -> lc'` : `eol` older than 30d -> `dead`.
- `isRoutable(lc) -> boolean` : true for `active|suspect`, false for `eol|dead`.
- `THRESHOLDS` default object; all transitions take an injected `thresholds` arg so
  they are pure and testable (no clock, no env read inside).

**Description:** Pure state-machine functions per the design doc section 4.2. No I/O,
no `Date.now()` inside (caller passes `now`). This is the model-granular shadow of the
existing backend-granular health machine; it does NOT touch backend health.

**Acceptance criteria:**
- All transitions in 4.2 covered: active<->suspect<->eol->dead, and eol->active recovery.
- `suspect` is routable; `eol`/`dead` are not.
- Thresholds injectable; openrouter's 2-cycle suspect rule honored via the `provider` arg.

**Test plan (write these first, they must fail before impl):**
- 3 consecutive 410s: active -> eol with `eol_reason:'provider_410'`.
- 2 x 410 then a 200: counter resets, stays `active`.
- absent 1 cycle (provider=openrouter): active -> suspect; absent 1 cycle (default): also suspect.
- absent 3 cycles: suspect -> eol with `eol_reason:'dropped_from_catalog'`.
- reappear in catalog + successful probe: eol -> active.
- eol for 31 days: -> dead; a returning id from `dead` becomes `suspect`, not `active`.
- `isRoutable`: true for active/suspect, false for eol/dead.

**Out of scope:** persistence, wiring into router/discovery (later cards).

- [ ] Write `tests/lifecycle.test.mjs` (cases above), run, confirm FAIL.
- [ ] Implement `src/discovery/lifecycle.mjs`, run tests to green.
- [ ] `npm test` (no new failures). Commit.

---

### Card P1.2: Record per-model completion outcomes in the router loop

**Depends:** P1.1
**Files:**
- Create: `src/discovery/model_catalog_store.mjs` (thin persistence around the catalog
  store: `loadCatalogStore()`, `recordModelOutcome(id, {status, now})`,
  `getLifecycle(id)`, mtime/TTL cached like `loadRatings()` in `empirical.mjs`).
- Modify: `src/proxy/router.mjs` (the candidate loop around `router.mjs:1534`, where
  `const success = res.status < 500`).
- Test: `tests/model-catalog-store.test.mjs`, `tests/router-model-outcome.test.mjs`

**Interfaces:**
- Consumes: `lifecycle.mjs` (`applyCompletionOutcome`, `defaultLifecycle`).
- Produces: `recordModelOutcome(modelId, { status, now }) -> void` (fail-soft; never
  throws into the request path), `getLifecycle(modelId) -> lifecycle`.

**Description:** At the point the router already has `res.status` for a concrete model,
call `recordModelOutcome(currentReq.model, { status, now })` for 404/410 (and 2xx to
reset). This is the passive signal for actively-used models (section 4.2). ~10 lines in
the loop plus the small store module. Fail-soft: a store write error must never affect
the response. IMPORTANT: this does NOT change the existing `success = res.status < 500`
failover decision (the shipped `classifyError(410)->backend_error` stopgap already makes
410 fail over); it only records the lifecycle signal.

**Acceptance criteria:**
- A 410 completion for model X increments X's `consecutive_permanent_errors` in the store.
- A 2xx completion resets X's counter and sets `last_verified_at`.
- Store writes are fail-soft (inject a write that throws; the request still returns).
- Store reads are mtime/TTL cached (no fs read per request).

**Test plan:**
- `model-catalog-store`: round-trip a lifecycle; recordModelOutcome mutates + persists;
  a throwing writer is swallowed; TTL cache returns stale within TTL.
- `router-model-outcome`: drive the loop path (or a extracted helper) with a fake 410
  response, assert `recordModelOutcome` called with `{status:410}`; with a 200, called
  with `{status:200}`.

**Out of scope:** advertise/route filtering (P1.4), fallback resolution (P1.5).

- [ ] Failing tests first. [ ] Store module. [ ] Router hook. [ ] Green. [ ] Commit.

---

### Card P1.3: Catalog-absence tracking in discovery

**Depends:** P1.1, P1.2 (store)
**Files:**
- Modify: `src/discovery.mjs` (`discoverCatalog()` / the per-cycle merge that writes ids).
- Test: `tests/discovery-absence.test.mjs`

**Interfaces:**
- Consumes: `lifecycle.applyCatalogPresence`, `model_catalog_store` (load/save).

**Description:** Each discovery cycle, for every known model in the store, call
`applyCatalogPresence(lc, { present, provider, now, thresholds })` where `present` is
whether the id appeared in this cycle's fetched catalog. Per-provider thresholds (Q5:
openrouter suspect at 2 absent). Persist the updated lifecycle. Cadence unchanged
(`discovery.refresh_seconds`), runs where `refreshCatalog()` already runs.

**Acceptance criteria:**
- A model absent from an nvidia cycle goes active->suspect after the default threshold.
- An openrouter model needs 2 absent cycles to reach suspect (per-provider).
- A model absent for `absentEolThreshold` cycles reaches eol (`dropped_from_catalog`).
- Reappearance resets absence and (with a prior probe) recovers eol->active.

**Test plan:** feed `discoverCatalog` (or an extracted `reconcilePresence(store, fetchedIds,
provider, now)`) synthetic fetched-id sets across cycles; assert lifecycle transitions
match Q5 per-provider thresholds. No network (inject the fetched sets).

- [ ] Failing tests. [ ] Implement presence reconcile. [ ] Green. [ ] Commit.

---

### Card P1.4: Lifecycle-aware advertise + route registration

**Depends:** P1.1, P1.2
**Files:**
- Modify: `src/index.mjs` (`registerDiscoveredRoutes()` ~`src/index.mjs:119`; the
  `/v1/models` merge ~`src/index.mjs:580`; `/admin/models/status`).
- Test: `tests/advertise-lifecycle.test.mjs`

**Interfaces:**
- Consumes: `model_catalog_store.getLifecycle`, `lifecycle.isRoutable`.

**Description:** Only `active|suspect` ids are written into `Backend.models` by
`registerDiscoveredRoutes()`. `/v1/models` (and `/admin/models`) hide `eol|dead`, and
flag `suspect` (mirror the existing `status:"unavailable"` reconcile convention in
`advertise.mjs`). `/admin/models/status` gains lifecycle counts
(`{active, suspect, eol, dead}`). `/v1/models` shape stays a superset (additive only,
skchat picker unaffected).

**Acceptance criteria:**
- An `eol` id is absent from `Backend.models` and from `/v1/models`.
- A `suspect` id is present but flagged.
- `/admin/models/status` reports lifecycle counts.
- Existing allowlist filtering still applies (composes with, does not replace).

**Test plan:** build a fake store with mixed-state models; assert `registerDiscoveredRoutes`
writes only active/suspect; assert the `/v1/models` builder hides eol/dead and flags
suspect; assert status counts. Reuse the existing advertise test fixtures.

**Out of scope:** the concrete-model 404 gate (P1.6).

- [ ] Failing tests. [ ] Implement. [ ] Green. [ ] Commit.

---

### Card P1.5: Registry-resolved live local fallback (removes the hardcoded id)

**Depends:** P1.1, P1.4
**Files:**
- Modify: `~/.skcapstone/models/registry.yaml` (add `failover.local_fallback`).
- Modify: `src/proxy/registry.mjs` (parse `failover.local_fallback`).
- Modify: `src/proxy/local-failover.mjs` (`getFailoverConfig` / the fallback resolution:
  resolve the fallback model from the registry, filtered to lifecycle `active`; keep the
  `SKGATEWAY_LOCAL_FALLBACK_MODEL` env override).
- Test: `tests/local-failover.test.mjs` (extend), `tests/registry-failover.test.mjs`

**Interfaces:**
- Consumes: `model_catalog_store.getLifecycle`, registry `failover.local_fallback`.

**Description:** Replace the shipped hardcoded `openai/gpt-oss-20b` default (itself a
stopgap over the EOL `deepseek-v4-flash`) with a registry-declared fallback resolved to a
CURRENTLY-`active` model at call time. `registry.failover.local_fallback` names a role or
concrete id; local-failover picks the first `active` candidate. The env override remains
top priority. A dead model can never be a fallback again (eol is a hard filter).

**Acceptance criteria:**
- With `failover.local_fallback` set and the named model `active`, that model is used.
- If that model is `eol`, the next `active` candidate is used (never the eol one).
- `SKGATEWAY_LOCAL_FALLBACK_MODEL` env still overrides everything.
- Update the existing `sensible defaults` test: the default now comes from the registry,
  not a hardcoded string.

**Test plan:** inject a fake store + registry; assert active-only resolution, eol skip,
env override precedence. No network.

- [ ] Failing tests. [ ] registry.yaml + parse. [ ] local-failover resolution. [ ] Green. [ ] Commit.

---

### Card P1.6: Gate concrete-model requests for known-eol ids

**Depends:** P1.1, P1.2
**Files:**
- Modify: `src/proxy/router.mjs` (`candidatesFor()` ~`router.mjs:859`, the fall-back-to-
  all-backends branch).
- Test: `tests/router-eol-gate.test.mjs`

**Description:** When a request names a concrete model id that is `eol|dead` in the store,
return a clean 404 with `eol_reason` INSTEAD of spraying it across all backends (the
current fall-through, section 7.3). UNKNOWN ids keep today's fall-through (backward
compat). Only KNOWN-eol ids are gated.

**Acceptance criteria:**
- A request for a known-eol id gets a 404 with the `eol_reason`, no backend attempts.
- A request for an unknown id keeps the current fall-through behavior unchanged.
- A request for an `active` id is unaffected.

**Test plan:** fake store with an eol id; assert `candidatesFor(eolId)` returns the gated
404 path (or empty + a 404 responder) and makes no backend attempt; unknown id still
fans out; active id normal.

- [ ] Failing tests. [ ] Implement gate. [ ] Green. [ ] Commit.
- [ ] After P1.1-P1.6 merged: deploy, force a model eol (probe a known-dead id 3x or set
  its lifecycle), confirm it vanishes from `/v1/models`, `registerDiscoveredRoutes`, and
  fallback within one cycle. Then REMOVE the tactical hardcoded default note.

---

# PHASE 2 - Cards kept + probe sweep

### Card P2.1: Provider adapters with full-card normalization

**Depends:** Phase 1 merged
**Files:**
- Create: `src/discovery/providers/openrouter.mjs`, `src/discovery/providers/nvidia.mjs`
  (each exports `fetch()` and `normalize(json) -> ModelCard[]`).
- Modify: `src/discovery.mjs` (call the adapters; keep `discoverCatalog()` signature and
  fail-soft/cache-fallback semantics; stop discarding fields).
- Test: `tests/providers-openrouter.test.mjs`, `tests/providers-nvidia.test.mjs`

**Interfaces (Produces):**
- `ModelCard` shape per design 4.1 (`card.{context_length,max_output_tokens,modality,
  supported_parameters,description,pricing,source,fetched_at}`).
- `normalize(providerJson) -> ModelCard[]`.

**Description:** OpenRouter: keep the full card already in its `/models` response
(`context_length`, `supported_parameters` incl `tools`/`reasoning`/`structured_outputs`,
`architecture.modality`, `pricing`, `top_provider.max_completion_tokens`, `description`,
`created`); source `card`. NVIDIA: `/v1/models` is bare ids, so `normalize` does heuristic
family parsing of the id (org/family/size/variant: `-instruct`, `-thinking`, `coder`,
param counts) with `source:'heuristic'` (Q2). Do NOT scrape build.nvidia.com.

**Acceptance criteria:**
- OpenRouter free filter unchanged (`pricing.prompt==='0' && completion==='0'` or `:free`),
  but the full card is retained, not discarded.
- NVIDIA ids produce a heuristic card with `source:'heuristic'` and best-effort family/size.
- `discoverCatalog()` keeps its signature and cache-fallback behavior (fixture in, cards out).

**Test plan:** feed captured OpenRouter + NVIDIA `/models` JSON fixtures; assert full-card
fields retained for OR, heuristic fields for NVIDIA, and free-filtering preserved.

- [ ] Failing tests + fixtures. [ ] Adapters. [ ] Wire into discovery. [ ] Green. [ ] Commit.

---

### Card P2.2: Manual card overlay

**Depends:** P2.1
**Files:**
- Create: `config/model-cards.overrides.yaml` (fold in the `model_limits:` knowledge and
  known-slow flags currently hand-maintained in `skgateway.yaml` comments).
- Modify: `src/discovery.mjs` or the adapter merge (overlay wins over heuristics, loses to
  fresh provider cards).
- Test: `tests/card-overrides.test.mjs`

**Description:** Preserve Chef's validated per-model knowledge (context windows, "slow,
batch use" flags) as committed data with `source:'manual'`. Precedence: fresh provider
card > manual overlay > heuristic.

**Acceptance criteria:** overlay values override heuristic ones; a fresh provider card
overrides the overlay; `basis/source` reflects the winner.

**Test plan:** model with heuristic + overlay -> overlay wins; model with provider card +
overlay -> provider wins; assert `source` tags.

- [ ] Failing tests. [ ] Overlay file + merge. [ ] Green. [ ] Commit.

---

### Card P2.3: EOL probe sweep (automates the manual prune)

**Depends:** P1.1 (lifecycle), P1.2 (store)
**Files:**
- Create: `src/discovery/probe.mjs` (`probeModels(store, { budget, timeoutMs, pool, now })`).
- Modify: `src/discovery.mjs` / interval machinery (run on `discovery.probe_seconds`,
  default daily; `0` disables).
- Test: `tests/probe.test.mjs`

**Description:** Off the request path. Only models with no live traffic in 7 days, max
~20/cycle, one-word `max_tokens:4` completion, 15s timeout, through the existing NVIDIA
connection pool (respect the 20-concurrent limit). Outcomes feed `applyProbeOutcome`.
Exactly Chef's "warm one-word probe" methodology, budgeted.

**Acceptance criteria:**
- Only long-tail (no recent traffic) models are probed; budget cap respected.
- A 410 probe flips the model eol; a 200 probe records `last_verified_at`.
- `probe_seconds: 0` disables the sweep.
- Probes go through the pool (assert pool used; never a raw unbounded fan-out).

**Test plan:** inject a fake completion runner + store + clock; assert selection (traffic
filter + budget), lifecycle updates per probe status, and disable switch. No network.

- [ ] Failing tests. [ ] probe.mjs. [ ] Wire cadence. [ ] Green. [ ] Commit.

---

### Card P2.4: Expose cards + lifecycle on /admin/models and picker badges

**Depends:** P2.1
**Files:**
- Modify: `src/index.mjs` (`/admin/models` returns `card` + `lifecycle`; `/v1/models`
  gains ADDITIVE badge fields: `ctx_tokens`, `tools`, `vision`).
- Optional: `skchat/src/skchat/agent_model.py` (surface ctx/tools badges; additive only).
- Test: `tests/admin-models-cards.test.mjs`

**Description:** Make the kept cards visible. `/v1/models` stays a superset (additive
fields only) so the skchat picker and any consumer keep working; new badges are optional
to render. `/admin/models` returns the full card + lifecycle for the console (card
`e7cde8f1`).

**Acceptance criteria:** `/admin/models` includes card + lifecycle; `/v1/models` adds
`ctx_tokens`/`tools`/`vision` without removing/renaming existing fields.

**Test plan:** assert `/admin/models` payload shape; assert `/v1/models` is a superset of
the pre-change shape (no field removed/renamed) plus the new badges.

- [ ] Failing tests. [ ] Implement. [ ] Green. [ ] Commit.

---

# PHASE 3 - Scoring + suggest-only ranking

### Card P3.1: Capability derivation

**Depends:** P2.1
**Files:**
- Create: `src/ranking/capabilities.mjs`
  (`deriveCapabilities(modelCard, { metrics, ratings, now }) -> capabilities`).
- Test: `tests/capabilities.test.mjs`

**Interfaces (Produces):** `capabilities` per design 4.1 (`tool_use/reasoning/coding` with
`{score, basis}`, `ctx_tokens`, `latency_p50_ms`, `success_rate`, `vision`, `sovereignty`).

**Description:** Derive the capability vector from: card (`supported_parameters` ->
`tool_use` declared, `modality` -> vision, `context_length` -> ctx), `metrics.db`
(latency_p50, success_rate 14-day window), and `ratings.jsonl` via the EXISTING
`empirical.mjs modelStats()` (reasoning/coding priors + ratings mean per `prompt_class`).
Every score carries `basis` (card/heuristic/manual/prior/ratings). `sovereignty` from
`isLocalUrl()` (local-failover.mjs) + provider tag. Do NOT invent reasoning quality from
cards (basis honesty: declared vs reliable, per design 6.1).

**Acceptance criteria:**
- `tool_use.basis==='card'` when `supported_parameters` includes `tools`.
- Empirical dims (latency/success) sourced from injected metrics; priors when absent.
- `sovereignty` in `{local, free-remote, paid-cloud}` correct per backend url/provider.
- Reuses `modelStats()`; does not reimplement ratings parsing.

**Test plan:** inject card + fake metrics + fake modelStats; assert each dimension value +
basis; assert no reasoning score claims `basis:'card'`.

- [ ] Failing tests. [ ] Implement (reuse modelStats). [ ] Green. [ ] Commit.

---

### Card P3.2: The ranker (pure function)

**Depends:** P3.1
**Files:**
- Create: `src/ranking/rank.mjs`
  (`rankModels(catalog, requirements, opts) -> [{id, score, breakdown, excluded_reason}]`).
- Test: `tests/rank.test.mjs`

**Interfaces (Produces):** `rankModels(catalog, requirements, { allowlist, isModelAvailable,
now }) -> RankedCandidate[]`. `requirements = { require:{}, prefer:[], tier:[] }`.

**Description:** Pure, read-time (design 6.2). Pipeline: (1) hard filters:
`lifecycle.state==='active'`, `require` block (min_ctx, tool_use, vision, max_latency),
allowlist, backend availability; (2) sovereignty tiering by the `tier` ladder (local beats
remote within policy); (3) weighted score within tier over `prefer` dims with basis
weights (eval 1.0, ratings 0.8, card 0.6, prior 0.3) so empirical dominates priors;
(4) top-K ordered chain with per-model `breakdown`. No daemon, no precomputed leaderboard;
mtime/TTL cached like `loadRatings()`.

**Acceptance criteria:**
- eol/dead never ranked; `require` failures excluded with `excluded_reason`.
- Tier ordering strict: no free-remote ranked above a qualifying local within a role whose
  tier lists local first.
- A prior-only score never outranks an empirically-better model across a tier boundary.
- Deterministic + pure (same inputs -> same output; no clock/rand inside beyond injected `now`).

**Test plan:** synthetic catalog spanning states/tiers/bases; assert filter exclusions,
tier partition order, basis-weighted ordering, and `breakdown` content.

- [ ] Failing tests. [ ] Implement. [ ] Green. [ ] Commit.

---

### Card P3.3: Suggest-only rank API (loopback)

**Depends:** P3.2
**Files:**
- Modify: `src/index.mjs` (`GET /admin/models/rank?role=...` or `?require=...`, loopback
  only, same posture as other `/admin` routes).
- Test: `tests/admin-rank.test.mjs`

**Description:** Suggest-only (Q3): returns the ranked chain + breakdowns, routes nothing.
Loopback-bound like the other admin routes. Accepts a registry `@match` role name OR an
inline `require=` spec. This is what `skmodels suggest` and the skdashboard console call.

**Acceptance criteria:** returns ranked chain for a role and for an inline require spec;
refuses non-loopback; never triggers a completion.

**Test plan:** drive the handler with a fake ranker; assert loopback gate, role vs require
parsing, and shape. No routing.

- [ ] Failing tests. [ ] Implement route. [ ] Green. [ ] Commit.

---

### Card P3.4: `skmodels rank|suggest` CLI

**Depends:** P3.3
**Files:**
- Modify: `~/clawd/skos/src/skos/models/cli.py` (add `rank <role>` and
  `suggest --need tools --ctx 64k --tier local,free-remote` subcommands that curl the
  gateway's `/admin/models/rank`, like `cmd_test` already curls backends).
- Test: skos test suite (mirror an existing cli command test).

**Description:** Thin CLI over the rank API. Pretty-print the ranked chain + breakdown.
No new logic; formatting only.

**Acceptance criteria:** `skmodels rank sk-tools` prints the ranked chain; `skmodels
suggest --need tools --ctx 64k` builds the require spec and prints suggestions. Errors are
handled (gateway down -> clear message, non-zero exit).

**Test plan:** mock the HTTP call; assert request construction (role vs require flags) and
output formatting; assert graceful failure when the gateway is unreachable.

- [ ] Failing test. [ ] Implement subcommands. [ ] Green. [ ] Commit (skos repo).

---

### Card P3.5 (OPTIONAL): Micro-eval harness

**Depends:** P3.1
**Files:**
- Create: `src/ranking/eval.mjs` + fixed fixtures.
- Modify: `src/index.mjs` (`POST /admin/models/eval?model=...`, loopback).
- Test: `tests/eval.test.mjs`

**Description:** Tiny deterministic smoke suite (design 6.3), free/local models only:
one forced tool-call round trip (well-formed `tool_calls` via `src/proxy/tools.mjs`), one
JSON-schema adherence prompt, 3-5 fixed reasoning/coding items graded by string match (NOT
LLM-judged). Results land in `capabilities.*.score` with `basis:'eval'`. This is the only
path to `tool_use: reliable`. Keep it a smoke test, not a benchmark (risk 6).

**Acceptance criteria:** deterministic grading (string match), writes `basis:'eval'`
scores, loopback-only, opt-in per model. Never runs in the hot path or refresh loop.

**Test plan:** inject a fake completion runner returning known good/bad tool JSON; assert
grading + `basis:'eval'` write; assert it never auto-runs.

- [ ] Failing tests. [ ] Implement. [ ] Green. [ ] Commit.

---

# PHASE 4 - Capability-aware routing (@match roles, flag OFF)

> Ship behind `routing.match_enabled` (default OFF). Phase 3's suggest-only API is the
> soak period: observe rankings before they route a single request.

### Card P4.1: `@match` marker + requirements parsing in the registry

**Depends:** Phase 3 merged
**Files:**
- Modify: `src/proxy/registry.mjs` (`resolve()` ~`registry.mjs:196`: a role whose target is
  `@match` returns `{ match:true, role }`, parallel to the existing `{ auto:true }` marker;
  parse the `requirements:` and `failover.local_fallback` blocks).
- Modify: `~/.skcapstone/models/registry.yaml` (add example `@match` roles + `requirements`).
- Test: `tests/registry-match.test.mjs`

**Description:** Reuse the exact `sk-auto: auto` marker pattern for `@match`. Parse
`requirements[role] = { require, prefer, tier }`. Everything existing untouched.

**Acceptance criteria:** `resolve()` returns `{match:true, role}` for an `@match` role;
`requirements` parsed; non-match roles behave exactly as before.

**Test plan:** registry fixture with `@match` + plain + `auto` roles; assert resolution
markers and requirement parsing; assert plain roles unchanged.

- [ ] Failing tests. [ ] Implement parse/resolve. [ ] Green. [ ] Commit.

---

### Card P4.2: `@match` routing branch + decision-cache epoch

**Depends:** P4.1, P3.2
**Files:**
- Modify: `src/proxy/router.mjs` (after registry resolve, ~`router.mjs:1293`: on
  `{match:true}`, call `rankModels(catalog, requirements[role])` and map the top-K to the
  `candidates` array using the existing `bodyOverride` model-rewrite mechanism
  ~`router.mjs:1355`; gate the whole branch behind `routing.match_enabled`).
- Modify: the decision-cache epoch (`getConfigEpoch()` usage): epoch becomes
  `max(registry mtime, catalog store mtime)` so a catalog refresh / EOL flip invalidates
  cached `@match` picks.
- Test: `tests/router-match.test.mjs`

**Description:** The ranked chain IS the failover chain (design 7.2). Failover/quarantine/
pool/SIEM all apply unchanged because candidates use the existing shape. Flag-gated.

**Acceptance criteria:**
- With `match_enabled` ON, an `@match` role produces a ranked candidate chain; failover
  across the chain works (reuse existing failover test harness).
- With the flag OFF, `@match` roles are inert (fall back to today's behavior / a safe default).
- A catalog mtime bump invalidates a cached `@match` decision (epoch composition).

**Test plan:** fake ranker + registry; assert candidate chain built from rank output; flip
the flag and assert inert; bump catalog mtime and assert cache miss.

- [ ] Failing tests. [ ] Implement branch + epoch. [ ] Green (flag OFF by default). [ ] Commit.

---

### Card P4.3: `x-sk-require` header escape hatch

**Depends:** P4.1
**Files:**
- Modify: `src/index.mjs` (parse `x-sk-require: tool_use,min_ctx=64000,tier=local|free-remote`
  alongside the existing `x-sk-context/service/role` headers; feed the same resolver).
- Test: `tests/header-require.test.mjs`

**Description:** One-off jobs declare requirements per-request without editing the registry
(design 7.1). Parses into the same `requirements` shape the ranker consumes. Flag-gated
with P4.2.

**Acceptance criteria:** header parsed into `{require, tier}`; malformed header is ignored
(fail-soft, request proceeds by normal resolution); composes with role/context precedence.

**Test plan:** assert parse of well-formed header; malformed -> ignored; interaction with an
explicit role.

- [ ] Failing tests. [ ] Implement parse. [ ] Green. [ ] Commit.

---

### Card P4.4: Rollout flag + `sk-heavy-free` A/B (Q1)

**Depends:** P4.2
**Files:**
- Modify: config (`routing.match_enabled`, default OFF) + `~/.skcapstone/models/registry.yaml`
  (add `sk-heavy-free: "@match"` with a deep-reasoning requirement block; leave
  `sk-heavy: opus` PINNED).
- Test: `tests/router-match.test.mjs` (extend) / a small A/B routing test.

**Description:** Q1 decision: `sk-heavy` stays pinned to Opus. `sk-heavy-free` is a new
`@match` role for opt-in A/B. The difficulty classifier still emits `sk-heavy` for hard
prompts; only an explicit opt-in (a service/agent context pointing at `sk-heavy-free`, or a
future flag) routes hard prompts to free models. Record outcomes so ratings can compare.

**Acceptance criteria:** `sk-heavy` unchanged (opus); `sk-heavy-free` resolves via `@match`;
default hard-prompt routing is NOT altered; the A/B is opt-in only.

**Test plan:** assert `sk-heavy` still resolves to opus; `sk-heavy-free` resolves to a
ranked free chain; classifier output for a hard prompt still yields `sk-heavy` unless the
context opts into free.

- [ ] Failing tests. [ ] Flag + roles. [ ] Green. [ ] Commit.

---

### Card P4.5 (OPTIONAL): AGE projection exporter

**Depends:** P2.1
**Files:**
- Create: `scripts/pipelines/model-catalog-to-age.mjs` (or a hook in the refresh cycle).
- Modify: `scripts/pipelines/cron-jobs.json` (schedule the one-way projection).
- Test: a small exporter unit test (mock the AGE upsert).

**Description:** One-way projection of cards/ratings into skmem-pg AGE (`{agent}_knowledge`)
for skbrain/ops-wiki queries (model nodes, `replaced-by`/`same-family` edges). ZERO routing
dependency (design 4.4). Nice-to-have.

**Acceptance criteria:** exporter upserts model-card nodes + edges; is idempotent; the
gateway routing path never reads AGE.

**Test plan:** mock the AGE client; assert node/edge upserts from a fake catalog; assert
idempotency.

- [ ] Failing test. [ ] Exporter + cron. [ ] Green. [ ] Commit.

---

## Swarm execution guide

1. **One card = one worktree = one Sonnet agent.** Use `superpowers:using-git-worktrees`.
2. **TDD every card** (`superpowers:test-driven-development`): failing test first, minimal
   impl, green, then commit with the trailer.
3. **Respect the dependency graph.** Do not start a card until its `Depends` are merged.
   Phase gates are hard: fully merge + deploy + smoke a phase before the next.
4. **Reviewer gate per card** (`superpowers:requesting-code-review`): a card is mergeable
   only when its tests pass, the full suite has no NEW failures, and it touched only its
   listed files/surfaces.
5. **Two optional cards** (P3.5 eval harness, P4.5 AGE exporter) can be skipped/deferred
   without blocking anything.
6. **Phase 1 first, always.** It is the reliability fix (proper EOL handling) and unblocks
   nothing downstream depends on cards; ship it, deploy it, verify a real EOL model prunes
   itself, then proceed.
