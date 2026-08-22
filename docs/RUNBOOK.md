# SKGateway Operations Runbook

Day-two operations for a running SKGateway. For a cold install, see
[INSTALL.md](INSTALL.md). Everything here is grounded in the shipped code
(`src/index.mjs`, `src/config.mjs`, `src/proxy/router.mjs`, `src/siem/`,
`src/identity/`) and the current `config/skgateway.yaml`.

Service identity: a Node ESM HTTP proxy, run as the systemd user unit
`skgateway.service`, listening on `18780` (proxy + control endpoints) and
`18781` (dashboard).

---

## Quick reference

| Action | Command |
|---|---|
| Status | `systemctl --user status skgateway.service` |
| Restart (secrets, backends, upgrade) | `systemctl --user restart skgateway.service` |
| Reload YAML only (partial) | `systemctl --user reload skgateway.service` |
| Live logs | `journalctl --user -u skgateway.service -f` |
| Health | `curl -s localhost:18780/health \| jq .` |
| Status + metrics | `curl -s localhost:18780/status \| jq .` |
| Queue depth | `curl -s localhost:18780/queue \| jq .` |
| Model catalog | `curl -s localhost:18780/v1/models \| jq '.data[].id'` |

---

## Health checks

Four unauthenticated control endpoints on `18780`:

- **`GET /health`** (also `/healthz`): `{ status, uptime, backends }`, where
  `backends` is a per-backend snapshot with `status` (`up` / `degraded` /
  `down`) and `latencyP50`. Health is **passive**: an idle backend reads `up`
  until a real request exercises it. There is no active probe loop, so a "green"
  idle backend is not proof it works.
- **`GET /status`**: adds `version`, `uptime`, connection-`pool` totals, and the
  `metrics` object. `metrics: null` means the metrics store failed to open.
- **`GET /queue`**: connection-pool depth: `totalActive`, `totalQueued`,
  `totalCapacity`, `utilization`, plus per-domain stats. An ungrouped backend
  is its own domain. Each entry includes `active`, `queued`, `max`, `maxQueue`,
  `queueTimeoutMs`, `totalTimedOut`, `totalDropped`, and `totalCancelled`.
  Configured domains are present with zero counters before first traffic and
  contribute capacity once, not once per member alias.
- **`GET /v1/models`**: the aggregated model catalog across configured backends.

`GET /` and `GET /dashboard` redirect (302) to the dashboard on `18781`.

---

## Log locations

- **Service stdout/stderr**: journald, `journalctl --user -u skgateway.service`.
  Startup lines, config reloads, and backend cooldown transitions land here.
- **SIEM audit stream**: `logs/audit.jsonl` under the repo root (one JSON event
  per line). Path from `siem.outputs[].path`, resolved relative to the repo
  root. Rotates at `rotate_mb` (default 100 MB).
- **Metrics database**: `data/metrics.db` (SQLite) under the repo root, from
  `metrics.db_path`. Holds per-request duration, status, agent, model, backend,
  and token/cost accounting.

Both `data/` and `logs/` are gitignored and created at runtime.

---

## SIEM and syslog outputs

Every live `/v1/*` request emits structured SIEM events through a best-effort
hook that can never block or break routing. Events cover the request lifecycle:
`identity.resolved`, `auth`, `request`, `failover`, `error`, and `response`
(status, latency, best-effort token usage), correlated by a per-request id.

The hook fans out to three sinks:

1. **File** (default, always on): appends each event to `logs/audit.jsonl`.
2. **skcapstone sk-alert bus** (automatic when present): when `~/.skcapstone`
   exists and `SK_STANDALONE` is unset, `warn`, `error`, and `critical` events
   are published to the mesh-wide sk-alert bus (routine `info` events are
   dropped to avoid flooding). Absent that tree, this is a no-op.
3. **Syslog** (RFC 5424, disabled by default): ship events to a syslog
   collector or SIEM.

### Enabling syslog

Syslog is **off** unless explicitly enabled. Turn it on either in YAML:

