# Model Metadata, Risk Ratings, and Job-Requirement Matching

**Status:** PROPOSAL (design only, nothing implemented)
**Date:** 2026-08-14
**Scope:** skgateway model cards + ranker + routing gates; registry policy
(`~/.skcapstone/models/registry.yaml`); curated overlay
(`config/model-cards.overrides.yaml`); alignment with the Joule Economy
size x risk grading.
**Prior art (this spec is a DELTA, not a replacement):**
`docs/specs/2026-08-08-model-ranking-routing-intelligence-arch.md` and
`docs/superpowers/plans/2026-08-08-model-ranking-routing-epic-cards.md`
(Phases 1-4, cards P1.1-P4.5). Read those first.

---

## 1. Problem

Chef's ask, verbatim: "how we are using the new XL LLMs and risk ratings for
model selection too, we may need to capture more info on each model to link up
to the requirements of the jobs."

Unpacked against the code as it stands:

1. **XL models are invisible as a class.** The fleet now spans a 9B local
   Ornith to 397B and 675B free NVIDIA models and 500K-context Opus. Nothing
   in the card, the capability vector, or the ranker knows that
   `mistralai/mistral-large-3-675b-instruct-2512` is a fundamentally different
   instrument than `openai/gpt-oss-20b`. The only size knowledge is the NVIDIA
   heuristic id parse (`src/discovery/providers/nvidia.mjs`, `parseHeuristicId`,
   fields `size`/`active_params` as strings) and it feeds nothing downstream
   except a prior boost in `capabilities.mjs`.

2. **Risk is not modeled at all.** There are two distinct risk axes and the
   current design conflates neither because it carries neither:
   (i) the risk/sensitivity of the JOB (blast radius, secrets, private
   corpora, self-modification), and (ii) the trust/exposure posture of the
   MODEL + provider (sovereign local vs free remote vs paid cloud, retention).
   The existing `tier:` ladder in the ranker (`src/ranking/rank.mjs:73`,
   `DEFAULT_TIER = ['local', 'free-remote', 'paid-cloud']`) is a COST
   preference ladder. It is not a trust ladder, and treating it as one is the
   trap: free-remote is cheaper than paid-cloud but LESS trustworthy with
   data (the free tier is paid for with the prompts).

3. **The failover chain crosses trust boundaries silently.** Ground truth
   from the live incident memory (`skgateway-sk-default-routes-to-cloud`):
   when chiap08:11436 went unreachable, sk-default traffic silently failed
   over to remote free models, and "a working fallback looks healthy". There
   is currently NO mechanism by which a request can say "this payload must
   not leave the fleet" and have that survive failover.

4. **The Joule Economy epic already defines the job-side grading.** Its
   locked decisions (design doc on branch `spec/joule-economy`,
   `docs/superpowers/specs/2026-08-14-joule-economy-design.md` sections
   3.1-3.4): two axes, `size` in S/M/L/XL (reasoning difficulty) and `risk`
   in LOW/MED/HIGH/CRIT (blast radius), with
   `model_class = max(size_rank, risk_rank)`, hard floor, soft ceiling, and
   the grade stored under the card's `meta.grade`. This spec ALIGNS with that
   scheme rather than inventing a parallel one: skgateway CONSUMES the grade,
   it never computes or stores one.

## 2. Ground truth (measured 2026-08-14, do not re-derive)

- Phases 1-3 of the 2026-08-08 epic are largely IMPLEMENTED: lifecycle state
  machine (`src/discovery/lifecycle.mjs`), catalog-absence reconcile + probe
  sweep (`src/discovery.mjs:96`, `src/discovery/probe.mjs`), provider
  adapters keeping full cards, the manual overlay
  (`config/model-cards.overrides.yaml`, applied at `src/discovery.mjs:188`
  `applyCardOverlay`), capability derivation
  (`src/ranking/capabilities.mjs:219` `deriveCapabilities`), the pure ranker
  (`src/ranking/rank.mjs:233` `rankModels`), the suggest-only
  `GET /admin/models/rank` (`src/index.mjs:629` onward), `skmodels
  rank|suggest` in skos (`~/clawd/skos/src/skos/models/cli.py`), the `@match`
  marker (`src/proxy/registry.mjs:246`), the `@match` routing branch behind
  `routing.match_enabled` default OFF (`src/proxy/router.mjs:1237-1382`),
  and the `x-sk-require` header parse (`src/index.mjs:708`).
