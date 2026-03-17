# SKGateway — Installation Guide

SKGateway is an AI inference proxy that sits between your clients (OpenClaw, Claude Code, agents, apps) and any LLM backend (NVIDIA NIM, Anthropic, Ollama). It routes, monitors, audits, and secures all AI API traffic.

---

## Prerequisites

- **Node.js 20 or later** — `node --version` must show `v20.x` or higher
- **npm** — included with Node.js
- An **NVIDIA API key** if you plan to route through NVIDIA NIM (`nvapi-...`)
- An **Anthropic credentials file** at `~/.claude/.credentials.json` if you plan to use Anthropic OAuth

To install Node.js 20 on Ubuntu/Debian:

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

---

## Clone and Install

```bash
git clone https://github.com/smilinTux/skgateway.git ~/clawd/skcapstone-repos/skgateway
cd ~/clawd/skcapstone-repos/skgateway
npm install
```

Verify the install worked:

```bash
node --version        # should be v20+
node src/index.mjs --help  # prints usage and exits cleanly
```

---

## Configuration

Copy the example config and edit it for your environment:

```bash
cp config/skgateway.yaml config/skgateway.local.yaml
```

The config file is YAML. The most important section is `backends`. Open the file and set your values:

```yaml
server:
  port: 18780           # proxy port — clients point here
  dashboard_port: 18781 # dashboard web UI port
  bind: 0.0.0.0         # listen on all interfaces (use 127.0.0.1 for local-only)

backends:
  nvidia:
    url: https://integrate.api.nvidia.com/v1
    auth_type: api_key
    api_key_env: NVIDIA_API_KEY   # set this env var before starting
    models:
      - kimi-k2-instruct
      - kimi-k2.5
      - minimax-m2.1
    priority: 1

  anthropic:
    url: https://api.anthropic.com/v1
    auth_type: oauth
    credentials_path: ~/.claude/.credentials.json
    models:
      - claude-opus-4-6
      - claude-sonnet-4-6
    priority: 2

  ollama:
    url: http://192.168.0.100:11434/v1  # change to your Ollama host
    auth_type: none
    models:
      - "dolphin-*"
    priority: 3
```

All fields have sensible defaults — you only need to include entries that differ from the defaults. The full reference config is at `config/skgateway.yaml`.

**Setting your API key:**

```bash
export NVIDIA_API_KEY="nvapi-your-key-here"
```

Or add it permanently to your shell profile (`~/.bashrc` or `~/.zshrc`):

```bash
echo 'export NVIDIA_API_KEY="nvapi-your-key-here"' >> ~/.bashrc
source ~/.bashrc
```

---

## Running Standalone

```bash
cd ~/clawd/skcapstone-repos/skgateway
NVIDIA_API_KEY="nvapi-..." node src/index.mjs
```

With a custom config file:

```bash
node src/index.mjs --config config/skgateway.local.yaml
```

With a port override:

```bash
node src/index.mjs --port 18780 --config config/skgateway.yaml
```

You should see output like:

```
[skgateway] listening on http://0.0.0.0:18780
[skgateway] backends: nvidia, anthropic, ollama
[skgateway] metrics collector initialized
[skgateway] dashboard server started on port 18781
```

For development with auto-restart on file changes:

```bash
npm run dev
```

---

## Running as a systemd Service

The repo includes a service file at `scripts/skgateway.service`. This is the recommended way to run SKGateway in production — it starts automatically on login and restarts on failure.

**Step 1: Edit the service file** to match your paths and environment:

```bash
cp scripts/skgateway.service ~/.config/systemd/user/skgateway.service
```

Open `~/.config/systemd/user/skgateway.service` and update these lines:

```ini
ExecStart=/usr/bin/node /home/YOUR_USER/clawd/skcapstone-repos/skgateway/src/index.mjs \
  --port 18780 \
  --config /home/YOUR_USER/clawd/skcapstone-repos/skgateway/config/skgateway.yaml

Environment=NVIDIA_API_KEY=nvapi-your-key-here
Environment=SKCAPSTONE_AGENT=lumina
Environment=PATH=/home/YOUR_USER/.skenv/bin:/usr/local/bin:/usr/bin:/bin

WorkingDirectory=/home/YOUR_USER/clawd/skcapstone-repos/skgateway
```

