/**
 * provider-route-assertion.test.mjs: provider-route consistency assertion
 * (card 7ec1d18a; per-agent source moved to the registry by CR-5.1).
 *
 * The gateway must catch a mis-wired provider route the moment the config is
 * read (at BOOT and on every SIGHUP reload) instead of silently mis-routing
 * (or 502-ing) at the first request. These tests prove:
 *
 *   - a valid config boots and reloads cleanly;
 *   - a registry `agent:<id>` context pointing at an unknown model fails the
 *     assertion at boot with a clear error that names the bad context;
 *   - the same bad state is REJECTED on reload (the old config is retained);
 *   - a valid reload still applies;
 *   - the auth-completeness and pooling.per_backend rules fire;
 *   - sk-* aliases and routing.strict_targets: false are honoured.
 *
 * The per-agent pin now lives in the skmodels registry `agent:<id>` contexts
 * (the single source of truth), not a `routing.per_agent` config map, so the
 * fixtures seed a registry file and point the gateway at it via
 * $SKMODELS_REGISTRY (module default) or the assertProviderRoutes() path arg.
 *
 * Run with:  node --test tests/provider-route-assertion.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── fixtures + module-default registry ───────────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), "skgw-route-assert-"));

// The registry the BOOT/RELOAD path reads (assertProviderRoutes is called by
// validate() with no explicit path -> it uses REGISTRY_PATH). Seed it empty and
// point the module default at it BEFORE importing config.mjs (dynamic import so
// registry.mjs captures REGISTRY_PATH from this env).
const REG_PATH = join(TMP, "default-registry.yaml");
writeFileSync(REG_PATH, "contexts: {}\n", "utf8");
process.env.SKMODELS_REGISTRY = REG_PATH;

const { loadConfig, getConfig, reloadConfig, assertProviderRoutes } = await import("../src/config.mjs");

let _n = 0;
/** Write `yaml` to a fresh temp file and return its path. */
function yamlFile(yaml) {
  const p = join(TMP, `cfg-${_n++}.yaml`);
  writeFileSync(p, yaml, "utf8");
  return p;
}

/** Write a fresh registry fixture with the given `agent:<id> -> target` contexts. */
function registryFile(contexts = {}) {
  const p = join(TMP, `reg-${_n++}.yaml`);
  const lines = ["contexts:"];
  for (const [k, v] of Object.entries(contexts)) lines.push(`  ${k}: ${v}`);
  writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}

/** Overwrite the module-default registry with the given contexts (reload path). */
function setDefaultRegistry(contexts = {}) {
  const lines = ["contexts:"];
  for (const [k, v] of Object.entries(contexts)) lines.push(`  ${k}: ${v}`);
  writeFileSync(REG_PATH, lines.join("\n") + "\n", "utf8");
}

// A minimal but well-formed config with one local backend serving `good-model`.
const VALID_YAML = `
server: { port: 19980, dashboard_port: 19981 }
backends:
  local:
    url: http://127.0.0.1:8082/v1
    auth_type: none
    models: [good-model, "glob-*"]
    priority: 1
`;

// ── 1. direct assertion unit checks ──────────────────────────────────────────