```yaml
siem:
  outputs:
    - type: file
      path: ./logs/audit.jsonl
      rotate_mb: 100
    - type: syslog
      enabled: true
      host: syslog.internal
      port: 514
      protocol: udp        # udp | tcp | tls | unix
      format: cef          # cef | json
      facility: 16         # 16 = local0
```

or without editing YAML, via environment (in the unit or the secrets file):

```
SKGATEWAY_SYSLOG_ENABLED=1
SKGATEWAY_SYSLOG_HOST=syslog.internal
SKGATEWAY_SYSLOG_PORT=514
SKGATEWAY_SYSLOG_PROTOCOL=udp
SKGATEWAY_SYSLOG_FACILITY=16
SKGATEWAY_SYSLOG_FORMAT=cef
```

Messages are RFC 5424 framed (`<PRI>1 TIMESTAMP HOST skgateway PID MSGID SD MSG`),
with the event rendered as CEF or JSON in the MSG. TCP/TLS/unix transports
buffer up to `max_buffer` (default 1000) messages while reconnecting and drop
the oldest on overflow, so a syslog outage never wedges the gateway. A syslog
output with `enabled: false`, or a network transport with no `host`, is a safe
no-op. Changing syslog config requires a restart to take effect (see reload
behavior below).

---

## Metrics

Metrics are on by default (`metrics.enabled: true`). The collector records every
request into `data/metrics.db` and exposes rollups at `/status` and on the
dashboard (`18781`). Token and cost tracking use the per-model `metrics.pricing`
table (USD per 1,000,000 tokens); models with no entry fall back to
`default_local` (zero cost). Data is retained `metrics.retention_days` (default
90). If `/status` shows `metrics: null`, the SQLite file could not be opened;
confirm `data/` is writable or set `metrics.db_path` to an absolute path.

---

## CapAuth identity

CapAuth agent-identity resolution runs **live** on every `/v1/*` request
(identify-only). It resolves a caller so routing, metrics, and every SIEM event
key on the same agent, and emits an `identity.resolved` audit event per request.
The **auth gate is OFF by default**: unidentified callers resolve to `anonymous`
and are allowed through. Identity is enabled by default; disable resolution
entirely with `identity.enabled: false`.

Resolution order (`src/identity/capauth.mjs`):

1. `X-CapAuth-Signature` + `X-CapAuth-Timestamp` (+ `X-Agent-Id`): PGP
   challenge-response. `method: capauth`. Marked `verified: true` only if the
   signature validates.
2. `Authorization: Bearer <token>`: token hashed and matched to a registry
   entry. `method: bearer`, `verified: false`.
3. `X-Agent-Id`: simple name assertion. `method: header`, `verified: false`.
4. None of the above: `method: anonymous`, `verified: false`.

The agent registry merges three sources: built-in defaults, auto-discovery from
`~/.skcapstone/agents/` directories, and explicit `identity.agents` entries in
the gateway config (config wins on name conflicts).

### Turning the auth gate on

```yaml
identity:
  enabled: true
  allow_anonymous: false
  require_agent_id: true    # reject anonymous callers with 403
```

With `require_agent_id: true`, any request whose identity resolves to
`anonymous` gets a `403 identity_required`. Turn this on only after confirming
every real client sends an identity header, or you will lock out traffic.

### PGP verification is opt-in

Cryptographic signature verification needs the optional `openpgp` npm package.
It is **not** a declared dependency. Without it, a CapAuth signature is checked
for structural presence but `verified` stays `false` (transparent to the
request, and auditable). To enable real verification: `npm install openpgp` and
restart. An agent's public key is read from
`~/.skcapstone/agents/<name>/identity/public.asc` (or `trust/public.asc`, or
`~/.capauth/agents/<name>/public.asc`).

---

## Secrets standard

Secrets never enter git, a shell profile, or the unit inline. They live in a
`0600` EnvironmentFile at `~/.config/skgateway/secrets.env`, sourced from
skvault, and read by the unit at process start. `NVIDIA_API_KEY` is the primary
secret; NVIDIA is the only backend needing a key today (`api_key_env:
NVIDIA_API_KEY`). All other backends are `auth_type: none` (local ornith,
the claude-code-api wrapper, and Ollama).

