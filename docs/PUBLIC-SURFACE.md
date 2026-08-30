# Public documentation surface

This inventory defines the documentation retained for a public source release. It does
not change repository visibility or runtime behavior.

## Retained documentation

The public surface keeps the project overview and the material needed to install,
configure, operate, integrate, secure, and develop SKGateway:

- Root project documents: `README.md`, `MISSION.md`, `SECURITY.md`, `SOP.md`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `CHANGELOG.md`.
- User and operator guides in `docs/`: API, architecture, bootstrap, configuration,
  dashboard, development, installation, integrations, OpenClaw, policies, runbook,
  SIEM, and Claude Code guidance.
- `docs/specs/joule-grade-vocabulary.json`, a machine-consumed public contract whose
  values are checked by the test suite.

## Removed internal-only artifacts

| Artifact | Reason removed from the public surface | Rollback |
| --- | --- | --- |
| `docs/deploy-plan/skgateway-bulletproof-deploy.md` | Internal deployment assessment and work tracking, not an end-user deployment guide. Public installation and operations guidance remains in `docs/INSTALL.md` and `docs/RUNBOOK.md`. | Restore the path from source revision `158314b00db9bf1c9775d82b75d4f8c7bc000127`. |
| `docs/evidence/2026-08-21-qwen38-capacity-domain.md` | Environment-specific qualification evidence. Generic capacity configuration and operation remain documented in `docs/CONFIGURATION.md` and `docs/RUNBOOK.md`. | Restore the path from source revision `158314b00db9bf1c9775d82b75d4f8c7bc000127`. |
| `docs/evidence/2026-08-21-qwen38-source-alignment.md` | Environment-specific service and routing evidence, not public product documentation. | Restore the path from source revision `158314b00db9bf1c9775d82b75d4f8c7bc000127`. |
| `docs/evidence/openrouter-free-catalog-evaluation-2026-08-24.json` | Raw provider evaluation evidence with workstation-specific metadata. Public provider behavior remains described in configuration and architecture guides. | Restore the path from source revision `158314b00db9bf1c9775d82b75d4f8c7bc000127`. |
| `docs/model-dex.html` | Environment-specific model inventory and routing notes. Public model discovery and routing behavior remains in `docs/API.md`, `docs/CONFIGURATION.md`, and `docs/ARCHITECTURE.md`. | Restore the path from source revision `158314b00db9bf1c9775d82b75d4f8c7bc000127`. |
| `docs/specs/2026-08-08-model-ranking-routing-intelligence-arch.md` | Historical internal architecture proposal containing environment state and work references. Current public architecture remains in `docs/ARCHITECTURE.md`. | Restore the path from source revision `158314b00db9bf1c9775d82b75d4f8c7bc000127`. |
| `docs/specs/2026-08-14-model-metadata-risk-job-matching-arch.md` | Historical internal architecture proposal containing environment state and work references. The machine-consumed vocabulary remains public. | Restore the path from source revision `158314b00db9bf1c9775d82b75d4f8c7bc000127`. |
| `docs/superpowers/plans/2026-07-25-dynamic-provider-model-discovery.md` | Internal agent execution plan. Shipped discovery behavior remains documented in public configuration and architecture guides. | Restore the path from source revision `158314b00db9bf1c9775d82b75d4f8c7bc000127`. |
| `docs/superpowers/plans/2026-08-08-model-ranking-routing-epic-cards.md` | Internal agent task decomposition and workflow instructions, not user documentation. | Restore the path from source revision `158314b00db9bf1c9775d82b75d4f8c7bc000127`. |
| `docs/superpowers/specs/2026-07-25-dynamic-provider-model-discovery-design.md` | Historical internal design record containing environment observations and operational prerequisites. | Restore the path from source revision `158314b00db9bf1c9775d82b75d4f8c7bc000127`. |
| `docs/superpowers/specs/2026-08-19-bucket-advertise-and-pool-failover-design.md` | Historical internal design record containing fleet observations and task references. Current bucket behavior remains in public configuration and runbook guidance. | Restore the path from source revision `158314b00db9bf1c9775d82b75d4f8c7bc000127`. |

To restore all removed paths in a review branch, run `git restore` with the source
revision above and the exact paths listed in the table. Review the restored material
before considering it part of a public release.

## Public-safe replacements

- The README no longer links to the removed internal deployment assessment. It states
  the live-path limitation directly.
- The grade vocabulary comment points to its owning project specification without
  linking to a removed repository-local proposal.
- This inventory replaces implicit artifact placement with an explicit public-surface
  policy and rollback record.