- The live lifecycle store is INVERTED (83 upstream-live models marked eol,
  7 upstream-gone models marked active and advertised; 75 of the 83
  permanently stuck because `last_verified_at=null` blocks the
  `applyCatalogPresence` eol->active promotion at
  `src/discovery/lifecycle.mjs:105`). Only 16 models advertised, 6 answering
  410. That bug is being fixed separately; this spec ASSUMES a corrected
  store and only notes where its design depends on one.
- The `@match` catalog build feeds the capability deriver an EMPTY metrics
  snapshot: `deriveCapabilities(entry, { metrics: {} })` at
  `src/proxy/router.mjs:1314`. So in live `@match` routing, `latency_p50_ms`
  and `success_rate` are always null and score as 0.5 priors
  (`src/ranking/rank.mjs:159-168`). The empirical half of the ranker is
  wired but unfed.
- `metrics.db` has the tables (`request_log`, `token_usage`, `cost_log`,
  `latency_log`; `src/metrics/collector.mjs:194-253`) but the joule-economy
  audit found `recordResponse` is never called on the live path, so
  `token_usage`/`cost_log` receive zero live rows. Tokens/sec and measured
  cost derivations in this spec are BLOCKED on that fix.
- Energy metering exists in config as shadow-OFF
  (`~/.skcapstone/gateway/skgateway.yaml:354` `energy:` block) with one real
  measured coefficient (ornith on .100: 2.85 J per output token). Joule cost
  as a ranking signal is BLOCKED on joule-economy P0 landing.
- The live fleet: Anthropic Opus 4.8 / 4.7 / Sonnet 4.6 / Haiku 4.5 via the
  :18782 wrapper; local ornith-1.0-9b (.100:8082), ornith-1.0-35b
  (chiap08:11436, currently dead), qwen3.6-27b-abliterated (vision, same
  dead port), qwen3.8-27b (chiap08:11439, current sk-default); ~84 free
  NVIDIA NIM; ~17 free OpenRouter.

---

## 3. Design overview

Three additions, layered onto the existing two-store split (registry =
policy, catalog = facts):

1. **Model side:** the card gains a small set of machine fields (size,
   class, latency class, reasoning/output economics) and the capability
   vector gains `size_class` and `trust_zone`. Provider trust posture
   (retention/training) is curated per PROVIDER in the existing overlay
   file, not per model and not in a new store.
2. **Job side:** the existing `requirements` shape (`{require, prefer,
   tier}`) gains a handful of new `require` keys (`min_class`,
   `sensitivity`, `interactive`, `reasoning`, `structured_outputs`) and new
   `prefer` dimensions (`size`, `throughput`, `energy`). They ride the
   existing `@match` role blocks, the existing `x-sk-require` header
   grammar, and the existing `/admin/models/rank?require=` spec with zero
   new syntax. The Joule grade maps onto these keys by a fixed rule.
3. **The gate:** job sensitivity resolves (via a registry policy map) to a
   TRUST ZONE CEILING that is a hard filter in the ranker AND in every
   failover path, so a sensitive request can fail closed but can never
   silently cross into a less-trusted zone. This is deliberately a separate
   axis from the cost `tier:` ladder, which keeps its existing meaning.

```
        JOB SIDE                              MODEL SIDE
  meta.grade {size, risk}              card {params_b, size_class,
  + sensitivity declaration                  latency_class, reasoning, ...}
        |                              provider posture {retention}
        v                                      |
  require.min_class  ----- floor ----->  capabilities.size_class
  require.sensitivity -- policy map -->  capabilities.trust_zone (ceiling)
        |                                      |
        +------------> rankModels() <----------+
                  hard filters first (class floor, zone ceiling,
                  lifecycle, ctx, tools, vision)
                  then the EXISTING cost tier ladder + weighted score
                           |
                  ranked chain = failover chain
                  (zone ceiling holds through failover: fail closed,
                   never fail across)
```

