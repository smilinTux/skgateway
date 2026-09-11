import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConfig,
  normalizeProviderMode,
  providerNetworkPermission,
} from "../src/config.mjs";

const temporaryDirectories = [];

function fixture(lines) {
  const directory = mkdtempSync(join(tmpdir(), "skgw-provider-mode-"));
  temporaryDirectories.push(directory);
  const configPath = join(directory, "skgateway.yaml");
  writeFileSync(configPath, `${lines.join("\n")}\n`, "utf8");
  return configPath;
}

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

describe("provider configured modes", () => {
  test("normalizes every supported mode and rejects an unknown mode", () => {
    assert.equal(normalizeProviderMode("DISABLED"), "disabled");
    assert.equal(normalizeProviderMode("monitor_only"), "monitor_only");
    assert.equal(normalizeProviderMode("Canary"), "canary");
    assert.equal(normalizeProviderMode("active"), "active");
    assert.throws(() => normalizeProviderMode("enabled"), /invalid provider configured_mode/);
  });

  test("applies each mode to monitor, qualification, recovery, and inference", () => {
    const purposes = ["monitor", "qualification", "recovery", "inference"];
    const expected = {
      disabled: [false, false, false, false],
      monitor_only: [true, false, false, false],
      canary: [true, true, true, false],
      active: [true, true, true, true],
    };

    for (const [mode, permissions] of Object.entries(expected)) {
      assert.deepEqual(
        purposes.map((purpose) => providerNetworkPermission(mode, purpose)),
        permissions,
        mode,
      );
    }
  });

  test("normalizes an explicit provider mode into the shared providers namespace", async () => {
    const cfg = (await loadConfig({
      configPath: fixture([
        "providers:",
        "  openrouter:",
        "    configured_mode: MONITOR_ONLY",
        "backends:",
        "  local:",
        "    url: http://127.0.0.1:9000/v1",
        "    auth_type: none",
        "    models: [local-model]",
        "    priority: 1",
      ]),
      silent: true,
    })).current();

    assert.equal(cfg.providers.openrouter.configured_mode, "monitor_only");
    assert.equal(cfg.providers.local.configured_mode, "active");
  });

  test("rejects a malformed configured mode before startup", async () => {
    await assert.rejects(
      () => loadConfig({
        configPath: fixture([
          "providers:",
          "  openrouter:",
          "    configured_mode: activated",
          "backends: {}",
        ]),
        silent: true,
      }),
      /invalid provider configured_mode: activated/,
    );
  });
});
