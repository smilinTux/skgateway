# Explicit gateway generation policy

Card: `f54adfd1`. Producer: `codex-gateway-default-f54adfd1`.
Base: `9807aba39b3962e2d5dc24b710e3d9b4d77b0783`.

The public model list now projects an explicit operator generation default after
concrete entries and aliases have been combined. The existing model-card YAML
sets `generation_default_tokens: 8192` for `deepseek-flash`, `sk-zai-m`,
`gpt-5.6-sol`, and `qwen3.8-27b-huihui-abliterated-q4_k_m`.
The value is an operator default, not a physical maximum or an authorization.

Only positive JavaScript safe integers are advertised. Missing or malformed
configured values leave the field absent, including when a provider or cached
card carried a prior value. This lets Fiber consumer card `6e47a2bd` fail closed.
The same projection runs on the normal and fallback `/v1/models` paths after
alias construction. No routing, deduplication, filtering or endpoint is added.

Changed files:
- `config/model-cards.overrides.yaml`: four explicit policy values.
- `src/index.mjs`: field-only validation and final catalog projection.
- `tests/card-overrides.test.mjs`: exact defaults and physical-limit preservation.
- `tests/admin-models-cards.test.mjs`: malformed/missing policy, nonmutation,
  metadata preservation, and real HTTP normal/fallback catalogs with exactly one
  entry per qualified requested ID, including the late `sk-zai-m` alias.
- This completion evidence.

Qwen context length remains 131072, maximum output remains 16384, and existing
minimum output remains 8192. Codex maximum remains null; its adapter continues
dropping unsupported request-budget fields. Other model-card fields are retained.
The live catalog was independently sampled before implementation: all four
requested IDs occurred exactly once. The change does not deduplicate existing
entries or claim that every advertised alias is an enabled backend.

Verification:
- Before implementation, the new regressions produced 5 failures and 26 passes.
- Focused card-overlay, HTTP-model-card and Codex-adapter suites: 48 passed,
  0 failed, 0 skipped.
- Broader catalog boundary command below: 97 passed, 0 failed, 0 skipped,
  15.07 seconds. All test stores use the existing isolation bootstrap.
- `git diff --check`: passed.

```text
node --test --import ./tests/_setup.mjs tests/card-overrides.test.mjs tests/admin-models-cards.test.mjs tests/codex-adapter.test.mjs tests/advertise-lifecycle.test.mjs tests/advertise-reconcile.test.mjs tests/match-catalog-serving-config-union.test.mjs tests/advertise.test.mjs tests/model-alias-parity.test.mjs
```

The base matches all 82 checked live gateway source/package/public-overlay files
in the operator provenance receipt. The extracted live directory has no Git
metadata; this source worktree is isolated and based on its verified clean commit.
No live source/configuration, credential, route, backend state or service was
changed. No model completion, push, merge or restart was performed for this task.
Exact final commit/tree and evidence digest are bound externally in the candidate
descriptor; a committed file cannot contain its own final commit hash.

Independent cross-family review and root-managed installation remain pending.
Roll back the source changes to the pinned base. Any later live installation must
preserve exact file preimages and restore them with a managed reload if verification
fails. Operator metadata is not effective until that reviewed rollout completes.
