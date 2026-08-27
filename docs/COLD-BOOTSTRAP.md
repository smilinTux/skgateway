# SKGateway Cold-Machine Bootstrap Runbook

Bring SKGateway up on a COLD machine: fresh clone, nothing configured, no
secrets provisioned. This is the ordered, secret-by-name procedure. It never
prints a real key or token; every secret is referred to by name and by source.

For narrative install detail, systemd specifics, and troubleshooting, see
[INSTALL.md](INSTALL.md). For day-two operations (rotation, SIEM, failover, the
proven gotchas), see [RUNBOOK.md](RUNBOOK.md). This runbook is the checklist
that ties secrets and config materialization together in one place.

The golden rule: **no secret value ever lands in git, in a shell profile, in
shell history, or inline in the systemd unit.** Secrets reach the process only
through a `0600` EnvironmentFile (env vars) or a `0600` credentials file
referenced by path. This template and this doc contain names and paths, never
values.

---

## What "up" means

A healthy cold bootstrap ends with:

- `GET http://localhost:18780/health` returns `{"status":"ok", ...}`.
- `GET http://localhost:18780/v1/models` lists the models from your configured
  backends.
- One real completion returns text (a local backend needs no secret; an NVIDIA
  or `anthropic-direct` completion exercises a provisioned secret).

---

## Secret and config inventory (by NAME, never value)

### Secrets

| Name | Kind | Consumed by | Source | Materialized as |
|------|------|-------------|--------|-----------------|
| `NVIDIA_API_KEY` | env var (`nvapi-...`) | `nvidia` backend (`auth_type: api_key`, `api_key_env: NVIDIA_API_KEY`) | skvault | a `KEY=value` line in `~/.config/skgateway/secrets.env` (0600), sourced by the systemd `EnvironmentFile` |
| Claude Code OAuth token | credentials FILE | `anthropic-direct` fallback backend (`auth_type: oauth`, `credentials_path: ~/.claude/.credentials.json`) | written by `claude` login on the box (Claude Code); NOT provisioned by this repo | the existing `~/.claude/.credentials.json` (0600). Only needed if you keep the `anthropic-direct` fallback |
| claude-code-api wrapper session | external service login | `anthropic` primary backend (`auth_type: none`, `url: http://127.0.0.1:18782/v1`) | the local `claude-code-api` wrapper process (outside this repo), which must be logged in | none in this repo; the wrapper holds its own session. Only needed to route `claude-*` models |

Notes:
- Only `NVIDIA_API_KEY` is a true env-var secret this repo provisions. If you do
  not route NVIDIA models, you need no secret at all: local backends use
  `auth_type: none`.
- `anthropic` (primary, via the `:18782` wrapper) and `anthropic-direct`
  (fallback, direct OAuth) are BOTH optional. Drop both backends from the config
  if this box does not serve `claude-*`.
- Secret ROTATION is a full `systemctl --user restart`. A `SIGHUP` reload does
  NOT re-read the EnvironmentFile. See RUNBOOK.md.

### Config keys (materialized from the committed template, NOT secrets)

The config file is `config/skgateway.yaml`. Every field has a code default in
`src/config.mjs`, so you only keep what differs. Provision it by copying the
committed template `config/skgateway.yaml.example` and editing the host-specific
values below.

| Key path | Purpose | Cold-machine action |
|----------|---------|---------------------|
| `server.port` / `server.dashboard_port` / `server.bind` | listen ports (default 18780 / 18781) and bind address | usually leave as default |
| `backends.<name>.url` | upstream URL per backend | EDIT to the reachable host:port on THIS network (the template uses `LOCAL_LLM_HOST` placeholders) |
| `backends.<name>.auth_type` | `none` / `api_key` / `oauth` / `bearer` | keep as shipped; drives which secret (if any) is read |
| `backends.nvidia.api_key_env` | NAME of the env var holding the NVIDIA key | leave `NVIDIA_API_KEY` unless you renamed the secret |
| `backends.anthropic-direct.credentials_path` | path to the OAuth creds FILE | leave `~/.claude/.credentials.json`; remove the whole backend if unused |
| `backends.<name>.models` | model catalog matched for routing | prune to what each upstream actually serves |
| `backends.<name>.priority` | routing order (lower number wins, failover up) | keep as shipped unless changing topology |
| `pooling.*` | per-backend concurrency + queue caps | keep nvidia `max` at or below the upstream NIM ceiling |
| `metrics.db_path` | SQLite metrics store path | default `./data/metrics.db` (repo-relative). Set absolute if `data/` is not writable |
| `siem.outputs[].path` | audit JSONL path | default `./logs/audit.jsonl` (repo-relative) |
| `identity.require_agent_id` | AUTH GATE (403 on anonymous) | default `false`; set `true` only to enforce CapAuth |

### Optional environment overrides (no YAML edit needed)

Read by `src/config.mjs` at startup, handy inside the unit or the secrets file.
None are secrets:
`SKGATEWAY_PORT`, `SKGATEWAY_DASHBOARD_PORT`, `SKGATEWAY_BIND`,
`SKGATEWAY_CONFIG`, `SKGATEWAY_TARGET` (nvidia url), `SKGATEWAY_NVIDIA_KEY_ENV`,
`SKGATEWAY_METRICS_DB`, `SKGATEWAY_RETENTION_DAYS`, and the
`SKGATEWAY_SYSLOG_*` family (`ENABLED`, `HOST`, `PORT`, `PROTOCOL`, `FACILITY`,
`FORMAT`).

---

## Ordered bootstrap steps

### 1. Prerequisites

