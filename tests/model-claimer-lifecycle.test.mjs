/**
 * model-claimer-lifecycle.test.mjs: a backend's explicit declaration of a
 * model id beats a lifecycle verdict the declaration's provider never
 * produced (incident inc-2026-08-18-qwen38-eol / problem
 * prob-2026-08-18-model-discovery-validation).
 *
 * The 2026-08-18 incident: `qwen38-abliterated`, declared under the local
 * chiap08-qwen38 backend (llama.cpp serves it name-agnostically, verified
 * 200), was condemned to eol/provider_410 by 404/410s from NON-claiming
 * backends in a fail-over spray (nvidia answers 404 to an alias it does not
 * host). The EOL record then gated the healthy local door in
 * candidatesFor()'s matched branch, so every request 404'd while the model
 * served fine on chiap08.
 *
 * The fix, covered here:
 *   1. isEffectivelyRoutable (lifecycle.mjs) — the gate only preempts a
 *      claim when the verdict is attributed to the claiming side.
 *   2. recordModelOutcome (model_catalog_store.mjs) — 404/410s from
 *      non-claiming backends no longer count toward the model's EOL.
 *   3. selectProbeCandidates/probeModels (probe.mjs) + declaredModelsElsewhere
 *      (discovery.mjs) — the provider probe sweep skips ids another backend
 *      declares, so one provider's 410 cannot retire a multi-provider or
 *      locally-served id.
 *   4. applyLifecycleView/modelClaimersFor (index.mjs) — the advertised
 *      catalog honors the same rule as the gate.
 *
 * No network: fake upstreams + fully injected fakes, the same conventions as
 * tests/router-eol-gate.test.mjs and tests/router-model-outcome.test.mjs.
 *
 * Run with:  node --test tests/model-claimer-lifecycle.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX_DIR = mkdtempSync(join(tmpdir(), "skgw-claimer-"));
process.env.SKMODELS_REGISTRY = join(FIX_DIR, "nonexistent-registry.yaml");
const STORE_PATH = join(FIX_DIR, "lifecycle-store.json");
process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = STORE_PATH;

// src/index.mjs boots (listens, registers SIGHUP) at module load, so import
// it LAST and only after a hermetic fixture config with unique loopback
// ports is in place — the same pattern as group 2 of
// tests/advertise-lifecycle.test.mjs. The exports under test here
// (applyLifecycleView / modelClaimersFor) are pure; the boot is collateral.
const INDEX_CFG = join(FIX_DIR, "gw.yaml");
writeFileSync(
  INDEX_CFG,
  [
    "server:",
    "  bind: 127.0.0.1",
    "  port: 18971",
    "  dashboard_port: 18972",
    "dashboard:",
    "  port: 18972",
    "discovery:",
    "  enabled: false",
    "metrics:",
    "  enabled: false",
    "identity:",
    "  enabled: false",
    "backends:",
    "  nvidia:",
    "    models: [_claimer-neutral]",
    "",
  ].join("\n"),
);
process.env.SKGATEWAY_CONFIG = INDEX_CFG;

const { isEffectivelyRoutable, defaultLifecycle, LIFECYCLE_STATES } = await import("../src/discovery/lifecycle.mjs");
const { getLifecycle, recordModelOutcome, _resetCacheForTests } = await import("../src/discovery/model_catalog_store.mjs");
const { selectProbeCandidates, probeModels } = await import("../src/discovery/probe.mjs");
const { declaredModelsElsewhere, discoverCatalog } = await import("../src/discovery.mjs");
const indexMod = await import("../src/index.mjs");
const { applyLifecycleView, modelClaimersFor } = indexMod;
const { createRouter, routeAndSend } = await import("../src/proxy/router.mjs");

after(() => {
  // The module-load boot above (server on 18961) keeps the event loop alive;
  // close it explicitly so the test process can exit, the same pattern as
  // group 2 of tests/advertise-lifecycle.test.mjs.
  try { indexMod.server?.close?.(); } catch { /* best effort */ }
  try { indexMod.dashboard?.close?.(); } catch { /* best effort */ }
});

