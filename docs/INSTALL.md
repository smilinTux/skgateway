# SKGateway Installation Guide

SKGateway is an AI inference proxy that sits between your clients (Claude Code,
agents, crons, apps) and any LLM backend. It routes by model name with priority
failover, enforces per-backend concurrency limits, resolves a caller identity,
records metrics, and writes a SIEM audit stream. It speaks the OpenAI-compatible
HTTP API on port `18780`, and serves a live SOC dashboard on port `18781`.

This guide takes a bare machine with Node.js 20+ to a running gateway that
passes a `/health` check. It documents the production install used on the fleet:
secrets arrive through a `0600` EnvironmentFile sourced from skvault, never in
plaintext in a shell profile and never inline in the systemd unit.

For a terse, ordered checklist that ties the secret and config inventory
together for a fresh box (rendered from `config/skgateway.yaml.example`), see
[COLD-BOOTSTRAP.md](COLD-BOOTSTRAP.md).

For day-two operations (health checks, credential rotation, SIEM/syslog, CapAuth,
failover, and the two proven gotchas), see [RUNBOOK.md](RUNBOOK.md).

---

## Prerequisites

- **Node.js 20 or later.** `node --version` must show `v20.x` or higher. The
  service is verified on Node 22.
- **npm**, included with Node.js. Used for a locked, reproducible install.
- **A C/C++ build toolchain** for the one native dependency, `better-sqlite3`
  (used by the metrics store). On most Linux hosts a prebuilt binary is fetched
  automatically; if it has to compile from source you need `python3`, `make`,
  and a C++ compiler (`build-essential` on Debian/Ubuntu).
- **An NVIDIA API key** (`nvapi-...`) if you route through NVIDIA NIM. It is read
  from the `NVIDIA_API_KEY` environment variable, populated by the secrets
  EnvironmentFile described below.
- **The local claude-code-api wrapper** on `127.0.0.1:18782` if you route any
  `claude-*` models. The `anthropic` backend points at this wrapper, not at
  `api.anthropic.com` directly. See the wrapper section in
  [RUNBOOK.md](RUNBOOK.md) for why and how.
- **Optional: the `openpgp` npm package** if you want cryptographic verification
  of CapAuth PGP signatures. It is not a declared dependency; without it,
  CapAuth identity still resolves but signatures are never marked `verified`.

To install Node.js 20 on Ubuntu/Debian:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## Clone and Install

Choose a checkout directory with `SKGATEWAY_DIR`; the default below is portable
across user accounts and can be overridden before running the commands.

```bash
export SKGATEWAY_DIR="${SKGATEWAY_DIR:-$HOME/src/skgateway}"
mkdir -p "$(dirname "$SKGATEWAY_DIR")"
git clone https://github.com/smilinTux/skgateway.git "$SKGATEWAY_DIR"
cd "$SKGATEWAY_DIR"
npm ci
```

`npm ci` installs the exact versions in `package-lock.json` (the reproducible
path). Use `npm install` only when you are intentionally changing dependencies.

Verify the toolchain and that the entrypoint parses:

```bash
node --version            # must be v20+
node --check src/index.mjs   # exits 0 with no output if the file parses
```

Note: `src/index.mjs` has no `--help` flag. Running it starts the server. Use
`node --check` to validate syntax without launching.

---

## Configuration

The shipped reference config is `config/skgateway.yaml`. Every field has a
code-level default in `src/config.mjs`, so the YAML only needs the entries that
differ from those defaults. Missing sections fall back to the built-in defaults;
a syntactically invalid file logs a warning and the gateway falls back to
defaults rather than crashing.

### Backends

Backends are matched by model name. Each request routes to the highest-priority
backend that lists a matching model (`priority: 1` beats `priority: 2`), with
failover to the next eligible backend. The current shipped backends are:

```yaml
backends:
  local:                                   # local ornith server on .100:8082
    url: http://192.168.0.100:8082/v1
    auth_type: none
    models:
      - ornith-tiny
      - ornith-1.0-9b
      - qwen3.6-27b-abliterated
    priority: 1

  tyler-ornith:                            # ornith-1.0-35b, .150 primary
    url: http://192.168.0.150:8087/v1
    auth_type: none
    models:
      - ornith-1.0-35b
      - ornith-big
    priority: 5
  tyler-ornith-b:                          # ornith-1.0-35b, .153 failover
    url: http://192.168.0.153:8087/v1
    auth_type: none
    models:
      - ornith-1.0-35b
      - ornith-big
    priority: 6

  nvidia:                                  # NVIDIA NIM (hosted)
    url: https://integrate.api.nvidia.com/v1
    auth_type: api_key
    api_key_env: NVIDIA_API_KEY            # name of the env var, not the value
    models:
      - moonshotai/kimi-k2.6
      - qwen/qwen3-next-80b-a3b-instruct
      - deepseek-ai/deepseek-v4-flash
      - openai/gpt-oss-120b
      # ... see config/skgateway.yaml for the full catalog
    priority: 1

  anthropic:                               # claude-* via LOCAL wrapper, NOT api.anthropic.com
    url: http://127.0.0.1:18782/v1
    auth_type: none
    models:
      - claude-opus-4-8
      - claude-opus-4-7
      - claude-sonnet-4-6
      - claude-haiku-4-5
    priority: 2

  ollama:
    url: http://192.168.0.100:11434/v1
    auth_type: none
    models:
      - "dolphin-*"
    priority: 3
```