- Node.js 20+ (`node --version` shows `v20` or higher; verified on Node 22).
- npm (ships with Node), plus a C/C++ toolchain for `better-sqlite3` if no
  prebuilt binary is available (`build-essential`, `python3`, `make`).
- Optional: the local `claude-code-api` wrapper on `127.0.0.1:18782` only if you
  route `claude-*` models. It lives outside this repo.

### 2. Clone and install

Choose a checkout directory with `SKGATEWAY_DIR`; the default below is portable
across user accounts and can be overridden before running the commands.

```bash
export SKGATEWAY_DIR="${SKGATEWAY_DIR:-$HOME/src/skgateway}"
mkdir -p "$(dirname "$SKGATEWAY_DIR")"
git clone https://github.com/smilinTux/skgateway.git "$SKGATEWAY_DIR"
cd "$SKGATEWAY_DIR"
npm ci                       # reproducible install from package-lock.json
node --check src/index.mjs   # exits 0 if the entrypoint parses
```

### 3. Materialize the config from the template

```bash
cp config/skgateway.yaml.example config/skgateway.yaml
${EDITOR:-nano} config/skgateway.yaml
```

Edit the host-specific values called out in the config table above: replace the
`LOCAL_LLM_HOST` placeholders with real upstream URLs, prune each backend's
`models` list to what that upstream serves, and remove any backend you do not
run (for example both `anthropic` and `anthropic-direct` if this box serves no
`claude-*`). Leave `api_key_env` and `credentials_path` naming values as
shipped. `git` ignores nothing here: the resulting `config/skgateway.yaml` holds
no secrets and is safe to commit on the fleet, but on a fresh machine it is
simply rendered from the template.

Sanity-check that it parses and validates (uses the real loader, so a bad value
throws a descriptive `ConfigError`):

```bash
node -e "import('./src/config.mjs').then(m=>m.loadConfig({configPath:'./config/skgateway.yaml',silent:true})).then(()=>console.log('config OK')).catch(e=>{console.error(e.message);process.exit(1)})"
```

### 4. Provision secrets (only if you route a backend that needs one)

Skip this step entirely for a local-only deployment (`auth_type: none`
backends).

For NVIDIA, create the `0600` EnvironmentFile and pull the key from skvault. Do
not echo the value into shell history:

```bash
mkdir -p ~/.config/skgateway
umask 077
${EDITOR:-nano} ~/.config/skgateway/secrets.env    # add: NVIDIA_API_KEY=<pull from skvault>
chmod 600 ~/.config/skgateway/secrets.env
```

The file is plain `KEY=value` lines, one per line, exactly as systemd expects.
The placeholder in this doc is `<NVIDIA_API_KEY>`; never write a real
`nvapi-...` value into any doc, template, or commit.

For the optional `anthropic-direct` fallback, no repo step is needed: it reads
`~/.claude/.credentials.json`, which the `claude` login already wrote. Confirm
it exists and is `0600` if you keep that backend.

### 5. Install and start the service

```bash
mkdir -p ~/.config/systemd/user
cp scripts/skgateway.service ~/.config/systemd/user/skgateway.service
# Set ExecStart + WorkingDirectory in the copied unit to $SKGATEWAY_DIR.
# The EnvironmentFile line uses %h and needs no edit.
${EDITOR:-nano} ~/.config/systemd/user/skgateway.service
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now skgateway.service
systemctl --user status skgateway.service
```

The unit sources `%h/.config/skgateway/secrets.env` with a leading `-` (optional,
so a missing file does not block startup) and never inlines a secret.

Dev alternative (foreground, no systemd): load the secrets into the shell first
so `NVIDIA_API_KEY` is present, then run directly.

```bash
set -a; . ~/.config/skgateway/secrets.env; set +a
node src/index.mjs --config config/skgateway.yaml
```

### 6. Verify

```bash
curl -s http://localhost:18780/health | jq .
curl -s http://localhost:18780/status | jq '{version, uptime, metrics: (.metrics != null)}'
curl -s http://localhost:18780/v1/models | jq '.data[].id'
```

A real completion through a local backend (no secret needed):

```bash
curl -s http://localhost:18780/v1/chat/completions \
  -H "Content-Type: application/json" -H "X-Agent-Id: bootstrap-test" \
  -d '{"model":"ornith-1.0-9b","messages":[{"role":"user","content":"Say hello."}],"max_tokens":20}' \
  | jq -r .choices[0].message.content
```

If you provisioned `NVIDIA_API_KEY`, repeat with an NVIDIA model (for example
`deepseek-ai/deepseek-v4-flash`) to exercise the secret end to end. Point all
clients at `http://localhost:18780/v1`, never at the `:18782` wrapper directly.

---

## Fast failure map

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| NVIDIA request 401 | `NVIDIA_API_KEY` missing / wrong / revoked | confirm `systemctl --user show skgateway.service -p EnvironmentFiles`, rewrite secrets.env from skvault, full restart |
| `claude-*` requests fail | `:18782` wrapper down or wedged | `curl -s http://127.0.0.1:18782/v1/models`; restart the wrapper; fallback is `anthropic-direct` |
| `/status` `"metrics": null` | `data/` not writable | set an absolute `metrics.db_path` |
| Config not found | run from another dir | pass an absolute `--config` or set `SKGATEWAY_CONFIG` |
| `ConfigError` on start | bad value in YAML | read the error; it lists the exact offending key |

Full versions of each item live in [INSTALL.md](INSTALL.md) (Troubleshooting)
and [RUNBOOK.md](RUNBOOK.md).