---

## 4. Model metadata schema (what is missing and where each value comes from)

### 4.1 Field-by-field, with provenance

Today's card (overlay + adapters): `display_name`, `good_at`,
`context_length`, `max_output_tokens`, `supported_parameters`, `modality`,
`tier`, `quant`, `speed`, `params` (free text), plus the NVIDIA heuristic's
`org/family/size/active_params/variant` strings. The additions:

| Field | Type | Serves | Source (in precedence order) |
|---|---|---|---|
| `card.params_b` | number or null | XL awareness | derived: normalize the heuristic `size` string ("397b" -> 397); manual overlay for statics (claude, ornith); never guessed when unparseable |
| `card.active_params_b` | number or null | XL awareness (MoE honesty) | derived from heuristic `active_params` ("a17b" -> 17); overlay |
| `card.size_class` | enum `S,M,L,XL` | job matching floor | derived from `params_b` + family (default thresholds 6.1); MANUAL OVERLAY WINS (a curated class beats a guessed one, same precedence rule as `applyCardOverlay`, `src/discovery.mjs:188`) |
| `card.latency_class` | enum `interactive,batch` | XL usability | measured: metrics.db `latency_log` p50 over 14d when rows exist (>= 10s p50 => batch); overlay for known-slow ("deepseek-v4-pro ~46s"); default `interactive` |
| `card.reasoning` | boolean | output economics | provider card: `supported_parameters` contains `reasoning`; heuristic: variant `thinking`; overlay |
| `card.structured_outputs` | boolean | job matching | provider card: `supported_parameters` contains `structured_outputs`; overlay |
| `card.min_output_tokens` | number or null | reasoning-model floor | overlay, seeded from the registry backend blocks that already carry it (`registry.yaml` `min_output_tokens: 8192` on ornith/qwen38); a job's max_tokens below this starves content, so the matcher must know it |
| `providers.<name>.data_retention` | enum `trains,retains,contractual-zero,local-only` | trust zone | MANUAL OVERLAY ONLY, per provider (see 4.3); a fact claim someone verified against the ToS, dated |
| `capabilities.size_class` | enum | ranker | derived: surfaced from the card |
| `capabilities.trust_zone` | int 0..2 | risk gate | derived at read time from sovereignty + provider posture (5.2); NEVER stored |
| `capabilities.throughput_tps` | number or null | prefer dim | measured: `token_usage.completion_tokens / latency_log.total_ms` per model, 14d window. BLOCKED on the recordResponse fix (section 2); null until then, honestly |
| `capabilities.joules_per_token` | `{value, basis}` | prefer dim `energy` | measured (`energy_log`, joule P0) or the config coefficients (`skgateway.yaml:359`), basis-tagged `measured_gpu` / `imputed_local` / `imputed_cloud` per the joule epic's locked labels; null when neither exists |

Everything keeps the epic's basis-honesty rule: every derived or guessed
value is distinguishable from a declared or measured one, and a prior never
outweighs a measurement (`BASIS_WEIGHTS`, `src/ranking/rank.mjs:61`).

### 4.2 Example: an XL free model, fully described

```yaml
# config/model-cards.overrides.yaml (additions to the existing entry style)
overrides:
  mistralai/mistral-large-3-675b-instruct-2512:
    context_length: 262144
    tier: free-remote
    params_b: 675
    size_class: XL
    latency_class: batch          # measured slow; keep off interactive roles
    supported_parameters: [tools, tool_choice]   # tag only when verified
    notes: "675B dense. Free via NIM. Batch/cron work only."

  claude-opus-4-8:
    # existing fields unchanged, plus:
    size_class: XL
    latency_class: interactive
    # params unknown and irrelevant: class is curated for statics

  ornith-1.0-35b:
    size_class: L
    latency_class: interactive
    min_output_tokens: 8192

  ornith-1.0-9b:
    size_class: M
    latency_class: interactive
    min_output_tokens: 8192
```

### 4.3 Provider trust posture (new top-level block, same overlay file)

