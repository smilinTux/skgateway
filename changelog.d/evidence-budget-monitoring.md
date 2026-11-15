### Added

- Evidence and budget monitoring (`evidence_budget_monitoring` in the config, docs/EVIDENCE-BUDGET-MONITORING.md), **off by default** and switched on per cluster: per-client guard rails (`src/policy/client-guard.mjs`: daily call and token caps per provider family per `x-app` client, per-minute rate limits, estimated spend), provider snapshots (rate-limit headers of real calls and the DeepSeek balance, persisted in metrics.db), `GET /status` `provider_usage` and `clients`, `GET /admin/clients/usage` (loopback only), and an alert outbox posted by `scripts/post-alerts.py` through an operator `SKGW_NOTIFY_MODULE`. The caps file (`config/client-caps.yaml.example`) carries the calendar (`timezone`, default UTC), `alerts.room` and `alerts.notes`.
- The `skgw-provider-usage/1` contract, written down in `docs/specs/skgw-provider-usage-1.json` and pinned by `tests/evidence-budget-contract.test.mjs`.
- `skgateway-deploy` sets `SKGATEWAY_CLIENT_CAPS` when the instance dir in the config repo has a `client-caps.yaml`; with `enabled` unset that also turns the feature on.

### Changed

- The subscription exhaustion probe interval is 60 minutes (was 15).
