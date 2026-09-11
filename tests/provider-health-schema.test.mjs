import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { foldProviderSnapshot } from "../src/health/fold.mjs";
import { normalizeObservation } from "../src/health/schema.mjs";

const base = {
  schema_version: 1,
  observation_id: "obs-001",
  observed_at: 1_800_000_000_000,
  expires_at: 1_800_000_060_000,
  gateway_instance: "gateway-a",
  boot_id: "boot-a",
  runtime_revision: "runtime-a",
  config_revision: "config-a",
  provider: "zai",
  backend_id: "glm-primary",
  account_ref: "acct-generation-a",
  model_id: "glm-4.5",
  bucket_id: "sk-m",
  scope: "model",
  source: "real_request",
  probe_cost: "zero",
  configured_mode: "active",
  circuit_state: "closed",
  dimensions: { transport: "available", auth: "ready", entitlement: "fresh", quota: "available", capacity: "available", inference: "available" },
  success: true,
};

describe("provider health observation schema", () => {
  test("normalizes an allowlisted observation without adding health claims", () => {
    const actual = normalizeObservation(base);
    assert.deepEqual(actual.dimensions, base.dimensions);
    assert.equal(actual.provider, "zai");
    assert.equal(actual.bucket_id, "sk-m");
    assert.equal(actual.next_due_at, null);
  });

  test("rejects unknown and forbidden data recursively", () => {
    for (const extra of [
      { prompt: "secret" },
      { headers: { authorization: "Bearer secret" } },
      { credential: "secret" },
      { response: { account: "complete-response" } },
      { private_url: "https://private.invalid" },
    ]) assert.throws(() => normalizeObservation({ ...base, ...extra }), /forbidden|unknown/i);
    assert.throws(() => normalizeObservation({ ...base, dimensions: { ...base.dimensions, raw_body: "x" } }), /forbidden|unknown/i);
  });

  test("rejects malformed identity, time, and unreviewed error values", () => {
    assert.throws(() => normalizeObservation({ ...base, expires_at: base.observed_at - 1 }), /expires_at/);
    assert.throws(() => normalizeObservation({ ...base, provider_error_code: "raw-secret-code" }), /provider_error_code/);
    assert.throws(() => normalizeObservation({ ...base, account_ref: "" }), /account_ref/);
    assert.throws(() => normalizeObservation({ ...base, configured_mode: "off" }), /configured_mode/);
  });

  test("accepts Task 1 disabled provider config through normalization and folding", async () => {
    const directory = mkdtempSync(join(tmpdir(), "skgw-health-mode-"));
    const configPath = join(directory, "skgateway.yaml");
    try {
      writeFileSync(configPath, "providers:\n  openrouter:\n    configured_mode: disabled\nbackends: {}\n", "utf8");
      const config = (await loadConfig({ configPath, silent: true })).current();
      const observation = normalizeObservation({
        ...base,
        provider: "openrouter",
        backend_id: null,
        model_id: null,
        configured_mode: config.providers.openrouter.configured_mode,
      });
      assert.equal(observation.configured_mode, "disabled");
      assert.equal(foldProviderSnapshot(null, observation).overall, "disabled");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
