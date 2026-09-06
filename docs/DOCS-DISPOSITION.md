# Internal documentation artifact disposition

This is a proposal only. No artifact was moved or deleted by this candidate.
Chef retains visibility control and must review this inventory before any disposition is applied.

| Inventory path | Proposed disposition | Basis |
| --- | --- | --- |
| `docs/superpowers/plans/` | Keep, internal | Active implementation plans are useful provenance; not public runtime claims. |
| `docs/superpowers/specs/` | Keep, internal | Specifications support engineering review and are not deployment instructions. |
| `docs/deploy-plan/skgateway-bulletproof-deploy.md` | Absent here; review before move/delete if found | Deployment planning material may be stale or operationally sensitive; do not recreate, move, or delete it without Chef review. |
| `docs/evidence/` | Keep, internal | Evidence records preserve decisions and their limitations. The directory currently contains `2026-08-26-xl-secret-capability-gap.md`. |
| `docs/model-dex.html` | Absent here; review before move/delete if found | Catalog artifact requires ownership and freshness review before publication or removal. Do not recreate, move, or delete it without Chef review. |

## Scope and disposition gate

The inventory covers the requested paths as observed in this checkout. The
candidate changes only documentation wording and personal-path placeholders.
Any move or deletion requires a subsequent reviewed change with an explicit
path list, owner approval, and a rollback copy or commit reference. No move or
deletion is authorized by this proposal.

## Remaining visible content

`docs/superpowers/plans/` and `docs/evidence/` remain visible, including the
three files listed above. `docs/superpowers/specs/`,
`docs/deploy-plan/skgateway-bulletproof-deploy.md`, and `docs/model-dex.html` are
not present in this checkout. No visibility setting, history, deployment, or
runtime configuration was changed.

## Exact diff and checks

The exact candidate is the reviewed git diff for this branch. A reviewer can
reproduce it with `git diff origin/main...HEAD -- README.md docs/POLICIES.md
SOP.md docs/DOCS-DISPOSITION.md scripts/skgateway.service src/siem/file.mjs`.
Documentation checks performed: `git diff --check`, a repository search for the
enumerated `/home/cbrd21` and `~/clawd` strings, and an inventory listing with
`find docs/superpowers/plans docs/superpowers/specs docs/deploy-plan docs/evidence
-maxdepth 2 -type f`.

## Limitations and rollback

No live pipeline qualification was run because the bounded production check was
not authorized. README and POLICIES therefore distinguish source and repository
test evidence from live-runtime qualification. The candidate does not assert
that optional policy, reducer, sanitizer, or retry components are wired into the
default runtime. Roll back by reverting the candidate commit, or restore the
pre-candidate files with `git restore --source=origin/main -- README.md
SOP.md docs/POLICIES.md scripts/skgateway.service src/siem/file.mjs` and remove
`docs/DOCS-DISPOSITION.md`; no artifact move or deletion needs rollback.
