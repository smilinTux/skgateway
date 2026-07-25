/**
 * provider-route-assertion.test.mjs: provider-route consistency assertion
 * (card 7ec1d18a).
 *
 * The gateway must catch a mis-wired provider route the moment the config is
 * read (at BOOT and on every SIGHUP reload) instead of silently mis-routing
 * (or 502-ing) at the first request. These tests prove:
 *
 *   - a valid config boots and reloads cleanly;
 *   - a per_agent route pointing at an unknown model fails the assertion at boot
 *     with a clear error that names the bad route;
 *   - the same bad config is REJECTED on reload (the old config is retained);
 *   - a valid reload still applies;
 *   - the auth-completeness and pooling.per_backend rules fire;
 *   - sk-* aliases and routing.strict_targets: false are honoured.
 *
 * Run with:  node --test tests/provider-route-assertion.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, getConfig, reloadConfig, assertProviderRoutes } from "../src/config.mjs";

// ── helpers ─────────────────────────────────────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), "skgw-route-assert-"));
let _n = 0;
/** Write `yaml` to a fresh temp file and return its path. */
function yamlFile(yaml) {
  const p = join(TMP, `cfg-${_n++}.yaml`);
  writeFileSync(p, yaml, "utf8");
  return p;
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

  test("valid config yields no problems", () => {
    const errs = assertProviderRoutes({
      backends: baseBackends,
      routing: { per_agent: { lumina: "good-model", jarvis: "glob-7b" }, strict_targets: true },
    });
    assert.deepEqual(errs, []);
  });

  test("dangling per_agent target is flagged and names the route", () => {
    const errs = assertProviderRoutes({
      backends: baseBackends,
      routing: { per_agent: { jarvis: "no-such-model" }, strict_targets: true },
    });
    assert.equal(errs.length, 1);
    assert.match(errs[0], /routing\.per_agent\.jarvis/);
    assert.match(errs[0], /no-such-model/);
    assert.match(errs[0], /dangling route/);
  });

  test("sk-* alias target is accepted (resolved live by the registry)", () => {
    const errs = assertProviderRoutes({
      backends: baseBackends,
      routing: { per_agent: { lumina: "sk-default" }, strict_targets: true },
    });
    assert.deepEqual(errs, []);
  });

  test("strict_targets: false disables the per_agent dangling check", () => {
    const errs = assertProviderRoutes({
      backends: baseBackends,
      routing: { per_agent: { jarvis: "registry-only-role" }, strict_targets: false },
    });
    assert.deepEqual(errs, []);
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
    const cfg = (await loadConfig({ configPath: yamlFile(VALID_YAML), silent: true })).current();
    assert.equal(cfg.server.port, 19980);
  });

  test("a per_agent route at an unknown backend fails the boot with a clear error", async () => {
    const bad = yamlFile(VALID_YAML + `
routing:
  per_agent:
    jarvis: totally-unknown-model
`);
    await assert.rejects(
      () => loadConfig({ configPath: bad, silent: true }),
      (err) => {
        assert.equal(err.name, "ConfigError");
        assert.ok(Array.isArray(err.problems));
        assert.ok(
          err.problems.some((p) => /routing\.per_agent\.jarvis/.test(p) && /totally-unknown-model/.test(p)),
          `expected a problem naming the bad route, got: ${JSON.stringify(err.problems)}`,
        );
        return true;
      },
    );
  });
});

// ── 3. reload: the same bad config is rejected, valid config applies ──────────

describe("reload assertion (SIGHUP path)", () => {
  test("a bad reload is rejected and the old config is retained; a valid reload applies", async () => {
    // Boot from a valid config (port 19980).
    const path = yamlFile(VALID_YAML);
    await loadConfig({ configPath: path, silent: true });
    assert.equal(getConfig().server.port, 19980);

    // Overwrite the SAME file with a config that BOTH changes the port AND adds a
    // dangling provider route. Reload must reject it wholesale and keep the old
    // config, proving the assertion fires on the reload path, not at first request.
    writeFileSync(path, `
server: { port: 19990, dashboard_port: 19991 }
backends:
  local:
    url: http://127.0.0.1:8082/v1
    auth_type: none
    models: [good-model]
    priority: 1
routing:
  per_agent:
    jarvis: bogus-on-reload
`, "utf8");
    reloadConfig(true);
    assert.equal(getConfig().server.port, 19980, "bad reload must be rejected; old port retained");

    // Now overwrite with a VALID config that changes the port (a good reload applies).
    writeFileSync(path, `
server: { port: 19995, dashboard_port: 19996 }
backends:
  local:
    url: http://127.0.0.1:8082/v1
    auth_type: none
    models: [good-model]
    priority: 1
routing:
  per_agent:
    jarvis: good-model
`, "utf8");
    reloadConfig(true);
    assert.equal(getConfig().server.port, 19995, "valid reload must apply the new port");
  });
});
