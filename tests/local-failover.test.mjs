/**
 * local-failover.test.mjs — health-aware, sovereign-first local-backend failover.
 *
 * The gateway routes logical roles (sk-default, ornith-tiny) to a sovereign local
 * llama backend via the skmodels registry. When that local GPU wedges (broken
 * driver, llama-server hung, /chat/completions never replies) the single-candidate
 * registry route stalls every caller. This suite proves the health-aware layer:
 *
 * Unit (pure helpers):
 *   - getFailoverConfig(): defaults + env overrides + the on/off switch.
 *   - isLocalUrl(): loopback/RFC1918/tailnet local vs. public.
 *   - probeLocalHealth(): ok/err/throw verdicts, TTL caching, clock control.
 *   - recordLocalOutcome(): completion outcome overrides the cached verdict.
 *
 * Integration (routeAndSend with real local + cloud upstreams):
 *   - local healthy   → served by local, cloud untouched (sovereign-first).
 *   - local down       → probe fails, request skips local and serves from cloud.
 *   - local hang       → probe passes but completion times out → fails over.
 *   - recovery         → once local is live again, traffic routes back.
 *   - switch OFF        → the probe/fallback is bypassed entirely.
 *
 * Run with:  node --test tests/local-failover.test.mjs
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin the skmodels registry to a fixed temp path BEFORE importing the router
// (registry.mjs captures REGISTRY_PATH at eval time). The file is written in the
// integration `before()` once the upstream ports are known; registry.mjs
// re-stats + re-parses on mtime change, so a late write is picked up live.
const REG_DIR = mkdtempSync(join(tmpdir(), "skgw-localfailover-"));
const REG_PATH = join(REG_DIR, "registry.yaml");
process.env.SKMODELS_REGISTRY = REG_PATH;

// Pin the model-lifecycle catalog store to a fixed temp path too (card P1.5):
// getFailoverConfig() now consults it to filter the registry-resolved
// fallback candidate to lifecycle 'active'. Pinning keeps these unit tests
// isolated from any real ~/.config/skgateway/model_catalog_store.json.
const STORE_DIR = mkdtempSync(join(tmpdir(), "skgw-localfailover-store-"));
const STORE_PATH = join(STORE_DIR, "model_catalog_store.json");
process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = STORE_PATH;

const {
  getFailoverConfig,
  isLocalUrl,
  probeLocalHealth,
  recordLocalOutcome,
  peekVerdict,
  resetLocalHealth,
} = await import("../src/proxy/local-failover.mjs");

const { recordModelOutcome } = await import("../src/discovery/model_catalog_store.mjs");

const { createRouter, routeAndSend } = await import("../src/proxy/router.mjs");

// ── 1. getFailoverConfig ─────────────────────────────────────────────────────

describe("getFailoverConfig", () => {
  before(() => {
    // registry.failover.local_fallback (card P1.5): a role name resolved to
    // its backend's concrete model + backend id. Deliberately NOT the old
    // hardcoded "openai/gpt-oss-20b" literal, so a passing test proves the
    // value came from the registry rather than surviving in code by accident.
    writeFileSync(
      REG_PATH,
      `backends:
  nv-fallback:
    url: https://integrate.api.nvidia.com/v1
    model: meta/free-fallback-model
    kind: chat
roles:
  sk-cheap-fast: nv-fallback
failover:
  local_fallback: sk-cheap-fast
`,
      "utf8",
    );
  });

  test("sensible defaults, enabled ON, fallback resolved from the registry", () => {
    const c = getFailoverConfig({});
    assert.equal(c.enabled, true);
    // No env override and the store has never recorded an outcome for this
    // model, so it defaults to lifecycle 'active' and is picked.
    assert.equal(c.fallbackModel, "meta/free-fallback-model");
    assert.equal(c.fallbackBackend, "nv-fallback");
    assert.equal(c.probeTimeoutMs, 3000);
    assert.equal(c.completionTimeoutMs, 10000);
    assert.equal(c.verdictTtlMs, 20000);
  });

  test("an eol registry candidate is skipped in favour of the next active one", () => {
    writeFileSync(
      REG_PATH,
      `backends:
  dead-one:
    url: https://x/v1
    model: nvidia/dead-fallback-model
    kind: chat
  live-one:
    url: https://y/v1
    model: nvidia/live-fallback-model
    kind: chat
roles:
  sk-fb-a: dead-one
  sk-fb-b: live-one
failover:
  local_fallback: [sk-fb-a, sk-fb-b]
`,
      "utf8",
    );
    recordModelOutcome("nvidia/dead-fallback-model", { status: 410, now: 1 });
    recordModelOutcome("nvidia/dead-fallback-model", { status: 410, now: 2 });
    recordModelOutcome("nvidia/dead-fallback-model", { status: 410, now: 3 }); // 3rd 410 -> eol

    const c = getFailoverConfig({});
    assert.equal(c.fallbackModel, "nvidia/live-fallback-model", "the eol candidate is never picked");
    assert.equal(c.fallbackBackend, "live-one");
  });

  test("no active registry candidate → fallbackModel is null (no dead hardcoded id)", () => {
    writeFileSync(
      REG_PATH,
      `backends:
  only-dead:
    url: https://x/v1
    model: nvidia/only-dead-model
    kind: chat
roles:
  sk-fb-only: only-dead
failover:
  local_fallback: sk-fb-only
`,
      "utf8",
    );
    recordModelOutcome("nvidia/only-dead-model", { status: 410, now: 10 });
    recordModelOutcome("nvidia/only-dead-model", { status: 410, now: 20 });
    recordModelOutcome("nvidia/only-dead-model", { status: 410, now: 30 });

    const c = getFailoverConfig({});
    assert.equal(c.fallbackModel, null);
    // Backend id still defaults so a caller that only checks the backend
    // does not see undefined; the model is the actual "no fallback" signal.
    assert.equal(c.fallbackBackend, "nvidia");
  });

  test("the on/off switch disables via 0/false/off/no (case-insensitive)", () => {
    for (const v of ["0", "false", "off", "no", "OFF", "False"]) {
      assert.equal(getFailoverConfig({ SKGATEWAY_LOCAL_FAILOVER: v }).enabled, false, `value ${v}`);
    }
    for (const v of ["1", "true", "on", "yes", ""]) {
      assert.equal(getFailoverConfig({ SKGATEWAY_LOCAL_FAILOVER: v }).enabled, true, `value ${v}`);
    }
  });

  test("env overrides model / backend / timeouts", () => {
    const c = getFailoverConfig({
      SKGATEWAY_LOCAL_FALLBACK_MODEL: "meta/llama-x:free",
      SKGATEWAY_LOCAL_FALLBACK_BACKEND: "openrouter",
      SKGATEWAY_LOCAL_HEALTH_TIMEOUT_MS: "2500",
      SKGATEWAY_LOCAL_COMPLETION_TIMEOUT_MS: "8000",
      SKGATEWAY_LOCAL_HEALTH_TTL_MS: "15000",
    });
    assert.equal(c.fallbackModel, "meta/llama-x:free");
    assert.equal(c.fallbackBackend, "openrouter");
    assert.equal(c.probeTimeoutMs, 2500);
    assert.equal(c.completionTimeoutMs, 8000);
    assert.equal(c.verdictTtlMs, 15000);
  });

  test("blank / malformed numeric env falls back to defaults", () => {
    const c = getFailoverConfig({ SKGATEWAY_LOCAL_HEALTH_TIMEOUT_MS: "abc", SKGATEWAY_LOCAL_HEALTH_TTL_MS: "  " });
    assert.equal(c.probeTimeoutMs, 3000);
    assert.equal(c.verdictTtlMs, 20000);
  });
});

// ── 2. isLocalUrl ────────────────────────────────────────────────────────────

describe("isLocalUrl", () => {
  test("local / private / tailnet hosts are local", () => {
    for (const u of [
      "http://127.0.0.1:8082/v1",
      "http://localhost:8082/v1",
      "http://192.168.0.100:8082/v1",
      "http://10.1.2.3:11434/v1",
      "http://172.16.5.5/v1",
      "http://172.31.9.9/v1",
      "http://100.86.156.5:8082/v1", // tailscale CGNAT
      "http://box.local/v1",
      "http://svc.internal/v1",
      "http://169.254.1.1/v1",
    ]) {
      assert.equal(isLocalUrl(u), true, u);
    }
  });

  test("public hosts / out-of-range octets are NOT local", () => {
    for (const u of [
      "https://integrate.api.nvidia.com/v1",
      "https://openrouter.ai/api/v1",
      "http://8.8.8.8/v1",
      "http://172.15.0.1/v1",
      "http://172.32.0.1/v1",
      "http://100.63.0.1/v1", // just below CGNAT
      "http://100.128.0.1/v1", // just above CGNAT
      "not-a-url",
      "",
    ]) {
      assert.equal(isLocalUrl(u), false, u);
    }
  });
});

// ── 3. probeLocalHealth + recordLocalOutcome ─────────────────────────────────

describe("probeLocalHealth (stubbed fetch, controlled clock)", () => {
  beforeEach(() => resetLocalHealth());

  test("ok response → healthy and cached (no re-probe within TTL)", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: true }; };
    let t = 1000;
    const opts = { probeTimeoutMs: 100, verdictTtlMs: 5000, now: () => t, fetchImpl };

    assert.equal(await probeLocalHealth("http://127.0.0.1:9/v1", opts), true);
    assert.equal(calls, 1);
    // Within TTL → served from cache, fetch not called again.
    t = 4000;
    assert.equal(await probeLocalHealth("http://127.0.0.1:9/v1", opts), true);
    assert.equal(calls, 1);
    // Past TTL → re-probe.
    t = 7000;
    assert.equal(await probeLocalHealth("http://127.0.0.1:9/v1", opts), true);
    assert.equal(calls, 2);
  });

  test("non-2xx response → unhealthy", async () => {
    const fetchImpl = async () => ({ ok: false, status: 503 });
    assert.equal(await probeLocalHealth("http://127.0.0.1:9/v1", { fetchImpl, now: () => 1 }), false);
  });

  test("fetch throw / abort → unhealthy (fail-soft, never rejects)", async () => {
    const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
    assert.equal(await probeLocalHealth("http://127.0.0.1:9/v1", { fetchImpl, now: () => 1 }), false);
  });

  test("recordLocalOutcome overrides the cached verdict", () => {
    resetLocalHealth();
    recordLocalOutcome("http://127.0.0.1:9/v1", false, 100);
    assert.equal(peekVerdict("http://127.0.0.1:9/v1").healthy, false);
    recordLocalOutcome("http://127.0.0.1:9/v1", true, 200);
    assert.equal(peekVerdict("http://127.0.0.1:9/v1").healthy, true);
  });

  test("a real completion outcome is honoured on the next probe (within TTL)", async () => {
    resetLocalHealth();
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: true }; };
    // Mark unhealthy from a failed completion at t=1000; a probe at t=1500
    // (within TTL) trusts that verdict without hitting the network.
    recordLocalOutcome("http://127.0.0.1:9/v1", false, 1000);
    const healthy = await probeLocalHealth("http://127.0.0.1:9/v1", {
      verdictTtlMs: 5000, now: () => 1500, fetchImpl,
    });
    assert.equal(healthy, false);
    assert.equal(calls, 0, "cached completion verdict must short-circuit the probe");
  });
});

// ── 4. Integration: routeAndSend sovereign-first failover ────────────────────

/**
 * Start a fake OpenAI-ish LOCAL upstream. It serves GET /v1/models (the liveness
 * probe) and POST /v1/chat/completions, both driven by mutable refs so a single
 * server can act healthy, error its /models, or hang its completion per-test.
 */