Per PROVIDER, because retention posture is a property of who serves the
model, not of the weights. Lives in the committed overlay (curated fact,
dated, verifiable), NOT in the registry (it is not policy) and NOT in a new
store.

```yaml
# config/model-cards.overrides.yaml
providers:
  local:        { data_retention: local-only }   # any isLocalUrl() backend
  anthropic:    { data_retention: contractual-zero,
                  verified: 2026-08-14, ref: "Anthropic commercial terms" }
  nvidia:       { data_retention: trains,
                  verified: 2026-08-14, ref: "NIM free tier ToS" }
  openrouter:   { data_retention: trains,
                  verified: 2026-08-14, ref: "free-tier routing providers vary; assume worst" }
```

A per-model override key (`data_retention` on a model entry) is allowed for
the exceptional case (e.g. a paid OpenRouter route with a no-log flag) and
wins over the provider default, same precedence philosophy as everywhere
else in the overlay.

---

## 5. Risk model: two axes, graded against each other

### 5.1 The job axis (consumed from the Joule Economy, not reinvented)

The joule design's grade, verbatim shape (its section 3.4):

```jsonc
"meta": { "grade": {
  "size": "M",            // S|M|L|XL   reasoning difficulty
  "risk": "high",         // low|med|high|crit   blast radius
  "model_class": "L",     // max(size, risk), derived
  ...
}}
```

`model_class` is the capability FLOOR for the work. That epic's floor/ceiling
rule carries over exactly: floor is hard (never route a graded job to a
model below its class), ceiling is soft (a bigger model is allowed; in the
joule economy the energy overage is debited, which the gateway does not
enforce, it only reports cost).

What the joule grade does NOT carry is confidentiality. Blast radius (what
the WORK can break) and sensitivity (what the DATA in the prompt exposes)
are different things: a docs card built on the private legal corpus is risk
LOW but must never reach a free remote model. So the job side declares one
more field:

- `sensitivity`: `public | internal | secret`
  - `public`: nothing in the payload that could not be posted publicly.
  - `internal`: fleet/business context, code, ops detail. Default for agent
    traffic.
  - `secret`: credentials, keys, private corpora (legal/medical), soul or
    memory content, anything under seal.

Proposed home: alongside the grade in `meta.grade.sensitivity` (cross-repo
decision with the joule epic, open question Q3), and per-request as a
`require` key (6.2). Self-modifying work: the joule epic already routes
`risk = CRIT` to Chef; the gateway-side reflection is that `risk=crit`
requests are treated as `sensitivity: secret` minimum plus a SIEM annotation
(9.4), never a free-remote candidate.

### 5.2 The model axis: trust zone (derived, three values)

```
zone 0  sovereign      isLocalUrl() backend or curated tier local;
                       data never leaves hardware we own
zone 1  contractual    paid cloud with a verified contractual-zero /
                       no-training retention posture (the Anthropic fleet
                       via the :18782 wrapper and anthropic-direct)
zone 2  exposed        free remote (NVIDIA NIM free tier, OpenRouter free):
                       assume prompts are retained and trained on
```

Derivation, at read time in `deriveCapabilities()`:

```
sovereignty == 'local'                          -> zone 0
provider posture data_retention == 'contractual-zero'
  (and sovereignty == 'paid-cloud')             -> zone 1
otherwise                                       -> zone 2
```

Note the deliberate inversion vs the cost ladder: the cost `tier:` ladder
(`local > free-remote > paid-cloud`) prefers free-remote OVER paid-cloud,
and it keeps doing so. The trust zone orders them the other way
(`local > paid-contractual > free-remote`). Two axes, two orders, both
correct for what they measure. The ranker applies the zone as a HARD FILTER
and the tier ladder as the ORDERING among survivors, so the two never fight.

### 5.3 The gate: how the axes grade against each other

Registry policy (human-owned) maps sensitivity to a zone ceiling:

```yaml
# registry.yaml (new top-level block; policy, so it lives here)
sensitivity_policy:
  public:   { max_zone: 2 }     # anything goes
  internal: { max_zone: 1 }     # sovereign or contractual cloud; never free-remote
  secret:   { max_zone: 0 }     # sovereign only
  default: internal             # traffic that declares nothing (see Q1)
```

