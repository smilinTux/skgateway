# Security Policy

SKGateway is an inference security plane: it sits inline on every AI request, so its
own security posture matters as much as the controls it enforces. This document states
the threat model, reporting channel, secret handling, and dependency posture.

## Reporting a vulnerability

Report privately. Do NOT open a public issue for a security bug.

- Preferred: a PGP-encrypted report to the SKWorld security contact via CapAuth
  identity (the same identity plane SKGateway verifies against).
- Alternate: contact the smilinTux / SKWorld maintainers directly through the
  SKCapstone coordination channel.

Include: affected version (`GET /status` reports it), a reproduction, and the impact
you observed. We aim to acknowledge within a few days and will coordinate a fix and
disclosure timeline with you.

## Threat model (summary)

SKGateway's job is to be the chokepoint an operator owns. The primary assets are:
the prompts and completions passing through, the backend API credentials, the audit
trail, and the policy configuration.

| Threat | Control in SKGateway |
|---|---|
| Unattributed / spoofed agents | CapAuth PGP identity verification stamps every request with a verified `agent_id`; policies and metrics key off it. |
| Prompt injection / jailbreak | Classifier plane scores intent, risk (0-10), jailbreak (pattern families), and injection signatures; policy engine hard-blocks above threshold. |
| Data exfiltration / secret leakage outbound | DLP/PII scanning + outbound secret detection (`password=`, `api_key=`, `secret=` patterns) with configurable redaction transforms. |
| Cost / abuse | Per-agent and per-model rate limits, token quotas, and budget-based auto-downgrade. |
| Silent loss of auditability | Metrics (SQLite) + SIEM event bus (CEF / JSONL / syslog) on every request lifecycle stage; `/status` self-reports whether metrics are live. |
| Credential disclosure at rest | API keys are referenced by env-var name, never inlined in config; `.env` is gitignored. |

Explicitly out of scope for SKGateway itself: it is not the identity authority
(CapAuth is), not a key store, and does not terminate public TLS (the SKWorld ingress
tier does). Transport to cloud backends relies on the backend's HTTPS endpoint; local
backends are LAN-only.

## Secret handling

- Never commit a live secret. Backend API keys are supplied through environment
  variables referenced by NAME in config (`api_key_env: NVIDIA_API_KEY`), and read
  from the environment at request time.
- Provide those env vars to the systemd service via an `EnvironmentFile=` drop-in
  (mode `600`, outside the repo) or the vault, not a tracked file.
- Anthropic credentials are read from `credentials_path` on disk, never copied into
  config or logs.
- `.env`, `data/`, `logs/`, and `*.db` are gitignored so metrics databases, audit
  logs, and local secrets cannot be committed by accident.
- If a key is ever exposed, rotate it at the provider and update the environment; no
  key material lives in the repo to scrub.

## Dependency posture

- Runtime dependencies are intentionally minimal: `better-sqlite3` (metrics) and
  `js-yaml` (config/policy parsing). Fewer dependencies is a smaller attack surface.
- Dependencies are pinned via `package-lock.json`; review lockfile changes on every
  bump.
- Node.js 20+ is required (`engines` in `package.json`); run a supported LTS with
  current security patches.

## Supported versions

The latest tagged release on `main` receives security fixes. See `CHANGELOG.md` for
the current version and history.