**Step 2: Enable lingering** so the service starts even without an active login session:

```bash
loginctl enable-linger $USER
```

**Step 3: Enable and start the service:**

```bash
systemctl --user daemon-reload
systemctl --user enable skgateway.service
systemctl --user start skgateway.service
```

**Step 4: Check service status:**

```bash
systemctl --user status skgateway.service
```

**View logs:**

```bash
journalctl --user -u skgateway.service -f
```

---

## Verifying It Works

**Health check endpoint:**

```bash
curl -s http://localhost:18780/health | jq .
```

Expected output:

```json
{
  "status": "ok",
  "uptime": 42.3,
  "backends": {
    "nvidia": { "status": "up", "totalRequests": 0, "totalErrors": 0 },
    "anthropic": { "status": "up", "totalRequests": 0, "totalErrors": 0 }
  }
}
```

**Full status endpoint** (includes metrics):

```bash
curl -s http://localhost:18780/status | jq .
```

**Test a proxied request** (requires a valid NVIDIA API key):

```bash
curl -s http://localhost:18780/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Agent-Id: test" \
  -d '{
    "model": "moonshotai/kimi-k2-instruct",
    "messages": [{"role": "user", "content": "Say hello."}],
    "max_tokens": 20
  }' | jq .choices[0].message.content
```

**Open the dashboard:**

Navigate to `http://localhost:18781` in your browser. You should see the SOC dashboard with backend health cards and activity panels.

---

## Troubleshooting

### Port already in use

```
Error: listen EADDRINUSE: address already in use 0.0.0.0:18780
```

Find what is using the port and stop it, or choose a different port:

```bash
lsof -i :18780           # find the process
node src/index.mjs --port 18790   # use a different port
```

### NVIDIA API key missing or invalid

```
[skgateway] upstream error: 401 Unauthorized
```

Verify your key is set:

```bash
echo $NVIDIA_API_KEY
```

If empty, export it and restart. If set but returning 401, your key may be expired — generate a new one at [build.nvidia.com](https://build.nvidia.com).

### Anthropic OAuth credentials not found

```
[skgateway] anthropic backend: credentials file not found
```

The OAuth credentials are written by Claude Code when you log in. Run `claude` once to authenticate, which creates `~/.claude/.credentials.json`. Or switch `auth_type` to `api_key` and set `ANTHROPIC_API_KEY`.

### Backend unreachable (Ollama)

```
[skgateway] upstream error: connect ECONNREFUSED 192.168.0.100:11434
```

Check that your Ollama instance is running and reachable:

```bash
curl http://192.168.0.100:11434/api/tags
```

Update the `url` in your config if the host or port differs.

### Dashboard shows no data

Metrics require the SQLite database directory to be writable. Check that `./data/` exists and is writable, or set `metrics.db_path` to an absolute path you control:

```yaml
metrics:
  db_path: /home/YOUR_USER/.skgateway/metrics.db
```

### Config file not found

If you see `config file not found`, make sure you are running from the repo root or passing `--config` with an absolute path:

```bash
node /full/path/to/skgateway/src/index.mjs \
  --config /full/path/to/skgateway/config/skgateway.yaml
```

---

## Upgrading

```bash
cd ~/clawd/skcapstone-repos/skgateway
git pull
npm install
```

Then reload the config without a full restart (SIGHUP is safe for config-only changes):

```bash
pkill -HUP -f "node.*skgateway"
# or with systemd:
systemctl --user kill -s HUP skgateway.service
```

For code changes (new features, bug fixes), do a full restart:

```bash
systemctl --user restart skgateway.service
```

Verify the new version started:

```bash
curl -s http://localhost:18780/status | jq .version
```