Confirm the file is `0600`, owned by the service user, and referenced by the
unit:

```bash
ls -l ~/.config/skgateway/secrets.env
systemctl --user show skgateway.service -p EnvironmentFiles
```

---

## Credential rotation

Rotating a secret (for example `NVIDIA_API_KEY`) requires a **full restart**,
because systemd reads the EnvironmentFile at process start and `SIGHUP` does not
re-read it.

1. Rotate the credential at the provider and update the value in skvault.
2. Rewrite the secrets file from skvault (do not echo the value into shell
   history), keeping `0600`:
   ```bash
   umask 077
   ${EDITOR:-nano} ~/.config/skgateway/secrets.env
   chmod 600 ~/.config/skgateway/secrets.env
   ```
3. Full restart so the new environment is loaded:
   ```bash
   systemctl --user restart skgateway.service
   ```
4. Verify:
   ```bash
   curl -s localhost:18780/health | jq .
   # optionally exercise the affected backend with a small completion
   ```

A `reload` (`SIGHUP`) here is a silent no-op for secrets: the process keeps the
old key. Always restart.

---

## Config reload behavior (important)

The unit's `ExecReload` sends `SIGHUP`. On `SIGHUP`, `src/config.mjs` re-reads
and re-validates the YAML file and emits `config-changed`, and `src/index.mjs`
refreshes its config snapshot. This is only **partial** hot reload:

- **Re-read on SIGHUP**: values that the running code reads live from the
  refreshed snapshot.
- **NOT applied on SIGHUP**: backend topology. The router is built once at
  startup, so adding, removing, or re-pointing a backend does not take effect
  until a restart. Editing backends and sending `SIGHUP` silently does nothing
  to routing.
- **NOT applied on SIGHUP**: EnvironmentFile secrets (see rotation) and syslog
  output config.

Rule of thumb: **restart** for backend changes, secret rotation, syslog changes,
and code upgrades. Reserve `SIGHUP` for narrow live tuning, and verify it
actually took effect. On a validation failure during reload, the gateway logs
the error and keeps the previous good config.

---

## Restart and upgrade

```bash
cd ~/clawd/skcapstone-repos/skgateway
git pull
npm ci                                      # reproducible install
systemctl --user restart skgateway.service
curl -s localhost:18780/status | jq '{version, uptime}'
```

Graceful shutdown drains in-flight requests, closes the metrics store, dashboard,
and any syslog sockets, then exits (forced after 5 seconds).

---

## Backend failover behavior

Routing is by model name, highest priority first (lower `priority` number wins),
with failover to the next eligible backend on upstream `5xx`. Each backend runs
a health state machine (`src/proxy/router.mjs`):

- **degraded** once the recent error rate exceeds 10%.
- **down** once the recent error rate exceeds 50%. A down backend enters a
  cooldown (default 60 seconds, `cooldown_ms`). During cooldown it resolves
  immediately as down without making a real request.
- After cooldown it transitions **down to degraded** and is allowed one probe
  request to determine liveness.

Connection pooling enforces concurrency (`pooling`): NVIDIA is capped at 20
concurrent (its NIM limit), with per-backend `max` / `maxQueue` overrides.
Logical routes that reach one physical service belong in one explicit
`capacity_domains` entry so they cannot each consume a separate limit.
Requests beyond a cap queue FIFO up to `maxQueue` and time out after the
configured queue SLA; `maxQueue: 0` is fail-fast. The `chiap08-qwen38` and
`reg:qwen38` routes share four active slots, four queued slots, and a 30-second
SLA. Pool topology changes require a process restart. The skmodels registry
bridge keeps a last-good cache so a registry hiccup does not break routing.

`degraded` and `down` transitions raise `warn`+ SIEM events, which reach the
sk-alert bus when the skcapstone tree is present.

---

## The two proven gotchas

