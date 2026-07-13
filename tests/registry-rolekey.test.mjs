/**
 * registry-rolekey.test.mjs — isRegistryRouted() recognises named role-keys.
 *
 * A friendly label like `ornith-tiny` is declared in the registry `roles:` map
 * (roles: { ornith-tiny: ornith }). It must be registry-routed so it inherits
 * the model rewrite to the backend's concrete id AND the per-backend
 * `min_output_tokens` floor. A BARE concrete model id (ornith-1.0-9b) must NOT
 * trigger registry routing, so existing raw callers keep their behaviour.
 *
 * Run with:  node --test tests/registry-rolekey.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRegistryRouted, resolve } from "../src/proxy/registry.mjs";

const dir = mkdtempSync(join(tmpdir(), "skgw-reg-"));
const fixture = join(dir, "registry.yaml");
writeFileSync(
  fixture,
  `backends:
  ornith:
    url: http://192.168.0.100:8082/v1
    model: ornith-1.0-9b
    ctx: 131072
    min_output_tokens: 8192
    kind: chat
roles:
  ornith-tiny: ornith
  sk-default: ornith
defaults:
  role: sk-default
`,
);

describe("isRegistryRouted — named role-keys", () => {
  test("a named role-key label IS registry-routed", () => {
    assert.equal(isRegistryRouted({ model: "ornith-tiny" }, fixture), true);
  });

  test("a bare concrete model id is NOT registry-routed", () => {
    assert.equal(isRegistryRouted({ model: "ornith-1.0-9b" }, fixture), false);
  });

  test("an sk-* role stays registry-routed (no registry load needed)", () => {
    assert.equal(isRegistryRouted({ model: "sk-default" }), true);
  });

  test("an unknown label is NOT registry-routed", () => {
    assert.equal(isRegistryRouted({ model: "gpt-4o" }, fixture), false);
  });

  test("a routing header always wins regardless of model", () => {
    assert.equal(isRegistryRouted({ service: "skingest.vision" }, fixture), true);
  });
});

describe("resolve — role-key rewrites to concrete model + carries floor", () => {
  test("ornith-tiny resolves to the ornith backend, concrete model, floor 8192", () => {
    const r = resolve({ model: "ornith-tiny" }, fixture);
    assert.ok(r, "should resolve");
    assert.equal(r.backend, "ornith");
    assert.equal(r.model, "ornith-1.0-9b");
    assert.equal(r.minOutputTokens, 8192);
  });
});
