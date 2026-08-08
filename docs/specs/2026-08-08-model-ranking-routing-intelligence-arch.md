# Model Quality/Ranking + Capability-Aware Routing Intelligence

**Status:** PROPOSAL (design only, nothing implemented)
**Date:** 2026-08-08
**Scope:** skgateway (`~/clawd/skcapstone-repos/skgateway`), skmodels registry (`~/.skcapstone/models/registry.yaml`), skos.models, skchat model picker
**Author:** strategic-architecture pass, grounded in the code as of `main` 2026-08-08

---

## 1. Problem

skgateway fronts a heterogeneous model fleet: local Ornith-1.0-35B on chiap08
(`chiap08-ornith`, priority 4), ornith-tiny/9B on .100:8082 (`local`, priority 1),
~84 free NVIDIA NIM models, ~16 free OpenRouter models (both live-discovered),
and Anthropic cloud via the :18782 Claude Code wrapper with `anthropic-direct`
as degraded fallback (see `~/.skcapstone/gateway/skgateway.yaml`).

Model *selection* today is two mechanisms:

- **Role registry** (`~/.skcapstone/models/registry.yaml`, resolved by
  `src/proxy/registry.mjs`): `context > service > role > default`, roles map to
  exactly ONE backend each.
- **Difficulty classifier** (`src/classifiers/difficulty.mjs` +
  `src/classifiers/empirical.mjs`): for `sk-auto`, a heuristic picks one of
  three roles (`sk-vision` / `sk-heavy` / `sk-default`), with a bounded
  empirical nudge from `~/.skcapstone/models/ratings.jsonl`.

Neither mechanism knows anything about the ~100 free discovered models beyond
their id string. Nobody rates them, nobody tracks their capabilities, and
nobody notices when one dies. The concrete incident: the local-failover cloud
fallback is a **hardcoded model id**,
`src/proxy/local-failover.mjs:75`:

```js
fallbackModel: env.SKGATEWAY_LOCAL_FALLBACK_MODEL || "deepseek-ai/deepseek-v4-flash",
```

