# SKGateway — Dashboard User Guide

The SOC dashboard is a real-time web interface that shows everything passing through SKGateway: backend health, token usage, costs, agent activity, security events, and prompt classification. It updates every 5 seconds via WebSocket with no page refresh required.

---

## Accessing the Dashboard

Navigate to:

```
http://localhost:18781
```

If you changed `dashboard_port` in `skgateway.yaml`, use that port number instead. The dashboard is also reachable by visiting `http://localhost:18780/` — the proxy will redirect you automatically.

The dashboard has no login. It is intended for local or LAN access. If you expose SKGateway to a wider network, put it behind a reverse proxy with auth.

---

## Dashboard Panels Overview

### Header Bar

The sticky bar at the top of every page. Contains:

- **SKGateway SOC** logo and title (top-left)
- **Uptime** — how long the gateway process has been running, formatted as `Xh Ym`
- **Total Requests** — cumulative request count since last start
- **RPS** — requests per second, averaged over the last 5 minutes
- **Tokens** — total tokens processed (input + output combined) since last start
- **Cost** — total USD cost since last start, calculated from per-model pricing
- **WebSocket badge** (top-right) — shows `WS` with a green pulsing dot when live data is connected, or a red dot if the WebSocket has disconnected and the dashboard is falling back to polling

The header stats refresh on every WebSocket push (every 5 seconds).

---

### Backend Health Cards

A horizontal row of cards, one per configured backend. Each card shows:

- **Status dot** — green (up), yellow with pulse (degraded), red with fast pulse (down), or grey (unknown)
- **Backend name** — e.g., `nvidia`, `anthropic`, `ollama`
- **Status label** — UP / DEGRADED / DOWN / UNKNOWN badge
- **Model list** — the models routed to this backend, shown in monospace font
- **Latency P50** — median request latency in milliseconds
- **Error rate** — percentage of requests that returned a 4xx or 5xx
- **Requests** — total request count through this backend
- **Errors** — total error count

The health data comes from the router's per-backend health tracker, which monitors every proxied request. A backend moves to `degraded` when its error rate exceeds a threshold; to `down` when it is unreachable.

---

### Token Usage Chart

A bar chart showing token consumption over time. Located in the main grid left-center.

**Time period toggles** — buttons across the top of the panel let you switch between:
- `1h` — last hour, one bar per 5 minutes
- `6h` — last 6 hours, one bar per 30 minutes
- `24h` — last 24 hours, one bar per hour

Each bar is stacked by agent. Clicking a legend item mutes or un-mutes that agent's contribution to the bars.

**Legend** — shown below the chart, one colored dot per agent. Agent colors match the soul color system (see the Design System section below). Click a legend entry to toggle that agent's data on or off.

The chart queries `/api/tokens?period=<period>` and redraws whenever you change the time window or when a WebSocket push arrives with new token data.

---

### Cost Tracker

Located to the right of the token chart. Shows cost data broken down by time period and agent.

**Summary row** — three numbers across the top:
- **Today** — total cost for the current UTC day
- **Week** — total cost for the last 7 days
- **Month** — total cost for the last 30 days

**Per-agent bars** — a horizontal bar chart showing each agent's contribution to today's spend. The bar length is proportional to that agent's share of total cost. Each bar is colored with that agent's soul color.

**Per-model table** — below the bars, a breakdown of cost by model showing input cost, output cost, and total. Useful for seeing which model is driving the most spend.

Costs are calculated using the pricing table in `skgateway.yaml` under `metrics.pricing`. NVIDIA-hosted models (Kimi K2, MiniMax M2.1) are configured as free-tier ($0). Anthropic models are billed at their standard rates.

---

### Agent Activity Feed

A live scrolling feed of recent requests, one row per request. Located in the bottom-left of the main grid.

Each row shows:
- **Agent color dot** — the soul color for that agent
- **Agent name** — e.g., `lumina`, `opus`, `jarvis`
- **Model** — the model that handled the request
- **Token count** — total tokens for that request
- **Latency** — round-trip time in milliseconds
- **Timestamp** — relative time (e.g., `2s ago`, `1m ago`)

New entries appear at the top. The feed keeps the last 50 entries in memory. When a new SIEM security event arrives, it is also injected into the feed with a red border to make it stand out.

---

### Prompt Classification Donut

A donut chart showing the distribution of prompt intent categories across recent requests.

**Categories:**
- `code_generation` — writing, debugging, or reviewing code
- `data_query` — SQL, analytics, search, or database operations
- `creative` — stories, essays, image prompts, creative writing
- `administrative` — tasks, GTD, scheduling, email, project management
- `security_sensitive` — credentials, keys, encryption, penetration testing
- `tool_use` — shell commands, file operations, MCP tool calls
- `conversation` — general chat, questions, short exchanges
- `system` — configuration, system prompts, policy discussion

Each category has a percentage shown in the legend. The classification runs entirely on-device using regex patterns — no prompts are sent anywhere for analysis, and it completes in under 5ms per request.

Hover over a segment to see the exact count and percentage for that category.

---

### Security Events

A filterable list of security events from the SIEM subsystem. Located in the lower portion of the right column.

