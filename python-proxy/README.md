# Immutable SKGateway Python proxy

This directory packages the sovereign fleet's Python proxy separately from the Node SKGateway runtime.

## Provenance and stop condition

The source began as a byte-for-byte capture of `<home>/.local/share/skgateway/skgateway.py` observed on a fleet node. Before being published to this public repository, the captured file's infrastructure-identifying literals (the observed upstream hostname and the observed home-directory path) were replaced with generic, env-driven defaults; see `SKGATEWAY_UPSTREAM` and `SKGATEWAY_ADVERTISE_STATE` below. The SHA-256 of the committed, redacted file is `c72ecdfba0f7c78863878a5f86b087f077758942fe506b68512add037f8dffea`, pinned by `tests/test_proxy.py::test_redacted_source_hash`. The copied file had no Git metadata. A scan of all objects reachable from the canonical GitHub repository found no matching blob. Therefore this candidate deliberately makes no claim that the copy equals repository HEAD or descends from any repository revision. The reviewed candidate begins with the captured (and redacted) bytes as a new, explicit Git history entry.

Observed read-only runtime state:

- launcher: user unit `skgateway.service`
- endpoint: `127.0.0.1:18780`
- application: `uvicorn skgateway:app`
- upstream default and observed health routing: configured via `SKGATEWAY_UPSTREAM` (example: `http://<upstream-host>:11439/v1`; the committed default is `http://127.0.0.1:11439/v1`)
- upstream model default and observed health model: `qwen3.8-27b-huihui-abliterated-q4_k_m`
- health paths: `/health` and `/v1/health`
- configuration reference: `%h/.config/skgateway/skgateway.env`
- configuration keys: `SKGATEWAY_UPSTREAM`, `SKGATEWAY_UPSTREAM_MODEL`, `SKGATEWAY_ALIASES`, `SKGATEWAY_TIMEOUT_SECONDS`, and `SKGATEWAY_ADVERTISE_STATE`
- credential references: none in the observed unit, environment key names, or source
- captured dependencies: `requirements.lock`

No environment values are committed. The configuration schema records names and types only. A deployment sets `SKGATEWAY_UPSTREAM` and `SKGATEWAY_ADVERTISE_STATE` to the real fleet host and home path via the (uncommitted) environment file at `%h/.config/skgateway/skgateway.env`; the defaults in source are placeholders only.

## Build

Run `python python-proxy/tools/build.py --output OUT`. The build uses canonical JSON, sorted inputs, fixed ownership, permissions, and timestamps. The manifest digest is the content ID in the tar filename. Repeating the build from clean checkouts must produce identical tar and receipt bytes.

The bundle includes the complete source, dependency lock, launcher, configuration schema, provenance, health probe, and rollback declaration. It does not create a virtual environment and does not mutate a service.

## Rollback

Deployment is outside this card. A later authorized deployment must install the bundle and its dedicated wheel-built environment under its content ID, verify all hashes, atomically move a `current` symlink, retain the prior symlink target, qualify `GET /health` on port 18780, and restore the prior target on any startup or health failure. The current copied source, unit, environment file, process, and symlinks are not changed by this candidate.
