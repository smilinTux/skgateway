# SKGateway — REST API Reference

## Contents

1. [Base URLs](#base-urls)
2. [Authentication](#authentication)
3. [Proxy Endpoints](#proxy-endpoints)
   - [POST /v1/chat/completions](#post-v1chatcompletions)
   - [GET /health](#get-health)
   - [GET /status](#get-status)
4. [Dashboard API Endpoints](#dashboard-api-endpoints)
   - [GET /api/stats](#get-apistats)
   - [GET /api/health](#get-apihealth)
   - [GET /api/agents](#get-apiagents)
   - [GET /api/tokens](#get-apitokens)
   - [GET /api/costs](#get-apicosts)
   - [GET /api/events](#get-apievents)
   - [GET /api/activity](#get-apiactivity)
5. [WebSocket Protocol](#websocket-protocol)
6. [Error Responses](#error-responses)
7. [Headers Reference](#headers-reference)

---

## Base URLs

| Service | Default URL | Description |
|---------|------------|-------------|
| Proxy | `http://localhost:18780` | LLM inference proxy |
| Dashboard | `http://localhost:18781` | SOC dashboard + REST API |

Both ports are configurable. See `server.port` and `server.dashboard_port` in
`config/skgateway.yaml`.

---

## Authentication

### Proxy endpoints

The proxy passes authentication headers through to the upstream backend. Client
applications (OpenClaw, Claude Code, etc.) should use their existing API keys.

SKGateway identity headers are optional and additive — they allow the proxy to
associate requests with specific agents for metrics and policy enforcement:

| Header | Description |
|--------|-------------|
| `X-Agent-Id` | Agent identifier (e.g. `lumina`, `jarvis`). Used for metrics, policy, and SIEM attribution. |
| `X-Session-Id` | Session/conversation UUID. Used for conversation-level token tracking. |
| `X-CapAuth-Signature` | PGP signature over a deterministic per-request challenge. Required when `identity.capauth_verify: true` in config. |
| `X-CapAuth-Timestamp` | Unix timestamp (seconds) for the CapAuth signature. Must be within ±300 seconds of gateway time. |

### Dashboard API endpoints

The dashboard API is unauthenticated by default (CORS wildcard). Restrict access
at the network level (bind to loopback or put behind a reverse proxy with auth).

---

## Proxy Endpoints

### POST /v1/chat/completions

Forward an inference request to the selected LLM backend. Compatible with the
OpenAI chat completions API.

**Request**

```
POST http://localhost:18780/v1/chat/completions
Content-Type: application/json
Authorization: Bearer <your-api-key>
X-Agent-Id: lumina
X-Session-Id: sess-abc123
```

```json
{
  "model": "kimi-k2-instruct",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user",   "content": "What is 2 + 2?" }
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 1024
}
```

**With tools:**

```json
{
  "model": "kimi-k2-instruct",
  "messages": [
    { "role": "user", "content": "Search my memory for notes about GTD inbox." }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "skmemory_search",
        "description": "Search the agent memory",
        "parameters": {
          "type": "object",
          "properties": {
            "query": { "type": "string" }
          },
          "required": ["query"]
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

**Response — non-streaming (stream: false or omitted)**

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1742219531,
  "model": "kimi-k2-instruct",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "2 + 2 = 4"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 28,
    "completion_tokens": 9,
    "total_tokens": 37
  }
}
```

**Response — streaming (stream: true)**

The gateway returns `Content-Type: text/event-stream`. Events are sent as
Server-Sent Events (SSE):

```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1742219531,"model":"kimi-k2-instruct","choices":[{"index":0,"delta":{"role":"assistant","content":"2"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1742219531,"model":"kimi-k2-instruct","choices":[{"index":0,"delta":{"content":" + 2 = 4"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1742219531,"model":"kimi-k2-instruct","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

**Proxy-applied transformations:**

The gateway silently applies these transformations before forwarding:

1. **Tool reduction** — if `tools` contains more than `max_budget` entries, the
   list is reduced using semantic scoring.
2. **Request trimming** — if the serialized body exceeds `max_body_bytes`, the
   conversation history is trimmed (preserving `keep_start` + `keep_end` messages).
3. **Policy transforms** — any matching `transform` rules are applied
   (e.g. `redact_pii`, `downgrade_model`).

The gateway applies these response fixups after receiving from the backend:

1. **Content sanitization** — strips leaked Kimi tool markup and thinking
   preamble (when `sanitizer.strip_thinking: true`).
2. **Empty content fallback** — injects a fallback message if the model returns
   empty content with no tool calls.
3. **Ghost tool-call fix** — corrects `finish_reason: "tool_calls"` when no
   tool calls are present in the response.
4. **Hallucinated tool removal** — removes tool calls whose names don't exist in
   the original tool list.

**Status codes:**

| Status | Meaning |
|--------|---------|
| `200` | Success |
| `400` | Malformed request (bad JSON, missing required fields) |
| `401` | Agent identity required (`identity.require_agent_id: true`) |
| `403` | Request blocked by policy (`deny` rule matched) |
| `429` | Rate limit exceeded |
| `502` | All backends failed |
| `503` | Gateway temporarily unavailable |

---

### GET /health

Lightweight liveness check. Returns `200 OK` when the gateway is running.
Does not check backend availability.

**Request**

```
GET http://localhost:18780/health
```

**Response**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime_s": 3600
}
```

---

### GET /status

Detailed gateway status including backend health snapshots and basic metrics.

**Request**

```
GET http://localhost:18780/status
```

**Response**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime_s": 3600,
  "backends": {
    "nvidia": {
      "state": "healthy",
      "error_rate": 0.02,
      "requests": 1420,
      "last_check": "2026-03-17T14:30:00.000Z"
    },
    "anthropic": {
      "state": "degraded",
      "error_rate": 0.12,
      "requests": 380,
      "last_check": "2026-03-17T14:31:00.000Z"
    },
    "ollama": {
      "state": "healthy",
      "error_rate": 0.0,
      "requests": 95,
      "last_check": "2026-03-17T14:31:30.000Z"
    }
  },
  "metrics": {
    "requests_5min": 42,
    "tokens_5min": 128000,
    "errors_5min": 1,
    "p50_latency_ms": 820,
    "p95_latency_ms": 2400,
    "p99_latency_ms": 4100
  }
}
```

---

## Dashboard API Endpoints

All dashboard endpoints are served on port `18781` (default). All responses
include `Content-Type: application/json` and CORS headers (`Access-Control-Allow-Origin: *`).

---

### GET /api/stats

Live in-memory metrics snapshot. Reflects the most recent 5-minute rolling window.

**Request**

```
GET http://localhost:18781/api/stats
```

**Query parameters:** none

**Response**

```json
{
  "timestamp": "2026-03-17T14:32:00.000Z",
  "window_ms": 300000,
  "requests": {
    "total": 42,
    "successful": 41,
    "failed": 1,
    "rate_limited": 0
  },
  "tokens": {
    "input": 95200,
    "output": 32800,
    "total": 128000
  },
  "costs": {
    "total_usd": 0.1872,
    "by_backend": {
      "anthropic": 0.1872,
      "nvidia": 0.0,
      "ollama": 0.0
    }
  },
  "latency": {
    "p50_ms": 820,
    "p95_ms": 2400,
    "p99_ms": 4100,
    "mean_ms": 1050
  },
  "backends": {
    "nvidia":    "healthy",
    "anthropic": "degraded",
    "ollama":    "healthy"
  },
  "active_agents": ["lumina", "jarvis", "artisan"],
  "policy_violations": 2,
  "siem_events": 156
}
```

---

### GET /api/health

Backend health snapshots including error rates and state transitions.

**Request**

```
GET http://localhost:18781/api/health
```

**Response**

```json
{
  "backends": {
    "nvidia": {
      "state": "healthy",
      "error_rate": 0.02,
      "requests_window": 1420,
      "errors_window": 28,
      "cooldown_remaining_ms": 0,
      "last_probe": "2026-03-17T14:30:00.000Z",
      "url": "https://integrate.api.nvidia.com/v1",
      "models": ["kimi-k2-instruct", "kimi-k2.5", "minimax-m2.1"]
    },
    "anthropic": {
      "state": "degraded",
      "error_rate": 0.12,
      "requests_window": 380,
      "errors_window": 46,
      "cooldown_remaining_ms": 0,
      "last_probe": "2026-03-17T14:31:00.000Z",
      "url": "https://api.anthropic.com/v1",
      "models": ["claude-opus-4-6", "claude-sonnet-4-6"]
    }
  }
}
```

**Backend state values:**

| State | Meaning |
|-------|---------|
| `healthy` | Error rate below 10%. All requests routed normally. |
| `degraded` | Error rate between 10–50%. Still receives requests but failover candidates are preferred. |
| `down` | Error rate above 50%. No requests routed. Cooldown period active. |

---

### GET /api/agents

Active agents and their recent session counts.

**Request**

```
GET http://localhost:18781/api/agents
```

**Response**

```json
{
  "agents": [
    {
      "agent_id": "lumina",
      "sessions_active": 2,
      "requests_5min": 28,
      "tokens_5min": 86400,
      "last_seen": "2026-03-17T14:31:58.000Z"
    },
    {
      "agent_id": "jarvis",
      "sessions_active": 1,
      "requests_5min": 8,
      "tokens_5min": 24000,
      "last_seen": "2026-03-17T14:31:40.000Z"
    },
    {
      "agent_id": "artisan",
      "sessions_active": 0,
      "requests_5min": 6,
      "tokens_5min": 17600,
      "last_seen": "2026-03-17T14:30:12.000Z"
    }
  ],
  "total_active": 3
}
```

---

### GET /api/tokens

Token usage from the SQLite metrics database, with optional filtering.

**Request**

```
GET http://localhost:18781/api/tokens?agent=lumina&period=1h
```

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `agent` | string | _(all agents)_ | Filter by agent ID. |
| `model` | string | _(all models)_ | Filter by model ID. |
| `backend` | string | _(all backends)_ | Filter by backend name. |
| `period` | string | `"24h"` | Time window. Supported: `1h`, `6h`, `24h`, `7d`, `30d`, or an integer seconds value. |

**Response**

```json
{
  "period": "1h",
  "from": "2026-03-17T13:32:00.000Z",
  "to":   "2026-03-17T14:32:00.000Z",
  "totals": {
    "input":       95200,
    "output":      32800,
    "cache_read":  12000,
    "cache_write":  3200,
    "total":      128000
  },
  "by_agent": {
    "lumina":  { "input": 62000, "output": 21000, "total": 83000 },
    "jarvis":  { "input": 20000, "output":  8000, "total": 28000 },
    "artisan": { "input": 13200, "output":  3800, "total": 17000 }
  },
  "by_model": {
    "kimi-k2-instruct":  { "input": 55000, "output": 20000, "total": 75000 },
    "claude-sonnet-4-6": { "input": 40200, "output": 12800, "total": 53000 }
  },
  "by_hour": [
    { "hour": "2026-03-17T13:00:00.000Z", "input": 38000, "output": 12000, "total": 50000 },
    { "hour": "2026-03-17T14:00:00.000Z", "input": 57200, "output": 20800, "total": 78000 }
  ]
}
```

---

### GET /api/costs

Cost breakdown from the SQLite metrics database.

**Request**

```
GET http://localhost:18781/api/costs?period=24h
```

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `agent` | string | _(all agents)_ | Filter by agent ID. |
| `model` | string | _(all models)_ | Filter by model ID. |
| `period` | string | `"24h"` | Time window: `1h`, `6h`, `24h`, `7d`, `30d`. |

**Response**

```json
{
  "period": "24h",
  "from": "2026-03-16T14:32:00.000Z",
  "to":   "2026-03-17T14:32:00.000Z",
  "total_usd": 4.2187,
  "by_agent": {
    "lumina":  2.8120,
    "artisan": 0.9043,
    "jarvis":  0.0,
    "scholar": 0.5024
  },
  "by_model": {
    "claude-opus-4-6":   3.1200,
    "claude-sonnet-4-6": 1.0987,
    "kimi-k2-instruct":  0.0,
    "minimax-m2.1":      0.0
  },
  "by_day": [
    { "date": "2026-03-16", "usd": 1.8920 },
    { "date": "2026-03-17", "usd": 2.3267 }
  ]
}
```

---

### GET /api/events

Recent SIEM events from the in-memory ring buffer (last 200 events max).

**Request**

```
GET http://localhost:18781/api/events?type=policy_violation&limit=20
```

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `type` | string | _(all types)_ | Filter by `event_type`. One of: `auth`, `request`, `response`, `error`, `policy_violation`, `anomaly`, `failover`, `tool_use`. |
| `severity` | string | _(all severities)_ | Filter by severity: `info`, `warning`, `error`, `critical`. |
| `agent` | string | _(all agents)_ | Filter by `agent_id`. |
| `limit` | integer | `50` | Maximum number of events to return (max 200). |

**Response**

```json
{
  "events": [
    {
      "event_id": "550e8400-e29b-41d4-a716-446655440000",
      "timestamp": "2026-03-17T14:31:55.000Z",
      "event_type": "policy_violation",
      "severity": "critical",
      "source": "skgateway",
      "agent_id": "unknown",
      "model": "claude-opus-4-6",
      "details": {
        "rule": "block-jailbreak-critical",
        "severity": "critical",
        "details": "jailbreak_score=9.2 >= 9 threshold",
        "action": "deny"
      }
    }
  ],
  "total": 1,
  "ring_size": 200
}
```

---

### GET /api/activity

Per-agent activity feed — recent requests, latency, and token usage for the
live dashboard activity table.

**Request**

```
GET http://localhost:18781/api/activity?limit=50
```

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `agent` | string | _(all agents)_ | Filter by agent ID. |
| `limit` | integer | `50` | Maximum number of activity entries to return. |

**Response**

```json
{
  "activity": [
    {
      "request_id":   "req-abc123",
      "timestamp":    "2026-03-17T14:31:58.000Z",
      "agent_id":     "lumina",
      "model":        "kimi-k2-instruct",
      "backend":      "nvidia",
      "prompt_class": "tool_use",
      "tokens_in":    2400,
      "tokens_out":   312,
      "latency_ms":   892,
      "status":       200,
      "cost_usd":     0.0
    },
    {
      "request_id":   "req-def456",
      "timestamp":    "2026-03-17T14:31:40.000Z",
      "agent_id":     "lumina",
      "model":        "claude-sonnet-4-6",
      "backend":      "anthropic",
      "prompt_class": "code_generation",
      "tokens_in":    4200,
      "tokens_out":   1100,
      "latency_ms":   2140,
      "status":       200,
      "cost_usd":     0.0291
    }
  ],
  "total": 2
}
```

---

## WebSocket Protocol

The dashboard server exposes a WebSocket endpoint for real-time push.

**URL:** `ws://localhost:18781/ws`

**Upgrade request:**

```http
GET /ws HTTP/1.1
Host: localhost:18781
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
Sec-WebSocket-Version: 13
```

**Server messages:**

The server sends JSON-framed text messages. Three message types are pushed:

### `stats` — periodic metrics push

Sent every `dashboard.refresh_ms` milliseconds (default 5000ms).

```json
{
  "type": "stats",
  "data": {
    "timestamp": "2026-03-17T14:32:00.000Z",
    "requests": { "total": 42, "successful": 41, "failed": 1, "rate_limited": 0 },
    "tokens": { "input": 95200, "output": 32800, "total": 128000 },
    "costs": { "total_usd": 0.1872 },
    "latency": { "p50_ms": 820, "p95_ms": 2400, "p99_ms": 4100 },
    "backends": { "nvidia": "healthy", "anthropic": "degraded", "ollama": "healthy" },
    "active_agents": ["lumina", "jarvis"],
    "policy_violations": 2
  }
}
```

### `event` — immediate SIEM event push

Sent immediately when a new SIEM event is emitted. Useful for real-time alert
display in the dashboard.

```json
{
  "type": "event",
  "data": {
    "event_id": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2026-03-17T14:32:05.000Z",
    "event_type": "policy_violation",
    "severity": "critical",
    "agent_id": "unknown",
    "details": {
      "rule": "block-jailbreak-critical",
      "action": "deny"
    }
  }
}
```

### `health` — backend health update

Sent whenever a backend health state changes (healthy → degraded → down →
degraded → healthy).

```json
{
  "type": "health",
  "data": {
    "backend": "anthropic",
    "state": "healthy",
    "error_rate": 0.04,
    "previous_state": "degraded"
  }
}
```

**Client messages:**

The server accepts one client message type:

```json
{ "type": "ping" }
```

The server responds with:

```json
{ "type": "pong", "timestamp": "2026-03-17T14:32:10.000Z" }
```

**WebSocket JavaScript client example:**

```js
const ws = new WebSocket('ws://localhost:18781/ws');

ws.addEventListener('open', () => {
  console.log('Connected to SKGateway dashboard');
});

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'stats':
      updateDashboard(msg.data);
      break;
    case 'event':
      appendToEventFeed(msg.data);
      break;
    case 'health':
      updateBackendStatus(msg.data);
      break;
  }
});

ws.addEventListener('close', () => {
  console.log('Disconnected — reconnecting in 5s...');
  setTimeout(() => connectDashboard(), 5000);
});
```

---

## Error Responses

All error responses from the proxy use the OpenAI error format for compatibility
with clients that parse it:

```json
{
  "error": {
    "message": "Request blocked by policy: jailbreak attempt detected",
    "type": "policy_violation",
    "code": "policy_deny"
  }
}
```

**Error types:**

| `type` | When used |
|--------|-----------|
| `policy_violation` | `deny` rule matched |
| `rate_limit_exceeded` | Rate limit rule triggered or per-agent/model limit hit |
| `identity_required` | `require_agent_id: true` and no identity found |
| `upstream_error` | All backends failed after retry exhaustion |
| `invalid_request` | Malformed JSON body or missing required fields |

Dashboard API errors use a simpler format:

```json
{
  "error": "period must be one of: 1h, 6h, 24h, 7d, 30d",
  "status": 400
}
```

---

## Headers Reference

**Request headers sent by clients:**

| Header | Example | Description |
|--------|---------|-------------|
| `Content-Type` | `application/json` | Required for POST requests. |
| `Authorization` | `Bearer nvapi-xxx` | API key forwarded to the upstream backend. |
| `X-Agent-Id` | `lumina` | Agent identifier for metrics and policy. |
| `X-Session-Id` | `sess-abc123` | Session UUID for conversation-level tracking. |
| `X-CapAuth-Signature` | _(PGP signature)_ | PGP signature for cryptographic identity verification. |
| `X-CapAuth-Timestamp` | `1742219531` | Unix timestamp for CapAuth signature validation (±300s window). |

**Response headers added by the gateway:**

| Header | Example | Description |
|--------|---------|-------------|
| `X-Gateway-Request-Id` | `req-abc123` | Per-request UUID for log correlation. |
| `X-Gateway-Backend` | `nvidia` | Backend that served this request. |
| `X-Gateway-Model` | `kimi-k2-instruct` | Model actually used (may differ if `downgrade_model` transform was applied). |
| `X-Gateway-Latency-Ms` | `892` | Total gateway processing time in milliseconds. |
