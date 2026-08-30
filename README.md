# SKGateway

SKGateway is a Node.js inference gateway with OpenAI compatible HTTP endpoints,
model routing, audit events, metrics, and an optional local dashboard. The shipped
runtime entrypoint is [`src/index.mjs`](src/index.mjs), and its behavior is exercised
by the repository's [`tests`](tests).

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D22.0.0-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

## Shipped capabilities

The following claims are limited to behavior present in this repository.

| Capability | Shipped evidence |
| --- | --- |
| OpenAI compatible chat completions and model listing | Runtime handlers in [`src/index.mjs`](src/index.mjs) and live gateway coverage in [`tests/client-auth-integration.test.mjs`](tests/client-auth-integration.test.mjs) |
| Anthropic Messages request and response adaptation, including streaming tool use | Adapter in [`src/proxy/anthropic-frontend.mjs`](src/proxy/anthropic-frontend.mjs), with [`tests/anthropic-frontend.test.mjs`](tests/anthropic-frontend.test.mjs) and [`tests/stream-anthropic.test.mjs`](tests/stream-anthropic.test.mjs) |
| Routing across configured backends, registry roles, discovery results, and failover candidates | Router in [`src/proxy/router.mjs`](src/proxy/router.mjs), with [`tests/router-match.test.mjs`](tests/router-match.test.mjs), [`tests/discovery-provider-routing.test.mjs`](tests/discovery-provider-routing.test.mjs), and [`tests/registry-failover.test.mjs`](tests/registry-failover.test.mjs) |
| Bounded local backend health checks and cloud fallback when enabled | [`src/proxy/local-failover.mjs`](src/proxy/local-failover.mjs) and [`tests/local-failover.test.mjs`](tests/local-failover.test.mjs) |
| Optional client credential authentication and separate operator authentication | [`src/identity/client-auth.mjs`](src/identity/client-auth.mjs) and the live process test [`tests/client-auth-integration.test.mjs`](tests/client-auth-integration.test.mjs) |
| Optional external authorization enforcement through CapAuth or SKLegal decision services | [`src/policy/authz_gate.mjs`](src/policy/authz_gate.mjs), [`tests/authz-enforce-integration.test.mjs`](tests/authz-enforce-integration.test.mjs), and [`tests/sklegal-authz-wire.test.mjs`](tests/sklegal-authz-wire.test.mjs) |
| Passive prompt classification for intent, risk, jailbreak, and injection labels | [`src/classifiers/engine.mjs`](src/classifiers/engine.mjs) and [`tests/classification-engine.test.mjs`](tests/classification-engine.test.mjs) |
| Structured audit events with JSONL, RFC 5424 syslog, and Elasticsearch outputs | [`src/siem/events.mjs`](src/siem/events.mjs), [`tests/siem-syslog.test.mjs`](tests/siem-syslog.test.mjs), and [`tests/siem-elasticsearch.test.mjs`](tests/siem-elasticsearch.test.mjs) |
| Request, token, cost, latency, and energy metrics stored in SQLite when metrics are enabled | [`src/metrics/collector.mjs`](src/metrics/collector.mjs), [`tests/metrics-wiring-e2e.test.mjs`](tests/metrics-wiring-e2e.test.mjs), and [`tests/energy-e2e.test.mjs`](tests/energy-e2e.test.mjs) |
| Optional local SOC dashboard with REST data endpoints and WebSocket updates | [`src/dashboard/server.mjs`](src/dashboard/server.mjs) and the static UI in [`src/dashboard/static/index.html`](src/dashboard/static/index.html) |
| File based SKCapstone alert and service registration integration when a shared SKCapstone home exists | [`src/integration.mjs`](src/integration.mjs) and [`tests/integration.test.mjs`](tests/integration.test.mjs) |
| Configuration reload on `SIGHUP` | [`src/config.mjs`](src/config.mjs) and live credential rotation coverage in [`tests/client-auth-integration.test.mjs`](tests/client-auth-integration.test.mjs) |

## Scope and defaults

The gateway is not a claim that every implemented module is enabled or enforced in
every deployment.

* Client and operator authentication are configuration controlled and default to off.
  See [`src/config.mjs`](src/config.mjs) and
  [`tests/client-auth.test.mjs`](tests/client-auth.test.mjs).