The `anthropic` backend routes Claude models through the local claude-code-api
wrapper at `127.0.0.1:18782` (`auth_type: none`). This bills as genuine
first-party subscription usage. Hitting `api.anthropic.com` directly with a raw
OAuth token is treated as a third-party app that draws from extra-usage and
fails under load, which is why the direct-OAuth mode was abandoned. Do not set
`auth_type: oauth` with a `credentials_path` for this backend.

### Secrets (never inline)

Secrets are never committed, never exported in `~/.bashrc`, and never written
inline in the systemd unit. They arrive at the process through a `0600`
EnvironmentFile that the unit sources at start.

Create the secrets directory and file (source the values from skvault, never
paste them into a doc or a shell history):

```bash
mkdir -p ~/.config/skgateway
umask 077
# Write NVIDIA_API_KEY (and any other secret env vars) into the file.
# Pull the value from skvault; do not echo it into your shell history.
${EDITOR:-nano} ~/.config/skgateway/secrets.env
chmod 600 ~/.config/skgateway/secrets.env
```

The file is plain `KEY=value` lines, one per line, as systemd expects:

```
NVIDIA_API_KEY=nvapi-REPLACED_FROM_SKVAULT
```

The `.gitignore` already excludes `.env`, `data/`, and `logs/`, so runtime
state and secrets never enter git. Confirm the file is `0600` and owned by you.

### Environment overrides (optional)

A few settings can be overridden by environment variables without editing YAML
(handy inside the unit or the secrets file). The full list lives in
`src/config.mjs`; the common ones are `SKGATEWAY_PORT`,
`SKGATEWAY_DASHBOARD_PORT`, `SKGATEWAY_BIND`, `SKGATEWAY_CONFIG`,
`SKGATEWAY_METRICS_DB`, and the `SKGATEWAY_SYSLOG_*` family (see
[RUNBOOK.md](RUNBOOK.md)).

---

## Run as a systemd User Service

The repo ships a user service unit at `scripts/skgateway.service`. It runs the
gateway on port `18780`, restarts on failure, and sources the secrets
EnvironmentFile (`%h/.config/skgateway/secrets.env`, optional so a missing file
does not block startup).

**Step 1: Install the unit.**

```bash
mkdir -p ~/.config/systemd/user
cp scripts/skgateway.service ~/.config/systemd/user/skgateway.service
```

Set the `ExecStart` and `WorkingDirectory` paths in the copied unit to
`$SKGATEWAY_DIR` (expand the variable to its current value when editing). The
`EnvironmentFile=` line uses `%h`, so it already resolves to your home directory
and needs no edit.

```bash
${EDITOR:-nano} ~/.config/systemd/user/skgateway.service
```

**Step 2: Enable lingering** so the service runs without an active login
session (the unit is `WantedBy=default.target`, a user target that only comes up
when the user has a session unless lingering is enabled):

```bash
loginctl enable-linger $USER
```

**Step 3: Enable and start.**

```bash
systemctl --user daemon-reload
systemctl --user enable skgateway.service
systemctl --user start skgateway.service
```

**Step 4: Check status and logs.**

```bash
systemctl --user status skgateway.service
journalctl --user -u skgateway.service -f
```

On a healthy start you will see lines like:

```
[skgateway] listening on http://0.0.0.0:18780
[skgateway] backends: local, tyler-ornith, tyler-ornith-b, nvidia, anthropic, ollama
[skgateway] metrics collector initialized
[skgateway] identity registry loaded (N agents, anonymous allowed, auth-gate OFF)
[skgateway] dashboard server started on port 18781
```

### Running standalone (development)

For a foreground run without systemd, load the secrets file into the shell
first so `NVIDIA_API_KEY` is present:

```bash
set -a; . ~/.config/skgateway/secrets.env; set +a
node src/index.mjs --config config/skgateway.yaml
```

`--port` and `--config` are the only CLI flags. Auto-restart on file changes:
`npm run dev`.

---

## Verifying It Works

**Health check.** No auth required:

```bash
curl -s http://localhost:18780/health | jq .
```

```json
{
  "status": "ok",
  "uptime": 42.3,
  "backends": {
    "nvidia":    { "status": "up", "latencyP50": 0 },
    "anthropic": { "status": "up", "latencyP50": 0 }
  }
}
```

