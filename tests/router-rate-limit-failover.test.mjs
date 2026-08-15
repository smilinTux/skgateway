/**
 * router-rate-limit-failover.test.mjs (card 9e28de88): 429/402 are
 * failover-worthy, model-granular cooldown, multi-door preference.
 *
 * MEASURED: opencode.ai/zen/v1 (deepseek-v4-flash-free) returns HTTP 429
 * FreeUsageLimitError on its free tier. Before this card the candidate loop
 * decided failover with `res.status < 500`, so a 429 counted as success: no
 * failover, no health signal, the 429 relayed straight to the caller. That
 * turns card C9's bucket pools into "the first member's error with extra
 * steps" under any real free-tier load, which the card calls the steady
 * state, not an edge case.
 *
 * Coverage:
 *   1. A two-member candidate list where the first returns 429 is served by
 *      the second, and the first is not marked unhealthy or pushed toward
 *      eol (fixes #1 and #4).
 *   2. Retry-After (or the status-specific default) arms a model-granular
 *      cooldown; a following request against the still-cooling door skips
 *      it with no network call (fix #2).
 *   3. A 402 also fails over, with the longer quota-scale default cooldown;
 *      a 403 stays terminal, unchanged (the 402/403 decision).
 *   4. An all-throttled chain returns one attributable 429 rather than
 *      hanging or relaying an arbitrary raw upstream body (fix #3).
 *   5. `@match` prefers another door to the SAME ranked model over moving to
 *      a different ranked model (fix #5).
 *
 * Run with:  node --test tests/router-rate-limit-failover.test.mjs
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same convention as tests/router-model-outcome.test.mjs / router-match.test.mjs:
// pin every path-based store to an isolated fixture BEFORE importing router.mjs,
// which captures each one as a module-level constant at import time.
const FIX_DIR = mkdtempSync(join(tmpdir(), "skgw-rate-limit-failover-"));
const REGISTRY_PATH = join(FIX_DIR, "registry.yaml");
const STORE_PATH = join(FIX_DIR, "model_catalog_store.json");
const CATALOG_CACHE_PATH = join(FIX_DIR, "model_catalog_cache.json");

process.env.SKMODELS_REGISTRY = REGISTRY_PATH; // never written: plain model-name routing only
process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = STORE_PATH;
process.env.SKGATEWAY_MODEL_CATALOG_CACHE_PATH = CATALOG_CACHE_PATH;

const { createRouter, routeAndSend, _resetThrottleCooldownsForTests, _throttleStateForTests } =
  await import("../src/proxy/router.mjs");
const { getLifecycle, _resetCacheForTests } = await import("../src/discovery/model_catalog_store.mjs");
const { loadConfig } = await import("../src/config.mjs");

/** A tiny upstream whose status + response headers are mutable via a shared
 * ref, so one server can throttle in one test and heal in the next. */