Selection rule, in full:

```
zone_ceiling = sensitivity_policy[job.sensitivity].max_zone
candidates   = models where
                 lifecycle active                        (existing)
                 AND trust_zone   <= zone_ceiling        (NEW hard filter)
                 AND size_class   >= require.min_class   (NEW hard floor)
                 AND existing require checks (ctx, tools, vision, latency)
order          = existing tier ladder, then existing weighted score
failover chain = candidates, in order; if the chain empties, FAIL CLOSED
                 (503 with a reason), never widen the zone
```

The fail-closed clause is the fix for the silent sovereignty crossing: an
`internal` request whose local backend dies may fail over to Anthropic
(zone 1) but returns 503 rather than touching NIM; a `secret` request whose
local backend dies just fails, loudly, which is the correct behavior for
secrets. `public` traffic keeps today's full failover freedom, including the
free-remote `local_fallback` chain.

### 5.4 Worked examples against the real fleet

| Job | Grade / sensitivity | Eligible | Picked (typical) |
|---|---|---|---|
| coord card: write a pure helper + tests | S / LOW, internal | zone <= 1, class >= S | ornith-9b (zone 0, M) |
| coord card: MCP tool wrapping ansible (the joule golden-set example) | M / CRIT => class XL, secret | zone 0, class XL | none locally => fail closed, route to Chef (matches the joule CRIT rule) |
| legal-corpus summarization cron | M / LOW, secret | zone 0 | qwen3.8-27b or ornith-35b; NEVER cloud |
| skwhisper digest, batch overnight | M / LOW, internal, interactive: false | zone <= 1, batch OK | local first; large free NIM models EXCLUDED by zone despite being free and huge |
| public docs draft, batch | M / LOW, public | zone <= 2 | XL free models finally earn their keep: mistral-large-675b / qwen3.5-397b via `prefer: [size, free]` |
| hard interactive prompt via sk-auto | classifier says sk-heavy, internal | zone <= 1 | Opus (pinned, Q1 of the epic unchanged) |

This is the concrete answer to "how are we using the new XL LLMs": the free
XL tier is a PUBLIC-WORK BATCH tier. Zone gating is what makes it safe to
lean on it hard, because the same mechanism that unlocks it for public work
locks it away from everything else.

---

## 6. Job requirements schema (the other half of the match)

### 6.1 One shape, three entry points (all existing)

The `requirements` object stays `{require, prefer, tier}` everywhere. New
keys ride the existing grammar with no parser changes on the header/query
side (`parseRequireSpec`, `src/index.mjs:657`, already passes through
arbitrary `key=value` and bare-word keys):

```
require:
  min_class: S|M|L|XL         # capability floor = the joule model_class
  sensitivity: public|internal|secret
  interactive: true            # excludes latency_class batch
  reasoning: true              # model must support reasoning output
  structured_outputs: true
  min_ctx, tool_use, vision, max_latency_p50_ms   # existing, unchanged
prefer:                        # new dims join the existing ones
  size                         # bigger size_class scores higher (within tier)
  throughput                   # measured tps (null-safe prior 0.5)
  energy                       # lower joules_per_token scores higher
tier: [...]                    # existing cost ladder, meaning unchanged
```

CRITICAL implementation note (why this is an amendment, not config): the
ranker's `requireFailureReason` (`src/ranking/rank.mjs:100-125`) only
inspects the keys it knows. An unknown key like `min_class=XL` is SILENTLY
IGNORED today, which would pass every model. The new keys MUST be
implemented in `rank.mjs` before any caller is told they exist; until then a
`sensitivity=secret` header would be a placebo. This is the single most
dangerous foot-gun in this design and gets its own card (P5.3) plus a
negative-control test (a nonsense require key must be observable, not
silent: log or reject unknown keys once the known set is defined).

Entry points:

1. **Registry `@match` role** (primary): `requirements:` blocks per role,
   parsed by `getRequirements` (`src/proxy/registry.mjs:125`), routed by the
   P4.2 branch. Example:

