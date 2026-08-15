# Changelog

All notable changes to SKGateway are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Documentation

- **SOP: the `0.0.0.0` bind is now stated as a DEVIATION, not as compliance.** §2's
  exposure subsection previously read "Bind: `server.bind` (127.0.0.1 or tailnet); never
  expose a raw public port", which restated `UNIFIED_INGRESS_STANDARD` as though it were
  met. It is not: `src/config.mjs:81` defaults to `0.0.0.0` (all interfaces, broader than
  the tailnet) and both fleet nodes are live on `0.0.0.0:18780` / `0.0.0.0:18781`. The
  blast radius is now scoped accurately as LAN + tailnet, with the reasoning: no public
  interface on either node, and Tailscale Funnel publishes only `:443` / `:8443` /
  `:10000`, none of which reach the gateway.
- **SOP: documented the Anthropic-compatible `POST /v1/messages` front end**
  (`src/index.mjs:1347`), matched by **pathname** so Claude Code's `?beta=true` still
  hits it, and the default logical role `sk-default`.
- **SOP §4: added an explicit "CI cannot fail" gap.** There is no `ci.yml`. The only test
  invocation is `npm test 2>/dev/null || true` inside a tags-only `publish.yml`, with
  `continue-on-error: true` on the job and `if: always()` on the publisher. A green check
  here certifies that a tag was pushed and nothing else. Owned by card `62a5256d`.
- **SOP §5/§6: documented the EFFECTIVE `ExecStart`.** The `config-path.conf` drop-in
  clears `ExecStart=` and re-declares it without `--config`, so the service loads the
  Syncthing-synced `~/.skcapstone/gateway/skgateway.yaml`, not the in-repo config. Also
  recorded that `ExecStart` runs source directly out of the shared working checkout
  `~/clawd/skcapstone-repos/skgateway`, so an uncommitted edit there is live behaviour.
- **SOP §9: stopped quoting a stale version.** `package.json` and the hardcoded
  `src/index.mjs:962` `/status` string both still say `0.1.0` while the newest release tag
  is far past it, and `publish-npm` overwrites `package.json` from the tag anyway. The SOP
  now says where the version comes from and warns that `/status` is not a version oracle.
- **SOP §7: completed the route table** (`/v1/messages`, `/v1/models/<id>`, `/healthz`,
  `/.well-known/skworld-module.json`, `/admin/models*`).
- **README: flagged the same `0.0.0.0` deviation** at the config sample, plus the config
  precedence order.

### Added

- `docs-evidence` block at the end of `SOP.md`: 8 hermetic, repo-local checks pinning the
  documented ports and `0.0.0.0` bind default, the pathname match for `/v1/messages`, the
  MIT licence (this repo is private and is NOT relicensed to GPL), the documented CI gap,
  the health/self-description routes, the config precedence chain, `sk-default`, and the
  stale `/status` version. Every check was negative-tested.
- `.github/workflows/docs-check.yml` running tiers 1 and 2 on push and pull_request.

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
