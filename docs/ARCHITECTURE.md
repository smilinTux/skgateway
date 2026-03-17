# SKGateway — Enterprise AI Inference Proxy

## Vision

A "BlueCoat for AI" — a dedicated security proxy for all AI inference traffic.
Sits between any client (OpenClaw, agents, apps, users) and any LLM backend
(Anthropic, OpenAI, NVIDIA NIM, Ollama, vLLM clusters). Provides enterprise
SOC/SIEM functions: identity verification, prompt monitoring, token cost
tracking, policy enforcement, DLP, and real-time dashboarding.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        SKGateway                                │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐  │
│  │ Identity  │  │  Policy   │  │ Metrics  │  │   Dashboard   │  │
│  │ (CapAuth) │  │  Engine   │  │ Collector│  │   (Web UI)    │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬───────┘  │
│       │              │             │                 │           │
│  ┌────┴──────────────┴─────────────┴─────────────────┴───────┐  │
│  │                    Core Proxy Layer                        │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────────┐  │  │
│  │  │   Router     │  │  Sanitizer  │  │  Stream Handler  │  │  │
│  │  │  (backends)  │  │  (DLP/PII)  │  │  (SSE/JSON)      │  │  │
│  │  └──────┬──────┘  └──────┬──────┘  └────────┬─────────┘  │  │
│  └─────────┼────────────────┼──────────────────┼─────────────┘  │
│            │                │                  │                 │
│  ┌─────────┴────────────────┴──────────────────┴─────────────┐  │
│  │                    SIEM Event Bus                          │  │
│  │  → Structured logs (JSON/CEF) → Syslog/Elastic/Splunk     │  │
│  │  → Prompt classification events                           │  │
│  │  → Token usage events                                     │  │
│  │  → Security alerts (DLP violations, anomalies)            │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
        │                    │                    │
   ┌────┴────┐         ┌────┴────┐         ┌────┴────┐
   │Anthropic│         │  NVIDIA │         │  Ollama  │
   │  API    │         │  NIM    │         │  Local   │
   └─────────┘         └─────────┘         └─────────┘
```

## Components

### 1. Core Proxy (`src/proxy/`)
- **router.mjs** — Backend selection (Anthropic, OpenAI, NVIDIA, Ollama, custom)
- **stream.mjs** — SSE/JSON response handling, chunked transfer
- **sanitizer.mjs** — Content sanitization, DLP, PII detection
- **retry.mjs** — Multi-layer retry with fallback (existing skgateway logic)
- **tools.mjs** — Tool reduction, semantic routing (existing nvidia-proxy logic)

### 2. Identity (`src/identity/`)
- **capauth.mjs** — CapAuth integration for agent/user identity
- **session.mjs** — Session tracking, agent fingerprinting
- **reputation.mjs** — Real-time reputation scoring for AI agents

### 3. Policy Engine (`src/policy/`)
- **engine.mjs** — Rule evaluation (allow/deny/transform)
- **rules.mjs** — Policy definitions (YAML-driven)
- **dlp.mjs** — Data Loss Prevention (block PII, secrets, sensitive data outbound)
- **ratelimit.mjs** — Per-agent, per-model, per-tenant rate limiting

### 4. Metrics (`src/metrics/`)
- **collector.mjs** — Real-time metrics aggregation
- **tokens.mjs** — Token usage tracking (input/output/cache, per-agent, per-model)
- **cost.mjs** — Cost accounting (per-model pricing, budget alerts)
- **latency.mjs** — Request latency tracking, P50/P95/P99

### 5. Prompt Classifiers (`src/classifiers/`)
- **classifier.mjs** — Prompt intent classification (code gen, data query, creative, admin)
- **sentiment.mjs** — Sentiment/tone analysis
- **risk.mjs** — Risk scoring (sensitive data, jailbreak attempts, prompt injection)

### 6. SIEM (`src/siem/`)
- **events.mjs** — Structured event generation (CEF/JSON)
- **syslog.mjs** — Syslog output (RFC 5424)
- **elastic.mjs** — Elasticsearch/OpenSearch output
- **file.mjs** — File-based audit log (JSON lines)

### 7. Dashboard (`src/dashboard/`)
- **server.mjs** — FastAPI/Express dashboard server
- **static/** — Web UI (OLED black, glass effects, matching SK design system)
  - Real-time token usage graphs
  - Per-agent activity feed
  - Cost tracking & budget alerts
  - Prompt classification breakdown
  - Security events & alerts
  - Backend health status
  - ITIL incident integration

## Configuration

```yaml
# config/skgateway.yaml
server:
  port: 18780
  dashboard_port: 18781
  bind: 0.0.0.0

backends:
  anthropic:
    url: https://api.anthropic.com/v1
    auth: oauth  # or api_key
    models: [claude-opus-4-6, claude-sonnet-4-6]
    priority: 1
  nvidia:
    url: https://integrate.api.nvidia.com/v1
    auth: api_key
    models: [kimi-k2-instruct, kimi-k2.5]
    priority: 2
  ollama:
    url: http://192.168.0.100:11434/v1
    auth: none
    models: [dolphin-*]
    priority: 3

identity:
  capauth: true
  require_agent_id: true
  allow_anonymous: false

policy:
  dlp:
    block_pii: true
    block_secrets: true
    block_patterns:
      - "(?i)(password|api.key|secret)\\s*[:=]\\s*\\S+"
  rate_limits:
    default: 100/min
    per_agent:
      lumina: 200/min
      sentinel: 50/min  # read-only agent

metrics:
  token_tracking: true
  cost_tracking: true
  latency_percentiles: [50, 95, 99]
  retention_days: 90

siem:
  enabled: true
  outputs:
    - type: file
      path: /var/log/skgateway/audit.jsonl
    - type: syslog
      host: localhost
      port: 514
    - type: elastic
      url: http://localhost:9200
      index: skgateway-events

dashboard:
  enabled: true
  refresh_interval: 5s
  auth: capauth
```

## Data Flow

1. **Request arrives** → Identity check (CapAuth) → Policy evaluation
2. **Pre-processing** → Prompt classification → DLP scan → Tool reduction
3. **Routing** → Backend selection → Retry/fallback logic
4. **Response** → Content sanitization → Token counting → Cost calculation
5. **Post-processing** → SIEM event emission → Metrics update → Dashboard push
6. **Audit** → Full request/response logged (configurable retention)

## Integration Points

- **CapAuth** — PGP-based identity for every request
- **SKSecurity** — Threat detection, behavioral baselines
- **ITIL (Deming)** — Auto-create incidents on anomalies
- **skmemory** — Agent context enrichment
- **OpenClaw** — Primary client (replace nvidia provider baseUrl)
- **Syncthing** — Config/policy sync across nodes

## Existing Code to Absorb

- `skcapstone/scripts/nvidia-proxy.mjs` (878 lines) — tool reduction, retry, SSE
- `skcapstone/scripts/skgateway.mjs` (856 lines) — semantic routing, content sanitization
- `skforge/blueprints/api-gateways/` — routing, auth, rate limiting patterns
- `skforge/blueprints/agent-security/` — 5-layer security architecture
- `skcapstone/src/skcapstone/metrics.py` — metrics patterns
- `security/reports/audit-siem.json` — SIEM report structure
