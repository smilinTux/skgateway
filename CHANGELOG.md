# Changelog

All notable changes to SKGateway are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Metrics collector double config dereference (card `7e739811`). `index.mjs`
  initialises the collector with `createMetricsCollector(config.metrics || {})`
  (the already-extracted metrics slice), but the factory dereferenced
  `config.metrics` a second time, so the internal `cfg` was `undefined` and
  `cfg.enabled` threw a `TypeError`. The error was swallowed as "optional", so
  metrics silently never recorded and `/status` reported `metrics: null`. The
  factory now normalises with `const cfg = config?.metrics ?? config ?? {}`,
  accepting both call shapes (the extracted slice `config.metrics` and the full
  gateway config), so a caller that dereferences one level too many or too few
  can no longer silently disable metrics. Added `tests/metrics-collector.test.mjs`
  exercising the exact production call shapes so this class of wiring bug cannot
  recur silently.

## [0.1.0] - 2026-07-08

### Added

- Initial SKGateway release: transparent auditing AI inference proxy on
  `:18780` (OpenAI-compatible) with a real-time SOC dashboard on `:18781`.
- Multi-backend routing across Anthropic, NVIDIA NIM, Ollama, OpenAI-compatible,
  and custom vLLM backends, selected by model name and priority with retry and
  circuit-breaker fallback.
- Identity plane: CapAuth PGP identity verification, agent registry, session
  tracking, and per-agent reputation scoring.
- Classifier plane: prompt intent classification, 0-10 risk scoring, jailbreak
  detection, prompt-injection detection, and DLP/PII scanning.
- Policy engine: YAML-driven, hot-reloadable rules with allow / deny / transform
  / rate_limit / alert actions and per-agent and per-model rate limits.
- Semantic tool reduction that trims a large tool set to a scored budget while
  always preserving a guaranteed set.
- Metrics plane: token, cost, and P50/P95/P99 latency tracking persisted in
  SQLite (`better-sqlite3`), with configurable retention.
- SIEM event bus emitting structured events (ArcSight CEF, JSONL, syslog RFC
  5424) across the request lifecycle.
- File-based integration with the SKCapstone stack (PubSub alert bus + job tree)
  with a standalone fallback when `~/.skcapstone/` is absent.
- Hot-reload of `config/skgateway.yaml` and `config/policies.yaml` on `SIGHUP`.

[Unreleased]: https://github.com/smilinTux/skgateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/smilinTux/skgateway/releases/tag/v0.1.0
