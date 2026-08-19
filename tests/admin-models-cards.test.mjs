/**
 * admin-models-cards.test.mjs: expose cards + lifecycle on /admin/models and
 * add additive picker badges to /v1/models (card P2.4).
 *
 * Card P2.1 already merges each nvidia/openrouter discovered entry with a
 * `card` object (src/discovery/providers/{nvidia,openrouter}.mjs) and card
 * P1.4 already hides eol/dead ids from /v1/models via applyLifecycleView.
 * This card's job is narrow: (1) /admin/models must additionally surface the
 * full `lifecycle` record per model (not just the allowlist `advertised`
 * flag it already returns), and (2) /v1/models must gain three ADDITIVE
 * badge fields derived from `card` (`ctx_tokens`, `tools`, `vision`) as a
 * strict superset: no existing field removed or renamed, so the skchat
 * picker (which reads id/provider/free/owned_by/status) keeps working
 * unchanged.
 *
 * Two groups, mirroring tests/advertise-lifecycle.test.mjs:
 *
 *   1. Direct-import (hermetic: discovery disabled, unique loopback ports,
 *      SKGATEWAY_MODEL_CATALOG_STORE_PATH redirected to a temp fixture) to
 *      obtain the exported pure helpers (deriveModelBadges,
 *      applyPickerBadges, buildAdminModelsView) AND the module's own live
 *      HTTP listener, so both the pure-function contracts and the actual
 *      wired-up endpoint shapes are asserted from one boot.
 *
 * Run with:  node --test tests/admin-models-cards.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(__dirname, "..", "src", "index.mjs");

const PORT = 18961, DASH = 18962;

describe("card P2.4: /admin/models cards+lifecycle, /v1/models picker badges", () => {
  let mod;
  let tmpDir;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "skgw-p24-"));
    const cfgPath = join(tmpDir, "gw.yaml");
    const storePath = join(tmpDir, "model_catalog_store.json");

    writeFileSync(
      storePath,
      JSON.stringify({
        "p24-suspect-1": {
          state: "suspect",
          last_verified_at: null,
          consecutive_permanent_errors: 0,
          absent_cycles: 1,
          eol_reason: null,
          eol_at: null,
        },
        "p24-eol-1": {
          state: "eol",
          last_verified_at: null,
          consecutive_permanent_errors: 3,
          absent_cycles: 0,
          eol_reason: "provider_410",
          eol_at: 1000,
          // 2026-08-18 (incident inc-2026-08-18-qwen38-eol): declared by the
          // `local` backend below, so the verdict is attributed to the
          // claimer to keep pinning "eol id hidden from /v1/models". An
          // unattributed verdict on a claimed id is rescued by the claim
          // (see tests/model-claimer-lifecycle.test.mjs).
          provider: "local",
        },
      }),
    );

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
        "  nvidia:",
        "    models: [_p24-neutral]",
        "  anthropic:",
        "    models: [_p24-neutral]",
        "  ollama:",
        "    models: [_p24-neutral]",
        "  openrouter:",
        "    models: []",
        "  local:",
        "    url: http://127.0.0.1:1/v1",
        "    auth_type: none",
        "    priority: 1",
        "    models:",
        "      - p24-active-1",
        "      - p24-suspect-1",
        "      - p24-eol-1",
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

  // ── Pure helper: deriveModelBadges ──

  test("deriveModelBadges: derives ctx_tokens/tools/vision from a full card", () => {
    const card = {
      context_length: 131072,
      supported_parameters: ["tools", "tool_choice", "structured_outputs"],
      modality: "text+image->text",
    };
    assert.deepEqual(mod.deriveModelBadges(card), {
      ctx_tokens: 131072,
      tools: true,
      vision: true,
    });
  });

  test("deriveModelBadges: tools false and vision false when declared absent", () => {
    const card = {
      context_length: 8192,
      supported_parameters: ["structured_outputs"],
      modality: "text->text",
    };
    assert.deepEqual(mod.deriveModelBadges(card), {
      ctx_tokens: 8192,
      tools: false,
      vision: false,
    });
  });

  test("deriveModelBadges: {} for a heuristic NVIDIA card with no declared ctx", () => {
    // nvidia.mjs's normalize() emits context_length:null, supported_parameters:[]
    // (design 6.1 basis honesty: never claim a fact the provider didn't declare).
    const card = { context_length: null, supported_parameters: [], modality: "text->text", source: "heuristic" };
    assert.deepEqual(mod.deriveModelBadges(card), { tools: false, vision: false });
  });

  test("deriveModelBadges: {} when there is no card at all (local backend entry)", () => {
    assert.deepEqual(mod.deriveModelBadges(undefined), {});
    assert.deepEqual(mod.deriveModelBadges(null), {});
  });

  // ── Pure helper: applyPickerBadges (superset proof) ──

  test("applyPickerBadges: is a strict superset, no existing field removed or renamed", () => {
    const preChangeShape = {
      id: "openrouter/free-model-x",
      object: "model",
      created: 0,
      owned_by: "openrouter",
      provider: "openrouter",
      free: true,
      card: {
        context_length: 65536,
        supported_parameters: ["tools"],
        modality: "text->text",
      },
    };
    const [out] = mod.applyPickerBadges([preChangeShape]);
    // Every pre-change key must survive with its original value.
    for (const [k, v] of Object.entries(preChangeShape)) {
      assert.deepEqual(out[k], v, `field ${k} must be preserved unchanged`);
    }
    // New additive badges.
    assert.equal(out.ctx_tokens, 65536);
    assert.equal(out.tools, true);
    assert.equal(out.vision, false);
  });

  test("applyPickerBadges: entries without a card pass through with no badge keys added", () => {
    const localEntry = { id: "ornith-1.0-9b", object: "model", created: 0, owned_by: "local" };
    const [out] = mod.applyPickerBadges([localEntry]);
    assert.deepEqual(out, localEntry);
    assert.equal("ctx_tokens" in out, false);
    assert.equal("tools" in out, false);
    assert.equal("vision" in out, false);
  });

  // ── Pure helper: stripInternalCardFields (public-safe /v1/models) ──

  test("stripInternalCardFields: drops internal card notes, keeps the public-safe fields", () => {
    const entry = {
      id: "claude-opus-4-8", object: "model", provider: "anthropic",
      card: {
        display_name: "Claude Opus 4.8", summary: "flagship", good_at: ["reasoning"],
        tier: "paid-cloud", context_length: 500000, supported_parameters: ["tools"],
        notes: "costs real money, keep the tier ladder tight",
      },
    };
    const [out] = mod.stripInternalCardFields([entry]);
    assert.equal("notes" in out.card, false, "notes is internal, must not reach /v1/models");
    assert.equal(out.card.display_name, "Claude Opus 4.8");
    assert.equal(out.card.summary, "flagship");
    assert.deepEqual(out.card.good_at, ["reasoning"]);
    assert.equal(out.card.tier, "paid-cloud");
    assert.equal(out.id, "claude-opus-4-8");        // non-card fields untouched
    assert.equal(entry.card.notes !== undefined, true, "does not mutate the input");
  });

  test("stripInternalCardFields: a card-less entry passes through untouched", () => {
    const e = { id: "x", object: "model", owned_by: "local" };
    assert.deepEqual(mod.stripInternalCardFields([e])[0], e);
  });

  // ── Pure helper: buildAdminModelsView ──

  test("buildAdminModelsView: each entry gains a full lifecycle record, keeps card+advertised", () => {
    const full = [
      { id: "openrouter/free-model-x", provider: "openrouter", free: true, card: { context_length: 1000 } },
      { id: "p24-suspect-1", provider: "local", free: true },
    ];
    const lifecycle = {
      "openrouter/free-model-x": { state: "active", last_verified_at: 5, consecutive_permanent_errors: 0, absent_cycles: 0, eol_reason: null, eol_at: null },
      "p24-suspect-1": { state: "suspect", last_verified_at: null, consecutive_permanent_errors: 0, absent_cycles: 1, eol_reason: null, eol_at: null },
    };
    const getLifecycleFn = (id) => lifecycle[id];
    const data = mod.buildAdminModelsView(full, [], getLifecycleFn);

    const a = data.find((m) => m.id === "openrouter/free-model-x");
    assert.deepEqual(a.card, { context_length: 1000 });
    assert.deepEqual(a.lifecycle, lifecycle["openrouter/free-model-x"]);
    assert.equal(a.advertised, true); // empty allowlist => everything advertised

    const s = data.find((m) => m.id === "p24-suspect-1");
    assert.equal(s.lifecycle.state, "suspect");
  });

  test("buildAdminModelsView: `advertised` still respects a non-empty allowlist", () => {
    const full = [{ id: "a" }, { id: "b" }];
    const data = mod.buildAdminModelsView(full, ["a"], () => ({ state: "active" }));
    assert.equal(data.find((m) => m.id === "a").advertised, true);
    assert.equal(data.find((m) => m.id === "b").advertised, false);
  });

  // ── Live endpoint wiring: GET /admin/models ──

  test("GET /admin/models: every entry carries a lifecycle object, suspect/eol reflected", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/admin/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data) && body.data.length > 0);
    for (const m of body.data) {
      assert.equal(typeof m.lifecycle, "object", `entry ${m.id} must carry a lifecycle object`);
      assert.ok(m.lifecycle !== null);
      assert.ok("state" in m.lifecycle);
    }
    const suspect = body.data.find((m) => m.id === "p24-suspect-1");
    assert.ok(suspect, "p24-suspect-1 must still be present in /admin/models (eol/dead hiding is a /v1/models concern)");
    assert.equal(suspect.lifecycle.state, "suspect");
    const eol = body.data.find((m) => m.id === "p24-eol-1");
    assert.ok(eol, "eol id stays visible in the admin view (unlike /v1/models)");
    assert.equal(eol.lifecycle.state, "eol");
  });

  // ── Live endpoint wiring: GET /v1/models stays a superset ──

  test("GET /v1/models: pre-existing fields untouched, eol id hidden, active id present", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/models`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const ids = body.data.map((m) => m.id);
    assert.ok(ids.includes("p24-active-1"));
    assert.ok(ids.includes("p24-suspect-1"));
    assert.equal(ids.includes("p24-eol-1"), false);

    const active = body.data.find((m) => m.id === "p24-active-1");
    // Pre-existing /v1/models fields (buildModelCatalog + mergeDiscoveredCatalog
    // shape) must still be exactly what they were before this card.
    assert.equal(active.object, "model");
    assert.equal(active.owned_by, "local");
    assert.equal(active.provider, "local");
    assert.equal(active.free, true);
  });
});
