# Internal documentation artifact disposition

This is a proposal only. No artifact was moved or deleted by this candidate.
Chef retains visibility control and must review this inventory before any disposition is applied.

| Inventory path | Proposed disposition | Basis |
| --- | --- | --- |
| `docs/superpowers/plans/` | Keep, internal | Active implementation plans are useful provenance; not public runtime claims. |
| `docs/superpowers/specs/` | Keep, internal | Specifications support engineering review and are not deployment instructions. |
| `docs/deploy-plan/skgateway-bulletproof-deploy.md` | Review before move/delete | Deployment planning material may be stale or operationally sensitive; retain pending Chef review. |
| `docs/evidence/` | Keep, internal | Evidence records preserve decisions and their limitations. |
| `docs/model-dex.html` | Review before move/delete | Catalog artifact requires ownership and freshness review before publication or removal. |

## Scope and disposition gate

The inventory covers the requested paths as they exist in this checkout. The
candidate changes only documentation wording and personal-path placeholders.
Any move or deletion requires a subsequent reviewed change with an explicit
path list, owner approval, and a rollback copy or commit reference.

## Remaining visible content

The listed internal artifacts remain visible in the repository. No visibility
setting, history, deployment, or runtime configuration was changed.