function startUpstream(status) {
  let requestCount = 0;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      requestCount++;
      req.on("data", (c) => c);
      req.on("end", () => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: status < 400 }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(r)),
        get requestCount() { return requestCount; },
      });
    });
  });
}

// ── 1. isEffectivelyRoutable (pure) ─────────────────────────────────────────

describe("isEffectivelyRoutable — the claim-over-verdict rule", () => {
  const eol = (overrides = {}) => ({
    state: LIFECYCLE_STATES.EOL,
    last_verified_at: null,
    consecutive_permanent_errors: 3,
    eol_reason: "provider_410",
    eol_at: 1000,
    ...overrides,
  });

  test("active and suspect are always routable, with or without claimers", () => {
    const active = { ...defaultLifecycle() };
    const suspect = { ...defaultLifecycle(), state: LIFECYCLE_STATES.SUSPECT };
    assert.equal(isEffectivelyRoutable(active, []), true);
    assert.equal(isEffectivelyRoutable(active, ["chiap08-qwen38"]), true);
    assert.equal(isEffectivelyRoutable(suspect, ["chiap08-qwen38"]), true);
    assert.equal(isEffectivelyRoutable(null, []), true, "no record => defaultLifecycle() semantics");
  });

  test("no claimers: eol/dead/not_chat gate exactly as isRoutable did (card P1.6)", () => {
    assert.equal(isEffectivelyRoutable(eol(), []), false);
    assert.equal(isEffectivelyRoutable(eol(), undefined), false);
    assert.equal(isEffectivelyRoutable({ ...eol(), state: LIFECYCLE_STATES.DEAD }, []), false);
    assert.equal(isEffectivelyRoutable({ ...eol(), state: LIFECYCLE_STATES.NOT_CHAT }, []), false);
  });

  test("UNATTRIBUTED verdict (provider null) does not preempt a claim (the qwen38 incident)", () => {
    assert.equal(isEffectivelyRoutable(eol({ provider: null }), ["chiap08-qwen38"]), true);
    assert.equal(isEffectivelyRoutable(eol(), ["chiap08-qwen38"]), true, "a record without the field at all is unattributed too");
  });

  test("verdict against a FOREIGN provider does not preempt a local claim (multi-provider)", () => {
    assert.equal(isEffectivelyRoutable(eol({ provider: "nvidia" }), ["chiap08-qwen38"]), true);
    assert.equal(isEffectivelyRoutable(eol({ provider: "nvidia" }), ["nvidia", "chiap08-qwen38"]), true);
  });

  test("verdict attributed to the ONLY claimer still gates (card C4 production shape)", () => {
    assert.equal(isEffectivelyRoutable(eol({ provider: "nvidia" }), ["nvidia"]), false);
    assert.equal(isEffectivelyRoutable(eol({ provider: "nvidia" }), ["nvidia"]), false);
    assert.equal(isEffectivelyRoutable(eol({ provider: "opencode" }), ["opencode"]), false);
  });

  test("verdict attributed to one claimer among many gates only when ALL claimers are implicated", () => {
    // Two claimers, both equal to the verdict provider is impossible (names
    // are unique), so any second claimer outside the provider rescues.
    assert.equal(isEffectivelyRoutable(eol({ provider: "nvidia" }), ["nvidia", "openrouter"]), true);
    assert.equal(isEffectivelyRoutable(eol({ provider: "nvidia" }), ["openrouter"]), true);
  });
});

// ── 2. recordModelOutcome — claimer-aware permanent errors ─────────────────

