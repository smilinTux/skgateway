# Evidence and budget monitoring

One optional feature that lets budget guards, spend collectors and alerting
see what the gateway spends and how close each paid provider is to its limits.
It is **off by default**. Each cluster switches it on in its own config repo.

With it on, the gateway:

- names every caller by its `x-app` header (`untagged` when absent) on audit
  events and in `request_log`;
- keeps per-client daily caps and per-minute rate limits for paid provider
  families (logged and enforced from a caps file you own);
- records the provider rate-limit headers of real calls (Codex, zai) and the
  DeepSeek account balance in `metrics.db`, with no extra completion calls;
- serves two extra blocks on `GET /status`: `provider_usage` (contract
  `skgw-provider-usage/1`) and `clients`;
- serves `GET /admin/clients/usage` (loopback only): today's counters plus
  estimated dollars per day, client and provider;
- writes alerts (cap percent, call spike, Codex window, DeepSeek floor, stale
  snapshot) as JSON lines to an outbox that `scripts/post-alerts.py` posts.

With it off, none of this runs: `/status` has only `status`, `version`,
`uptime`, `backends`, `pool` and `metrics`; there is no client guard, no
balance poll, no `provider_snapshot`, `deepseek_balance_log` or `alert_fired`
table, no `/admin/clients/usage`, and audit events carry no `client` field.
`tests/evidence-budget-monitoring.test.mjs` checks both states against live
gateway processes.

## Switching it on

In the instance's `skgateway.yaml`:

```yaml
evidence_budget_monitoring:
  enabled: true
  client_caps: client-caps.yaml        # relative to this config file
  provider_backends: [codex, deepseek, zai]
```

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | unset | `true` is on, `false` is off. Unset means on only when `$SKGATEWAY_CLIENT_CAPS` is set. |
| `client_caps` | unset | The caps, limits and alerts file. Unset: `$SKGATEWAY_CLIENT_CAPS`, else `client-caps.yaml` next to the config file. |
| `provider_backends` | `[codex, deepseek, zai]` | Backends listed under `provider_usage.backends`, each always present. |

The switch is read at boot; restart to change it. The caps file itself is
re-read within 10 seconds of a save.

`deploy/skgateway-deploy` sets `SKGATEWAY_CLIENT_CAPS` when the instance folder
in the config repo has a `client-caps.yaml`, so an instance that already runs
with a caps file stays on across the upgrade. Set `enabled: true` explicitly in
the config repo anyway; `enabled: false` turns it off even with the variable set.

Without a caps file at the configured path the feature still serves the
`/status` blocks and names clients, but enforces nothing and raises no client
alerts.

## The caps file

Start from [`config/client-caps.yaml.example`](../config/client-caps.yaml.example).
Keep the real file in the cluster config repo, never in this repository.

| Key | Meaning |
| --- | --- |
| `enabled` | `true` enforces caps and limits and raises cap and spike alerts. |
| `timezone` | IANA zone for daily caps, alert days and spend rows. Default `UTC`. |
| `reject_untagged`, `untagged_grace_until` | Answer requests without `x-app` with 400; grace date for the audit warning. |
| `exempt_backends` | Backend ids never capped or counted (local models). |
| `families` | Backend id to requested-model globs, decided before routing. |
| `caps.default`, `caps.clients.<client>` | Daily `calls` and `tokens` per family. |
| `rate_limits.default`, `rate_limits.clients.<client>` | `client_per_minute`, `session_per_minute` (`x-session-id`). |
| `alerts.outbox` | Outbox JSONL path. |
| `alerts.cap_percent`, `spike_factor`, `spike_min_calls`, `codex_used_percent`, `stale_hours` | Alert thresholds. |
| `alerts.room` | Optional, copied onto every outbox record for the poster. |
| `alerts.notes.<kind>` | Optional text appended to that kind's summary (`cap`, `spike`, `codex`, `deepseek_floor`, `stale`). Put cluster wording here. |
| `deepseek_balance_poll_minutes`, `deepseek_balance_floor` | Balance poll cadence (0 = off) and alert floor (null = no alert). |
| `prices`, `peak_windows_utc`, `peak_weekdays`, `holidays` | Dollars per million tokens for spend estimates. |

## Posting alerts

`scripts/post-alerts.py [outbox]` posts new outbox lines and remembers the
byte offset in `<outbox>.posted`; a failed post is retried on the next run.
Delivery is yours: set `SKGW_NOTIFY_MODULE` to a Python file that defines
`notify(title, summary) -> bool`. That module reads its own settings and
credentials from its environment. Run the script from a timer.

## Contract: skgw-provider-usage/1

The machine-readable contract is
[`docs/specs/skgw-provider-usage-1.json`](specs/skgw-provider-usage-1.json),
pinned by `tests/evidence-budget-contract.test.mjs`. Consumers may rely on
every field below. Removing or renaming a field, or changing its type, needs a
new version (`skgw-provider-usage/2`) served alongside `/1` until consumers
move. Adding a field does not.

### `GET /status` keys

