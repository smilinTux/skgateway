/**
 * router-match.test.mjs (card P4.2): the `@match` routing branch + decision-
 * cache epoch composition in routeAndSend().
 *
 * resolve() (card P4.1) returns a `{ match:true, role, requirements }` marker
 * for a role whose target is "@match". This card wires that marker into the
 * ranked candidate chain (design 7.2): rank the discovered catalog against
 * the role's requirements (rank.mjs, P3.2), map the top-K ranked ids onto
 * the EXISTING candidates array via router.route() + the same bodyOverride
 * model-rewrite mechanism the cloud-fallback candidate already uses, so
 * failover/quarantine/pool all apply unchanged.
 *
 * The whole branch is gated behind config `routing.match_enabled` (default
 * OFF): with the flag off, an `@match` role must be byte-identical to
 * today's fallback (no rank call, no new candidates, no added latency).
 *
 * Run with:  node --test tests/router-match.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same convention as tests/router-eol-gate.test.mjs / router-model-outcome.test.mjs:
// pin every path-based store to an isolated fixture BEFORE importing router.mjs,
// which captures each one as a module-level constant at import time.
const FIX_DIR = mkdtempSync(join(tmpdir(), "skgw-router-match-"));
const REGISTRY_PATH = join(FIX_DIR, "registry.yaml");
const STORE_PATH = join(FIX_DIR, "model_catalog_store.json");
const CATALOG_CACHE_PATH = join(FIX_DIR, "model_catalog_cache.json");

process.env.SKMODELS_REGISTRY = REGISTRY_PATH;
process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = STORE_PATH;
process.env.SKGATEWAY_MODEL_CATALOG_CACHE_PATH = CATALOG_CACHE_PATH;

const { createRouter, routeAndSend, _matchDecisionCacheStats, _resetMatchDecisionCacheForTests } =
  await import("../src/proxy/router.mjs");
const { loadConfig } = await import("../src/config.mjs");
const { _resetCacheForTests } = await import("../src/discovery/model_catalog_store.mjs");

function writeRegistry(yaml) {
  writeFileSync(REGISTRY_PATH, yaml, "utf8");
}

function writeCatalog(models) {
  writeFileSync(CATALOG_CACHE_PATH, JSON.stringify({ models }), "utf8");
}

function writeStore(obj) {
  writeFileSync(STORE_PATH, JSON.stringify(obj), "utf8");
}

const MATCH_REGISTRY = `roles:
  sk-match: "@match"
requirements:
  sk-match:
    require: {}
    prefer: [sovereign]
    tier: [local, free-remote]
`;

/** A tiny upstream whose response status is mutable via a shared ref (so one
 * server can play "healthy" in one test and "down" in the next). */
function startUpstream() {
  const ref = { status: 200 };
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(ref.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolvePromise({
        base: `http://127.0.0.1:${port}/v1`,
        ref,
        close: () => new Promise((r) => server.close(r)),
        get requestCount() { return requestCount; },
      });
    });
  });
}

const HEADERS = { "content-type": "application/json" };
const MESSAGES = [{ role: "user", content: "hello from router-match test" }];
const bodyFor = (model) => Buffer.from(JSON.stringify({ model, messages: MESSAGES }));

function matchRequest(extra = {}) {
  return { role: "sk-match", agentId: "test", messages: MESSAGES, ...extra };
}

