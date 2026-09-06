import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { loadConfig } from "../src/config.mjs";
import { servingConfigModels } from "../src/discovery.mjs";
import { resolveBucket } from "../src/policy/buckets.mjs";
import { buildModelCatalog } from "../src/proxy/advertise.mjs";

function fixture(lines) {
  const dir = mkdtempSync(join(tmpdir(), "skgw-config-removal-"));
  const path = join(dir, "skgateway.yaml");
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

async function load(lines) {
  return (await loadConfig({ configPath: fixture(lines), silent: true })).current();
}

function modelIds(backends) {
  return buildModelCatalog(backends, null, "off").map((entry) => entry.id);
}

describe("config loader backend removal contract", () => {
  test("a declared backends mapping replaces built-in defaults while unrelated defaults merge", async () => {
    const cfg = await load([
      "server:",
      "  bind: 127.0.0.1",
      "backends:",
      "  local:",
      "    url: http://127.0.0.1:9000/v1",
      "    auth_type: none",
      "    models: [local-model]",
      "    priority: 1",
    ]);

    assert.deepEqual(Object.keys(cfg.backends), ["local"]);
    assert.deepEqual(modelIds(cfg.backends), ["local-model"]);
    assert.deepEqual(servingConfigModels(cfg.backends).map((entry) => entry.id), ["local-model"]);
    assert.equal(cfg.server.bind, "127.0.0.1");
    assert.equal(cfg.server.port, 18780, "unrelated server default must still merge");
    assert.equal(cfg.tools.max_budget, 16, "unrelated tools default must still merge");
    assert.equal(cfg.discovery.providers.anthropic.enabled, false);
    assert.equal(cfg.discovery.providers.nvidia.enabled, false);
    assert.equal(cfg.discovery.providers.openrouter.enabled, false);
  });

  test("enabled false removes a built-in backend before advertising and bucketing", async () => {
    const cfg = await load([
      "backends:",
      "  anthropic:",
      "    enabled: false",
      "  local:",
      "    url: http://127.0.0.1:9000/v1",
      "    auth_type: none",
      "    models: [local-model]",
      "    priority: 1",
    ]);

    assert.equal(Object.hasOwn(cfg.backends, "anthropic"), false);
    assert.equal(modelIds(cfg.backends).some((id) => id.startsWith("claude-")), false);

    const catalog = servingConfigModels(cfg.backends).map((entry) => ({
      ...entry,
      lifecycle: { state: "active" },
      capabilities: { size_class: "S", trust_zone: 0 },
    }));
    const bucket = resolveBucket({
      bucket: { model_class: "S", sensitivity: "secret" },
      catalog,
      isRoutable: () => true,
    });
    assert.deepEqual(bucket.members.map((entry) => entry.id), ["local-model"]);
    assert.equal(bucket.members.some((entry) => entry.id.startsWith("claude-")), false);
    assert.equal(cfg.discovery.providers.anthropic.enabled, false);
  });

  test("orphan pooling references to removed direct and registry routes fail loudly", async () => {
    await assert.rejects(
      () => load([
        "pooling:",
        "  per_backend:",
        "    anthropic: { max: 1, maxQueue: 1 }",
        "  capacity_domains:",
        "    retired:",
        "      members: [retired, 'reg:anthropic']",
        "      max: 1",
        "      maxQueue: 1",
        "      queueTimeoutMs: 1000",
        "backends:",
        "  local:",
        "    url: http://127.0.0.1:9000/v1",
        "    auth_type: none",
        "    models: [local-model]",
        "    priority: 1",
      ]),
      (error) => {
        assert.equal(error.name, "ConfigError");
        assert.match(error.message, /pooling\.per_backend\.anthropic references an unknown backend/);
        assert.match(error.message, /members references disabled or removed backend anthropic/);
        return true;
      },
    );
  });

  test("malformed disablement and malformed YAML fail instead of restoring defaults", async () => {
    await assert.rejects(
      () => load(["backends:", "  anthropic:", "    enabled: disabled"]),
      /backends\.anthropic\.enabled must be a boolean/,
    );
    await assert.rejects(
      () => load(["backends:"]),
      /backends must be a mapping when declared/,
    );
    await assert.rejects(
      () => load(["backends: [anthropic"]),
      /could not parse .* (?:unexpected end|deficient indentation)/i,
    );
  });
});
