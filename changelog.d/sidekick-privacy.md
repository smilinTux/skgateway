### Added

- `privacy.content_logs` (boolean, default `true`). With `false`, no request or response text reaches a log line, SIEM event, `metrics.db` row or cache: the sites that quoted upstream error bodies, model reasoning, empty-response choices, model tool names or JSON parse errors (which quote their input) log lengths and error classes instead, and the semantic cache shadow stays off. `true` logs exactly as before. docs/CONFIGURATION.md, "privacy".

### Changed

- With `client_auth` on, the verified client id is the metering key for the client guard (caps, rate limits, `/admin/clients/usage`), audit events and `request_log.client`; the caller's `x-app` header is ignored. Without `client_auth` nothing changes.