When NVIDIA decommissioned `deepseek-v4-flash` (410 Gone), the sovereign-first
failover path failed over to a dead model. The static NVIDIA list in
`skgateway.yaml` has a comment block ("PRUNED 2026-07-15, validated dead, all
failed a warm one-word probe") documenting that EOL pruning is currently a
**manual chore Chef does by hand with curl**.

Chef wants: (1) fresh catalogs + model cards, with EOL pruning; (2) quality and
capability ratings per model; (3) job-requirements-to-model matching including
the local vs free-remote vs Anthropic decision; (4) all of it integrated into
the existing machinery, no parallel store.

---

## 2. Ground truth: what exists today (read the code)

### 2.1 Discovery (already built, but lossy)

`src/discovery.mjs` polls both provider catalogs on a timer
(`refreshCatalog()` in `src/index.mjs:135`, interval
`discovery.refresh_seconds`, default/configured 3600s):

- `fetchNvidia()` GETs `https://integrate.api.nvidia.com/v1/models`;
  `parseNvidia()` keeps **only the id**: `{ id, provider: 'nvidia', free: true }`.
- `fetchOpenRouter()` GETs `https://openrouter.ai/api/v1/models`;
  `parseOpenRouterFree()` filters on `pricing.prompt === '0' &&
  pricing.completion === '0'` (or `:free` suffix), then **discards everything
  else**. OpenRouter's response actually carries `context_length`,
  `architecture.modality`, `supported_parameters` (which includes `tools`,
  `tool_choice`, `reasoning`, `structured_outputs`), `top_provider.max_completion_tokens`,
  `description`, and `created`. All of that is thrown on the floor today.
- Results are cached fail-soft at `~/.config/skgateway/model_catalog_cache.json`
  (`loadCache`/`saveCache`), with per-provider health bookkeeping
  (`recordProvider`) surfaced by `catalogStatus()` at
  `GET /admin/models/status`, and a manual `POST /admin/models/refresh`.

`registerDiscoveredRoutes()` (`src/index.mjs:119`) writes each cycle's ids
directly onto the live `Backend.models` arrays and **recomputes rather than
appends**, so a model that drops out of a provider catalog already drops out of
routing. This is the freshness backbone we build on; it is genuinely good.

### 2.2 Advertise pipeline

`GET /v1/models` (`src/index.mjs:580`) = `buildModelCatalog()` (static config
models, reconciled against live backend health per
`src/proxy/advertise.mjs`, modes `flag|hide|off`) merged with the discovered
catalog (`mergeDiscoveredCatalog()`), then filtered by the operator allowlist
(`src/advertise.mjs`, `~/.config/skgateway/advertise.json`, managed via
loopback-only `GET /admin/models` + `PUT /admin/models/advertise`). The skchat
picker (`skchat/src/skchat/agent_model.py`) consumes `/v1/models` and groups by
`provider`/`free`.

### 2.3 Routing + failover

`routeAndSend()` (`src/proxy/router.mjs:1192`) is the whole pipeline:
per-agent pin from the registry `agent:<id>` context (CR-5.1,
`resolveAgentTarget`) -> registry role/context resolution
(`isRegistryRouted`/`resolve`) -> `sk-auto` marker triggers
`classifyDifficulty()` + `adjustWithEmpirical()` behind a TTL+LRU decision
cache keyed on the registry mtime epoch (`decision-cache.mjs`,
`getConfigEpoch()`) -> candidate list -> loop with failover on status >= 500,
per-backend connection pool, health window, and consecutive-failure quarantine
(card 2d1f3a2c).

Two grounded gaps matter for this design:

1. **Health is backend-granular, never model-granular.** `Backend.recordOutcome()`
   and the quarantine trip key on the whole backend (all of `nvidia`). In the
   candidate loop, `const success = res.status < 500` (router.mjs:1534), so a
   **410/404 for one dead model counts as a SUCCESS**: no failover, no health
   damage, no quarantine. A dead model on a healthy backend is structurally
   invisible to every existing safety net. Reconciliation
   (`isModelAvailable()`) inherits this: it only asks whether the *backend* is
   available.
2. **Unmatched models route anyway.** `candidatesFor()` (router.mjs:859) falls
   back to *all available backends* when no backend claims a model, so even a
   pruned id gets tried against every backend and fails with client errors.

### 2.4 Existing empirical signal stores (do not rebuild these)

- `~/.skcapstone/models/ratings.jsonl` (shared contract with
  `skchat/src/skchat/telegram_ratings.py`): human 1-5 scores keyed by
  `(model, prompt_class)`; consumed by `classifiers/empirical.mjs`
  (`modelStats`) with prompt classes `vision|code|reasoning|agentic|long|general`.
- `data/metrics.db` (SQLite, `src/metrics/collector.mjs`, 90-day retention):
  per-request `{duration, status, model, backend, agent_id}` - a real latency
  and success-rate corpus per concrete model, already being written.
- Per-backend `latencyP50` / error-rate in the router health window.

### 2.5 The two model-selection systems (extend B, feed A)

- **A: per-agent reply model** - skchat picker; since CR-5.1 it *is* the
  registry `agent:<name>` context (agent_model.py writes through
  `skos.models.set_context`, ruamel round-trip preserving comments).
- **B: skos.models role registry** - `registry.yaml` + `skmodels` CLI
  (`~/clawd/skos/src/skos/models/cli.py`), mtime-watched by the gateway.

A already reads through B and through `GET /v1/models`. So the rule for this
design: **all new intelligence lands in B (registry = policy) and in the
gateway's discovery/advertise layer (catalog = facts); A inherits for free.**

### 2.6 Card-derived data already lives in config, hand-maintained

`model_limits:` in `skgateway.yaml` ("Values from NVIDIA NIM model cards
(2026-05-12)") is exactly the per-model context-window knowledge this design
automates, currently maintained by hand and already stale (it still lists
pruned models). The `metrics.pricing` block is the same story for cost.

---

## 3. Design overview

```
                      +---------------------------------------------+
  NVIDIA /v1/models   |  DISCOVERY (existing loop, enriched)        |
  OpenRouter /models  |  src/discovery.mjs + providers/*.mjs        |
        |             |  cards kept, not discarded                  |
        v             +-----------------+---------------------------+
  normalize to ModelCard               |
                                       v
                      +---------------------------------------------+
                      |  MODEL CATALOG STORE (facts, machine-owned) |
                      |  ~/.config/skgateway/model_catalog.json     |
                      |  card + capability vector + lifecycle       |
                      |  (evolves model_catalog_cache.json)         |
                      +------+----------------------+---------------+
                             |                      |
            liveness/EOL     |                      |  scores at read time
            verdicts from    v                      v
   routeAndSend outcomes  ADVERTISE            RANKER (pure fn)
   + probe sweep          /v1/models           /admin/models/rank
                          (never advertise     suggest-only API
                           eol/dead)                 |
                                                     v
                      +---------------------------------------------+
                      |  REGISTRY (policy, human-owned, SSOT)       |
                      |  ~/.skcapstone/models/registry.yaml         |
                      |  roles gain `require:`/`prefer:` blocks     |
                      |  sk-auto classifier unchanged as tierer     |
                      +---------------------------------------------+
                                       |
                                       v
                      routeAndSend candidate chain (existing
                      failover/quarantine/pool machinery)
```

Two-store split, deliberately:

- **Registry = policy.** Human-editable, Syncthing-synced, comment-preserving,
  already the SSOT for *which role/agent gets what*. It gains declarative
  *requirements*, never machine-written model picks.
- **Catalog store = facts.** Machine-refreshed, per-node, fail-soft, advertise-
  adjacent. It is the natural growth of the existing
  `model_catalog_cache.json`, not a new store: same path family, same
  load/save discipline, same freshness endpoint.

No new daemon, no new service, no third selection system.

---

## 4. Data model

### 4.1 ModelCard record (catalog store)

Evolve `~/.config/skgateway/model_catalog_cache.json` into
`~/.config/skgateway/model_catalog.json` (keep the old filename readable for
one release; `loadCache()` already tolerates shape drift by returning `{}`).
Per model:

```jsonc
{
  "id": "qwen/qwen3.5-122b-a10b",
  "provider": "nvidia",              // existing tag
  "free": true,                      // existing tag
  "card": {                          // NEW: raw-ish provider metadata
    "context_length": 262144,        // OpenRouter: direct; NVIDIA: enrichment/heuristic
    "max_output_tokens": 32768,
    "modality": "text->text",        // vision detection
    "supported_parameters": ["tools", "tool_choice", "structured_outputs"],
    "description": "...",            // truncated, for the graph/picker only
    "pricing": { "prompt": "0", "completion": "0" },
    "source": "openrouter|nvidia|manual|heuristic",
    "fetched_at": 1786500000000
  },
  "capabilities": {                  // NEW: derived, see section 6
    "tool_use":   { "score": 0.8, "basis": "card" },
    "reasoning":  { "score": 0.6, "basis": "prior" },
    "coding":     { "score": 0.7, "basis": "prior+ratings" },
    "ctx_tokens": 262144,
    "latency_p50_ms": 2400,          // from metrics.db / router window
    "success_rate": 0.98,            // from metrics.db, 14-day window
    "vision": false,
    "sovereignty": "free-remote"     // local | free-remote | paid-cloud
  },
  "lifecycle": {                     // NEW: EOL/availability, model-granular
    "state": "active",               // active | suspect | eol | dead
    "last_verified_at": 1786500000000,   // last 2xx completion or probe
    "consecutive_permanent_errors": 0,   // 404/410 counter
    "eol_reason": null,               // "provider_410" | "dropped_from_catalog" | "probe_failed"
    "eol_at": null
  }
}
```

`providers` and `lastRefreshedAt` bookkeeping stay exactly as `recordProvider`
writes them today.

### 4.2 Lifecycle state machine (model-granular, the piece that is missing)

- `active`: in provider catalog, no recent permanent errors.
- `suspect`: dropped out of one discovery cycle OR 1-2 permanent errors OR
  probe timeout. Still routable, deprioritized in ranking, flagged in
  `/admin/models`.
- `eol`: N (default 3) consecutive 404/410s on completions, OR absent from the
  provider catalog for M (default 3) consecutive cycles, OR a 410 on a probe.
  **Removed from `Backend.models` (so `supportsModel()` says no), removed from
  `/v1/models`, ineligible as a failover/fallback target.** This closes the
  candidatesFor() fall-through: an `eol` id in a request gets a clean 404 from
  the gateway's `/v1/models/:id`-style validation rather than being sprayed
  across backends (see 7.2 Phase 1).
- `dead`: `eol` for > 30 days; kept only as a tombstone so a returning id
  re-enters as `suspect`, not instantly `active`.
- Recovery: reappearing in the provider catalog + one successful probe
  promotes `eol -> active` automatically (mirrors the quarantine re-admit
  philosophy in router.mjs).

The signal source is the point where the gateway already sees every outcome:
in `routeAndSend()`'s candidate loop, after `sendUpstream`, a
`res.status === 404 || 410` on a completion for model X feeds
`recordModelOutcome(X, 'permanent_error')` into the catalog store (mtime-cheap,
same discipline as `recordLocalOutcome`). This is ~10 lines in the loop and a
small module; it is NOT a new health system, it is the model-granular shadow of
the existing backend-granular one.

### 4.3 Registry additions (policy)

```yaml
# registry.yaml (additions only; everything existing is untouched)
roles:
  sk-tools: "@match"        # "@match" marker: resolve via requirements, like "auto"
  sk-cheap-fast: "@match"

requirements:               # per-role requirement blocks (only for @match roles)
  sk-tools:
    require: { tool_use: true, min_ctx: 32768 }
    prefer:  [sovereign, success_rate, tool_use]   # ordered tie-breakers
    tier:    [local, free-remote, paid-cloud]      # sovereignty ladder
  sk-cheap-fast:
    require: { max_latency_p50_ms: 3000 }
    prefer:  [free, latency]
    tier:    [local, free-remote]                  # never escalate to paid

failover:
  local_fallback: sk-cheap-fast   # replaces the hardcoded deepseek id:
                                  # local-failover resolves a LIVE model here
```

This reuses the exact pattern the registry already has for `sk-auto: auto` (a
marker the gateway resolves per-request, `registry.mjs:196`). `skmodels` gains
`skmodels rank <role>` / `skmodels suggest --need tools --ctx 64k` subcommands
reading the gateway's rank endpoint (cli.py already curls backends in
`cmd_test`).

### 4.4 Where ratings live: NOT the graph (for routing)

skmem-pg AGE (`{agent}_knowledge` graph) is the right place for *analytics and
provenance* (model cards as nodes, "replaced-by"/"same-family" edges, rating
history), but the wrong place for the routing hot path:

- Routing must work when Postgres is down; every store the router reads today
  is a local file with an mtime cache (registry.mjs, empirical.mjs,
  advertise.mjs). The catalog store follows that proven pattern.
- The graph is per-agent and node-local; the gateway is fleet infrastructure.

So: catalog store is authoritative for routing; an **optional, one-way
projection** (a small exporter invoked from the existing refresh cycle or a
cron in `scripts/pipelines/cron-jobs.json`) can upsert cards into AGE for
skbrain/ops-wiki queries. Phase 4, nice-to-have, zero routing dependency.

---

## 5. Ingestion: catalogs + cards, fresh

### 5.1 Adapter pattern, inside the existing loop

Refactor `discovery.mjs`'s two parse functions into per-provider adapters
(`src/discovery/providers/nvidia.mjs`, `openrouter.mjs`) each exporting
`fetch()` and `normalize(json) -> ModelCard[]`. `discoverCatalog()` keeps its
exact signature and fail-soft/cache-fallback semantics; it just stops
discarding fields. Cadence stays `discovery.refresh_seconds` (3600s), kicked at
startup, plus the existing manual `POST /admin/models/refresh`. **No new
process; it all runs where `refreshCatalog()` already runs.**

Per provider, honestly:

- **OpenRouter**: one call already returns the full card
  (`context_length`, `supported_parameters`, `architecture.modality`,
  `pricing`, `top_provider.max_completion_tokens`). Just keep it. This is the
  richest and cheapest source.
- **NVIDIA NIM**: `/v1/models` returns essentially bare ids (`id`, `object`,
  `owned_by`). Card enrichment options, in order of preference:
  1. **Heuristic family parsing** of the id (org/family/size/variant:
     `-instruct`, `-thinking`, `coder`, parameter counts) - free, instant,
     honest `basis: "heuristic"`.
  2. **Manual overlay**: fold the existing hand-curated `model_limits:` +
     comments knowledge into a committed
     `config/model-cards.overrides.yaml` (context windows, known-slow flags
     like "deepseek-v4-pro ~46s, batch use"). This preserves Chef's validated
     knowledge instead of losing it in YAML comments.
  3. **build.nvidia.com card scrape**: possible but brittle and rate-limited;
     defer, open question Q2.
- **Local backends** (`tagLocalModels()` output): cards come from the registry
  backend blocks, which already carry `ctx`, `vision`, `kind`,
  `min_output_tokens` (registry.yaml:12-62). Zero new data entry.

### 5.2 EOL probe sweep (automating the 2026-07-15 manual prune)

A `probeModels()` pass, OFF the request path, budgeted and rate-limited
(default: only models with no live traffic in 7 days, max ~20 probes/cycle,
one-word `max_tokens: 4` completion, 15s timeout - exactly Chef's manual "warm
one-word probe" methodology). Runs at a slower cadence
(`discovery.probe_seconds`, default daily) inside the same interval machinery.
Outcomes feed the lifecycle state machine (4.2). Probes respect the NVIDIA
20-concurrent pool limit by going through the existing connection pool.

Honest note: probing ~100 models daily costs ~100 tiny free completions; the
passive completion-outcome signal (4.2) covers actively-used models for free,
so the sweep only exists for the long tail that nobody is routing to.

---

## 6. Scoring and ranking

### 6.1 Capability dimensions and their honest provenance

| Dimension | Derivation | Basis tag | Trustworthy? |
|---|---|---|---|
| `ctx_tokens` | OpenRouter card; registry `ctx`; NIM overlay/heuristic | card/manual | yes |
| `tool_use` (supported) | OpenRouter `supported_parameters` contains `tools` | card | yes (declared) |
| `tool_use` (reliable) | eval harness or ratings only | eval | **not card-derivable** |
| `vision` | `architecture.modality`; registry `vision:` | card | yes |
| `free`/cost | pricing fields; `metrics.pricing` block | card | yes |
| `sovereignty` | `isLocalUrl()` (local-failover.mjs) on serving backend; provider tag | derived | yes |
| `latency_p50_ms` | `metrics.db` per-model + router `LatencyTracker` | empirical | yes, for used models |
| `success_rate` | `metrics.db` status codes, 14-day window | empirical | yes, for used models |
| `reasoning`, `coding` quality | id-family priors + `ratings.jsonl` per `prompt_class` + optional evals | prior/ratings/eval | **weakest; be explicit** |

Every score carries its `basis`. A prior-only quality score is displayed as
such and weighted below any empirical signal. This design does **not** pretend
card metadata can rank reasoning quality; it can only rank *declared
capability* and *fit* (context, tools, modality, cost, locality) plus whatever
the fleet has empirically observed.

### 6.2 The ranker (pure function, unit-testable)

`src/ranking/rank.mjs`: `rankModels(catalog, requirements, opts) -> [{id,
score, breakdown, excluded_reason}]`. Pipeline:

1. **Hard filters**: `lifecycle.state === 'active'` (never rank eol/dead),
   `require` block (min_ctx, tool_use, vision, max_latency), allowlist
   (`applyAllowlist`), backend availability (`isModelAvailable`).
2. **Sovereignty tiering**: partition by the role's `tier:` ladder. Local
   models beat remote *within policy*, mirroring the sovereign-first stance of
   `local-failover.mjs`.
3. **Weighted score within tier**: normalized weighted sum over the `prefer:`
   dimensions; empirical dimensions (success_rate, latency, ratings mean via
   the existing `modelStats()` from `empirical.mjs`) dominate priors by
   construction (basis weights: eval 1.0, ratings 0.8, card 0.6, prior 0.3).
4. Output the top-K as an ordered candidate chain, with per-model `breakdown`
   for observability (same spirit as the classifier's `signals` array).

Same read-time discipline as everything else in this codebase: no ranking
daemon, no precomputed leaderboard to go stale; scores are computed from the
catalog + metrics caches on demand, mtime/TTL-cached like `loadRatings()`.

### 6.3 Optional micro-eval harness (Phase 3+, honest tier)

A tiny fixed suite per capability, run through the gateway itself against
free/local models only, on demand (`POST /admin/models/eval?model=...`) or
weekly for the top-ranked-by-prior models:

- tool-use: one forced tool-call round trip, check well-formed `tool_calls`
  JSON (the gateway already has the tool plumbing in `src/proxy/tools.mjs`).
- structured output: one JSON-schema adherence prompt.
- reasoning/coding: 3-5 fixed items each, graded by string match (not
  LLM-judged, to stay deterministic and free).

Results land in `capabilities.*.score` with `basis: "eval"`. This is the only
way `tool_use: reliable` becomes real; everything before it is declared
capability. Scoped small deliberately: this is a smoke test, not a benchmark.

---

## 7. Job -> model matching and routing composition

### 7.1 How a job declares requirements

Three surfaces, all existing:

1. **Registry role** (primary): a job/service uses a `@match` role
   (`x-sk-role: sk-tools`, or `model: "sk-tools"`, or a
   `service:<name>`/`job:<name>` context pointing at it). This is the
   convention today ("code asks for a ROLE, never a raw url") extended from
   role -> one-backend to role -> requirement-set.
2. **Per-request header** (escape hatch): `x-sk-require:
   tool_use,min_ctx=64000,tier=local|free-remote` parsed in `index.mjs`
   alongside the existing `x-sk-context/service/role` headers, feeding the same
   resolver. For one-off jobs without registry edits.
3. **Suggest-only API**: `GET /admin/models/rank?role=sk-tools` (or
   `?require=...`) returns the ranked chain + breakdowns without routing
   anything. This is what `skmodels suggest`, the skdashboard model console
   (card `e7cde8f1`), and autocode adapters call to *choose* a model.

### 7.2 Resolution order (composing with what exists)

In `resolve()` (registry.mjs), a role whose target is the `@match` marker
returns `{ match: true, role }`, exactly parallel to the existing
`{ auto: true }` marker. In `routeAndSend()`:

```
per-agent pin (agent:<id> context)          [unchanged]
  -> registry resolve, precedence context > service > role > default  [unchanged]
    -> sk-auto?   classifyDifficulty + empirical nudge -> concrete role  [unchanged]
    -> @match?    rankModels(catalog, requirements[role]) -> top-K chain [NEW]
    -> plain role -> single backend                                    [unchanged]
  -> candidates[] -> pool/failover/quarantine loop                     [unchanged]
```

Key composition decisions:

- **The difficulty classifier is the TIERER, the ranker is the PICKER.**
  `sk-auto` keeps deciding *how hard* the request is; the roles it emits
  (`sk-heavy`/`sk-default`/`sk-vision`) may themselves be `@match` roles, so
  "hard" can resolve to "best available deep-reasoning model under the
  sovereignty ladder" instead of a single pinned backend. No change to
  `difficulty.mjs` or `empirical.mjs` is required; the layering point is
  `resolveRegistry({ role: d.role })` (router.mjs:1293).
- **The ranked chain IS the failover chain.** `rankModels()` output maps to
  the `candidates` array (with `bodyOverride` model rewrites per candidate,
  the mechanism the cloud-fallback candidate already uses,
  router.mjs:1355), so failover on 5xx, quarantine, SIEM events, and the
  connection pool all apply untouched.
- **Local vs remote vs Anthropic** = the `tier:` ladder in requirements +
  hard `sovereign: local-only` requirement when a job must not leave the
  fleet. Paid-cloud (Anthropic) is only reachable when a role's tier ladder
  includes it, preserving the cost posture (`free` tagging exists precisely
  because mislabeling paid models "is a cost footgun", index.mjs:88-95).
- **Decision cache**: `@match` decisions enter the existing
  `_autoDecisionCache` keyed on `decisionKey(messages, epoch)`; the epoch must
  become `max(registry mtime, catalog store mtime)` so a catalog refresh or
  EOL flip invalidates cached picks (one-line change to `getConfigEpoch()`
  usage).
- **Fallback model fix**: `getFailoverConfig()` resolves
  `registry.failover.local_fallback` through the ranker (filtered to
  `state: active`, tier free-remote) instead of the hardcoded id; env var
  stays as an override. A dead model can then never be a fallback target
  again, because `eol` is a hard filter.

### 7.3 What "never advertised, never failed-over-to" means concretely

- `/v1/models` + `/admin/models`: lifecycle filter added next to
  `applyAllowlist` (eol/dead hidden; suspect flagged, mirroring the existing
  `status: "unavailable"` reconcile convention).
- `registerDiscoveredRoutes()`: only `active|suspect` ids are written into
  `Backend.models`.
- Ranker hard filter (7.2) covers `@match` roles, the failover fallback, and
  suggestions.
- Plain concrete-model requests for an `eol` id: `candidatesFor()`'s
  fall-back-to-all behavior is gated for known-eol ids so the gateway answers
  with a clean 404 + `eol_reason` instead of spraying the request across
  backends. (Unknown ids keep today's fall-through behavior, backward-compat.)

---

## 8. Integration points and phasing

Files/surfaces touched, by phase. Reuse-not-rebuild throughout: every phase
extends an existing module; the only new files are the provider adapters, the
lifecycle module, and the ranker.

### Phase 1 - Freshness + EOL pruning (the bug fix; smallest useful slice)
- `src/discovery.mjs`: lifecycle fields on catalog entries; catalog-absence
  counter (model missing M cycles -> eol).
- `src/proxy/router.mjs` (candidate loop): record 404/410 completion outcomes
  per model into the catalog store (`recordModelOutcome`); ~10 lines plus a
  small `src/discovery/lifecycle.mjs`.
- `src/index.mjs`: lifecycle filter in `registerDiscoveredRoutes()` and the
  `/v1/models` merge; `/admin/models/status` gains lifecycle counts.
- `src/proxy/local-failover.mjs`: fallback model resolved from the registry
  `failover.local_fallback` + catalog `active` filter (env override kept).
- Registry: add `failover.local_fallback`.
- Exit criteria: a 410'd model disappears from routing, advertise, and
  fallback within one refresh cycle + N request failures, automatically.

### Phase 2 - Cards kept + probe sweep
- `src/discovery/providers/{nvidia,openrouter}.mjs`: normalize full cards.
- `config/model-cards.overrides.yaml`: fold in `model_limits` knowledge.
- `probeModels()` sweep on `discovery.probe_seconds` cadence.
- `/admin/models` returns card + lifecycle; skchat picker can show ctx/tools
  badges (additive fields only, `/v1/models` shape stays a superset).

### Phase 3 - Scoring + suggest-only ranking
- `src/ranking/rank.mjs` (pure) + capability derivation
  (`src/ranking/capabilities.mjs`) reading metrics.db, ratings.jsonl
  (`modelStats` reused), and cards.
- `GET /admin/models/rank` (loopback, same posture as other admin routes).
- `skmodels rank|suggest` subcommands in skos (`skos/src/skos/models/cli.py`).
- Optional micro-eval harness behind `POST /admin/models/eval`.

### Phase 4 - Capability-aware routing (`@match` roles)
- `src/proxy/registry.mjs`: `@match` marker + `requirements:` parsing.
- `src/proxy/router.mjs`: `@match` branch building the ranked candidate chain;
  epoch composition for the decision cache.
- `x-sk-require` header parsing in `src/index.mjs`.
- Rollout flag: `routing.match_enabled` (config), default OFF; suggest-only
  API (Phase 3) is the soak period where rankings are observed before they
  route a single request.
- Optional: AGE projection exporter for skbrain/ops-wiki.

---

## 9. Risks and open questions

**Risks**
1. **Garbage-in for NVIDIA cards.** NIM's `/v1/models` is metadata-poor;
   heuristic priors on id strings will be wrong sometimes. Mitigation: `basis`
   tags everywhere, manual overlay file wins over heuristics, empirical signal
   wins over both. Never let a prior-only score cross a tier boundary.
2. **False EOL from transient 404s** (e.g. NVIDIA's per-account "404 Function
   not found"). Mitigation: N-consecutive threshold + catalog-absence
   corroboration + automatic probe-based recovery; `suspect` is reversible and
   still routable.
3. **Probe sweep burning rate limits.** Budgeted, pooled, daily, long-tail
   only; can be disabled (`probe_seconds: 0`).
4. **Decision-cache staleness across two epochs** (registry + catalog).
   Addressed in 7.2; must be tested explicitly.
5. **Catalog store divergence across nodes.** It is per-node derived state
   (like `data/metrics.db`), NOT synced; each gateway learns its own view.
   Policy (registry) stays the only synced artifact. This is a feature
   (node-local reachability differs) but must be documented so nobody "fixes"
   it with Syncthing.
6. **Scope creep toward a benchmark platform.** The eval harness is a smoke
   test with fixed tiny suites; anything bigger belongs in skos autopilot's
   grading machinery, not the gateway.

**Open questions**
- **Q1: Should `sk-heavy` become `@match` immediately in Phase 4, or stay
  pinned to Anthropic?** Difficulty escalation to a mis-ranked free model
  would silently degrade the "hard prompt" experience Chef tuned the
  classifier for. Proposal: keep `sk-heavy: opus` pinned; introduce
  `sk-heavy-free` as `@match` first and A/B via `ratings.jsonl`.
- **Q2: NVIDIA card enrichment source.** Is there a supported NGC/NIM metadata
  API worth the dependency, or do we accept heuristics + manual overlay
  permanently? Needs a spike.
- **Q3: Where do per-use-case rankings surface to humans?** skdashboard model
  console (Phase 2 kanban card `e7cde8f1`) vs skchat picker badges vs
  `skmodels` CLI only. Affects only presentation, but decides whether
  `/admin/models/rank` needs a non-loopback (capauth-gated) variant.
- **Q4: Should ratings.jsonl grow a `capability` field** so Telegram 1-5
  ratings can key on tool-use vs prose quality, or does `prompt_class` remain
  the only bucketing? Touches the shared contract with
  `skchat/telegram_ratings.py`, so it needs a cross-repo decision.
- **Q5: OpenRouter free-tier volatility.** Free models appear/disappear daily;
  should `suspect` demotion require 2 absent cycles instead of 1 for
  openrouter specifically (per-provider lifecycle tuning)?

---

## 10. Explicit non-goals

- No new routing daemon, service, or database.
- No third model-selection system: the registry remains the single policy
  authority; the catalog store is derived facts under the gateway's existing
  discovery/advertise ownership.
- No machine writes to `registry.yaml` model picks: the system *suggests*
  (rank API), humans (or an explicit operator action) commit policy.
- No LLM-judged evals in the gateway hot path or refresh loop.
