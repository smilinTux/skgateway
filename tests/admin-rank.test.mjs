/**
 * admin-rank.test.mjs (card P3.3): GET /admin/models/rank, the suggest-only
 * rank API.
 *
 * Wraps the pure P3.2 ranker (src/ranking/rank.mjs) behind a loopback-only
 * admin route that accepts either a registry `@match` role name (looked up
 * in registry.yaml's `requirements:` block) or an inline `require=` spec,
 * and returns the ranked chain + breakdowns. ROUTES NOTHING: no candidate
 * loop, no upstream call, no completion is ever triggered.
 *
 * One boot (mirrors tests/admin-models-cards.test.mjs), two kinds of
 * assertions off it:
 *   1. Pure unit tests on the exported query-parsing/catalog-assembly
 *      helpers (parseRequireSpec, loadRoleRequirements,
 *      resolveRankRequirements, buildRankCatalog, isLoopback).
 *   2. Live endpoint wiring: role vs require query parsing, shape, and a
 *      fake upstream proving zero requests are ever made (no routing).
 *
 * Run with:  node --test tests/admin-rank.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(__dirname, "..", "src", "index.mjs");

const PORT = 18971, DASH = 18972;

describe("card P3.3: GET /admin/models/rank (suggest-only rank API)", () => {
  let mod;
  let tmpDir;
  let upstream;
  let upstreamRequestCount = 0;
  let reqFixturePath;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "skgw-p33-"));
    const cfgPath = join(tmpDir, "gw.yaml");
    const regPath = join(tmpDir, "registry.yaml");
    const storePath = join(tmpDir, "model_catalog_store.json");
    reqFixturePath = join(tmpDir, "reg-with-requirements.yaml");
    writeFileSync(
      reqFixturePath,
      [
        "requirements:",
        "  sk-tools:",
        "    require:",
        "      tool_use: true",
        "      min_ctx: 32768",
        "    prefer:",
        "      - sovereign",
        "      - success_rate",
        "    tier:",
        "      - local",
        "      - free-remote",
        "",
      ].join("\n"),
    );

    // A fake "local" backend upstream. If /admin/models/rank ever actually
    // routed a completion, this counter would move; the live tests below
    // assert it stays at 0 across every rank call made in this suite.
    upstream = await new Promise((res) => {
      const server = http.createServer((req, r) => {
        upstreamRequestCount++;
        r.writeHead(200, { "content-type": "application/json" });
        r.end(JSON.stringify({ ok: true }));
      });
      server.listen(0, "127.0.0.1", () => res(server));
    });
    const upstreamPort = upstream.address().port;

    writeFileSync(
      storePath,
      JSON.stringify({
        "p33-active-1": {
          state: "active",
          last_verified_at: 5,
          consecutive_permanent_errors: 0,
          absent_cycles: 0,
          eol_reason: null,
          eol_at: null,
        },
        "p33-eol-1": {
          state: "eol",
          last_verified_at: null,
          consecutive_permanent_errors: 3,
          absent_cycles: 0,
          eol_reason: "provider_410",
          eol_at: 1000,
        },
      }),
    );

    writeFileSync(
      regPath,
      [
        "requirements:",
        "  p33-rank-role:",
        "    require: {}",
        "    prefer: [success_rate]",
        "    tier: [free-remote]",
        "",
      ].join("\n"),
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
        "    models: [_p33-neutral]",
        "  anthropic:",
        "    models: [_p33-neutral]",
        "  ollama:",
        "    models: [_p33-neutral]",
        "  openrouter:",
        "    models: []",
        "  local:",
        `    url: http://127.0.0.1:${upstreamPort}/v1`,
        "    auth_type: none",
        "    priority: 1",
        "    models:",
        "      - p33-active-1",
        "      - p33-eol-1",
        "",
      ].join("\n"),
    );

    process.env.SKGATEWAY_CONFIG = cfgPath;
    process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = storePath;
    process.env.SKMODELS_REGISTRY = regPath;
    mod = await import(pathToFileURL(INDEX).href);
  });

  after(() => {
    delete process.env.SKGATEWAY_CONFIG;
    delete process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH;
    delete process.env.SKMODELS_REGISTRY;
    try { mod.server.close(); } catch { /* best effort */ }
    try { mod.dashboard?.close?.(); } catch { /* best effort */ }
    try { upstream.close(); } catch { /* best effort */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // ── Pure helper: parseRequireSpec ──

  test("parseRequireSpec: empty/undefined spec yields an empty require block", () => {
    assert.deepEqual(mod.parseRequireSpec(""), { require: {} });
    assert.deepEqual(mod.parseRequireSpec(undefined), { require: {} });
    assert.deepEqual(mod.parseRequireSpec(null), { require: {} });
  });

  test("parseRequireSpec: bare token -> require.<token> = true", () => {
    assert.deepEqual(mod.parseRequireSpec("tool_use"), { require: { tool_use: true } });
  });

  test("parseRequireSpec: key=number -> require.<key> = Number(value)", () => {
    assert.deepEqual(mod.parseRequireSpec("min_ctx=64000"), { require: { min_ctx: 64000 } });
  });

  test("parseRequireSpec: tier=a|b -> top-level tier array, not in require", () => {
    const out = mod.parseRequireSpec("tier=local|free-remote");
    assert.deepEqual(out.tier, ["local", "free-remote"]);
    assert.deepEqual(out.require, {});
  });

  test("parseRequireSpec: prefer=a|b -> top-level prefer array", () => {
    const out = mod.parseRequireSpec("prefer=sovereign|success_rate|tool_use");
    assert.deepEqual(out.prefer, ["sovereign", "success_rate", "tool_use"]);
  });

  test("parseRequireSpec: full design-doc grammar example, all at once", () => {
    const out = mod.parseRequireSpec("tool_use,min_ctx=64000,tier=local|free-remote");
    assert.deepEqual(out, {
      require: { tool_use: true, min_ctx: 64000 },
      tier: ["local", "free-remote"],
    });
  });

  test("parseRequireSpec: non-numeric value stays a string", () => {
    const out = mod.parseRequireSpec("provider=nvidia");
    assert.deepEqual(out.require, { provider: "nvidia" });
  });

  // ── Pure helper: loadRoleRequirements ──

  test("loadRoleRequirements: returns the role's block from a fixture registry", () => {
    const out = mod.loadRoleRequirements("sk-tools", reqFixturePath);
    assert.deepEqual(out, {
      require: { tool_use: true, min_ctx: 32768 },
      prefer: ["sovereign", "success_rate"],
      tier: ["local", "free-remote"],
    });
  });

  test("loadRoleRequirements: unknown role -> null", () => {
    assert.equal(mod.loadRoleRequirements("no-such-role", reqFixturePath), null);
  });

  test("loadRoleRequirements: missing/malformed registry file -> null (fail-soft)", () => {
    assert.equal(mod.loadRoleRequirements("sk-tools", join(tmpDir, "nonexistent.yaml")), null);
  });

  // ── Pure helper: resolveRankRequirements ──

  test("resolveRankRequirements: role only, resolves via injected lookup", () => {
    const fakeReqs = { require: { tool_use: true }, prefer: ["success_rate"] };
    const out = mod.resolveRankRequirements(
      { role: "sk-tools", require: null },
      { loadRoleRequirementsFn: (role) => (role === "sk-tools" ? fakeReqs : null) },
    );
    assert.deepEqual(out, { requirements: fakeReqs, role: "sk-tools" });
  });

  test("resolveRankRequirements: require only, parses the inline spec", () => {
    const out = mod.resolveRankRequirements({ role: null, require: "tool_use,min_ctx=8000" });
    assert.deepEqual(out.requirements, { require: { tool_use: true, min_ctx: 8000 } });
    assert.equal(out.role, undefined);
    assert.equal(out.error, undefined);
  });

  test("resolveRankRequirements: unknown role -> error, no requirements", () => {
    const out = mod.resolveRankRequirements(
      { role: "ghost-role", require: null },
      { loadRoleRequirementsFn: () => null },
    );
    assert.ok(out.error);
    assert.equal(out.requirements, undefined);
  });

  test("resolveRankRequirements: neither role nor require -> error", () => {
    const out = mod.resolveRankRequirements({ role: null, require: null });
    assert.ok(out.error);
  });

  test("resolveRankRequirements: both role and require -> error", () => {
    const out = mod.resolveRankRequirements({ role: "sk-tools", require: "tool_use" });
    assert.ok(out.error);
  });

  // ── Pure helper: buildRankCatalog ──

  test("buildRankCatalog: attaches lifecycle + capabilities via injected lookups", () => {
    const full = [
      { id: "model-a", provider: "openrouter", free: true, card: { supported_parameters: ["tools"] } },
      { id: "model-b", provider: "local", free: true },
    ];
    const lifecycleById = {
      "model-a": { state: "active" },
      "model-b": { state: "eol" },
    };
    const out = mod.buildRankCatalog(full, {
      getLifecycleFn: (id) => lifecycleById[id],
      deriveCapabilitiesFn: (entry) => ({ tag: entry.id }),
    });
    assert.equal(out.length, 2);
    const a = out.find((m) => m.id === "model-a");
    assert.deepEqual(a.lifecycle, { state: "active" });
    assert.deepEqual(a.capabilities, { tag: "model-a" });
    // Original fields survive (card, provider, free): additive, not replaced.
    assert.deepEqual(a.card, { supported_parameters: ["tools"] });
    assert.equal(a.free, true);
    const b = out.find((m) => m.id === "model-b");
    assert.deepEqual(b.lifecycle, { state: "eol" });
  });

  // ── Pure helper: isLoopback (the gate every /admin/models* route shares) ──

  test("isLoopback: true for 127.0.0.1 / ::1 / ::ffff:127.0.0.1", () => {
    assert.equal(mod.isLoopback({ socket: { remoteAddress: "127.0.0.1" } }), true);
    assert.equal(mod.isLoopback({ socket: { remoteAddress: "::1" } }), true);
    assert.equal(mod.isLoopback({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  });

  test("isLoopback: false for a remote/external address, and when socket info is missing", () => {
    assert.equal(mod.isLoopback({ socket: { remoteAddress: "10.20.30.40" } }), false);
    assert.equal(mod.isLoopback({ socket: { remoteAddress: "203.0.113.9" } }), false);
    assert.equal(mod.isLoopback({ socket: {} }), false);
    assert.equal(mod.isLoopback({}), false);
  });

  // ── Live endpoint: GET /admin/models/rank ──

  test("GET /admin/models/rank?role=<role>: 200, ranked chain, eol excluded, active present", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/admin/models/rank?role=p33-rank-role`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.role, "p33-rank-role");
    assert.deepEqual(body.requirements, { require: {}, prefer: ["success_rate"], tier: ["free-remote"] });
    assert.ok(Array.isArray(body.chain));

    const active = body.chain.find((m) => m.id === "p33-active-1");
    assert.ok(active, "active model must appear in the chain");
    assert.equal(active.excluded_reason, null);
    assert.equal(typeof active.rank, "number");
    assert.ok(active.breakdown && typeof active.breakdown === "object");

    const eol = body.chain.find((m) => m.id === "p33-eol-1");
    assert.ok(eol, "excluded entries are still returned (not dropped), per rank.mjs contract");
    assert.equal(eol.rank, null);
    assert.equal(eol.excluded_reason, "lifecycle:eol");
  });

  test("GET /admin/models/rank?require=...: 200, inline spec parsed and used, no role in body", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/admin/models/rank?require=tier%3Dfree-remote`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.role, null);
    assert.deepEqual(body.requirements, { require: {}, tier: ["free-remote"] });
    assert.ok(Array.isArray(body.chain));
  });

  test("GET /admin/models/rank with neither role nor require: 400", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/admin/models/rank`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error && body.error.message);
  });

  test("GET /admin/models/rank?role=<unknown>: 400, no chain computed", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/admin/models/rank?role=nonexistent-role-xyz`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error && body.error.message);
    assert.equal(body.chain, undefined);
  });

  test("GET /admin/models/rank?role=<role>&require=...: 400, mutually exclusive", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/admin/models/rank?role=p33-rank-role&require=tool_use`);
    assert.equal(res.status, 400);
  });

  test("never routes anything: the fake upstream saw zero requests across every rank call above", () => {
    assert.equal(upstreamRequestCount, 0, "GET /admin/models/rank must never trigger a completion");
  });
});
