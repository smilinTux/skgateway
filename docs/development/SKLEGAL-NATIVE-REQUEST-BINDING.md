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