Idle backends report `status: "up"` until a real request exercises them; this is
passive health, not an active probe.

**Full status** (adds version, pool, and metrics):

```bash
curl -s http://localhost:18780/status | jq .
```

`metrics` should be a non-null object once the collector initialized. A `null`
here means the metrics store failed to open (see Troubleshooting).

**Model catalog** (aggregated across configured backends):

```bash
curl -s http://localhost:18780/v1/models | jq '.data[].id'
```

**A proxied completion** through a real NVIDIA model (requires a valid
`NVIDIA_API_KEY`):

```bash
curl -s http://localhost:18780/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Agent-Id: test" \
  -d '{
    "model": "moonshotai/kimi-k2.6",
    "messages": [{"role": "user", "content": "Say hello."}],
    "max_tokens": 20
  }' | jq -r .choices[0].message.content
```

**Point clients at the gateway, not the wrapper.** Client and cron `base_url`
must be `http://localhost:18780/v1`. Pointing at `:18782` bypasses routing and
lands directly on the claude-code-api wrapper. See the gotchas in
[RUNBOOK.md](RUNBOOK.md).

**Dashboard.** Open `http://localhost:18781` for the live SOC dashboard.

---

## Troubleshooting

### Port already in use

```
Error: listen EADDRINUSE: address already in use 0.0.0.0:18780
```

```bash
lsof -i :18780                       # find the process
node src/index.mjs --port 18790      # or run on a different port
```

### NVIDIA request returns 401

The key is missing, wrong, or revoked. Confirm the process actually received it:

```bash
systemctl --user show skgateway.service -p EnvironmentFiles
```

If the key is present but returns 401 it is likely revoked or expired. Rotate it:
update the value in skvault, rewrite `~/.config/skgateway/secrets.env`, then do a
**full restart** (`systemctl --user restart skgateway.service`). A `SIGHUP`
reload does **not** re-read the EnvironmentFile. See the rotation runbook in
[RUNBOOK.md](RUNBOOK.md).

### claude-* models fail

All `claude-*` traffic is routed PRIMARILY through the claude-code-api wrapper at
`127.0.0.1:18782` (first-party subscription billing). If it is down or wedged,
the gateway now fails over to the lower-priority `anthropic-direct` backend
(direct OAuth to api.anthropic.com) as a degraded last resort, and a fail-fast
idle timeout on the wrapper backend prevents a wedged wrapper from hanging
requests (see RUNBOOK "claude-code-api :18782 wrapper dependency + SPOF
fallback"). Confirm the wrapper is up:

```bash
curl -s http://127.0.0.1:18782/v1/models | jq . || echo "wrapper down"
```

Restart the wrapper (it lives outside this repo) and retry. NVIDIA and local
models are unaffected.

### Backend unreachable (local / ollama)

```
upstream error: connect ECONNREFUSED 192.168.0.100:11434
```

Check the upstream is running and reachable, and fix the `url` in the config if
the host or port differs:

```bash
curl http://192.168.0.100:11434/api/tags
```

### /status shows "metrics": null, or the dashboard is empty

The metrics SQLite store could not open. `data/` must be writable (it is created
under the repo root by default, `metrics.db_path: ./data/metrics.db`). Set an
absolute, writable path if needed:

Set a variable to an absolute writable location, then use its expanded value in
YAML (YAML does not expand shell variables):

```bash
export SKGATEWAY_METRICS_DB="${SKGATEWAY_METRICS_DB:-$HOME/.local/state/skgateway/metrics.db}"
mkdir -p "$(dirname "$SKGATEWAY_METRICS_DB")"
printf 'metrics:\n  db_path: %s\n' "$SKGATEWAY_METRICS_DB"
```

Copy the printed `db_path` into `config/skgateway.yaml`.

### Config file not found

The loader resolves `config/skgateway.yaml` relative to the repo root, or from
`SKGATEWAY_CONFIG`, or `--config`. If you run from another directory, pass an
absolute path:

```bash
node "$SKGATEWAY_DIR/src/index.mjs" --config "$SKGATEWAY_DIR/config/skgateway.yaml"
```

---

## Upgrading

```bash
cd "$SKGATEWAY_DIR"
git pull
npm ci
systemctl --user restart skgateway.service
```

Always do a **full restart** for a code upgrade. `SIGHUP` (the unit's
`ExecReload`) re-reads the YAML config file only, and even then backend topology
changes (adding, removing, or re-pointing a backend) do not reach the running
router. Secret (EnvironmentFile) changes are never picked up by `SIGHUP`. Treat
`SIGHUP` as a narrow live-tuning tool and restart for anything structural. Full
reload behavior is documented in [RUNBOOK.md](RUNBOOK.md).

Confirm the new process is live:

```bash
curl -s http://localhost:18780/status | jq '{version, uptime}'
```
