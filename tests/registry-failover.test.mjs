/**
 * registry-failover.test.mjs: resolveFailoverCandidates() (card P1.5).
 *
 * `registry.failover.local_fallback` replaces the hardcoded cloud fallback
 * model id that used to live in proxy/local-failover.mjs. This suite covers
 * the pure registry-side parsing/resolution: role -> concrete model+backend,
 * concrete-id passthrough, array ordering, and the empty/unset cases.
 * local-failover.test.mjs covers the lifecycle ('active') filtering on top
 * of this list.
 *
 * Run with:  node --test tests/registry-failover.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveFailoverCandidates } from "../src/proxy/registry.mjs";

const dir = mkdtempSync(join(tmpdir(), "skgw-reg-failover-"));
let _seq = 0;
function fixture(yaml) {
  const p = join(dir, `registry-${_seq++}.yaml`);
  writeFileSync(p, yaml, "utf8");
  return p;
}

describe("resolveFailoverCandidates", () => {
  test("a single role name resolves to its backend's concrete model + backend id", () => {
    const p = fixture(`backends:
  nv-fallback:
    url: https://integrate.api.nvidia.com/v1
    model: meta/free-fallback-model
    kind: chat
roles:
  sk-cheap-fast: nv-fallback
failover:
  local_fallback: sk-cheap-fast
`);
    assert.deepEqual(resolveFailoverCandidates(p), [
      { model: "meta/free-fallback-model", backend: "nv-fallback" },
    ]);
  });

  test("an array of role names resolves in order", () => {
    const p = fixture(`backends:
  dead-one:
    url: https://x/v1
    model: nvidia/dead-model
    kind: chat
  live-one:
    url: https://y/v1
    model: nvidia/live-model
    kind: chat
roles:
  sk-fb-a: dead-one
  sk-fb-b: live-one
failover:
  local_fallback: [sk-fb-a, sk-fb-b]
`);
    assert.deepEqual(resolveFailoverCandidates(p), [
      { model: "nvidia/dead-model", backend: "dead-one" },
      { model: "nvidia/live-model", backend: "live-one" },
    ]);
  });

  test("a concrete model id (not a declared role) passes through with backend null", () => {
    const p = fixture(`backends: {}
roles: {}
failover:
  local_fallback: nvidia/some-concrete-id
`);
    assert.deepEqual(resolveFailoverCandidates(p), [{ model: "nvidia/some-concrete-id", backend: null }]);
  });

  test("a role whose backend config has no model field falls back to name-as-concrete-id", () => {
    const p = fixture(`backends:
  no-model:
    url: https://x/v1
    kind: chat
roles:
  sk-broken: no-model
failover:
  local_fallback: sk-broken
`);
    assert.deepEqual(resolveFailoverCandidates(p), [{ model: "sk-broken", backend: null }]);
  });

  test("no failover block at all yields an empty list", () => {
    const p = fixture(`backends: {}
roles: {}
`);
    assert.deepEqual(resolveFailoverCandidates(p), []);
  });

  test("failover.local_fallback unset (block present but key absent) yields an empty list", () => {
    const p = fixture(`backends: {}
roles: {}
failover: {}
`);
    assert.deepEqual(resolveFailoverCandidates(p), []);
  });

  test("a missing registry file yields an empty list, never throws", () => {
    assert.doesNotThrow(() => {
      assert.deepEqual(resolveFailoverCandidates(join(dir, "does-not-exist.yaml")), []);
    });
  });
});