1. **Pin clients to `:18780`, never `:18782`.** Every client, cron, and agent
   `base_url` must be `http://localhost:18780/v1` (the gateway). `:18782` is the
   internal claude-code-api wrapper. Pointing a client there bypasses the
   gateway (no routing, no failover, no metrics, no audit) and provider
   resolution lands directly on the wrapper. This bites cold rebuilds because
   the pin lives in client config, not the gateway.

2. **The claude-code-api wrapper is the PRIMARY dependency for `claude-*`.** The
   `anthropic` backend points at `127.0.0.1:18782`, the local `claude --print`
   OpenAI-compatible wrapper, so Claude traffic bills as first-party
   subscription usage. The wrapper lives **outside this repo** and has no health
   integration of its own. Check it directly:
   ```bash
   curl -s http://127.0.0.1:18782/v1/models | jq . || echo "wrapper down"
   ```

---

## claude-code-api :18782 wrapper dependency + SPOF fallback (card 2b5bcedd)

**What it is.** `claude-code-api` is a local OpenAI-compatible shim around
`claude --print` (the Claude Code CLI), listening on `127.0.0.1:18782`. It is
the ONLY path that bills `claude-*` traffic as genuine first-party subscription
usage, which is why the `anthropic` backend routes through it.

**Where it runs / how skgateway depends on it.** It runs as a separate local
service on the same host as the gateway (`.158`), outside this repo. The gateway
`anthropic` backend (`config/skgateway.yaml`, `url: http://127.0.0.1:18782/v1`,
`auth_type: none`, priority 2) forwards `claude-*` requests to it verbatim.

**How to restart it.** It is not managed by this repo. Restart the
`claude-code-api` service however it is supervised on the host (systemd user
unit or the launcher script that started it), then confirm with the `curl`
probe above. If it is a bare process, relaunch it and re-run the probe.

**Fallback (no more hard SPOF).** Two mitigations now cover a wrapper outage so
`claude-*` no longer hard-fails or hangs:

- **`anthropic-direct` fallback backend** (`config/skgateway.yaml`, priority 8):
  same `claude-*` models, `auth_type: oauth` to `https://api.anthropic.com/v1`
  using `~/.claude/.credentials.json`. Because it serves the same models at a
  strictly lower priority, the router's existing failover machinery tries the
  wrapper first and falls over to this backend on a 5xx/504. This is a
  **degraded, last-resort path**: direct OAuth bills as third-party extra-usage
  (not the plan) and can 400 under load, so it exists to keep Claude answering
  during a wrapper outage, not as the steady state. Its health shows in
  `/health` alongside the wrapper.
- **Fail-fast idle timeout** (`timeout_ms: 120000` on the wrapper backend): a
  wedged wrapper that accepts the socket but never replies used to hang the
  request forever. The gateway now aborts a stalled wrapper call with a 504 so
  it fails over to `anthropic-direct` instead of blocking.

After a wrapper outage, `/health` reflects the `anthropic` backend degrading to
`down` (error rate ≥ 50%) while `anthropic-direct` absorbs the traffic. Fix the
wrapper, then the `anthropic` backend recovers to `up` on the cooldown re-probe
and reclaims priority automatically.

### Dynamic Claude catalog and OAuth verification

The `anthropic` and `anthropic-direct` backends are discovery-managed from the
authenticated wrapper catalog. `discovery.providers.anthropic.enabled: true`
causes SKGateway to call `claude-code-api /v1/models` with `CCAPI_TOKEN`; each
successful cycle replaces both routing lists. New Claude IDs therefore appear
without YAML edits, and IDs removed by Anthropic leave routing and progress
through lifecycle absence. A wrapper failure preserves the cached last-good
catalog and marks provider discovery stale.

After Claude login/token rotation:

1. Restart `claude-code-api` to clear any inherited OAuth environment override.
2. Verify `/health` reports `model_discovery.ok=true` and `stale=false`.
3. Call the wrapper `/v1/models` with its `CCAPI_TOKEN` and record only IDs,
   never either token.
4. Restart SKGateway (backend topology is not hot-reloaded), then invoke
   `POST /admin/models/refresh`.