* Prompt classification is passive by default. It emits labels but does not block or
  reroute requests. See the `classification` defaults in
  [`src/config.mjs`](src/config.mjs) and the side effect guard in
  [`tests/classification-engine.test.mjs`](tests/classification-engine.test.mjs).
* The YAML policy engine, tool reducer, sanitizer, and rate limiter are used by the
  embeddable `handleRequest` path in [`src/proxy/core.mjs`](src/proxy/core.mjs).
  They are not presented here as unconditional enforcement by the main runtime.
* Syslog and Elasticsearch are optional sinks. The default SIEM output is a local
  JSONL file. See [`src/config.mjs`](src/config.mjs),
  [`tests/siem-syslog.test.mjs`](tests/siem-syslog.test.mjs), and
  [`tests/siem-elasticsearch.test.mjs`](tests/siem-elasticsearch.test.mjs).
* A cloud backend necessarily receives request data routed to it. No third party
  telemetry is added by the gateway, but data locality depends on the configured
  backend.

## Quick start

Node.js 22 or newer is required by [`package.json`](package.json).

```bash
git clone https://github.com/smilinTux/skgateway.git
cd skgateway
npm install

# Set credentials required by your configured backends, for example:
export NVIDIA_API_KEY=your_key_here

npm start
```

The default gateway port is `18780`. The optional dashboard defaults to `18781`.
Both defaults are defined in [`src/config.mjs`](src/config.mjs).

Point an OpenAI compatible client at `http://localhost:18780/v1`. Availability of
a particular model depends on backend configuration, discovery state, lifecycle
state, and backend health. Catalog reconciliation is covered by
[`tests/match-catalog-live-config.test.mjs`](tests/match-catalog-live-config.test.mjs)
and [`tests/advertise-reconcile.test.mjs`](tests/advertise-reconcile.test.mjs).

## Configuration

Configuration is resolved in this order:

1. `--config`
2. `SKGATEWAY_CONFIG`
3. `~/.skcapstone/gateway/skgateway.yaml`, when present
4. `config/skgateway.yaml`

This precedence is implemented in [`src/config.mjs`](src/config.mjs) and tested by
[`tests/config-path-resolution.test.mjs`](tests/config-path-resolution.test.mjs).
See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for the configuration reference.

The code default for `server.bind` is `0.0.0.0`, which listens on all host
interfaces. Set it to `127.0.0.1` or a specific trusted interface unless wider
access is intended. The default and environment override are defined in
[`src/config.mjs`](src/config.mjs).

Example:

```yaml
server:
  bind: 127.0.0.1
  port: 18780
  dashboard_port: 18781

dashboard:
  enabled: true

backends:
  nvidia:
    url: https://integrate.api.nvidia.com/v1
    auth_type: api_key
    api_key_env: NVIDIA_API_KEY
    models:
      - moonshotai/kimi-k2.6
    priority: 1
```

## Runtime endpoints

The main runtime implements these public protocol surfaces in
[`src/index.mjs`](src/index.mjs):

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI compatible chat completion |
| `POST` | `/v1/messages` | Anthropic Messages frontend |
| `GET` | `/v1/models` | Reconciled public model catalog |
| `GET` | `/v1/models/:id` | Public model metadata |
| `GET` | `/health` and `/healthz` | Process health |

The runtime also has authenticated admin and operator routes. Their exact contract
is documented in [`docs/API.md`](docs/API.md) and exercised by
[`tests/operator-http.test.mjs`](tests/operator-http.test.mjs) and
[`tests/admin-models-cards.test.mjs`](tests/admin-models-cards.test.mjs).

When enabled, the dashboard server exposes `/api/stats`, `/api/health`,
`/api/agents`, `/api/tokens`, `/api/costs`, `/api/events`, `/api/activity`, and
`/ws`. These handlers are in [`src/dashboard/server.mjs`](src/dashboard/server.mjs).

## Development

Run the shipped test suite:

```bash
npm test
```

The command is defined in [`package.json`](package.json) and runs the files under
[`tests`](tests).

Additional documentation:

* [Installation](docs/INSTALL.md)
* [API](docs/API.md)
* [Architecture](docs/ARCHITECTURE.md)
* [Configuration](docs/CONFIGURATION.md)
* [Operations runbook](docs/RUNBOOK.md)
* [Security policy](SECURITY.md)
* [Contributing](CONTRIBUTING.md)

## License

MIT. See [`LICENSE`](LICENSE).