```yaml
roles:
  sk-batch-public: "@match"
  sk-secret: "@match"
requirements:
  sk-batch-public:
    require: { sensitivity: public, min_class: L }
    prefer:  [size, free, success_rate]
    tier:    [local, free-remote]
  sk-secret:
    require: { sensitivity: secret }
    prefer:  [reasoning, success_rate, latency]
    tier:    [local]
```

2. **`x-sk-require` header** (per-request escape hatch, card P4.3):
   `x-sk-require: min_class=L,sensitivity=internal,interactive` parsed at
   `src/index.mjs:708`, gated by `routing.match_enabled`
   (`resolveRequestRequirements`, `src/index.mjs:735`). No new header is
   introduced; the joule grade travels on the existing one.

3. **Suggest-only API**: `GET /admin/models/rank?require=min_class=XL,...`
   (`resolveRankRequirements`, `src/index.mjs:777`) and `skmodels suggest`
   pick the new keys up for free once rank.mjs implements them.

### 6.2 The joule-grade mapping rule (dispatcher contract, cross-repo)

The component that dispatches a graded card to an LLM (skcoord/skharness
autopilot, the pull-market worker of joule P4) sets the header from the
grade by a fixed rule, so grading stays the grader's job and matching stays
the gateway's:

```
x-sk-require: min_class=<meta.grade.model_class>,
              sensitivity=<meta.grade.sensitivity || policy default>,
              interactive=<false for cron/batch lanes>
```

plus `risk=crit` handling upstream of the gateway per the joule rule (route
to Chef; the gateway never sees fully-automated CRIT work). The gateway does
NOT read coord cards and coord does NOT learn model names: the header is the
whole contract.

### 6.3 Reconciliation with sk-auto (the difficulty classifier)

Unchanged in role: the classifier (`classifyDifficulty`,
`src/classifiers/difficulty.mjs:250`) stays the TIERER for ungraded chat
traffic, the ranker stays the PICKER (epic 7.2). The alignment is that the
classifier's output roles are, in effect, a coarse size estimate for
interactive traffic that nobody graded:

```
sk-default  ~ class S/M     sk-heavy ~ class L/XL     sk-vision ~ vision
```

When those roles are later flipped to `@match` (epic Q1 keeps `sk-heavy`
pinned to Opus; `sk-heavy-free` is the A/B), their requirement blocks SHOULD
carry the equivalent `min_class` so the two vocabularies stay convertible.
No change to `difficulty.mjs` is needed or wanted: graded work arrives with
a grade, chat arrives with heuristics, both funnel into one requirements
shape.

---

## 7. Integration: which field lands in which store (no parallel stores)

| Datum | Store | Why there |
|---|---|---|
| `sensitivity_policy` map, per-role `require.sensitivity` / `min_class`, tier ladders | `~/.skcapstone/models/registry.yaml` | policy, human-owned, Syncthing-synced; the ONLY place a sensitivity->zone decision exists |
| `size_class`, `params_b`, `latency_class`, `min_output_tokens`, `reasoning`, `structured_outputs` overrides; `providers:` retention posture | `config/model-cards.overrides.yaml` | curated facts, committed, dated, reviewable in git; extends the existing overlay, precedence rules unchanged (`applyCardOverlay`, `src/discovery.mjs:188`) |
| heuristic `params_b`/`active_params_b`/`size_class` guesses, full provider cards | discovery catalog cache (`~/.config/skgateway/model_catalog_cache.json`) | machine facts, per-node, refreshed hourly where they are refreshed today |
| latency p50, success rate, throughput tps | `data/metrics.db` (`latency_log`, `request_log`, `token_usage`) | measured signal, already being written (tps blocked on the recordResponse fix) |
| joules per token | `energy_log` (joule P0) + config coefficients until then | measured signal, shadow-gated |
| human quality scores | `~/.skcapstone/models/ratings.jsonl` | UNCHANGED (epic locked decision Q4); consumed via `modelStats()` as today |
| `trust_zone`, zone ceilings, the merged capability vector, rankings | NOWHERE. Derived at request time in `deriveCapabilities()` / `rankModels()` | same read-time discipline as the whole epic: no daemon, no leaderboard, nothing to go stale |