**Severity levels:**
- `critical` — high-confidence jailbreak attempt or data exfiltration signal (risk score 9-10)
- `suspicious` — unusual patterns, possible injection, encoding tricks (risk score 6-8)
- `sensitive` — credential mentions, system access, security tooling (risk score 3-5)
- `normal` — informational events, no risk signals (risk score 0-2)

**Filter controls** — filter by event type: `auth`, `request`, `response`, `error`, `policy_violation`, `anomaly`, `failover`, `tool_use`.

**Each event row shows:**
- Severity badge (color-coded)
- Event type
- Agent ID
- Human-readable message
- Timestamp

Click any event row to expand it and see the full structured detail object, including which risk signals were matched and their individual scores.

The in-memory ring buffer holds the last 200 events. Events older than the ring buffer limit are gone after a gateway restart unless you are writing to the audit log file (`siem.outputs` in config).

**Audit log file** — all events are also written to `./logs/audit.jsonl` (JSON Lines format, one event per line). Files are rotated at 100MB. You can tail this file for real-time monitoring:

```bash
tail -f ~/clawd/skcapstone-repos/skgateway/logs/audit.jsonl | jq .
```

---

### ITIL Status

A small panel in the lower-right showing incident and change management status. Intended for integration with ITIL/Deming-style ops workflows.

**Incidents** — open incidents auto-created from high-severity security events or repeated backend failures. Shows count, severity, and time-since-open.

**Changes** — recently applied configuration changes (config reloads via SIGHUP). Shows what changed and when.

This panel is informational in the current release. Full ITIL integration (auto-incident creation, change approval workflows) is planned for a future version.

---

## Interacting with the Dashboard

### Time Period Toggles

The token chart and cost tracker both have period buttons (`1h`, `6h`, `24h`). Click a button to reload the chart for that time window. The active period button is highlighted in purple (the accent color).

### Legend Filtering

In the token chart legend, click an agent name to toggle that agent's bars on or off. Muted agents are shown at 30% opacity. This is useful when one agent dominates the chart and you want to see the others.

### Expanding Security Events

Click any row in the security events list to expand it and see the full event JSON. Click again to collapse it.

### Refreshing

The dashboard refreshes automatically every 5 seconds via WebSocket. If the WebSocket disconnects (gateway restart, network hiccup), it falls back to polling the REST API every 10 seconds. The WebSocket badge in the header shows the current connection state.

You can force a manual refresh by reloading the page (`Ctrl+R` / `Cmd+R`).

---

## WebSocket vs REST

The dashboard uses WebSocket as the primary data channel:

- **WebSocket** (`ws://localhost:18781/ws`) — server pushes a full stats payload every 5 seconds, plus immediate pushes for new SIEM events and activity feed entries
- **REST fallback** — if WebSocket is unavailable, the dashboard polls `/api/stats`, `/api/health`, `/api/events`, and `/api/activity` on a 10-second interval

You can query the REST endpoints directly for scripting or monitoring:

```bash
# Live stats snapshot
curl -s http://localhost:18781/api/stats | jq .

# Backend health
curl -s http://localhost:18781/api/health | jq .

# Last 20 security events
curl -s "http://localhost:18781/api/events?limit=20" | jq .events

# Token usage for a specific agent
curl -s "http://localhost:18781/api/tokens?agent=lumina&period=6h" | jq .rows

# Cost breakdown for today
curl -s "http://localhost:18781/api/costs?period=24h" | jq .rows

# Active agents and session counts
curl -s http://localhost:18781/api/agents | jq .agents
```

---

## Mobile Support

The dashboard is usable on mobile browsers. The header stats wrap to two lines on narrow screens, and the backend health row scrolls horizontally. The main grid collapses to a single column below 900px viewport width.

The WebSocket connection works fine on mobile as long as your device can reach the gateway host (use Tailscale if you need remote access).

---

## Design System

The dashboard uses the SK design system:

**OLED black background** — pure `#000000` with no grey. This saves battery on OLED screens and gives the glass cards maximum contrast.

**Glass cards** — each panel is a `backdrop-filter: blur(20px)` frosted glass card with a subtle linear gradient overlay. The effect is consistent across all panels.

**Typography** — `Inter` for UI text, `JetBrains Mono` for numbers, model names, and code values.

**Accent color** — purple (`#A855F7`) for active states, highlights, and the SKGateway logo.

### Soul Colors

Each agent has a unique color that appears on their activity feed entries, legend dots, and cost bars. These colors are fixed — they match the agent's soul identity across all SK tooling.

| Agent | Color | Hex |
|---|---|---|
| lumina | Purple | `#A855F7` |
| jarvis | Cyan | `#06B6D4` |
| opus | Amber | `#F59E0B` |
| sentinel | Red | `#EF4444` |
| artisan | Pink | `#EC4899` |
| herald | Emerald | `#10B981` |
| architect | Indigo | `#6366F1` |
| scholar | Violet | `#8B5CF6` |
| steward | Teal | `#14B8A6` |
| coder | Orange | `#F97316` |
| unknown | Slate | `#64748B` |

`unknown` is used for any request that did not include an `X-Agent-Id` header — for example, a raw `curl` test or an unconfigured client.
