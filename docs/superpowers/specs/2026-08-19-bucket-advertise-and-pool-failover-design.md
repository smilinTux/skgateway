# SKGateway Bucket Advertisement + Pool Failover

**Status:** design approved (brainstorm 2026-08-19, Chef approved incl. the 404/410
failover extension), pending implementation.
**Author:** clawd (with Chef). **Supersedes:** nothing; extends card 2ba73bf9/C9
(buckets) and the 2026-08-18 incident fix (declaration-beats-verdict).

## 1. Goal

Two gaps in the shipped bucket layer (card 2ba73bf9 / C9), both verified by
recon on 2026-08-19:

1. **Buckets are armed but invisible.** `routing.buckets_enabled: true` has been
   live since 2026-08-16, yet `GET /v1/models` advertises 69 concrete models and
   **zero** `sk-*` ids — not the 12 size/sensitivity pools
   (`sk-{s,m,l,xl}-{public,internal,secret}`), and not even the registry roles
   (`sk-default`, `sk-vision`, `sk-creative`, `sk-heavy`, `sk-auto`,
   `ornith-tiny`). Clients discover them only by reading config files. Telling
   detail: `allBuckets()` in `src/policy/buckets.mjs` carries a doc comment
   saying it exists "to advertise buckets on /v1/models so a picker can offer
   them" — built but never wired, the exact "built-but-unreachable" failure
   pattern this codebase's cards (C3, C8) document.
2. **Pool failover is per-request, not per-fault.** A bucket request picks ONE
   member (deterministic round-robin, `selectMember`) and fails over only across
   that member's *doors* (same model, different providers, card 9e28de88). If the
   picked member 402s on every door, the request fails while other pool members
   idle. 404/410 are hard errors even for bucket requests, and an EOL-gated
   member throws `ModelEolError` out of `resolveBucketCandidates()` and kills
   the whole request.

This design closes both: buckets + roles are advertised on the public and admin
surfaces with a live per-bucket membership view, and a bucket request fails over
across the whole pool (members × their doors), preserving the
same-model-different-provider preference and the round-robin load spread.

## 2. Verified current state (recon, 2026-08-19)

- Buckets: `parseBucketId`, `isBucketId`, `looksLikeBucketAttempt`, `allBuckets`,
  `resolveBucket`, `selectMember` in `src/policy/buckets.mjs`; vocabulary from
  `docs/specs/joule-grade-vocabulary.json` (S/M/L/XL × public/internal/secret);
  sensitivity ceilings from the registry `sensitivity_policy`
  (`public: 2, internal: 1, secret: 0`).
- Routing: `resolveBucketCandidates()` in `src/proxy/router.mjs` (≈line 2049)
  picks one member via `_bucketCounters` + `selectMember`, then
  `await router.route({model: picked.id})` and returns that member's doors only.
  `route()` throws `ModelEolError` when a candidate set is eol-gated.
  `isFailoverStatus()` (≈line 292) = `>=500 || 429 || 402` — 404/410 do NOT
  fail over today. The candidate loop (≈line 2552) drives failover via
  `retryElsewhere = isFailoverStatus(res.status)`.
- Catalog: `GET /v1/models` handler in `src/index.mjs` (≈line 1098):
  `buildModelCatalog → mergeDiscoveredCatalog → applyAllowlist →
  applyLifecycleView(…, modelClaimersFor(…)) → applyPickerBadges →
  stripInternalCardFields`. `GET /admin/models` uses `buildAdminModelsView`
  (≈line 382). Admin surface pattern to copy: `GET /admin/models/rank`
  (≈line 758, read-only, loopback).
- Registry roles (live `~/.skcapstone/models/registry.yaml`): `ornith-tiny`,
  `sk-default`, `sk-vision`, `sk-creative`, `sk-heavy`, `sk-auto`;
  `defaults.role: sk-auto`. `isRegistryRouted()` (registry.mjs) routes any
  `sk-*` id, so roles are already routable — just not advertised.
- Gate config: `routing.buckets_enabled` read by `isBucketsEnabled()`
  (router.mjs ≈line 1950) from `config.routing.buckets_enabled`; `true` in both
  live configs.