describe("recordModelOutcome — non-claimer 404/410s do not count", () => {
  before(() => { _resetCacheForTests(); });

  test("claiming: false, 410 ×3 — the record stays active (the incident's false positive, stopped)", () => {
    const id = `a/noclaim-${Date.now()}`;
    for (let i = 0; i < 3; i++) recordModelOutcome(id, { status: 410, now: Date.now(), claiming: false });
    const lc = getLifecycle(id);
    assert.equal(lc.state, "active");
    assert.equal(lc.consecutive_permanent_errors, 0);
    assert.equal(lc.eol_reason, null);
  });

  test("claiming: false, 404 — also skipped", () => {
    const id = `a/noclaim404-${Date.now()}`;
    for (let i = 0; i < 3; i++) recordModelOutcome(id, { status: 404, now: Date.now(), claiming: false });
    const lc = getLifecycle(id);
    assert.equal(lc.state, "active");
    assert.equal(lc.consecutive_permanent_errors, 0);
  });

  test("claiming: false, 2xx still counts (a success is a success from any door)", () => {
    const id = `a/success-${Date.now()}`;
    recordModelOutcome(id, { status: 200, now: 12345, claiming: false });
    const lc = getLifecycle(id);
    assert.equal(lc.last_verified_at, 12345, "a non-claimer 2xx still verifies the model");
  });

  test("claiming: true, 410 ×3 — the record flips eol (genuinely dead on its claimer)", () => {
    const id = `a/claimer-${Date.now()}`;
    for (let i = 0; i < 3; i++) recordModelOutcome(id, { status: 410, now: Date.now(), claiming: true });
    const lc = getLifecycle(id);
    assert.equal(lc.state, "eol");
    assert.equal(lc.eol_reason, "provider_410");
  });

  test("claiming omitted (legacy callers / unclaimed ids) — original behavior, 410 counts", () => {
    const id = `a/legacy-${Date.now()}`;
    for (let i = 0; i < 3; i++) recordModelOutcome(id, { status: 410, now: Date.now() });
    const lc = getLifecycle(id);
    assert.equal(lc.state, "eol");
  });
});

// ── 3. probe sweep exclusion ────────────────────────────────────────────────

describe("probe sweep — ids claimed by another backend are excluded", () => {
  test("selectProbeCandidates honors excludedIds", () => {
    const store = {
      "solo": { ...defaultLifecycle(), last_verified_at: null },
      "shared": { ...defaultLifecycle(), last_verified_at: null },
      "claimed-elsewhere": { ...defaultLifecycle(), last_verified_at: null },
    };
    const ids = selectProbeCandidates(store, {
      now: Date.now(),
      excludedIds: new Set(["shared", "claimed-elsewhere"]),
    });
    assert.deepEqual(ids, ["solo"]);
  });

  test("probeModels never probes (or mutates) excluded ids", async () => {
    const store = {
      "solo": { ...defaultLifecycle(), last_verified_at: null },
      "shared": { ...defaultLifecycle(), last_verified_at: null },
    };
    const probed = [];
    const out = await probeModels(store, {
      now: Date.now(),
      runProbe: async (id) => { probed.push(id); return { ok: false, status: 410 }; },
      excludedIds: new Set(["shared"]),
    });
    assert.deepEqual(probed, ["solo"], "only the non-excluded id is probed");
    assert.equal(out["shared"].state, "active", "an excluded id keeps its record untouched");
    assert.equal(out["solo"].state, "eol", "the probed id still folds its 410 into lifecycle");
  });

  test("declaredModelsElsewhere: every concrete id declared outside the probe provider, wildcards and self skipped", () => {
    const backends = {
      nvidia: { models: ["qwen/qwen3.5-122b-a10b", "shared-model"] },
      chiap08: { models: ["qwen38-abliterated", "shared-model"] },
      ollama: { models: ["dolphin-*"] },
      opencode: { models: [] },
    };
    const ids = declaredModelsElsewhere("nvidia", backends);
    assert.ok(ids.has("qwen38-abliterated"));
    assert.ok(ids.has("shared-model"), "a model the OTHER backends declare is excluded from nvidia's sweep");
    assert.ok(!ids.has("qwen/qwen3.5-122b-a10b"), "the probe provider's own declarations are not excluded");
    assert.ok(!ids.has("dolphin-*"), "wildcards are patterns, not ids");
    assert.ok(!ids.has("shared-model-x"));
  });

  test("declaredModelsElsewhere is fail-soft: no backends / no config => empty set, never throws", () => {
    assert.deepEqual([...declaredModelsElsewhere("nvidia", {})], []);
    assert.deepEqual([...declaredModelsElsewhere("nvidia", null)], []);
    const live = declaredModelsElsewhere("nvidia"); // no arg => reads the (fixture) config
    assert.ok(live instanceof Set);
  });

  test("discoverCatalog threads probeExcludedIds into the sweep (wired, not documented-only)", async () => {
    // The incident wiring: qwen38-abliterated is tagged nvidia (it could have
    // been declared under both providers) AND declared by chiap08. The
    // sweep must skip it, so nvidia's 410 cannot retire the locally-served
    // alias — while a pure-nvidia long-tail id is still probed.
    const storePath = join(FIX_DIR, `probe-wire-${Date.now()}.json`);
    writeFileSync(storePath, JSON.stringify({
      "shared": { ...defaultLifecycle(), last_verified_at: null, provider: "nvidia" },
      "nvidiasolo": { ...defaultLifecycle(), last_verified_at: null, provider: "nvidia" },
    }));
    const probed = [];
    await discoverCatalog({
      localModels: [],
      nvidiaFetch: async () => ({ data: [] }),
      openrouterFetch: async () => ({ data: [] }),
      opencodeFetch: async () => ({ zen: { data: [] }, modelsDev: null }),
      cache: {},
      now: () => Date.now(),
      lifecycleStorePath: storePath,
      probeSeconds: 86400,
      probeRunProbe: async (id) => { probed.push(id); return { ok: false, status: 410 }; },
      probeExcludedIds: new Set(["shared"]),
      cardOverrides: {},
    });
    assert.ok(probed.includes("nvidiasolo"), "the provider's own long-tail id is still probed");
    assert.ok(!probed.includes("shared"), "the id another backend declares is excluded from this provider's sweep");
  });
});