Nothing new is persisted anywhere else. The lifecycle store, allowlist, and
decision caches are untouched in shape.

---

## 8. What is already built vs amended vs genuinely new

### 8.1 Built, and covers Chef's ask as-is (do not touch)

- Lifecycle machine + probe sweep + EOL gating (P1.x, P2.3): the freshness
  substrate everything here filters on.
- Full-card discovery + manual overlay + precedence (P2.1, P2.2): the
  vehicle for every new model field; zero new plumbing needed to carry them.
- Capability derivation + basis honesty (P3.1).
- The pure ranker with hard filters, tier ladder, basis-weighted scoring
  (P3.2): the zone ceiling and class floor are two more hard filters in a
  pipeline built for hard filters.
- `GET /admin/models/rank` + `skmodels rank|suggest` (P3.3, P3.4): the soak
  surface where the new filters get observed before they route anything.
- `@match` marker + routing branch + decision-cache epoch + `x-sk-require`
  parse, all behind `routing.match_enabled` OFF (P4.1-P4.3): the delivery
  mechanism, grammar included.
- sk-auto difficulty classifier as tierer (unchanged).

### 8.2 Amendments to existing modules (extend, in place)

- **A1 `capabilities.mjs`**: derive `size_class`, `trust_zone`,
  `latency_class`, `reasoning`, `structured_outputs`, `throughput_tps`,
  `joules_per_token`; read the `providers:` posture block.
- **A2 `rank.mjs`**: implement `require.min_class`, `require.sensitivity`
  (via an injected zone-ceiling resolver so the module stays pure),
  `require.interactive`, `require.reasoning`, `require.structured_outputs`;
  new `prefer` dims `size`/`throughput`/`energy`; unknown-require-key
  handling (reject or log, never silent).
- **A3 `router.mjs` buildMatchCatalog** (`:1303-1316`): feed a REAL metrics
  snapshot instead of `{metrics: {}}` (a small per-model
  `{latency_p50_ms, success_rate}` reader over metrics.db with an mtime/TTL
  cache, same discipline as `loadRatings()`), so live `@match` ranking stops
  scoring empirical dims as priors.
- **A4 overlay file**: new fields + `providers:` block (4.2, 4.3), seeded
  for the current fleet (statics, the XL NIM models, known-slow flags).
- **A5 `registry.mjs` + registry.yaml**: parse `sensitivity_policy`; example
  `@match` roles (`sk-batch-public`, `sk-secret`).

### 8.3 Genuinely new

- **N1 Trust-zone gating with fail-closed failover.** The zone ceiling as a
  hard filter in the ranker AND in the two non-match escape paths:
  `local-failover.mjs`'s cloud fallback (a sensitive request must 503, not
  fall to NIM) and `candidatesFor()`'s fall-back-to-all branch
  (`src/proxy/router.mjs:907-920`). This is the only piece that touches
  request-path semantics for non-`@match` traffic, so it gets its own flag
  (`routing.sensitivity_enforced`, default OFF, shadow-log first: log the
  WOULD-BLOCK decision for a soak window before enforcing, exactly the
  CR-3 PDP shadow->enforce pattern).
- **N2 size_class taxonomy + derivation**, aligned to the joule S/M/L/XL
  enum verbatim.
- **N3 Provider retention posture data** (the `providers:` block content
  itself: someone verifies the ToS claims and dates them).
- **N4 The grade->require dispatcher contract** (6.2), lands in
  skcoord/skharness, not skgateway; the gateway side is just the require
  keys.
- **N5 Energy-aware ranking** (`prefer: [energy]`), blocked on joule P0;
  ships as a dim that scores 0.5-prior until real numbers exist, so it can
  merge early and mean something later.

---

## 9. Phased delta against the 2026-08-08 epic

Phases 1-4 remain exactly as carded. This spec appends:

### Phase 5: metadata + risk gating (after Phase 4 merges; suggest-only first)

- **P5.1** Card schema fields: adapters keep/normalize `params_b` and
  `active_params_b`; overlay gains the 4.2 fields; `deriveCapabilities`
  surfaces `size_class`/`latency_class`/`reasoning`/`structured_outputs`.
  (A1, A4 part)
