### Added

- Per-client guard rails (`src/policy/client-guard.mjs`): daily call and token caps per provider family per client (the `x-app` header), per-minute rate limits, an alert outbox (`logs/alerts.jsonl`, posted by `scripts/post-alerts.py`) and estimated spend. Off unless a caps file exists: `$SKGATEWAY_CLIENT_CAPS`, or `config/client-caps.yaml` (gitignored); `config/client-caps.yaml.example` documents it.
- `GET /status` carries `provider_usage` (schema `skgw-provider-usage/1`: provider rate-limit headers and the DeepSeek balance, persisted in metrics.db) and `clients`; `GET /admin/clients/usage` (loopback only).
- `skgateway-deploy` sets `SKGATEWAY_CLIENT_CAPS` when the instance dir in the config repo has a `client-caps.yaml`.

### Changed

- The subscription exhaustion probe interval is 60 minutes (was 15).