// ── 4. advertised catalog consistency ───────────────────────────────────────

describe("applyLifecycleView + modelClaimersFor — advertised set matches the gate", () => {
  const eol = { state: "eol", eol_reason: "provider_410", eol_at: 1000 };

  test("modelClaimersFor maps concrete ids to declaring backends, skips wildcards", () => {
    const claimersFor = modelClaimersFor({
      chiap08: { models: ["qwen38-abliterated"] },
      nvidia: { models: ["shared-model"] },
      ollama: { models: ["dolphin-*"] },
    });
    assert.deepEqual(claimersFor("qwen38-abliterated"), ["chiap08"]);
    assert.deepEqual(claimersFor("shared-model"), ["nvidia"]);
    assert.deepEqual(claimersFor("dolphin-9b"), [], "wildcards do not claim concrete ids");
    assert.deepEqual(claimersFor("unknown"), []);
  });

  test("unattributed eol + local claimer => advertised (routable, so offered)", () => {
    const states = { "qwen38-abliterated": { ...eol, provider: null } };
    const out = applyLifecycleView(
      [{ id: "qwen38-abliterated" }, { id: "other" }],
      (id) => states[id] || { state: "active" },
      modelClaimersFor({ chiap08: { models: ["qwen38-abliterated"] } }),
    );
    assert.deepEqual(out.map((m) => m.id), ["qwen38-abliterated", "other"]);
  });

  test("claimer-attributed eol => still hidden (card C4 shape)", () => {
    const states = { "nvidiadead": { ...eol, provider: "nvidia" } };
    const out = applyLifecycleView(
      [{ id: "nvidiadead" }],
      (id) => states[id] || { state: "active" },
      modelClaimersFor({ nvidia: { models: ["nvidiadead"] } }),
    );
    assert.deepEqual(out, []);
  });

  test("no claimersFor (legacy callers) — original isRoutable behavior exactly", () => {
    const states = { "qwen38-abliterated": { ...eol, provider: null } };
    const out = applyLifecycleView([{ id: "qwen38-abliterated" }], (id) => states[id]);
    assert.deepEqual(out, []);
  });
});

// ── 5. router integration: the incident end to end ──────────────────────────