describe("router @match routing branch (card P4.2)", () => {
  let primaryUp;
  let secondaryUp;

  before(async () => {
    primaryUp = await startUpstream();
    secondaryUp = await startUpstream();
  });

  after(async () => {
    await primaryUp.close();
    await secondaryUp.close();
  });

  function makeRouter() {
    return createRouter({
      backends: {
        primary: { url: primaryUp.base, auth_type: "none", models: ["match-primary"], priority: 1 },
        secondary: { url: secondaryUp.base, auth_type: "none", models: ["match-secondary"], priority: 1 },
      },
    });
  }

  test("flag OFF (config never loaded): @match role is inert, byte-identical to no-role fallback", async () => {
    _resetCacheForTests();
    writeRegistry(MATCH_REGISTRY);
    // Populate a catalog that WOULD rank if the flag were on, to prove it is
    // never even read while the flag is off.
    writeCatalog([{ id: "match-primary", provider: "local", free: true, card: { tier: "local" } }]);
    primaryUp.ref.status = 200;
    secondaryUp.ref.status = 200;

    const router = makeRouter();
    const before_ = primaryUp.requestCount + secondaryUp.requestCount;

    // Case A: the @match role, flag off.
    const a = await routeAndSend(
      router,
      matchRequest({ model: "probe-unmatched-model" }),
      "/chat/completions", "POST", HEADERS, bodyFor("probe-unmatched-model"), false,
    );

    // Case B: an equivalent request with NO registry role/context/service at
    // all (isRegistryRouted() is false), same unmatched model id. Both must
    // fall through to the exact same candidatesFor() "no explicit match"
    // path and produce an identical result.
    const b = await routeAndSend(
      router,
      { agentId: "test", model: "probe-unmatched-model" },
      "/chat/completions", "POST", HEADERS, bodyFor("probe-unmatched-model"), false,
    );

    assert.equal(a.status, b.status);
    assert.equal(a.backendId, b.backendId);
    assert.equal(a.body.toString("utf-8"), b.body.toString("utf-8"));
    // Neither request may widen an unknown id to an unrelated backend.
    assert.equal(a.status, 404);
    assert.equal(primaryUp.requestCount + secondaryUp.requestCount, before_);
  });

  test("flag ON: ranked chain builds candidates + failover across the chain works", async () => {
    _resetCacheForTests();
    writeRegistry(MATCH_REGISTRY);
    writeStore({});
    writeCatalog([
      { id: "match-primary", provider: "local", free: true, card: { tier: "local" } },
      { id: "match-secondary", provider: "nvidia", free: true, card: { tier: "free-remote" } },
    ]);

    await loadConfig({
      configPath: writeGatewayConfigFixture({ match_enabled: true }),
      silent: true,
    });

    // Top-ranked (tier "local") is match-primary -> backend "primary". Make
    // it fail so the SAME candidate loop that already exists fails over to
    // the next ranked candidate, match-secondary -> backend "secondary".
    primaryUp.ref.status = 500;
    secondaryUp.ref.status = 200;

    const router = makeRouter();
    const beforePrimary = primaryUp.requestCount;
    const beforeSecondary = secondaryUp.requestCount;

    const r = await routeAndSend(
      router, matchRequest(), "/chat/completions", "POST", HEADERS, bodyFor("sk-match"), false,
    );

    assert.equal(primaryUp.requestCount, beforePrimary + 1, "top-ranked candidate was tried first");
    assert.equal(secondaryUp.requestCount, beforeSecondary + 1, "failed over to the next ranked candidate");
    assert.equal(r.status, 200);
    assert.equal(r.backendId, "secondary");
    assert.equal(r.failover, true);
  });

  test("flag ON, everything excluded from the rank: falls back to default routing instead of crashing", async () => {
    _resetCacheForTests();
    writeRegistry(`roles:
  sk-match-strict: "@match"
requirements:
  sk-match-strict:
    require: { tool_use: true }
    prefer: [sovereign]
    tier: [local, free-remote]
`);
    writeStore({});
    // No catalog entry declares tool_use support -> every entry is excluded
    // by the ranker's require:tool_use filter.
    writeCatalog([{ id: "match-primary", provider: "local", free: true, card: { tier: "local" } }]);

    await loadConfig({
      configPath: writeGatewayConfigFixture({ match_enabled: true }),
      silent: true,
    });

    primaryUp.ref.status = 200;
    secondaryUp.ref.status = 200;

    const router = makeRouter();
    const r = await routeAndSend(
      router,
      { role: "sk-match-strict", agentId: "test", messages: MESSAGES, model: "match-primary" },
      "/chat/completions", "POST", HEADERS, bodyFor("match-primary"), false,
    );

    // No crash (no null return), and the request still gets served by
    // falling back to the router's default resolution.
    assert.ok(r && typeof r.status === "number");
    assert.equal(r.status, 200);
  });

  test("catalog mtime bump invalidates a cached @match decision (epoch composition)", async () => {
    _resetCacheForTests();
    _resetMatchDecisionCacheForTests();
    writeRegistry(MATCH_REGISTRY);
    writeStore({});

    await loadConfig({
      configPath: writeGatewayConfigFixture({ match_enabled: true }),
      silent: true,
    });

    primaryUp.ref.status = 200;
    secondaryUp.ref.status = 200;

    // v1: match-primary is tier "local" (ranked #1) -> backend "primary".
    writeCatalog([
      { id: "match-primary", provider: "local", free: true, card: { tier: "local" } },
      { id: "match-secondary", provider: "nvidia", free: true, card: { tier: "free-remote" } },
    ]);

    const router = makeRouter();
    const r1 = await routeAndSend(
      router, matchRequest(), "/chat/completions", "POST", HEADERS, bodyFor("sk-match"), false,
    );
    assert.equal(r1.backendId, "primary", "first call ranks match-primary on top");
    const afterR1 = _matchDecisionCacheStats();
    assert.equal(afterR1.misses, 1, "first call is a cache miss (nothing ranked yet)");

    // Same request again, catalog UNCHANGED -> same epoch -> must be served
    // from the cache (a hit, not a second miss/re-rank).
    const r2 = await routeAndSend(
      router, matchRequest(), "/chat/completions", "POST", HEADERS, bodyFor("sk-match"), false,
    );
    assert.equal(r2.backendId, "primary");
    const afterR2 = _matchDecisionCacheStats();
    assert.equal(afterR2.misses, 1, "identical request under the same epoch is a cache HIT, not a re-rank");
    assert.equal(afterR2.hits, afterR1.hits + 1);

    // v2: flip the tiers (match-secondary now "local"). Writing the catalog
    // file bumps ITS OWN mtime, which is exactly the "catalog store mtime"
    // half of the epoch composition -> the cached decision is invalidated.
    writeCatalog([
      { id: "match-primary", provider: "local", free: true, card: { tier: "free-remote" } },
      { id: "match-secondary", provider: "nvidia", free: true, card: { tier: "local" } },
    ]);
    const r3 = await routeAndSend(
      router, matchRequest(), "/chat/completions", "POST", HEADERS, bodyFor("sk-match"), false,
    );
    assert.equal(r3.backendId, "secondary", "after the catalog-mtime bump, the fresh (already-updated) catalog is ranked");
    const afterR3 = _matchDecisionCacheStats();
    assert.equal(afterR3.misses, 2, "the catalog mtime bump forced a fresh rank (a second miss)");
  });
});

