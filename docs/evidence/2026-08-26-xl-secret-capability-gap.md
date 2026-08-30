# XL-secret capability gap decision, 2026-08-26

This records the decision for coordination card `94cffe51` against SKGateway
source commit `31d3127c84c94ceaf70870f77133864eca77a454`.

## Decision

The empty `sk-xl-secret` pool is an accepted current capability gap. Secret
work that requires the XL model-class floor is not eligible for automated
routing until a sovereign model has reviewable evidence supporting an XL
declaration. The gateway must continue returning
`503 bucket_no_eligible_member`. It must not lower the class floor or raise the
secret trust-zone ceiling to find a substitute.

This is an acceptance of unavailability, not a claim that the current local
models are incapable of architecture work. The model-card classification
contract uses total parameter count as a prior. It currently places models of
at most 100B parameters in L and models above 100B in XL. Passing capability
checks cannot promote a model beyond its declared prior. No reviewed evidence
found for this card supports changing that contract or any current sovereign
declaration.

## Evidence

The committed sovereign cards declare only these parameter and class pairs:

| Model declarations | Total parameters | Class |
|---|---:|---|
| `ornith-1.0-9b`, `ornith-1.5-9b` | 9B | M |
| Qwen3.8 and Qwen3.6 local declarations | 27B | L |
| `ornith-1.0-35b`, `ornith-big` | 35B | L |

The source rule in `src/discovery/model-size.mjs` sets XL only above 100B.
`config/model-cards.overrides.yaml` is explicit that unknown values must not be
guessed and that its curated overlay wins over heuristic discovery.

A read-only query to the live loopback gateway admin surface returned
`buckets_enabled: true`, `ceiling: 0`, and an empty member list for
`sk-xl-secret`. Rejections separated the two independent reasons correctly:
current sovereign models were below the XL floor, while remote XL models were
above the secret zone-0 ceiling. No completion request or model canary was run.

The repository already pins the exact HTTP response contract in
`tests/bucket-routing-integration.test.mjs`: status 503, type
`bucket_no_eligible_member`, class XL, sensitivity secret, ceiling 0, actionable
exclusions, and zero dispatches. `tests/xl-secret-capability-gap.test.mjs` adds
the accepted-gap boundary against the committed sovereign declarations and
proves that a remote XL model cannot fill it.

## Operating consequence

An XL and secret workload must remain unserved by this bucket. Operators may
queue it for a future reviewed sovereign capability or use a separately
approved workflow that does not misrepresent the model-class requirement. They
must not relabel current models, remove secret sensitivity, or route the data
to a remote provider merely to obtain a successful response.

The decision must be revisited if either of these facts changes:

1. a sovereign model receives a reviewed XL declaration supported by model or
   capability evidence; or
2. the governed model-class contract changes through its own review process.

## Limitations and rollback

This review did not install or probe a model, inspect or change GPU state,
modify live configuration, deploy, reload, restart, or touch llama.cpp source.
It therefore does not establish a new empirical reasoning score for any model.
It establishes only that the current declarations and policy produce the
intended fail-closed result and that no evidence justifies reclassification.

Rollback is source-only: revert this decision document and its focused test.
There is no runtime rollback because this card changes no runtime code or live
state. Reverting must not be used to weaken the existing 503 behavior.
