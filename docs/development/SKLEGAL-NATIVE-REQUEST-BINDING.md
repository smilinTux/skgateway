# Native SKLegal request binding

Card e06ba1ca, source baseline 3ba6a99dad1a9d65313811a1f3a0ad853adca074.
This bounded repair follows the authorized full native pilot implementation.

The fixed qualification route remains supported. Opt-in routes set
`request_capability: true` and configure subject, `model_route` (the signed grant
enum, for example `local_qwen`), tenant_id, matter_id, logical route_id
and all four context fields. Only material_id and material_version come from
the request-local capability. Purpose and subject must match the configured
tuple. Several distinct tuples may share one method/path.
The explicit mapping preserves the distinction between the signed model-route
enum and the deployment's logical route ID. Ambiguous mappings are rejected.

Parsing a capability does not verify it or grant access. These are untrusted
lookup selectors only. The unchanged original Bearer value goes to the strict
PDP, which must validate signature, canonical request binding, current policy,
source rights, replay and audit before permitting inference. Unknown, malformed
or ambiguous selectors remain governed denials, including loopback requests.
No prompt, custom header, allow cache or additional credential is introduced.

Implementation and checks:

- Extend the existing resolver and pass request Authorization from index.mjs.
- Exercise changing materials, scope mismatches, malformed envelopes, distinct
  same-path scopes, denial propagation and fixed-route compatibility.
- Run focused authorization and server integration tests; preserve exact source
  evidence for independent review. No running configuration changes here.

Rollback removes the opt-in routes and restores the prior reviewed source.
This source change alone does not qualify the deployed full pilot.

## Source validation, 2026-10-02

Node v22.23.2, dependencies installed from the unchanged lockfile with `npm ci`.
The following command passed 78 tests, with zero failures, cancellations or
skips in 15.54 seconds:

```sh
node --test --import ./tests/_setup.mjs tests/sklegal-native-selector.test.mjs tests/sklegal-authz-wire.test.mjs tests/authz-gate.test.mjs tests/sklegal-service-credential-file.test.mjs tests/authz-enforce-integration.test.mjs
```

The integration checks launch the real gateway on loopback with synthetic PDP
responses and no inference backend. They prove selector forwarding, unchanged
credentials, denial propagation and fixed-route compatibility. They do not
prove native signature verification, durable current-state policy, live model
execution or browser acceptance. Those require the completed SKLegal request
registry and scoped deployment qualification. No live configuration changed.

Native credentials contain printable spaces in the JSON-escaped armored PGP
signature. The strict transport now preserves those spaces while rejecting
control characters and enforcing the existing 8192-character limit.

## Authorization dependency status repair, 2026-10-02

The strict client now labels dependency failures with the internal
`failure_kind: dependency_unavailable`. The native gate carries this bounded
classification to the HTTP boundary, which returns 503. Transport failures,
timeouts including stalled response bodies, non-denial HTTP errors, malformed
200 responses, and unavailable service credentials remain fail-closed. Upstream
401/403 responses remain sanitized 403 denials without reading their bodies;
valid 200 policy and capability denials also remain 403. Status selection never
matches reason text. The upstream response schema, original Bearer, selectors,
generic authorization lane, and allow behavior remain unchanged.

The new mapping test first failed on the original source because the failure
classification was absent. After the repair, Node v22.23.2 passed all 106 tests
in 15.61 seconds, with zero failures, cancellations, or skips:

```sh
node --test --test-reporter=spec --import ./tests/_setup.mjs tests/sklegal-native-selector.test.mjs tests/sklegal-authz-wire.test.mjs tests/authz-gate.test.mjs tests/sklegal-service-credential-file.test.mjs tests/authz-enforce-integration.test.mjs tests/authz-decide.test.mjs
```

Real gateway subprocess tests use loopback synthetic PDP and backend servers.
The reachable counting backend receives no dispatch for 503/500, transport
outage, header timeout, stalled-body timeout, invalid JSON, invalid schema,
expanded response, policy denial, 401, or 403 scenarios. Response and current
process-log checks reject synthetic credentials, upstream private bodies, and
prompt content. Credential rotation, original header forwarding, selector
binding, and generic flag-off tests still pass. `git diff --check` passes.

No data migration, deployed configuration, service, credential, fleet route,
or real model call changed. The prior reviewed source remains commit
`ee6bd36063dfd1f7c4be1feaf03b12cfde7dd776`; rollback restores that candidate.
This local source candidate still requires independent review and isolated
installation qualification. It does not prove the entire deployed pilot.

## Opt-in model-only admission, 2026-10-02

The amended card authorizes this nested policy on each isolated pilot route:

```yaml
request_policy:
  model_only: true
  max_requests: 8
  window_ms: 60000
```

Only an explicitly configured POST `/v1/chat/completions` route can opt in.
The strict PDP must allow before index attaches the trusted admission hook.
The live entrypoint checks the buffered request before normalization and native
router dispatch. Tools, tool choice, parallel tool calls, legacy functions,
and tool-protocol messages return sanitized 403 without spending admission
budget. Invalid JSON or message shape also denies. No history is rewritten by
this policy, and generic or flag-off routes retain their existing behavior.

One counter belongs to each configured subject, Tenant, Matter, logical route,
and purpose tuple. Changing material, capability bytes, model selector aliases,
or caller identity headers does not mint a new counter. Duplicate configured
tuples share state and must agree on policy. A monotonic fixed window starts on
first admission; the ninth request returns sanitized 429 with Retry-After and
no dispatch. Elapsed windows replenish the budget. Counters intentionally reset
on process restart. This policy qualifies one isolated process only, not a
shared, persistent or fleet budget. Existing shared Qwen capacity is unchanged.

Startup accepts integer max_requests from 1 through 1000 and window_ms from 1
through 3600000, requires model_only true, and rejects unknown policy fields.
The pilot uses exactly 8 and 60000. Lower fixture windows support deterministic
recovery tests without waiting one minute. The exact 60000 boundary is tested
with an injected monotonic clock as well as the live eight-request limit.

On Node v22.23.2, the prior focused command plus
`tests/sklegal-request-admission.test.mjs` passes 113 tests, zero failures,
cancellations or skips, in 17.60 seconds. The following boundary suite passes
20 tests with zero failures, cancellations or skips in 0.18 seconds:

```sh
node --test --test-reporter=spec --import ./tests/_setup.mjs tests/qwen-capacity-domain.test.mjs tests/connection-pool-admission.test.mjs tests/client-credential-passthrough.test.mjs
```

Live subprocess checks cover all tool forms, unchanged original Bearer,
credential/prompt hygiene, no dispatch on denial, exact admission count,
concurrency, tuple isolation, timed recovery, restart reset, policy 403,
dependency 503, and flag-off compatibility. No deployed configuration changed.
Rollback restores reviewed outage candidate
`be3a4460ecea295231bbc13b633863ac59d0da77` and omits request_policy; the tool
and rate live gates must remain unqualified until root completes installation
qualification. No data migration is required.
