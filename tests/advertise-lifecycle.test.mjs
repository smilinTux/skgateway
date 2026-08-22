/**
 * advertise-lifecycle.test.mjs: lifecycle-aware advertise + route
 * registration (card P1.4).
 *
 * Two groups:
 *
 *   1. "GET /v1/models + /admin/models/status" boots the REAL gateway (src/
 *      index.mjs) as a subprocess, the same pattern as
 *      tests/authz-enforce-integration.test.mjs, with a single local backend
 *      declared statically (discovery disabled, zero network) and a fixture
 *      lifecycle store (SKGATEWAY_MODEL_CATALOG_STORE_PATH env override, so
 *      the real on-disk store at ~/.config/skgateway/ is never touched).
 *      Proves the ACTUAL request handlers hide eol/dead ids, flag suspect
 *      ones, and that /admin/models/status reports lifecycle counts.
 *
 *   2. "registerDiscoveredRoutes" does ONE hermetic direct import of src/
 *      index.mjs (discovery disabled, unique loopback ports, no metrics) to
 *      obtain the exported registerDiscoveredRoutes/filterRoutableModelIds
 *      functions, then calls them directly with fully injected
 *      getBackend/getLifecycleFn (no real router, no real store, no
 *      network). This is the only way to assert the effect on Backend.models
 *      directly: it has no HTTP-observable surface (GET /v1/models reads
 *      config.backends, not router.getBackend(x).models). The module's own
 *      listening server + dashboard are closed in `after` so the test
 *      process exits cleanly.
 *
 * Run with:  node --test tests/advertise-lifecycle.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(__dirname, "..", "src", "index.mjs");

// ── Group 1 helpers (subprocess boot, mirrors authz-enforce-integration.test.mjs) ──

/** Boot the gateway with the given env; resolve once it logs "listening". */
function bootGateway({ port, dashPort, storePath, env }) {
  const dir = mkdtempSync(join(tmpdir(), "skgw-lifecycle-"));
  const cfgPath = join(dir, "gw.yaml");
  writeFileSync(
    cfgPath,
    [
      "server:",
      "  bind: 127.0.0.1",
      `  port: ${port}`,
      `  dashboard_port: ${dashPort}`,
      "dashboard:",
      `  port: ${dashPort}`,
      "discovery:",
      "  enabled: false",
      "identity:",
      "  enabled: false",
      // config.mjs deep-merges this file over its built-in DEFAULTS (arrays
      // replace, objects merge key-by-key), so nvidia/anthropic/ollama/
      // openrouter still exist unless explicitly zeroed out here, otherwise
      // their default static models (e.g. claude-opus-4-6) would also show
      // up in /v1/models and pollute the lifecycle counts below.
      // Each non-discovery default backend requires a non-empty `models`
      // array (config.mjs validate()), so point them all at the SAME neutral
      // placeholder id: buildModelCatalog() dedupes across backends, so this
      // collapses to exactly one extra catalog entry, accounted for below
      // rather than pretending these backends don't exist.
      "backends:",
      "  nvidia:",
      "    models: [_p14-neutral]",
      "  anthropic:",
      "    models: [_p14-neutral]",
      "  ollama:",
      "    models: [_p14-neutral]",
      "  openrouter:",
      "    models: []",
      "  local:",
      "    url: http://127.0.0.1:1/v1",
      "    auth_type: none",
      "    priority: 1",
      "    models:",
      "      - p14-active-1",
      "      - p14-suspect-1",
      "      - p14-eol-1",
      "      - p14-dead-1",
      "      - p14-notchat-1",
      "",
    ].join("\n"),
  );

  const child = spawn(process.execPath, [INDEX, "--config", cfgPath, "--port", String(port)], {
    env: { ...process.env, ...env, SKGATEWAY_MODEL_CATALOG_STORE_PATH: storePath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolveBoot, rejectBoot) => {
    let out = "";
    const onData = (buf) => {
      out += buf.toString();
      if (/\[skgateway\] listening/.test(out)) {
        resolveBoot({ child, dir, out });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => rejectBoot(new Error(`gateway exited early (${code}):\n${out}`)));
    setTimeout(() => rejectBoot(new Error(`gateway did not start in time:\n${out}`)), 15000);
  });
}

async function getJson(port, path) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

function stop(handle) {
  if (!handle) return;
  try { handle.child.kill("SIGKILL"); } catch { /* already gone */ }
  try { rmSync(handle.dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Fixed loopback ports in a high, uncommon range to avoid collisions with
// authz-enforce-integration.test.mjs's 18942-18947.
const PORT = 18951, DASH = 18952;

describe("GET /v1/models + GET /admin/models/status - lifecycle-aware advertise (live server)", () => {
  let handle;
  let storeDir;

  before(async () => {
    storeDir = mkdtempSync(join(tmpdir(), "skgw-lifecycle-store-"));
    const storePath = join(storeDir, "model_catalog_store.json");
    // p14-active-1 and p14-unrecorded ids are deliberately absent from the
    // store (defaultLifecycle() => active), proving the common case needs no
    // fixture entry at all.
    //
    // 2026-08-18 (incident inc-2026-08-18-qwen38-eol): the eol/dead/not_chat
    // fixtures below are each declared by the `local` backend in the config
    // above. applyLifecycleView() now applies the same claim-over-verdict
    // rule as the router's gate (isEffectivelyRoutable): a verdict only
    // hides a claimed id when it is ATTRIBUTED TO THE CLAIMER. These records
    // therefore carry `provider: "local"` — the claimer's own verdict — so
    // they keep pinning the "eol/dead/not_chat ids are absent from
    // /v1/models" behavior this suite was written to prove. (An unattributed
    // verdict on a claimed id is now RESCUED by the claim — that is the
    // incident's fix, pinned in tests/model-claimer-lifecycle.test.mjs.)
    writeFileSync(
      storePath,
      JSON.stringify({
        "p14-suspect-1": {
          state: "suspect",
          last_verified_at: null,
          consecutive_permanent_errors: 0,
          absent_cycles: 1,
          eol_reason: null,
          eol_at: null,
        },
        "p14-eol-1": {
          state: "eol",
          last_verified_at: null,
          consecutive_permanent_errors: 3,
          absent_cycles: 0,
          eol_reason: "provider_410",
          eol_at: 1000,
          provider: "local",
        },
        "p14-dead-1": {
          state: "dead",
          last_verified_at: null,
          consecutive_permanent_errors: 0,
          absent_cycles: 0,
          eol_reason: "dropped_from_catalog",
          eol_at: 1000,
          provider: "local",
        },
        // Card f9e8002b / C14: a healthy, probe-classified non-chat model
        // (e.g. nvidia/nemotron-parse). Must be excluded from /v1/models
        // like eol, but must be DISTINGUISHABLE from eol on /admin/models.
        "p14-notchat-1": {
          state: "not_chat",
          last_verified_at: null,
          consecutive_permanent_errors: 0,
          consecutive_successes: 0,
          absent_cycles: 0,
          eol_reason: "not_chat",
          eol_at: 1000,
          provider: "local",
        },
      }),
    );
    handle = await bootGateway({ port: PORT, dashPort: DASH, storePath, env: {} });
  });
  after(() => {
    stop(handle);
    try { rmSync(storeDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  test("eol and dead ids are absent from /v1/models", async () => {
    const { status, body } = await getJson(PORT, "/v1/models");
    assert.equal(status, 200);
    const ids = body.data.map((m) => m.id);
    assert.equal(ids.includes("p14-eol-1"), false);
    assert.equal(ids.includes("p14-dead-1"), false);
  });

  test("card f9e8002b / C14: a not_chat id is also absent from /v1/models, same as eol", async () => {
    const { status, body } = await getJson(PORT, "/v1/models");
    assert.equal(status, 200);
    const ids = body.data.map((m) => m.id);
    assert.equal(ids.includes("p14-notchat-1"), false);
  });

  test("card f9e8002b / C14: GET /admin/models distinguishes not_chat from eol on the same entry", async () => {
    const { status, body } = await getJson(PORT, "/admin/models");
    assert.equal(status, 200);
    const notChat = body.data.find((m) => m.id === "p14-notchat-1");
    const eol = body.data.find((m) => m.id === "p14-eol-1");
    // Deliberately NOT hidden here (buildAdminModelsView shows every known id,
    // eol/dead/not_chat included, so the operator can see what is being pruned
    // vs. what merely belongs to a different API surface).
    assert.ok(notChat, "not_chat id must still be visible on the admin view");
    assert.ok(eol, "eol id must still be visible on the admin view");
    assert.equal(notChat.lifecycle.state, "not_chat");
    assert.equal(eol.lifecycle.state, "eol");
    assert.notEqual(
      notChat.lifecycle.state,
      eol.lifecycle.state,
      "an operator must be able to tell 'remove from config' (eol) apart from 'wrong API surface' (not_chat)",
    );
  });

  test("suspect id is present but flagged, active id is present and unflagged", async () => {
    const { body } = await getJson(PORT, "/v1/models");
    const active = body.data.find((m) => m.id === "p14-active-1");
    const suspect = body.data.find((m) => m.id === "p14-suspect-1");
    assert.ok(active, "active id must still be advertised");
    assert.equal(active.lifecycle, undefined, "active entries stay additive/unflagged");
    assert.ok(suspect, "suspect id must still be advertised (reversible state)");
    assert.equal(suspect.lifecycle, "suspect");
  });

  test("/v1/models never contains an eol or dead id, and is not otherwise pruned", async () => {
    const { body } = await getJson(PORT, "/v1/models");
    const ids = new Set(body.data.map((m) => m.id));
    // Robust to config.mjs's built-in DEFAULTS backends (nvidia/anthropic/
    // ollama, each given a harmless placeholder model so validate() accepts
    // an empty models: [] override; see the config template above) also
    // being present in the merged catalog: assert what P1.4 owns (no eol/
    // dead ids, suspect/active ids survive), not an exact-set equality that
    // would be fragile against those defaults.
    assert.ok(ids.has("p14-active-1"));
    assert.ok(ids.has("p14-suspect-1"));
    assert.equal(ids.has("p14-eol-1"), false);
    assert.equal(ids.has("p14-dead-1"), false);
  });

  test("/admin/models/status reports lifecycle counts {active, suspect, eol, dead}", async () => {
    const { status, body } = await getJson(PORT, "/admin/models/status");
    assert.equal(status, 200);
    // suspect/eol/dead are exact: only the fixture ids above carry those
    // states, nothing else in the merged catalog can contribute to them.
    // active is >=1 rather than exact: it also picks up every unrecorded id
    // in the catalog (defaultLifecycle() => active), including whatever
    // config.mjs's DEFAULTS backends contribute.
    assert.equal(body.lifecycle.suspect, 1);
    assert.equal(body.lifecycle.eol, 1);
    assert.equal(body.lifecycle.dead, 1);
    assert.ok(body.lifecycle.active >= 1);
  });
});

// ── Group 2: registerDiscoveredRoutes (direct import, fully injected deps) ──

const DIRECT_PORT = 18953, DIRECT_DASH = 18954;

describe("registerDiscoveredRoutes - only active|suspect ids written to Backend.models", () => {
  let mod;
  let tmpDir;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "skgw-lifecycle-direct-"));
    const cfgPath = join(tmpDir, "gw.yaml");
    const storePath = join(tmpDir, "model_catalog_store.json");
    // Discovery disabled and no backends declared: this config only exists to
    // let src/index.mjs's top-level boot (config load, router create, HTTP
    // listen) complete safely/hermetically so the module's exports become
    // available; the actual assertions below use fully injected
    // getBackend/getLifecycleFn and never touch this router or store.
    writeFileSync(
      cfgPath,
      [
        "server:",
        "  bind: 127.0.0.1",
        `  port: ${DIRECT_PORT}`,
        `  dashboard_port: ${DIRECT_DASH}`,
        "dashboard:",
        `  port: ${DIRECT_DASH}`,
        "discovery:",
        "  enabled: false",
        "identity:",
        "  enabled: false",
        "backends: {}",
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

  test("filterRoutableModelIds keeps active|suspect, drops eol|dead|not_chat", () => {
    const states = {
      "a": { state: "active" },
      "s": { state: "suspect" },
      "e": { state: "eol" },
      "d": { state: "dead" },
      "n": { state: "not_chat" },
    };
    const out = mod.filterRoutableModelIds(["a", "s", "e", "d", "n"], (id) => states[id]);
    assert.deepEqual(out, ["a", "s"]);
  });

  test("writes the union of static + discovered ids, filtered by lifecycle, per provider", () => {
    const backends = {
      nvidia: { models: ["stale-should-be-overwritten"] },
      openrouter: { models: ["stale-should-be-overwritten-2"] },
    };
    const getBackend = (name) => backends[name] || null;
    const lifecycle = {
      "nvidia/static-active": { state: "active" },
      "nvidia/active-1": { state: "active" },
      "nvidia/suspect-1": { state: "suspect" },
      "nvidia/eol-1": { state: "eol" },
      "nvidia/dead-1": { state: "dead" },
      // Card f9e8002b / C14: nvidia/nemotron-parse's shape, a healthy id
      // probe-classified as not serving chat completions.
      "nvidia/notchat-1": { state: "not_chat" },
      "openrouter/active-2": { state: "active" },
      "openrouter/eol-2": { state: "eol" },
    };
    const getLifecycleFn = (id) => lifecycle[id] || { state: "active" };
    const cfg = {
      backends: {
        nvidia: { models: ["nvidia/static-active"] },
        openrouter: { models: [] },
      },
    };
    const catalog = [
      { id: "nvidia/active-1", provider: "nvidia" },
      { id: "nvidia/suspect-1", provider: "nvidia" },
      { id: "nvidia/eol-1", provider: "nvidia" },
      { id: "nvidia/dead-1", provider: "nvidia" },
      { id: "nvidia/notchat-1", provider: "nvidia" },
      { id: "openrouter/active-2", provider: "openrouter" },
      { id: "openrouter/eol-2", provider: "openrouter" },
      { id: "irrelevant-local-1", provider: "local" }, // non nvidia/openrouter: ignored
    ];

    mod.registerDiscoveredRoutes(cfg, catalog, { getBackend, getLifecycleFn });

    assert.deepEqual(
      new Set(backends.nvidia.models),
      new Set(["nvidia/static-active", "nvidia/active-1", "nvidia/suspect-1"]),
    );
    assert.equal(backends.nvidia.models.includes("nvidia/eol-1"), false);
    assert.equal(backends.nvidia.models.includes("nvidia/dead-1"), false);
    assert.equal(backends.nvidia.models.includes("nvidia/notchat-1"), false);
    assert.deepEqual(backends.openrouter.models, ["openrouter/active-2"]);
  });

  test("a provider not present in the discovered catalog this cycle is left untouched", () => {
    const backends = { nvidia: { models: ["kept-as-is"] } };
    const getBackend = (name) => backends[name] || null;
    mod.registerDiscoveredRoutes(
      { backends: { nvidia: { models: ["kept-as-is"] } } },
      [], // empty discovered catalog this cycle
      { getBackend, getLifecycleFn: () => ({ state: "active" }) },
    );
    assert.deepEqual(backends.nvidia.models, ["kept-as-is"]);
  });

  test("all-eol provider: Backend.models ends up empty and gets flagged discovery-managed (wildcard guard)", () => {
    const backends = { openrouter: { models: [], discovery: null } };
    const getBackend = (name) => backends[name] || null;
    mod.registerDiscoveredRoutes(
      { backends: { openrouter: { models: [] } } },
      [{ id: "openrouter/only-eol", provider: "openrouter" }],
      { getBackend, getLifecycleFn: () => ({ state: "eol" }) },
    );
    assert.deepEqual(backends.openrouter.models, []);
    // Backend#supportsModel() treats an empty models array as "wildcard match
    // everything" UNLESS `discovery` is truthy (router.mjs:398); without this
    // flag an all-eol provider would silently start accepting every model id.
    assert.ok(backends.openrouter.discovery, "must be flagged so empty models means 'nothing', not 'everything'");
  });

  test("an authoritative catalog populates its primary and configured fallback", () => {
    const backends = {
      anthropic: { models: [], discovery: "anthropic" },
      "anthropic-direct": { models: [], discovery: "anthropic" },
    };
    mod.registerDiscoveredRoutes(
      { backends: {
        anthropic: { discovery: "anthropic" },
        "anthropic-direct": { discovery: "anthropic" },
      } },
      [{ id: "claude-new", provider: "anthropic" }],
      {
        getBackend: (name) => backends[name],
        // A foreign provider's EOL verdict cannot suppress this claimer.
        getLifecycleFn: () => ({ state: "eol", provider: "opencode" }),
      },
    );
    assert.deepEqual(backends.anthropic.models, ["claude-new"]);
    assert.deepEqual(backends["anthropic-direct"].models, ["claude-new"]);
  });

  test("live discovery models replace cold-start seeds for advertisement", () => {
    const configured = {
      anthropic: { discovery: "anthropic", models: ["claude-live", "claude-retired"] },
      local: { models: ["local-model"] },
    };
    const live = {
      anthropic: { models: ["claude-live", "claude-new"] },
    };
    const effective = mod.effectiveAdvertiseBackends(configured, {
      getBackend: (name) => live[name] || null,
    });
    assert.deepEqual(effective.anthropic.models, ["claude-live", "claude-new"]);
    assert.deepEqual(effective.local.models, ["local-model"]);
  });
});

// ── lifecycleCounts must not silently drop a disposition (card f9e8002b) ──
//
// The bucket list used to be a hand-written literal {active, suspect, eol,
// dead}. Adding `not_chat` meant those models were counted by nobody: the
// hasOwnProperty guard skipped them and the totals quietly stopped reconciling
// against the catalog size. A summary that omits what it cannot describe is the
// same failure this whole epic is about.
test("lifecycleCounts covers every lifecycle state and always reconciles", async () => {
  const { lifecycleCounts } = await import("../src/index.mjs");
  const { LIFECYCLE_STATES } = await import("../src/discovery/lifecycle.mjs");

  const catalog = [
    { id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }, { id: "f" },
  ];
  const states = {
    a: LIFECYCLE_STATES.ACTIVE,
    b: LIFECYCLE_STATES.SUSPECT,
    c: LIFECYCLE_STATES.EOL,
    d: LIFECYCLE_STATES.DEAD,
    e: LIFECYCLE_STATES.NOT_CHAT,
    f: "some-state-from-the-future",
  };
  const counts = lifecycleCounts(catalog, (id) => ({ state: states[id] }));

  assert.equal(counts[LIFECYCLE_STATES.NOT_CHAT], 1, "not_chat must be counted, not skipped");
  assert.equal(counts.unknown, 1, "an unrecognized state must be surfaced, not dropped");

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.equal(total, catalog.length, "counts must reconcile against the catalog size");

  for (const s of Object.values(LIFECYCLE_STATES)) {
    assert.ok(s in counts, `every state in the enum needs a bucket: ${s}`);
  }
});