describe("assertProviderRoutes() rule coverage", () => {
  const baseBackends = {
    local: { url: "http://x/v1", auth_type: "none", models: ["good-model", "glob-*"], priority: 1 },
  };

  test("valid config + registry contexts yield no problems", () => {
    const reg = registryFile({ "agent:lumina": "good-model", "agent:jarvis": "glob-7b" });
    const errs = assertProviderRoutes(
      { backends: baseBackends, routing: { strict_targets: true } },
      [],
      reg,
    );
    assert.deepEqual(errs, []);
  });

  test("dangling agent-context target is flagged and names the context", () => {
    const reg = registryFile({ "agent:jarvis": "no-such-model" });
    const errs = assertProviderRoutes(
      { backends: baseBackends, routing: { strict_targets: true } },
      [],
      reg,
    );
    assert.equal(errs.length, 1);
    assert.match(errs[0], /agent:jarvis/);
    assert.match(errs[0], /no-such-model/);
    assert.match(errs[0], /dangling route/);
  });

  test("sk-* alias target is accepted (resolved live by the registry)", () => {
    const reg = registryFile({ "agent:lumina": "sk-default" });
    const errs = assertProviderRoutes(
      { backends: baseBackends, routing: { strict_targets: true } },
      [],
      reg,
    );
    assert.deepEqual(errs, []);
  });

  test("strict_targets: false disables the agent-context dangling check", () => {
    const reg = registryFile({ "agent:jarvis": "registry-only-role" });
    const errs = assertProviderRoutes(
      { backends: baseBackends, routing: { strict_targets: false } },
      [],
      reg,
    );
    assert.deepEqual(errs, []);
  });

  test("only agent:* contexts are validated (a chat: context is ignored here)", () => {
    const reg = registryFile({ "chat:123": "no-such-model", "agent:ok": "good-model" });
    const errs = assertProviderRoutes(
      { backends: baseBackends, routing: { strict_targets: true } },
      [],
      reg,
    );
    assert.deepEqual(errs, [], "non-agent contexts are out of scope for this per-agent check");
  });

  test("oauth backend without credentials is flagged", () => {
    const errs = assertProviderRoutes({
      backends: { direct: { url: "http://x/v1", auth_type: "oauth", models: ["m"], priority: 1 } },
    });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /backends\.direct/);
    assert.match(errs[0], /oauth/);
  });

  test("api_key backend without a key/key_env is flagged", () => {
    const errs = assertProviderRoutes({
      backends: { nv: { url: "http://x/v1", auth_type: "api_key", models: ["m"], priority: 1 } },
    });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /backends\.nv/);
    assert.match(errs[0], /api_key/);
  });

  test("pooling.per_backend referencing an unknown backend is flagged", () => {
    const errs = assertProviderRoutes({
      backends: baseBackends,
      pooling: { per_backend: { local: { max: 5 }, ghost: { max: 5 } } },
    });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /pooling\.per_backend\.ghost/);
    assert.match(errs[0], /unknown backend/);
  });
});

// ── 2. boot: fail fast on a dangling provider route ──────────────────────────

describe("boot assertion (loadConfig)", () => {
  test("a valid config boots cleanly", async () => {
    setDefaultRegistry({}); // no agent pins
    const cfg = (await loadConfig({ configPath: yamlFile(VALID_YAML), silent: true })).current();
    assert.equal(cfg.server.port, 19980);
  });

  test("a dangling agent context fails the boot with a clear error", async () => {
    setDefaultRegistry({ "agent:jarvis": "totally-unknown-model" });
    await assert.rejects(
      () => loadConfig({ configPath: yamlFile(VALID_YAML), silent: true }),
      (err) => {
        assert.equal(err.name, "ConfigError");
        assert.ok(Array.isArray(err.problems));
        assert.ok(
          err.problems.some((p) => /agent:jarvis/.test(p) && /totally-unknown-model/.test(p)),
          `expected a problem naming the bad context, got: ${JSON.stringify(err.problems)}`,
        );
        return true;
      },
    );
  });
});

// ── 3. reload: the same bad state is rejected, valid state applies ────────────

describe("reload assertion (SIGHUP path)", () => {
  test("a bad reload is rejected and the old config is retained; a valid reload applies", async () => {
    // Boot from a valid config (port 19980) with no agent pins.
    setDefaultRegistry({});
    const path = yamlFile(VALID_YAML);
    await loadConfig({ configPath: path, silent: true });
    assert.equal(getConfig().server.port, 19980);

    // Change the port AND introduce a dangling agent pin in the registry. Reload
    // must reject the whole thing and keep the old config, proving the assertion
    // fires on the reload path (reading the registry), not at first request.
    writeFileSync(path, `
server: { port: 19990, dashboard_port: 19991 }
backends:
  local:
    url: http://127.0.0.1:8082/v1
    auth_type: none
    models: [good-model]
    priority: 1
`, "utf8");
    setDefaultRegistry({ "agent:jarvis": "bogus-on-reload" });
    reloadConfig(true);
    assert.equal(getConfig().server.port, 19980, "bad reload must be rejected; old port retained");

    // Repair the registry pin and change the port again → a good reload applies.
    setDefaultRegistry({ "agent:jarvis": "good-model" });
    writeFileSync(path, `
server: { port: 19995, dashboard_port: 19996 }
backends:
  local:
    url: http://127.0.0.1:8082/v1
    auth_type: none
    models: [good-model]
    priority: 1
`, "utf8");
    reloadConfig(true);
    assert.equal(getConfig().server.port, 19995, "valid reload must apply the new port");
  });
});