function startLocalUpstream() {
  const state = { chatCount: 0, lastModel: null, modelsStatus: 200, chatMode: "ok", pending: [] };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url.startsWith("/v1/models")) {
        res.writeHead(state.modelsStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        state.chatCount++;
        try { state.lastModel = JSON.parse(Buffer.concat(chunks).toString("utf-8")).model ?? null; }
        catch { state.lastModel = null; }
        if (state.chatMode === "hang") {
          // Never respond — the router's bounded completion timeout must fire.
          state.pending.push(res);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ served: "local", model: state.lastModel }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}/v1`,
        state,
        close: () => new Promise((r) => { for (const p of state.pending) { try { p.destroy(); } catch {} } server.close(r); }),
      });
    });
  });
}

/** Start a fake CLOUD fallback upstream that always answers 200 and echoes model. */
function startCloudUpstream() {
  const state = { count: 0, lastModel: null };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        state.count++;
        try { state.lastModel = JSON.parse(Buffer.concat(chunks).toString("utf-8")).model ?? null; }
        catch { state.lastModel = null; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ served: "cloud", model: state.lastModel }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}/v1`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

describe("routeAndSend — health-aware sovereign-first failover", () => {
  let local, cloud, router;
  const HEADERS = { "content-type": "application/json" };
  const skDefaultBody = () => Buffer.from(JSON.stringify({ model: "sk-default", messages: [] }));

  before(async () => {
    local = await startLocalUpstream();
    cloud = await startCloudUpstream();
    // Registry: role sk-default → local ornith backend serving ornith-1.0-9b.
    writeFileSync(REG_PATH, `backends:
  ornith:
    url: ${local.base}
    model: ornith-1.0-9b
    kind: chat
roles:
  sk-default: ornith
defaults:
  role: sk-default
`, "utf8");
    // Router carries the cloud fallback backend under the id we point env at.
    router = createRouter({
      backends: { cloud: { url: cloud.base, auth_type: "none", models: ["*"], priority: 9 } },
      failover: true,
    });
  });

  after(async () => {
    await local.close();
    await cloud.close();
  });

  beforeEach(() => {
    resetLocalHealth();
    local.state.modelsStatus = 200;
    local.state.chatMode = "ok";
    local.state.chatCount = 0;
    local.state.lastModel = null;
    cloud.state.count = 0;
    cloud.state.lastModel = null;
    // Standard env for the integration path.
    delete process.env.SKGATEWAY_LOCAL_FAILOVER;
    process.env.SKGATEWAY_LOCAL_FALLBACK_BACKEND = "cloud";
    process.env.SKGATEWAY_LOCAL_FALLBACK_MODEL = "deepseek-test";
    process.env.SKGATEWAY_LOCAL_HEALTH_TIMEOUT_MS = "1500";
    process.env.SKGATEWAY_LOCAL_COMPLETION_TIMEOUT_MS = "500";
    process.env.SKGATEWAY_LOCAL_HEALTH_TTL_MS = "20000";
  });

  test("local HEALTHY → served by local, cloud untouched", async () => {
    const r = await routeAndSend(
      router, { model: "sk-default" }, "/v1/chat/completions", "POST", HEADERS, skDefaultBody(), false,
    );
    assert.equal(r.status, 200);
    assert.equal(r.backendId, "reg:ornith", "sovereign-first: local backend served");
    assert.equal(r.failover, false);
    assert.equal(local.state.lastModel, "ornith-1.0-9b", "local received its concrete model");
    assert.equal(cloud.state.count, 0, "cloud fallback was not touched");
  });

  test("local DOWN (probe fails) → skips local, serves from cloud fallback", async () => {
    local.state.modelsStatus = 503; // liveness probe sees the backend as unhealthy
    const r = await routeAndSend(
      router, { model: "sk-default" }, "/v1/chat/completions", "POST", HEADERS, skDefaultBody(), false,
    );
    assert.equal(r.status, 200);
    assert.equal(r.backendId, "cloud", "failed over to the cloud fallback backend");
    assert.equal(cloud.state.lastModel, "deepseek-test", "outgoing model rewritten to the cloud fallback id");
    assert.equal(local.state.chatCount, 0, "unhealthy local backend received no completion");
  });

  test("local HANGS mid-request → bounded completion timeout → fails over to cloud", async () => {
    local.state.chatMode = "hang"; // /models is 200 (probe passes) but /chat never replies
    const r = await routeAndSend(
      router, { model: "sk-default" }, "/v1/chat/completions", "POST", HEADERS, skDefaultBody(), false,
    );
    assert.equal(r.status, 200);
    assert.equal(r.backendId, "cloud", "hung local completion failed over to cloud");
    assert.equal(r.failover, true, "this was a real failover, not a direct skip");
    assert.equal(cloud.state.lastModel, "deepseek-test");
    assert.equal(local.state.chatCount, 1, "local WAS attempted (probe passed) before the timeout");
    assert.equal(peekVerdict(local.base).healthy, false, "hung completion marked local unhealthy");
  });

  test("RECOVERY → once local is live again, traffic routes back", async () => {
    // Simulate a prior outage verdict, then local recovers + the verdict expires.
    recordLocalOutcome(local.base, false, Date.now());
    resetLocalHealth(); // stand-in for TTL expiry: forces a fresh probe
    local.state.modelsStatus = 200;
    local.state.chatMode = "ok";
    const r = await routeAndSend(
      router, { model: "sk-default" }, "/v1/chat/completions", "POST", HEADERS, skDefaultBody(), false,
    );
    assert.equal(r.backendId, "reg:ornith", "recovered local backend is served again");
    assert.equal(cloud.state.count, 0);
  });

  test("switch OFF → probe/fallback bypassed, local used even when /models errors", async () => {
    process.env.SKGATEWAY_LOCAL_FAILOVER = "0";
    local.state.modelsStatus = 503; // would trip the probe if it ran
    local.state.chatMode = "ok";
    const r = await routeAndSend(
      router, { model: "sk-default" }, "/v1/chat/completions", "POST", HEADERS, skDefaultBody(), false,
    );
    assert.equal(r.backendId, "reg:ornith", "with failover OFF the local route is unchanged");
    assert.equal(cloud.state.count, 0, "no cloud fallback when disabled");
  });
});
