/**
 * refresh-catalog-probe-wiring.test.mjs — card C3 (1f65cf45) regression test.
 *
 * BACKGROUND: card P2.3 built a complete EOL probe sweep (src/discovery/
 * probe.mjs, tested in tests/probe.test.mjs) and discoverCatalog() (src/
 * discovery.mjs) supports it correctly: budget, timeout, pool, cadence gate.
 * But refreshCatalog() in src/index.mjs, the only production call site of
 * discoverCatalog(), never forwarded probeSeconds/probeBudget/probeTimeoutMs
 * from cfg.discovery. discoverCatalog() defaults probeSeconds to 0, and the
 * whole probe block is gated on probeSeconds > 0, so no config key existed
 * that could ever turn the sweep on. Setting discovery.probe_seconds: 86400
 * in the live config did NOTHING.
 *
 * tests/probe.test.mjs exercises probe.mjs in isolation and passed the whole
 * time this was broken, because the break was never in probe.mjs, it was in
 * the wiring one layer up. That is exactly why this file does NOT test
 * probe.mjs. It tests the WIRING: that a discovery.probe_seconds /
 * probe_budget / probe_timeout_ms set in config actually reaches the opts
 * object discoverCatalog() is called with. refreshCatalog() now accepts an
 * injectable discoverCatalogFn (default: the real discoverCatalog) for
 * exactly this purpose, following the same DI convention already used
 * throughout src/index.mjs (getLifecycleFn, etc).
 *
 * Two groups:
 *   1. Direct-import of the exported refreshCatalog() with a spy
 *      discoverCatalogFn: hermetic, no network, asserts on the opts object.
 *   2. A live server boot (discovery disabled at startup, matching the
 *      convention in tests/admin-models-cards.test.mjs) to prove
 *      refreshCatalog is reachable and exported off the real module, not
 *      just some helper redefined for this test file.
 *
 * Run with:  node --test tests/refresh-catalog-probe-wiring.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(__dirname, "..", "src", "index.mjs");

const PORT = 18991, DASH = 18992;

describe("card C3: refreshCatalog wires discovery.probe_* into discoverCatalog", () => {
  let mod;
  let tmpDir;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "skgw-c3-probe-wiring-"));
    const cfgPath = join(tmpDir, "gw.yaml");
    const storePath = join(tmpDir, "model_catalog_store.json");

    writeFileSync(storePath, "{}");

    // discovery.enabled: false so module load never fires a real (networked)
    // refreshCatalog call, matching tests/admin-models-cards.test.mjs.
    writeFileSync(
      cfgPath,
      [
        "server:",
        "  bind: 127.0.0.1",
        `  port: ${PORT}`,
        `  dashboard_port: ${DASH}`,
        "dashboard:",
        `  port: ${DASH}`,
        "discovery:",
        "  enabled: false",
        "identity:",
        "  enabled: false",
        "backends:",
        "  local:",
        "    url: http://127.0.0.1:1/v1",
        "    auth_type: none",
        "    priority: 1",
        "    models: [c3-neutral]",
        "",
      ].join("\n"),
    );

    process.env.SKGATEWAY_CONFIG = cfgPath;
    process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = storePath;
    mod = await import(pathToFileURL(INDEX).href);
  });

  after(() => {
    delete process.env.SKGATEWAY_CONFIG;
    delete process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH;
    try { mod.server.close(); } catch { /* best effort */ }
    try { mod.dashboard?.close?.(); } catch { /* best effort */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // ── The regression itself: opts reaching discoverCatalog ──

  test("probe_seconds/probe_budget/probe_timeout_ms in cfg.discovery reach discoverCatalog's opts", async () => {
    let captured = null;
    const spy = async (opts) => {
      captured = opts;
      return { models: [] };
    };

    const cfg = {
      backends: {},
      discovery: {
        enabled: true,
        providers: {},
        probe_seconds: 86400,
        probe_budget: 7,
        probe_timeout_ms: 12000,
      },
    };

    await mod.refreshCatalog(cfg, spy);

    assert.ok(captured, "discoverCatalogFn must have been called");
    assert.equal(captured.probeSeconds, 86400, "discovery.probe_seconds must reach discoverCatalog as probeSeconds");
    assert.equal(captured.probeBudget, 7, "discovery.probe_budget must reach discoverCatalog as probeBudget");
    assert.equal(captured.probeTimeoutMs, 12000, "discovery.probe_timeout_ms must reach discoverCatalog as probeTimeoutMs");
  });

  test("a config with no discovery.probe_seconds key still resolves to probeSeconds 0 (sweep stays off by default)", async () => {
    let captured = null;
    const spy = async (opts) => {
      captured = opts;
      return { models: [] };
    };

    // No probe_* keys at all: the shape every pre-C3 config has today. Must
    // NOT silently enable the sweep, and must not pass `undefined` through
    // in a way that could be mistaken for "unset, use discoverCatalog's own
    // default" versus a bug that always sends 0 (this asserts the literal
    // value discoverCatalog would gate `probeSeconds > 0` on).
    const cfg = { backends: {}, discovery: { enabled: true, providers: {} } };

    await mod.refreshCatalog(cfg, spy);

    assert.ok(captured, "discoverCatalogFn must have been called");
    assert.equal(captured.probeSeconds, 0, "no discovery.probe_seconds must resolve to probeSeconds 0, not undefined/NaN/truthy");
  });

  test("a config with no discovery block at all (cfg.discovery undefined) also resolves to probeSeconds 0", async () => {
    let captured = null;
    const spy = async (opts) => {
      captured = opts;
      return { models: [] };
    };

    const cfg = { backends: {} };
    await mod.refreshCatalog(cfg, spy);

    assert.ok(captured);
    assert.equal(captured.probeSeconds, 0);
  });

  // ── Confirm the fix didn't disturb the rest of the opts contract ──

  test("existing opts (localModels/nvidiaFetch/openrouterFetch/cache) are still passed alongside the new probe knobs", async () => {
    let captured = null;
    const spy = async (opts) => {
      captured = opts;
      return { models: [] };
    };

    const cfg = {
      backends: {
        local: { url: "http://127.0.0.1:1/v1", auth_type: "none", priority: 1, models: ["c3-neutral"] },
      },
      discovery: { enabled: true, providers: {}, probe_seconds: 3600 },
    };

    await mod.refreshCatalog(cfg, spy);

    assert.ok(Array.isArray(captured.localModels), "localModels must still be computed from cfg.backends");
    assert.equal(typeof captured.nvidiaFetch, "function");
    assert.equal(typeof captured.openrouterFetch, "function");
    assert.ok(captured.cache && typeof captured.cache === "object", "the shared discovery cache object must still be passed");
  });

  // ── Prove refreshCatalog is reachable off the real, fully-booted module ──

  test("mod.refreshCatalog is exported from the real src/index.mjs (not a helper redefined only for this test)", () => {
    assert.equal(typeof mod.refreshCatalog, "function");
  });

  test("refreshCatalog defaults to the real discoverCatalog when no discoverCatalogFn is injected (production behavior unchanged)", async () => {
    // No spy: cfg.discovery.probe_seconds stays 0/absent so this never
    // touches the network or the probe path, it just proves the default
    // parameter is the real discoverCatalog and a normal call still works.
    const cfg = { backends: { local: { url: "http://127.0.0.1:1/v1", auth_type: "none", priority: 1, models: ["c3-neutral"] } }, discovery: { enabled: true, providers: {} } };
    const models = await mod.refreshCatalog(cfg);
    assert.ok(Array.isArray(models));
    assert.ok(models.some((m) => m.id === "c3-neutral"));
  });
});
