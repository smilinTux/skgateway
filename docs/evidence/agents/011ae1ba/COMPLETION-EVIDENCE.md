# Request history transport repair

Card: 011ae1ba. Parent: 9b230773.
Owner: codex-gateway-history-011ae1ba.
Source base: aaaa8851a43250c3500bad1e2d968a660cd00c31.
The external candidate descriptor binds the final commit, tree and file hashes.

## Defect and source evidence

Production trial 89508f83 requested sk-deepseek-m and served deepseek-flash.
The parent stopped it after 1,785,980 reported cumulative tokens without source
changes. This is a parent-observed trial result, not a new provider experiment.

A read-only journal query for skgateway-codex.service on chiap01 between
2026-10-01 08:33:30 and 08:39:10 UTC found 343 truncation/history-drop lines.
The first shortened 13 tool results to 1500 characters at 125630 input bytes.
The final request shortened 148 results and dropped 391 middle messages from
1140082 bytes to about 19111 bytes. Journal bytes SHA256:
66439fd3161280710ac471b33eb82d938f9a2757f8275a8f77525c94018dbd7b.

Live configuration separately confirms deepseek-flash has max_body_bytes
2000000 and max_system_bytes 800000, while the generic body default is 120000.
The old entrypoint applied the generic default before bucket resolution.
Client authentication is disabled in this existing deployment; this change
does not alter its configuration or credential boundary.

## Changes

- src/index.mjs bounds ingress and removes destructive request trimming.
- src/proxy/router.mjs checks the actual candidate's transport policy before
  provider admission. Explicit alias/bucket restrictions remain restrictive.
  Already-qualified alternative candidates may serve unchanged history;
  local size rejection does not penalize provider health.
- src/proxy/core.mjs applies explicit ingress/body/system rejection on its
  compatibility path and removes active byte-budget history trimming. Its
  upstream400 tool retries retain the complete conversation through all four
  attempts rather than deleting tool results and rewriting prior calls.
- src/proxy/request-limits.mjs shares positive safe-integer byte validation,
  UTF-8 system/developer totals and structured nonretryable 413 responses.
- HTTP, bucket, compatibility and authentication regression tests cover the
  changed boundaries. Historical static wiring assertions now prohibit trim
  calls in the active entrypoint. CHANGELOG.md records the resulting behavior.

## Validation

The unchanged base in an isolated archive failed all four initial actual HTTP
regressions, including byte-exact tool history and explicit oversized rejection.
BEFORE-QUALIFIED-HTTP.log retains this proof. Earlier fixture failures remain
retained and are not claimed as defect evidence.

Final command, from the isolated worktree:

```sh
node --test --import ./tests/_setup.mjs tests/request-history-contract.test.mjs tests/live-pipeline-wiring.test.mjs tests/model-alias-parity.test.mjs tests/qwen-context-preflight.test.mjs tests/client-auth-integration.test.mjs tests/client-auth.test.mjs tests/attribution-headers.test.mjs tests/bucket-routing-integration.test.mjs tests/bucket-tool-use-filter.test.mjs tests/tool-result-continuity.test.mjs tests/nonstream-response-contract.test.mjs tests/sse-tool-call-contract.test.mjs tests/upstream-url.test.mjs tests/stream-anthropic.test.mjs
```

Result: 167 tests passed, zero failed, zero skipped, exit 0, 20.128 seconds.
Log: ~/.skcapstone/evidence/work/011ae1ba/FINAL-BOUNDARY-TESTS-3.log.
All provider traffic in these tests uses local synthetic HTTP servers. The
auth test specifically checks chunked overflow still emits client_auth.denied
with request_too_large, with no upstream call or credential disclosure.

## Limits and rollout

This source candidate does not claim production installation or trial success.
Existing context preflight, upstream error failover and compatibility tool
instructions remain. Tool retries may reduce the available tool definitions
or force a tool choice, but never delete or rewrite prior conversation history.
The added four-attempt real HTTP regression failed on the initially reviewed
candidate320cde and passes after the narrow retry correction. The original
actual Zai PASS remains prior coverage, not approval of the later correction.
Deprecated standalone trimming utilities remain for existing callers/tests.

No model context sizes are invented, no provider or worker quota changes are
made, and explicit caller budgets remain intact. The 2MB DeepSeek transport
allowance is existing configuration, not a new unlimited context promise.
Oversized requests now fail explicitly rather than silently lose state.

Root owns independent-review acceptance and reversible deployment of the four
runtime files. Back up exact existing bytes/modes; the new request-limits.mjs
must be removed on rollback if absent before installation. Restore preimages
and managed service state on failure. Configuration and credentials stay
unchanged. Root then verifies health/catalog plus affected backend probes and
one bounded public synthetic long-history trial-alias probe. Keep the original
failed worker/session/claim untouched. Native source links and the external
descriptor carry current review and installation receipts when available.
