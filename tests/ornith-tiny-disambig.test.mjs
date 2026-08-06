/**
 * ornith-tiny-disambig.test.mjs role-vs-model-id disambiguation (card 31631c4f;
 * per-agent source moved to the registry by CR-5.1).
 *
 * `ornith-tiny` is BOTH a skos role name (registry `roles: { ornith-tiny: ornith }`)
 * and, historically, a model id listed under a config backend. The router's
 * classify/registry path (isRegistryRouted) treats it as a ROLE. The config
 * boot/reload route-assertion (assertProviderRoutes) used to recognise only the
 * "sk-" prefix as a role, so it treated `ornith-tiny` as a role ONLY by the
 * accident of it also being a backend model (an inconsistency).
 *
 * Resolution: `ornith-tiny` is a ROLE. Both paths now decide that with the SAME
 * predicate (isRegistryRouted), so an `agent:<id>` context target of `ornith-tiny`
 * validates as a registry role WITHOUT having to also be a backend model.
 *
 * Run with:  node --test tests/ornith-tiny-disambig.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRegistryRouted } from "../src/proxy/registry.mjs";
import { assertProviderRoutes } from "../src/config.mjs";

const dir = mkdtempSync(join(tmpdir(), "skgw-ornith-"));

// Shared backends+roles block: ornith-tiny is a role -> ornith backend. No config
// backend lists ornith-tiny as a model, so ONLY the role identity is in play.
const REG_HEAD = `backends:
  ornith:
    url: http://192.168.0.100:8082/v1
    model: ornith-1.0-9b
    min_output_tokens: 8192
    kind: chat
roles:
  ornith-tiny: ornith
  sk-default: ornith
defaults:
  role: sk-default
`;

let _n = 0;
/** Write a registry fixture (standard backends+roles) with the given contexts. */
function registryFile(contexts = {}) {
  const p = join(dir, `registry-${_n++}.yaml`);
  const lines = [REG_HEAD, "contexts:"];
  for (const [k, v] of Object.entries(contexts)) lines.push(`  ${k}: ${v}`);
  writeFileSync(p, lines.join("\n") + "\n");
  return p;
}

// A config whose backends DO NOT serve `ornith-tiny` as a concrete model.
const backends = {
  local: { url: "http://192.168.0.100:8082/v1", auth_type: "none", models: ["ornith-1.0-9b"] },
};

describe("ornith-tiny is a ROLE, consistently across both paths", () => {
  test("classify/registry path: isRegistryRouted treats ornith-tiny as a role", () => {
    const fixture = registryFile();
    assert.equal(isRegistryRouted({ model: "ornith-tiny" }, fixture), true);
    // a bare concrete model id is NOT registry-routed (raw callers unaffected)
    assert.equal(isRegistryRouted({ model: "ornith-1.0-9b" }, fixture), false);
  });

  test("route-assertion accepts an agent context of ornith-tiny as a role (not dangling)", () => {
    const fixture = registryFile({ "agent:lumina": "ornith-tiny" });
    const errs = assertProviderRoutes(
      { backends, routing: { strict_targets: true } },
      [],
      fixture,
    );
    assert.deepEqual(errs, [], `ornith-tiny must validate as a role, got: ${JSON.stringify(errs)}`);
  });

  test("the two paths AGREE: whatever isRegistryRouted routes, the assertion accepts", () => {
    for (const target of ["ornith-tiny", "sk-default"]) {
      const fixture = registryFile({ "agent:a": target });
      const routed = isRegistryRouted({ model: target }, fixture);
      const errs = assertProviderRoutes(
        { backends, routing: { strict_targets: true } },
        [],
        fixture,
      );
      assert.equal(routed, true, `${target} should be registry-routed`);
      assert.deepEqual(errs, [], `${target} routed by isRegistryRouted must also pass the assertion`);
    }
  });

  test("a genuinely-unknown agent-context target is still rejected as dangling", () => {
    const fixture = registryFile({ "agent:a": "not-a-role" });
    assert.equal(isRegistryRouted({ model: "not-a-role" }, fixture), false);
    const errs = assertProviderRoutes(
      { backends, routing: { strict_targets: true } },
      [],
      fixture,
    );
    assert.equal(errs.length, 1);
    assert.match(errs[0], /dangling route/);
    assert.match(errs[0], /not-a-role/);
  });
});