- Conventions: additive-only `/v1/models` (card P2.4: no field removed/renamed,
  picker reads id/provider/free/owned_by); fail-soft; SIEM events for routing
  decisions; node:test + `tests/_setup.mjs`; hermetic ports for `index.mjs`
  direct-import suites (see `tests/advertise-lifecycle.test.mjs`,
  `tests/admin-models-cards.test.mjs`, `tests/model-claimer-lifecycle.test.mjs`);
  full suite currently 1305 passing.
- Tags: semver, latest `v0.6.0`.

## 3. Design

### 3.1 Advertise buckets + roles (Part 1a)

**New pure helper in `src/index.mjs`** (next to `modelClaimersFor`):

```
aliasCatalogEntries(cfg) -> Array<entry>
```

- Returns **bucket entries** (12) when `cfg?.routing?.buckets_enabled === true`,
  else none — do not advertise a 503 surface when the feature is off. Built from
  `allBuckets()` (policy/buckets.mjs) — single source of truth, never retyped.
  Each entry, in `/v1/models` shape:
  `{ id: "sk-l-internal", object: "model", created: 0, provider: "skgateway",
  free: false, owned_by: "skgateway", kind: "bucket",
  model_class: "L", sensitivity: "internal" }`
  - `free: false` is the honest default: a bucket's cost depends on which member
    serves (documented in the field's comment; do NOT derive from members).
  - `kind: "bucket"` / for roles `kind: "role"` is the additive discriminator
    (same discipline as P2.4 badges).
- Returns **role entries** (always — registry routing is unconditional, no flag
  gates it): the live registry's `roles:` keys, read via
  `loadRegistry()` (proxy/registry.mjs), fail-soft to `[]` when the registry is
  unavailable. Each:
  `{ id: "sk-vision", object: "model", created: 0, provider: "skgateway",
  free: false, owned_by: "skgateway", kind: "role" }`.
- **Injection point:** in the `GET /v1/models` handler, AFTER
  `const allowed = applyAllowlist(merged, loadAllowlist())` (line ≈1126),
  compute the aliases and append them: `allowed = [...allowed, ...aliasCatalogEntries(config).filter((e) => !seenIds.has(e.id))]`
  (dedupe: a role id could in principle collide with a declared model id;
  concrete models win, same first-seen-wins rule as `mergeDiscoveredCatalog`).
  When a non-empty allowlist is in effect, filter the alias entries through
  the SAME allowlist predicate first, so an operator allowlist stays an
  allowlist (when the allowlist is empty — the live state — all aliases pass).
  Everything after (applyLifecycleView → applyPickerBadges →
  stripInternalCardFields) then runs over models+aliases uniformly: aliases
  have no lifecycle record → `defaultLifecycle()` → `isEffectivelyRoutable`
  passes, unflagged — no special-casing needed. Same injection in the
  static-catalog fallback branch (line ≈1130) and in the `GET /admin/models`
  path (`buildAdminModelsView` input, line ≈1172): its per-id `lifecycle`
  object will show the default active record for aliases — honest: aliases
  are not lifecycle-tracked.
- `GET /admin/models`: inject the same entries into the `buildAdminModelsView`
  input so the admin view lists them (its per-id `lifecycle` object will show
  the default active record — honest: aliases are not lifecycle-tracked).

### 3.2 `GET /admin/buckets` — live pool membership (Part 1b)

New loopback admin endpoint (pattern: `/admin/models/rank`, read-only):

```
GET /admin/buckets -> 200 {
  buckets_enabled: bool,
  buckets: [
    { bucket: "sk-s-public", model_class: "S", sensitivity: "public",
      ceiling: 2, members: [...], rejected: [{id, reason}, ...] },
    ... exactly the 12 taxonomy entries, in allBuckets() order
  ]
}
```

- Built by a **new exported pure helper** (index.mjs): `bucketStatusView({
  catalog, policy, isRoutable, cfg })` that loops `allBuckets()` and calls
  `resolveBucket()` (policy/buckets.mjs) with the **same inputs
  `resolveBucketCandidates()` uses** (`buildMatchCatalog()`,
  `policyFromRegistry(loadRegistry())`, lifecycle gate) — one resolution rule,
  two surfaces, so the admin view and the request path can never disagree.
- `members` entries keep `resolveBucket`'s shape (`id, class_basis,
  model_class, trust_zone`); `rejected` keeps the actionable reasons (this is
  the durable answer to "which models satisfy sk-l-internal right now, and why
  not the others").
- Empty pools are normal and reported (not an error): a bucket whose pool is
  empty today resolves to the `bucket_no_eligible_member` 503 at request time,
  and this endpoint shows why.
- Fail-soft like its siblings: catalog/policy load failures degrade to
  `members: []` + a top-level `error` string, never 500.

### 3.3 Pool failover chain (Part 2)

**`resolveBucketCandidates()` (router.mjs)** — replace the single-member
dispatch with a member chain, keeping every existing guarantee:

1. Rotation unchanged: increment `_bucketCounters[bucket]` and take
   `selectMember(members, n)` as the **starting member** — round-robin still
   spreads first-door load (card 9e28de88's original point).
2. Order the members starting at the selected position (wrap-around). For each
   member, in order:
   - `try { results = await router.route({ ...request, model: member.id,
     agentId: request.agentId }) } catch (err) { if (err instanceof
     ModelEolError) { siemEvent("bucket_member_skipped", {bucket, member:
     member.id, eol_reason}); continue; } throw err; }`
     — an EOL-gated member is absorbed by the pool instead of failing the
     request; other throws (empty registry, misconfig) still propagate.
   - Flatten `results` (array or single, same normalization as today) and
     **dedupe by `${backendId}:${member.id}`** (a door can serve several member
     ids; retrying the same door+model twice in one request is a wasted call).
   - Tag each candidate: `{ ...r, bodyOverride: rewriteBodyModel(body,
     member.id), model: member.id }` (body-rewrite per member — the existing
     mechanism).
3. If the chain ends up empty (every member eol-gated), return the EXISTING
   `bucket_no_eligible_member` 503 contract (status/type/code/bucket/
   model_class/sensitivity/ceiling fields byte-identical), with `excluded`
   carrying the skipped members as `{id: member.id, reason:
   "eol-gated (<eol_reason>)"}` — same shape as the existing rejects, so a
   client built against the current 503 keeps working.
4. Keep the `bucket_resolve` SIEM event; add `chain_length` (number of members
   in the chain) and `skipped` (eol-skipped member ids) to its details.

**Candidate loop (routeAndSend, router.mjs)** — bucket requests only:

- The loop already receives `candidates`; record `isBucketChain = true` when
  they came from `resolveBucketCandidates` (set a flag on the resolved object,
  read it before the loop).
- `retryElsewhere = isFailoverStatus(res.status) || (isBucketChain && (res.status === 404 || res.status === 410));`
  Rationale: for a bucket the contract is *capability floor + trust zone*, not
  a specific model — a member 404/410'd on all its doors has failed the bucket,
  but a different eligible member can still satisfy it. Non-bucket requests are
  byte-identical (`isBucketChain` false → same expression as today).
- 404/410 outcomes from a member's doors still feed `recordModelOutcome`
  (claimer-aware, incident fix) — the member's EOL accounting is untouched.
- Throttle cooldowns (9e28de88) are keyed per `(backendId, model)` — with
  per-member model ids the keys are naturally per-member; no change needed.

**Observability headers** (additive): the `attributionHeaders(reqId,
result)` helper in `src/metrics/attribution.mjs` already emits
`x-sk-req-id` / `x-sk-backend` / `x-sk-model-served` from the SERVING
attempt's `result` (the loop's `lastResult`). Extend that one helper with the
same two rules (omission-not-emptiness; serving attempt only):
- `x-sk-bucket: <bucket id>` (e.g. `sk-l-internal`) — present when
  `result.bucket` is a non-empty string
- `x-sk-bucket-member: <member id actually served>` — present when
  `result.bucketMember` is a non-empty string (equals `servedModel` on
  bucket requests; explicit so a caller need not infer it)
Plumbing: `routeAndSend` already knows `bucketAddr` (the parsed bucket) and
`lastResult` already carries per-attempt `servedModel`; set
`lastResult.bucket = bucketAddr?.bucket` and `lastResult.bucketMember =
lastResult.servedModel` on the same line that sets `servedModel`
(router.mjs ≈line 2893) when `bucketAddr` is set. Non-bucket responses are
byte-identical (both fields absent).

### 3.4 What deliberately does NOT change

- Non-bucket request path (concrete model ids, registry roles, `@match`):
  byte-identical failover semantics (404/410 remain hard errors there).
- `resolveBucket()` eligibility rules (floor/zone/lifecycle) and the
  `bucket_no_eligible_member` 503 contract.
- Round-robin counters, `looksLikeBucketAttempt` typo gate, `isBucketsEnabled`
  config key and its `true` live value.
- `/v1/models` existing fields (P2.4 superset discipline), the incident-fix
  claim-aware lifecycle behavior (2026-08-18).

## 4. Testing plan (TDD — red, green, refactor)

Extend the two existing bucket suites (conventions already in place:
`applyConfig`, hermetic registry/store/catalog paths, fake upstreams with
per-request status control) — `tests/buckets.test.mjs` and
`tests/bucket-routing-integration.test.mjs`:

1. **Alias catalog (pure):** `aliasCatalogEntries` — 12 bucket entries when
   `buckets_enabled: true` (exact ids, `kind: "bucket"`, class/sensitivity
   fields, `free: false`, `provider/owned_by: "skgateway"`); 0 bucket entries
   when flag off; role entries present in both cases (from a fixture registry);
   registry unavailable → roles `[]`, buckets unaffected (fail-soft).
2. **`/v1/models` wiring (live-server or handler-level):** role ids present
   whether or not `buckets_enabled`; bucket ids present only when enabled;
   the existing 69-model contract untouched (negative control on pre-existing
   fields); allowlist still filters aliases (fixture with a non-empty
   allowlist that omits one bucket id).
3. **`/admin/buckets`:** exactly 12 entries in `allBuckets()` order;
   `ceiling` correct per sensitivity (secret=0, internal=1, public=2);
   members carry `class_basis`/`trust_zone`; rejected carry `id`+`reason`;
   fail-soft shape.
4. **Pool failover (integration, fake upstreams):**
   - member A 402 on its door → member B 200 → caller gets 200, body model
     rewritten to B, `x-sk-bucket` / `x-sk-bucket-member` correct.
   - member A 429 → member B (cooldown recorded per (door, A) only).
   - member A 404 → member B (NEW semantics). **Negative control:** the
     identical two-backend setup with a CONCRETE model id (not a bucket) still
     returns 404 with no second member tried.
   - member A eol in the lifecycle store → skipped with `bucket_member_skipped`
     SIEM, member B serves.
   - Round-robin preserved: with A and B both 200, request 1's first door is
     member[0], request 2's first door is member[1] (assert by which door's
     upstream saw the first hit).
   - Chain empty (all members eol) → `bucket_no_eligible_member` 503 contract.
5. **Full suite:** all 1305 current tests still green + the new ones.

## 5. Live verification (on this node, after deploy)

- `curl localhost:18780/v1/models` → 12 `sk-*` bucket ids + the registry roles;
  pre-existing entries byte-identical.
- `curl localhost:18780/admin/buckets` → per-bucket membership: which live
  models fill each size/sensitivity pool today, and why the rest were excluded
  (the durable "are all sizes included" answer).
- A real bucket completion (e.g. `sk-s-public`) → 200; headers show
  `x-sk-bucket` and `x-sk-bucket-member`; journal shows the bucket chain log.
- Restart via `systemctl --user restart skgateway` (config/code both load from
  the repo path per the unit's `--config`).

## 6. Definition of done (Chef's ask)

1. All tests green (full suite).
2. Live verification (section 5) passes on this node.
3. CHANGELOG.md `[Unreleased]` entry (Fixed + Added, repo prose style).
4. **Staged, committed, tagged, pushed:** commit on `main`, tag
   `v0.7.0` (latest is `v0.6.0`; feature release), push both to
   `origin` (github.com/smilinTux/skgateway).
5. Design doc + implementation notes left where the next session finds them
   (this file; repo root HANDOFF if the work spans sessions).

## 7. Judgment calls recorded (approved 2026-08-19)

- **404/410 failover extension** for bucket requests: approved (Chef: "yes,
  include your recommendations"). Non-bucket paths unchanged.
- **Roles advertised always, buckets gated on the flag:** roles are
  unconditionally routable today (any `sk-*` id is registry-routed), so
  advertising them needs no gate; buckets are gated so the catalog never
  promises a 503 surface the feature flag has turned off.
- **`free: false` for all aliases:** honest (resolution-dependent); not
  derived from members (YAGNI).
- **Dedupe by (backendId, member id), not backendId alone:** the same door can
  legitimately serve two different member ids (name-agnostic llama.cpp);
  those are different attempts, not duplicates.