5. Compare Claude IDs from wrapper `/v1/models`, gateway `/v1/models`, and both
   live backend routing lists; then run one exact-response completion through
   SKGateway and confirm `x-sk-backend: anthropic`.

### Client disconnect and model-slot release (card a4f1066d)

SKGateway propagates a downstream socket close to the active upstream request.
The router records the internal outcome as `499/client_closed`, immediately
releases the backend pool slot, and does **not** fail over, penalize backend
health, or mutate model lifecycle state. This matters most for long local
generation: without propagation, llama.cpp continued generating after the
caller timed out and could hold an Ornith slot through service shutdown.

Qualification after a gateway change:

1. Start a long request through `:18780`, then close or time out the client.
2. Confirm the model-server log records cancellation and its slot returns idle.
3. Send a short follow-up request and verify that it starts promptly.
4. Confirm the gateway did not log `FAILOVER`, quarantine the backend, or add a
   404/410 lifecycle observation for the cancelled request.
5. Restart the model service and verify shutdown remains within its normal
   bounded stop interval rather than reaching `TimeoutStopSec`.

The focused regression is:

```bash
node --test --import ./tests/_setup.mjs \
  --test-name-pattern='downstream client cancellation' \
  tests/anthropic-spof.test.mjs
```

---

## Lingering requirement

The unit is `WantedBy=default.target`, a user target that only activates when
the user has a login session, unless lingering is enabled. Without lingering the
gateway will not start on boot or will stop when you log out. Enable it once:

```bash
loginctl enable-linger $USER
loginctl show-user $USER | grep Linger    # expect Linger=yes
```

---

## Node failover basics

The fleet runs SKGateway as independent per-node instances on the same port
(`18780`), not as a single clustered service. There is no built-in VIP or
server-side failover between nodes. Failover between gateway nodes is a
client-side concern: point clients at a chosen node, and on an outage repoint
them to the healthy node (or front the two with a load balancer / VIP if you add
one). Keep the nodes on the same commit and a reviewed config so a failover
target behaves identically. Within a single node, backend-level failover (above)
already contains upstream outages.

---

## Common failures

| Symptom | Likely cause | Action |
|---|---|---|
| `/status` shows `metrics: null` | metrics SQLite could not open | make `data/` writable or set an absolute `metrics.db_path`; restart |
| NVIDIA requests 401 | key missing / revoked | rotate in skvault, rewrite `secrets.env`, full restart |
| `claude-*` degraded / on `anthropic-direct` | claude-code-api wrapper down or wedged | restart the `:18782` wrapper; failover to `anthropic-direct` keeps Claude answering (degraded); NVIDIA/local unaffected |
| client hits wrapper directly | `base_url` set to `:18782` | repoint client to `:18780/v1` |
| backend stuck `down` | error rate exceeded 50% | wait for cooldown re-probe; fix the upstream; check `/queue` |
| requests queue / stall | per-backend concurrency cap hit | inspect `/queue`; raise `pooling.per_backend.<name>.max` if the upstream allows |
| edited backends, nothing changed | `SIGHUP` does not apply topology | full restart |
| rotated key, still 401 | `SIGHUP` does not re-read EnvironmentFile | full restart |
| service dies on logout / no boot start | lingering not enabled | `loginctl enable-linger $USER` |
| CapAuth sigs never `verified` | `openpgp` not installed | `npm install openpgp`; restart |
# Synchronize Pi models and buckets

Pi keeps custom providers in `~/.pi/agent/models.json`; it does not dynamically
consume OpenAI model catalogs. Synchronize its `skgateway` provider after a
gateway discovery refresh or release:

```bash
npm run sync:pi-models -- --dry-run
npm run sync:pi-models
pi --list-models skgateway
```

Use `--gateway-url http://HOST:18780` and `--pi-models PATH` for another node.
The command replaces only the `skgateway` provider, preserves every unrelated
Pi provider and top-level setting, refuses empty catalogs, and uses an atomic
rename. It never reads or copies gateway provider credentials.