describe("router integration (routeAndSend) — the incident sequence end to end", () => {
  let up410;
  let up200;
  const HEADERS = { "content-type": "application/json" };
  const bodyFor = (model) => Buffer.from(JSON.stringify({ model, messages: [] }));

  before(async () => {
    up410 = await startUpstream(410);
    up200 = await startUpstream(200);
  });
  after(async () => {
    await up410.close();
    await up200.close();
  });

  // The real incident sequence: chiap08 was briefly down, so requests for
  // the alias sprayed onto non-claiming backends (nvidia answered 404/410),
  // those errors accumulated to an EOL record, and the record then gated the
  // healthy local door once chiap08 recovered.
  test("410s from NON-claiming backends (claimer down) do not condemn a locally-claimed model", async () => {
    _resetCacheForTests();
    const modelId = `live/qwen38-${Date.now()}`;
    const router = createRouter({
      backends: {
        // Priority 1, does NOT claim the model — the nvidia door in the
        // incident, which answers 410 to the local alias.
        nvidia: { url: up410.base, auth_type: "none", models: ["some-nvidia-model"], priority: 1 },
        // Priority 3, claims the model — chiap08-qwen38. Quarantined below
        // to simulate the brief local outage that let the spray happen; its
        // DECLARATION is what must protect the record.
        local: {
          url: up410.base, auth_type: "none", models: [modelId], priority: 3,
          quarantine_threshold: 1, quarantine_cooldown_ms: 30_000,
        },
      },
    });

    // Take the claimer out of rotation (one failure quarantines it at the
    // threshold-1 config above).
    router.getBackend("local").recordOutcome(false, 5);
    assert.equal(router.getBackend("local").isAvailable(), false, "fixture: the claimer is down");

    for (let i = 0; i < 3; i++) {
      const r = await routeAndSend(
        router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false
      );
      assert.equal(r.status, 410, "the non-claiming door's own 410 is still what the caller sees");
      assert.equal(r.backendId, "nvidia", "with the claimer down the request sprays to the available non-claimer");
    }

    const lc = getLifecycle(modelId);
    assert.equal(lc.state, "active", "three non-claimer 410s must NOT accumulate toward eol");
    assert.equal(lc.consecutive_permanent_errors, 0);
  });

  test("410s from the CLAIMING backend still condemn (genuinely dead on its only claimer)", async () => {
    _resetCacheForTests();
    const modelId = `live/dead-${Date.now()}`;
    const router = createRouter({
      backends: {
        local: { url: up410.base, auth_type: "none", models: [modelId], priority: 1 },
      },
    });

    for (let i = 0; i < 3; i++) {
      await routeAndSend(
        router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false
      );
    }

    const lc = getLifecycle(modelId);
    assert.equal(lc.state, "eol", "claimer 410s keep counting — dead-on-its-only-claimer is still detected");
    assert.equal(lc.eol_reason, "provider_410");
  });

  test("a residual eol verdict does not preempt a healthy claimer (incident AC1)", async () => {
    _resetCacheForTests();
    const modelId = `live/rescued-${Date.now()}`;

    // The incident's residual state: the record is already eol — under the
    // OLD behavior the spray 404/410s accumulated it (under the new
    // behavior they don't, which is the fix) — unattributed, exactly as
    // completion-path records are. The healthy claimer is back.
    for (let i = 0; i < 3; i++) {
      recordModelOutcome(modelId, { status: 410, now: Date.now(), claiming: true });
    }
    _resetCacheForTests();
    assert.equal(getLifecycle(modelId).state, "eol", "fixture: the residual incident record");
    assert.equal(getLifecycle(modelId).provider, undefined, "completion-path records carry no provider tag at all");

    const router = createRouter({
      backends: {
        local: { url: up200.base, auth_type: "none", models: [modelId], priority: 3 },
        nvidia: { url: up410.base, auth_type: "none", models: ["some-nvidia-model"], priority: 1 },
      },
    });

    // Before the fix this request died at the gate: a clean 404 +
    // eol_reason, no backend attempted (card C4's matched-branch gate, which
    // is what trapped qwen38-abliterated while chiap08 served it fine).
    const r = await routeAndSend(
      router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false
    );
    assert.equal(r.status, 200, "qwen38-abliterated resolves to 200 through skgateway without EOL gating");
    assert.equal(r.backendId, "local", "it lands on the healthy claiming backend, not a 404 gate");
  });
});