- feature off: `status`, `version`, `uptime`, `backends`, `pool`, `metrics`
- feature on: the same plus `provider_usage` and `clients`

A block that fails to build is `{ "error": "<message>" }` instead.

### `provider_usage`

```json
{
  "schema": "skgw-provider-usage/1",
  "generated_at": "2026-11-14T18:01:30.000Z",
  "backends": {
    "codex": {
      "backend": "codex",
      "observed_at": "2026-11-14T18:00:00.000Z",
      "age_seconds": 90,
      "sources": {
        "headers": {
          "observed_at": "2026-11-14T18:00:00.000Z", "age_seconds": 90,
          "windows": [
            { "name": "primary", "unit": "percent", "limit": 100, "remaining": 59,
              "used_percent": 41, "reset_at": "2026-11-14T19:00:00.000Z" }
          ]
        }
      }
    },
    "deepseek": {
      "backend": "deepseek", "observed_at": "...", "age_seconds": 90,
      "sources": {
        "balance": {
          "observed_at": "...", "age_seconds": 90, "is_available": true,
          "balances": [ { "currency": "USD", "total_balance": 12.5,
                          "granted_balance": 0, "topped_up_balance": 12.5 } ]
        }
      },
      "daily": { "day": "2026-11-13", "currency": "USD", "readings": 2,
                 "first": { "observed_at": "...", "total_balance": 30 },
                 "last":  { "observed_at": "...", "total_balance": 28 },
                 "balance_drop": 2, "estimated_dollars": 1.9, "drift_percent": -5 }
    },
    "zai": { "backend": "zai", "observed_at": null, "age_seconds": null, "sources": {} }
  }
}
```

- Every backend in `provider_backends` is present. One with no snapshot has
  `observed_at` and `age_seconds` null and empty `sources`.
- `age_seconds` of a backend is that of its newest source. A consumer judges
  freshness from it.
- `sources.headers.windows[]`: `name`, `unit` (`count` or `percent`), `limit`,
  `remaining`, `used_percent` (null when `limit` is 0), `reset_at` (null when
  unknown).
- `sources.balance`: `is_available`, `balances[]` with `currency`,
  `total_balance`, `granted_balance`, `topped_up_balance` (numbers or null).
- `daily` (deepseek only): yesterday in the caps file's `timezone`; first and
  last balance reading, the drop between them and the estimated DeepSeek
  dollars over the same span. With no readings `first`, `last` and the
  numbers are null and `readings` is 0.
- No raw headers, prompt text or credentials are ever stored or served.

### `clients`

```json
{ "day": "2026-11-14", "enabled": true, "reject_untagged": false,
  "clients": [ { "client": "tool-a", "family": "deepseek", "calls": 12,
                 "tokens": 4100, "dollars": 0.0123, "cap_calls": 6000, "cap_tokens": null } ] }
```

`day` is today in the caps file's `timezone`; `enabled` is the caps file's
`enabled`; rows are successful calls on paid families since that day began.

### Alert outbox record

One JSON object per line with at least `ts`, `day`, `kind` (`cap`, `spike`,
`codex`, `deepseek_floor`, `stale`), `key`, `severity`, `title` and `summary`,
plus `room` when `alerts.room` is set and kind-specific fields (`client`,
`family`, `backend`, `used`, `limit`, ...). Each key fires once per day; the
fired state survives restarts in the `alert_fired` table.

### Router log lines

Spend collectors may count calls from the service journal. These lines are
written whether or not the feature is on:

```
[router] <status> OK backend=<backend id> latency=<ms>ms
[router] <402|429> THROTTLED backend=<backend id> model=<model> cooldown=<ms>ms
```

Pinned regexes: `\[router\] 200 OK backend=([A-Za-z0-9_.-]+)` and
`\[router\] (402|429) THROTTLED backend=([A-Za-z0-9_.-]+)`.

### Metrics database (read by evidence collectors)

Evidence collectors open `metrics.db` read only (`file:...?mode=ro`) and read
these `request_log` columns. They are part of this contract whether or not the
feature is on:

| Column | Type | Meaning |
| --- | --- | --- |
| `started_at` | integer | Request start, Unix milliseconds |
| `model` | text or null | The model the caller asked for |
| `status_code` | integer or null | HTTP status sent to the caller |
| `cost_truth` | text or null | `actual`, `estimated` or `unknown` |
| `agent_id` | text or null | Resolved agent identity |
| `session_id` | text or null | `x-session-id` |
| `client` | text or null | `x-app` |

Locate the file from `metrics.db_path` in the instance config (the file the
unit passes as `--config`), never from the framework's install directory: a
release export holds no state. A deployment that keeps state outside the
export also sets the unit's `WorkingDirectory` to the directory that holds
`data/metrics.db`, for collectors that look there.

### Related, always-on surfaces

- Dashboard `GET /api/tokens?period=...` (token rows by bucket, agent, model,
  backend) is part of the dashboard, not this feature. See
  [DASHBOARD.md](DASHBOARD.md).
- `GET /admin/providers/usage` (in-memory provider quota view) is documented in
  [API.md](API.md).