- **P5.2** Provider posture + `trust_zone` derivation + the seeded
  `providers:` block. (A1, A4, N3)
- **P5.3** Require-grammar keys in `rank.mjs` + unknown-key
  negative-control + registry `sensitivity_policy` parsing. Nothing user-
  facing announces the keys until this merges. (A2, A5)
- **P5.4** Metrics snapshot feed into the `@match` catalog. (A3)
- **P5.5** Fail-closed zone enforcement in `local-failover.mjs` and
  `candidatesFor()`, behind `routing.sensitivity_enforced` with a
  shadow-log soak. (N1)
- **P5.6** Registry example roles (`sk-batch-public`, `sk-secret`) +
  `skmodels suggest` flag pass-through (`--class`, `--sensitivity`), which
  is formatting only.

### Phase 6: measured economics (blocked, do not start until unblocked)

- **P6.1** `throughput_tps` derivation. BLOCKED on the live
  `recordResponse` wiring (joule epic's finding).
- **P6.2** `prefer: [energy]` with real `energy_log` numbers. BLOCKED on
  joule P0 meter validation.
- **P6.3** Dispatcher grade mapping in skcoord/skharness (N4, cross-repo,
  sequenced with joule P2 "route").

Exit criterion for Phase 5, in the epic's own style: a request tagged
`sensitivity=secret` with every local backend down returns a 503 with a
zone reason, appears in SIEM, and provably never opened a connection to
integrate.api.nvidia.com; and `skmodels suggest --class XL --sensitivity
public` returns the big NIM models while the same query at
`--sensitivity internal` returns only Claude and locals.

---

## 10. Open questions

- **Q1 Default sensitivity for undeclared traffic.** Proposal: `internal`
  (fail safe: free-remote requires an explicit `public`). But that flips
  today's behavior where anonymous traffic can reach NIM, so the default
  belongs to Chef and ships in the registry policy map, not in code.
  Shadow-log mode (N1) exists precisely to measure how much live traffic
  would change hands under `default: internal` before anyone enforces it.
- **Q2 Is Anthropic zone 1 acceptable for `internal`?** The
  `contractual-zero` claim needs a dated ToS verification before the
  `providers:` block asserts it. If Chef says no, `internal` collapses to
  zone 0 and the policy map expresses that in one line.
- **Q3 Where does `sensitivity` live on a graded card?** Proposed
  `meta.grade.sensitivity`, which is a joule-epic schema addition and needs
  that epic's sign-off (their grade schema is theirs). Fallback: a sibling
  `meta.sensitivity`, so the two epics stay decoupled.
- **Q4 MoE class: total or active params?** qwen3.5-397b-a17b is 397B total
  and 17B active. Proposal: class by TOTAL (it prices like a big model in
  quality terms), record `active_params_b` for honesty, let ratings correct
  the class over time via the overlay. Needs a decision before P5.1 writes
  the derivation.
- **Q5 Zone-gating unmatched concrete-model requests.** `candidatesFor()`'s
  fall-through sprays unknown ids across all backends; P5.5 gates it for
  sensitive requests, but should an unknown id + `secret` be a flat 404
  instead of a local-only try? Leaning yes (an unknown id is an unknown
  exposure), decide at P5.5 review.
- **Q6 `min_output_tokens` enforcement point.** Card field (this spec) vs
  the registry backend rewrite that already floors it for registry-routed
  roles. For `@match` picks of reasoning models the floor must apply too;
  probably a candidate `bodyOverride` concern in the P4.2 branch, small but
  needs a home.

## 11. Explicit non-goals

- No parallel grading scheme: size and risk enums, the max() rule, and the
  floor/ceiling semantics are the Joule Economy's, consumed verbatim.
- No machine writes to registry.yaml, no new store, no new daemon, no new
  database (the epic's non-goals all still bind).
- No jailbreak-resistance or content-safety scoring of models: trust zone
  is about where DATA goes, not what a model will say.
- No attempt to grade jobs inside the gateway: graders grade, dispatchers
  map, the gateway matches and gates.