/** Minimal valid skgateway.yaml fixture (defaults cover the rest) with a
 * `routing:` override, written to a fresh temp file each call. */
let _cfgSeq = 0;
/**
 * The gateway config fixture MUST zero the DEFAULTS' backend model lists.
 *
 * buildMatchCatalog() now unions the discovery cache with the models the
 * config declares the gateway SERVES, which is the whole point of that change:
 * a model on /v1/models must be matchable. config.mjs's DEFAULTS ship
 * placeholder backends (nvidia declares moonshotai/kimi-k2.6 and
 * minimaxai/minimax-m2.7, anthropic declares two claude ids), and deepMerge
 * keeps them for any backend a fixture does not mention. So a fixture that
 * writes only `routing:` silently inherits four extra serveable ids and this
 * suite's ranked chain becomes [match-primary, kimi-k2.6, minimax-m2.7,
 * match-secondary] instead of the two ids the catalog fixture declares. That
 * is the union working correctly (the effective config does serve them, and
 * buildModelCatalog would advertise them on /v1/models too), but it is not
 * what THIS suite is about: it tests rank order and failover across a chain it
 * defines in writeCatalog().
 *
 * A wildcard-only list is the way to say "this backend serves no concrete id
 * here": config validation rejects an EMPTY models array, and
 * servingConfigModels() skips patterns because a pattern is not an id. So the
 * catalog fixture becomes the only source of ranked ids, which is what every
 * assertion below already assumed. deepMerge REPLACES arrays rather than
 * concatenating them, so this genuinely clears the default.
 */
function writeGatewayConfigFixture({ match_enabled }) {
  const p = join(FIX_DIR, `gw-${_cfgSeq++}.yaml`);
  writeFileSync(
    p,
    `routing:\n  match_enabled: ${match_enabled === true ? "true" : "false"}\n` +
    "backends:\n" +
    "  nvidia:\n    models: [unused-in-this-fixture-*]\n" +
    "  anthropic:\n    models: [unused-in-this-fixture-*]\n" +
    "  ollama:\n    models: [unused-in-this-fixture-*]\n",
    "utf8",
  );
  return p;
}