function startUpstream() {
  const ref = { status: 200, headers: {} };
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    requestCount++;
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(ref.status, { "content-type": "application/json", ...ref.headers });
      res.end(JSON.stringify({
        error: ref.status >= 400 ? { type: "FreeUsageLimitError", message: "Rate limit exceeded" } : undefined,
        ok: ref.status < 400,
      }));
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
const bodyFor = (model) => Buffer.from(JSON.stringify({ model, messages: [] }));

describe("router 429/402 rate-limit failover (card 9e28de88)", () => {
  let primary, secondary;

  before(async () => {
    primary = await startUpstream();
    secondary = await startUpstream();
  });

  after(async () => {
    await primary.close();
    await secondary.close();
  });

  beforeEach(() => {
    _resetThrottleCooldownsForTests();
    _resetCacheForTests();
    primary.ref.status = 200;
    primary.ref.headers = {};
    secondary.ref.status = 200;
    secondary.ref.headers = {};
  });

  test("fix #1/#4: first candidate 429s, second serves, first stays healthy and non-eol", async () => {
    const modelId = `zen/deepseek-v4-flash-free-${Date.now()}`;
    const router = createRouter({
      backends: {
        primary: { url: primary.base, auth_type: "none", models: [modelId], priority: 1 },
        secondary: { url: secondary.base, auth_type: "none", models: [modelId], priority: 2 },
      },
    });

    primary.ref.status = 429;
    secondary.ref.status = 200;

    const r = await routeAndSend(router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false);

    assert.equal(r.status, 200, "served from the second candidate");
    assert.equal(r.backendId, "secondary");
    assert.equal(r.failover, true);

    const primaryHealth = router.getHealth().primary;
    assert.equal(primaryHealth.quarantined, false, "a 429 must not quarantine the backend");
    assert.equal(primaryHealth.consecutiveFailures, 0, "a 429 must not count as a backend failure");
    assert.equal(primaryHealth.totalErrors, 0, "a 429 must not count toward the error-rate window");
    assert.equal(primaryHealth.status, "up");

    const lc = getLifecycle(modelId);
    assert.equal(lc.state, "active", "a 429 must not push the model toward eol");
    assert.equal(lc.consecutive_permanent_errors, 0, "a 429 is not a permanent-error signal (only 404/410 are)");
  });

  test("fix #2: Retry-After arms a model-granular cooldown; a later request skips the throttled door with no network call", async () => {
    const modelId = `zen/cooldown-model-${Date.now()}`;
    const router = createRouter({
      backends: {
        primary: { url: primary.base, auth_type: "none", models: [modelId], priority: 1 },
        secondary: { url: secondary.base, auth_type: "none", models: [modelId], priority: 2 },
      },
    });

    primary.ref.status = 429;
    primary.ref.headers = { "retry-after": "120" };
    secondary.ref.status = 200;

    const r1 = await routeAndSend(router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false);
    assert.equal(r1.status, 200);
    assert.equal(r1.backendId, "secondary");

    const state = _throttleStateForTests("primary", modelId);
    assert.ok(state, "throttle observation recorded (fix #6)");
    assert.equal(state.status, 429);
    assert.equal(state.hits, 1);
    assert.equal(state.retryAfterMs, 120_000, "Retry-After (seconds) respected verbatim");

    const primaryHitsBefore = primary.requestCount;

    // Second request lands while the cooldown is still armed: primary must be
    // skipped WITHOUT a network call (still cooling down from its own recent
    // 429), and secondary must serve it directly.
    const r2 = await routeAndSend(router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false);
    assert.equal(r2.status, 200);
    assert.equal(r2.backendId, "secondary");
    assert.equal(primary.requestCount, primaryHitsBefore, "cooling-down door received no further requests");
  });

  test("402/403 decision: a 402 fails over with the longer quota-scale cooldown, a 403 stays terminal", async () => {
    const modelId402 = `paid-tier/quota-exhausted-${Date.now()}`;
    const router402 = createRouter({
      backends: {
        primary: { url: primary.base, auth_type: "none", models: [modelId402], priority: 1 },
        secondary: { url: secondary.base, auth_type: "none", models: [modelId402], priority: 2 },
      },
    });
    primary.ref.status = 402;
    secondary.ref.status = 200;
    const r402 = await routeAndSend(router402, { model: modelId402, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId402), false);
    assert.equal(r402.status, 200, "a 402 fails over just like a 429");
    assert.equal(r402.backendId, "secondary");
    const st402 = _throttleStateForTests("primary", modelId402);
    assert.equal(st402.status, 402);
    assert.ok(st402.untilMs - Date.now() > 60 * 60 * 1000, "402 with no Retry-After uses the long, period-scale default, not the short 429 default");
    const lc402 = getLifecycle(modelId402);
    assert.equal(lc402.state, "active", "a 402 must not feed eol bookkeeping either");

    _resetThrottleCooldownsForTests();
    primary.ref.status = 200;
    secondary.ref.status = 200;

    const modelId403 = `paid-tier/forbidden-${Date.now()}`;
    const router403 = createRouter({
      backends: {
        primary: { url: primary.base, auth_type: "none", models: [modelId403], priority: 1 },
        secondary: { url: secondary.base, auth_type: "none", models: [modelId403], priority: 2 },
      },
    });
    primary.ref.status = 403;
    const primaryHitsBefore = primary.requestCount;
    const secondaryHitsBefore = secondary.requestCount;
    const r403 = await routeAndSend(router403, { model: modelId403, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId403), false);
    assert.equal(r403.status, 403, "a 403 is returned to the caller, NOT failed over (deliberate decision)");
    assert.equal(r403.backendId, "primary");
    assert.equal(r403.failover, false);
    assert.equal(primary.requestCount, primaryHitsBefore + 1);
    assert.equal(secondary.requestCount, secondaryHitsBefore, "secondary was never tried for a 403");
  });

  test("fix #3: an all-throttled chain returns one attributable 429 instead of hanging or a raw 500", async () => {
    const modelId = `zen/all-throttled-${Date.now()}`;
    const router = createRouter({
      backends: {
        primary: { url: primary.base, auth_type: "none", models: [modelId], priority: 1 },
        secondary: { url: secondary.base, auth_type: "none", models: [modelId], priority: 2 },
      },
    });

    primary.ref.status = 429;
    secondary.ref.status = 429;

    const r = await routeAndSend(router, { model: modelId, agentId: "test" }, "/chat/completions", "POST", HEADERS, bodyFor(modelId), false);

    assert.equal(r.status, 429);
    const payload = JSON.parse(r.body.toString("utf-8"));
    assert.equal(payload.error.type, "rate_limited_all_candidates");
    assert.equal(payload.attempted.length, 2, "both throttled doors are attributed");
    const backendIds = payload.attempted.map((a) => a.backendId).sort();
    assert.deepEqual(backendIds, ["primary", "secondary"]);
    for (const a of payload.attempted) assert.equal(a.model, modelId);

    // Neither door was damaged by the all-throttled outcome.
    const health = router.getHealth();
    assert.equal(health.primary.quarantined, false);
    assert.equal(health.secondary.quarantined, false);
    const lc = getLifecycle(modelId);
    assert.equal(lc.state, "active");
  });
});

// ---------------------------------------------------------------------------
// fix #5: @match prefers another door to the SAME ranked model before moving
// on to a different ranked model.
// ---------------------------------------------------------------------------

const MATCH_REGISTRY = `roles:
  sk-match: "@match"
requirements:
  sk-match:
    require: {}
    prefer: [sovereign]
    tier: [local, free-remote]
`;

function writeCatalog(models) {
  writeFileSync(CATALOG_CACHE_PATH, JSON.stringify({ models }), "utf8");
}

let _cfgSeq = 0;
function writeGatewayConfigFixture() {
  const p = join(FIX_DIR, `gw-match-${_cfgSeq++}.yaml`);
  writeFileSync(p, "routing:\n  match_enabled: true\n", "utf8");
  return p;
}

describe("router @match multi-door preference (card 9e28de88 fix #5)", () => {
  let primary, primary2, secondary;

  before(async () => {
    primary = await startUpstream();
    primary2 = await startUpstream();
    secondary = await startUpstream();
  });

  after(async () => {
    await primary.close();
    await primary2.close();
    await secondary.close();
  });

  test("a throttled top door fails over to the SAME model's other door, never touching the next ranked model", async () => {
    _resetThrottleCooldownsForTests();
    _resetCacheForTests();
    writeFileSync(REGISTRY_PATH, MATCH_REGISTRY, "utf8");
    // Two doors for match-primary (nvidia + openrouter style overlap, the
    // measured case: nemotron-3-ultra-550b-a55b free on both), one door for
    // match-secondary.
    writeCatalog([
      { id: "match-primary", provider: "local", free: true, card: { tier: "local" } },
      { id: "match-secondary", provider: "nvidia", free: true, card: { tier: "free-remote" } },
    ]);
    await loadConfig({ configPath: writeGatewayConfigFixture(), silent: true });

    primary.ref.status = 429;   // top door for match-primary: throttled
    primary2.ref.status = 200;  // second door for the SAME model: healthy
    secondary.ref.status = 200; // door for the DIFFERENT ranked model: must never be hit

    const router = createRouter({
      backends: {
        primary: { url: primary.base, auth_type: "none", models: ["match-primary"], priority: 1 },
        primary2: { url: primary2.base, auth_type: "none", models: ["match-primary"], priority: 2 },
        secondary: { url: secondary.base, auth_type: "none", models: ["match-secondary"], priority: 1 },
      },
    });

    const secondaryHitsBefore = secondary.requestCount;

    const r = await routeAndSend(
      router,
      { role: "sk-match", agentId: "test", messages: [{ role: "user", content: "hi" }] },
      "/chat/completions", "POST", HEADERS, bodyFor("sk-match"), false,
    );

    assert.equal(r.status, 200);
    assert.equal(r.backendId, "primary2", "failed over to the SAME model's other door");
    assert.equal(secondary.requestCount, secondaryHitsBefore, "the different ranked model was never attempted");

    const primaryHealth = router.getHealth().primary;
    assert.equal(primaryHealth.quarantined, false, "the throttled door stays healthy");
  });
});
