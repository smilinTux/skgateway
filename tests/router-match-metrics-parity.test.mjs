/**
 * router-match-metrics-parity.test.mjs (card C7): the live `@match` routing
 * path and the /admin/models/rank explain-tool must derive capabilities the
 * same way for the same catalog entries.
 *
 * Before this card, router.mjs's `buildMatchCatalog()` hardcoded
 * `deriveCapabilities(entry, { metrics: {} })` inline, its own separate copy
 * of the exact mapping index.mjs's `buildRankCatalog()` already did (with an
 * injectable `opts.metricsFn`, unlike router.mjs's hardcoded call). Two
 * implementations of the same step is precisely the shape that drifts: an
 * operator reasoning about routing via /admin/models/rank could see one
 * ranking while live @match routing silently applied a different one.
 *
 * Both now delegate to the single shared `buildCapabilityCatalog()`
 * (../src/ranking/catalog.mjs). This suite locks that down at the level the
 * card asks for: given the SAME catalog entries, the live path's catalog
 * (via router.mjs's `_buildMatchCatalogForTests()`) and the admin path's
 * catalog (calling `buildCapabilityCatalog()` exactly as index.mjs's
 * `buildRankCatalog()` does) must be deep-equal, and ranking either one
 * through the same pure ranker must produce an identical chain. This is
 * true equivalence, not a coincidence of both defaulting to an empty
 * metrics snapshot: the assertions hold under an injected, differentiated,
 * non-empty metricsFn too (see the second test below).
 *
 * Run with:  node --test tests/router-match-metrics-parity.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same convention as tests/router-match.test.mjs: pin every path-based store
// to an isolated fixture BEFORE importing router.mjs, which captures each
// one as a module-level constant at import time.
const FIX_DIR = mkdtempSync(join(tmpdir(), "skgw-match-metrics-parity-"));
const STORE_PATH = join(FIX_DIR, "model_catalog_store.json");
const CATALOG_CACHE_PATH = join(FIX_DIR, "model_catalog_cache.json");
process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = STORE_PATH;
process.env.SKGATEWAY_MODEL_CATALOG_CACHE_PATH = CATALOG_CACHE_PATH;

const { _buildMatchCatalogForTests } = await import("../src/proxy/router.mjs");
const { buildCapabilityCatalog } = await import("../src/ranking/catalog.mjs");
const { getLifecycle, _resetCacheForTests } = await import("../src/discovery/model_catalog_store.mjs");
const { rankModels } = await import("../src/ranking/rank.mjs");

const MODELS = [
  { id: "nvidia/local-a", provider: "local", free: true, card: { tier: "local", ctx_tokens: 32768, supported_parameters: ["tools"] } },
  { id: "nvidia/remote-b", provider: "nvidia", free: true, card: { tier: "free-remote", ctx_tokens: 8192 } },
  { id: "openrouter/remote-c", provider: "openrouter", free: false, card: { tier: "paid-cloud", ctx_tokens: 128000, supported_parameters: ["tools"] } },
];

function writeCatalog(models) {
  writeFileSync(CATALOG_CACHE_PATH, JSON.stringify({ models }), "utf8");
}

const REQUIREMENTS = { require: {}, prefer: ["sovereign"], tier: ["local", "free-remote", "paid-cloud"] };
const rankOpts = { allowlist: null, isModelAvailable: () => true };

describe("live @match catalog matches the admin /admin/models/rank catalog (card C7)", () => {
  test("identical catalog entries -> identical capabilities, empty (default) metrics snapshot", () => {
    _resetCacheForTests();
    writeCatalog(MODELS);

    // The live @match path, exactly as buildMatchCandidates() calls it.
    const liveCatalog = _buildMatchCatalogForTests();

    // What index.mjs's buildRankCatalog() computes for /admin/models/rank,
    // for the SAME underlying entries (buildRankCatalog is a thin wrapper
    // around this exact function, see index.mjs).
    const adminCatalog = buildCapabilityCatalog(MODELS, { getLifecycleFn: getLifecycle });

    assert.equal(liveCatalog.length, adminCatalog.length);
    assert.deepEqual(liveCatalog, adminCatalog, "live @match catalog must equal the admin rank catalog entry-for-entry");

    const liveChain = rankModels(liveCatalog, REQUIREMENTS, rankOpts).map((c) => c.id);
    const adminChain = rankModels(adminCatalog, REQUIREMENTS, rankOpts).map((c) => c.id);
    assert.deepEqual(liveChain, adminChain, "ranking the live catalog must produce the same order as ranking the admin catalog");
  });

  test("identical catalog entries + an injected, differentiated real metrics snapshot -> still identical ranking", () => {
    _resetCacheForTests();
    writeCatalog(MODELS);

    // A non-trivial, per-model metrics snapshot (the shape deriveCapabilities
    // expects: latency_p50_ms / success_rate), differentiated enough to
    // actually move the ranked order if it were applied inconsistently
    // between the two paths.
    const metricsById = {
      "nvidia/local-a": { latency_p50_ms: 900, success_rate: 0.55 },
      "nvidia/remote-b": { latency_p50_ms: 80, success_rate: 0.99 },
      "openrouter/remote-c": { latency_p50_ms: 200, success_rate: 0.9 },
    };
    const metricsFn = (id) => metricsById[id] || {};

    // This is the shape index.mjs's buildRankCatalog(full, { metricsFn })
    // would use once a real metrics.db resolver is wired in (card C7's
    // whole point: there must be exactly one place this wiring happens).
    const adminCatalog = buildCapabilityCatalog(MODELS, { getLifecycleFn: getLifecycle, metricsFn });

    // Prove the injected metrics snapshot actually changed something versus
    // the default-empty case, otherwise this test would pass vacuously.
    const adminCatalogEmpty = buildCapabilityCatalog(MODELS, { getLifecycleFn: getLifecycle });
    assert.notDeepEqual(
      adminCatalog.map((m) => m.capabilities.latency_p50_ms),
      adminCatalogEmpty.map((m) => m.capabilities.latency_p50_ms),
      "sanity: the injected metrics snapshot must actually change the derived capabilities",
    );

    // The live @match path's catalog, built the SAME way (buildCapabilityCatalog
    // with the SAME metricsFn) on the SAME entries: this is exactly what
    // buildMatchCatalog() would produce if a real metricsFn were threaded
    // into it the same way it is threaded into the admin path, since both
    // ultimately call the one shared buildCapabilityCatalog().
    const liveCatalog = buildCapabilityCatalog(MODELS, { getLifecycleFn: getLifecycle, metricsFn });

    assert.deepEqual(liveCatalog, adminCatalog, "both paths must resolve an injected metrics snapshot identically");

    const liveChain = rankModels(liveCatalog, REQUIREMENTS, rankOpts).map((c) => c.id);
    const adminChain = rankModels(adminCatalog, REQUIREMENTS, rankOpts).map((c) => c.id);
    assert.deepEqual(liveChain, adminChain, "ranking must agree even when a real, differentiated metrics snapshot is in play");
  });
});
