/**
 * registry-match.test.mjs: `@match` marker + requirements parsing (card P4.1).
 *
 * A role whose target is the literal string "@match" (e.g.
 * `roles: { sk-tools: "@match" }`) makes `resolve()` return `{ match: true,
 * role }`, exactly parallel to the existing `{ auto: true }` marker for the
 * "auto" backend name (`sk-auto: auto`). The registry's new top-level
 * `requirements:` block (per role: `{require, prefer, tier}`) is parsed and
 * exposed both via the standalone `getRequirements(role)` export and inline
 * on the match `resolve()` result.
 *
 * Everything that existed before this card (plain roles, the auto marker,
 * contexts, `failover.local_fallback`) must resolve byte-identically.
 *
 * Run with:  node --test tests/registry-match.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve, getRequirements } from "../src/proxy/registry.mjs";

const dir = mkdtempSync(join(tmpdir(), "skgw-reg-match-"));
let _seq = 0;
function fixture(yaml) {
  const p = join(dir, `registry-${_seq++}.yaml`);
  writeFileSync(p, yaml, "utf8");
  return p;
}

const BASE = `backends:
  ornith:
    url: http://192.168.0.100:8082/v1
    model: ornith-1.0-9b
    ctx: 131072
    kind: chat
  nv-fallback:
    url: https://integrate.api.nvidia.com/v1
    model: meta/free-fallback-model
    kind: chat
roles:
  sk-default: ornith
  sk-auto: auto
  sk-tools: "@match"
  sk-cheap-fast: "@match"
contexts:
  chat:pinned: sk-default
defaults:
  role: sk-default
requirements:
  sk-tools:
    require: { tool_use: true, min_ctx: 32768 }
    prefer: [sovereign, success_rate, tool_use]
    tier: [local, free-remote, paid-cloud]
  sk-cheap-fast:
    require: { max_latency_p50_ms: 3000 }
    prefer: [free, latency]
    tier: [local, free-remote]
`;

describe("resolve, @match marker (role target)", () => {
  test("a role whose target is @match returns { match:true, role } via role precedence", () => {
    const p = fixture(BASE);
    const r = resolve({ role: "sk-tools" }, p);
    assert.ok(r, "should resolve");
    assert.equal(r.match, true);
    assert.equal(r.role, "sk-tools");
    assert.equal(r.via, "role");
    assert.equal(r.auto, undefined);
  });

  test("an @match role addressed via the model field (named role-key) also matches", () => {
    const p = fixture(BASE);
    const r = resolve({ model: "sk-tools" }, p);
    assert.ok(r);
    assert.equal(r.match, true);
    assert.equal(r.role, "sk-tools");
  });

  test("a context that points at an @match role resolves to match via context precedence", () => {
    const p = fixture(
      BASE.replace("chat:pinned: sk-default", "chat:pinned: sk-default\n  chat:tools: sk-tools"),
    );
    const r = resolve({ context: "chat:tools" }, p);
    assert.ok(r);
    assert.equal(r.match, true);
    assert.equal(r.role, "sk-tools");
    assert.equal(r.via, "context");
  });

  test("match result carries no url/model/backend (not a real backend)", () => {
    const p = fixture(BASE);
    const r = resolve({ role: "sk-tools" }, p);
    assert.equal(r.backend, null);
    assert.equal(r.model, null);
    assert.equal(r.url, undefined);
    assert.equal(r.anthropic, false);
    assert.equal(r.vision, false);
  });

  test("match result inlines the role's requirements block", () => {
    const p = fixture(BASE);
    const r = resolve({ role: "sk-cheap-fast" }, p);
    assert.deepEqual(r.requirements, {
      require: { max_latency_p50_ms: 3000 },
      prefer: ["free", "latency"],
      tier: ["local", "free-remote"],
    });
  });

  test("an @match role with no requirements entry still matches, with requirements:null", () => {
    const p = fixture(`backends:
  ornith:
    url: http://192.168.0.100:8082/v1
    model: ornith-1.0-9b
    kind: chat
roles:
  sk-undeclared: "@match"
`);
    const r = resolve({ role: "sk-undeclared" }, p);
    assert.equal(r.match, true);
    assert.equal(r.role, "sk-undeclared");
    assert.equal(r.requirements, null);
  });
});

describe("getRequirements()", () => {
  test("returns the role's raw requirement block", () => {
    const p = fixture(BASE);
    assert.deepEqual(getRequirements("sk-tools", p), {
      require: { tool_use: true, min_ctx: 32768 },
      prefer: ["sovereign", "success_rate", "tool_use"],
      tier: ["local", "free-remote", "paid-cloud"],
    });
  });

  test("returns null for a role with no requirements entry", () => {
    const p = fixture(BASE);
    assert.equal(getRequirements("sk-default", p), null);
  });

  test("returns null for an unknown role", () => {
    const p = fixture(BASE);
    assert.equal(getRequirements("sk-does-not-exist", p), null);
  });

  test("returns null (never throws) when the registry has no requirements: block at all", () => {
    const p = fixture(`backends:
  ornith:
    url: http://x/v1
    model: y
    kind: chat
roles:
  sk-default: ornith
`);
    assert.equal(getRequirements("sk-default", p), null);
  });

  test("returns null for a falsy/missing role argument", () => {
    const p = fixture(BASE);
    assert.equal(getRequirements(undefined, p), null);
    assert.equal(getRequirements("", p), null);
  });
});

describe("regression, everything existing stays byte-identical", () => {
  test("a plain role resolves exactly as before (no match/auto fields)", () => {
    const p = fixture(BASE);
    const r = resolve({ role: "sk-default" }, p);
    assert.deepEqual(r, {
      backend: "ornith",
      url: "http://192.168.0.100:8082/v1",
      model: "ornith-1.0-9b",
      vision: false,
      kind: "chat",
      minOutputTokens: 0,
      anthropic: false,
      via: "role",
      role: "sk-default",
    });
  });

  test("the sk-auto marker is unaffected by the @match branch", () => {
    const p = fixture(BASE);
    const r = resolve({ role: "sk-auto" }, p);
    assert.deepEqual(r, {
      auto: true,
      backend: "auto",
      model: null,
      vision: false,
      anthropic: false,
      via: "role",
      role: "sk-auto",
    });
  });

  test("context precedence over role still works for a plain (non-@match) target", () => {
    const p = fixture(BASE);
    const r = resolve({ context: "chat:pinned", role: "sk-tools" }, p);
    assert.equal(r.match, undefined);
    assert.equal(r.backend, "ornith");
    assert.equal(r.via, "context");
  });

  test("default fallback (no role/context/service/model) still resolves sk-default", () => {
    const p = fixture(BASE);
    const r = resolve({}, p);
    assert.equal(r.backend, "ornith");
    assert.equal(r.via, "default");
  });

  test("an unresolvable request still returns null", () => {
    const p = fixture(BASE);
    assert.equal(resolve({ role: "nonexistent-role" }, p), null);
  });
});
