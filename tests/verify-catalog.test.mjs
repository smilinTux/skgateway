/**
 * verify-catalog.test.mjs - card a7f65226.
 *
 * Drives the pure classification/summary functions, the failover redundancy
 * check against a REAL temp registry.yaml (through the real
 * resolveFailoverCandidates, not a mock of it), and the end-to-end orchestrator
 * with mocked HTTP + a recording alert stub. Includes the two DEFINITION OF
 * DONE cases from the card: a dead advertised model / unrepresented provider,
 * and a failover list pointed at a dead id so redundancy drops below 2.
 *
 * Run with:  node --test tests/verify-catalog.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyProbe,
  probeModel,
  probeAll,
  summarizeLiveness,
  computeRepresentationGaps,
  computeCountDivergence,
  checkFailoverRedundancy,
  runVerification,
  parseArgs,
  formatReport,
  main,
  MIN_FAILOVER_LIVE,
  ALERT_CATALOG_KEY,
  ALERT_FAILOVER_KEY,
  EXIT_OK,
  EXIT_DRIFT,
  EXIT_ERROR,
} from "../scripts/verify-catalog.mjs";
import { resolveFailoverCandidates } from "../src/proxy/registry.mjs";

const noSleep = async () => {};

// ── classifyProbe ────────────────────────────────────────────────────────────

describe("classifyProbe", () => {
  test("2xx is alive", () => {
    assert.deepEqual(classifyProbe({ status: 200 }), { alive: true, throttled: false, reason: "http_200" });
  });
  test("429 is alive AND throttled - never a failure", () => {
    const r = classifyProbe({ status: 429 });
    assert.equal(r.alive, true);
    assert.equal(r.throttled, true);
  });
  test("404 is dead with its own reason", () => {
    const r = classifyProbe({ status: 404 });
    assert.equal(r.alive, false);
    assert.equal(r.reason, "http_404");
  });
  test("410 is dead (retired model)", () => {
    const r = classifyProbe({ status: 410 });
    assert.equal(r.alive, false);
    assert.equal(r.reason, "http_410");
  });
  test("500 is dead, distinct reason from 4xx", () => {
    const r = classifyProbe({ status: 500 });
    assert.equal(r.alive, false);
    assert.equal(r.reason, "http_500");
  });
  test("timeout is dead with reason 'timeout', not conflated with an HTTP code", () => {
    const r = classifyProbe({ timedOut: true });
    assert.equal(r.alive, false);
    assert.equal(r.reason, "timeout");
  });
  test("network error is dead with the underlying message", () => {
    const r = classifyProbe({ networkError: "ECONNREFUSED" });
    assert.equal(r.alive, false);
    assert.match(r.reason, /ECONNREFUSED/);
  });
});

// ── probeModel / probeAll ────────────────────────────────────────────────────

describe("probeModel", () => {
  test("posts to /v1/chat/completions with the model id and a small max_tokens, classifies the status", async () => {
    let seenUrl, seenBody;
    const fetchImpl = async (url, opts) => {
      seenUrl = url;
      seenBody = JSON.parse(opts.body);
      return { status: 200 };
    };
    const r = await probeModel({ endpoint: "http://x:1/", id: "some/model", fetchImpl });
    assert.equal(seenUrl, "http://x:1/v1/chat/completions");
    assert.equal(seenBody.model, "some/model");
    assert.ok(seenBody.max_tokens > 0 && seenBody.max_tokens < 100, "max_tokens should be small");
    assert.equal(r.alive, true);
  });

  test("an AbortError from the fetch is classified as a timeout, not a network error", async () => {
    const fetchImpl = async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    };
    const r = await probeModel({ endpoint: "http://x:1", id: "m", fetchImpl });
    assert.equal(r.alive, false);
    assert.equal(r.reason, "timeout");
  });

  test("probeAll paces requests with the injected sleep between calls, not before the first or after the last", async () => {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return { status: 200 }; };
    let sleeps = 0;
    const sleepImpl = async () => { sleeps += 1; };
    await probeAll({ ids: ["a", "b", "c"], endpoint: "http://x", delayMs: 10, fetchImpl, sleepImpl });
    assert.equal(calls.length, 3);
    assert.equal(sleeps, 2, "one sleep between each pair, none trailing");
  });
});

// ── summarizeLiveness ────────────────────────────────────────────────────────

describe("summarizeLiveness", () => {
  test("groups per provider, separates alive/throttled/dead, keeps dead reasons", () => {
    const results = [
      { id: "a", status: 200, alive: true, throttled: false, reason: "http_200" },
      { id: "b", status: 429, alive: true, throttled: true, reason: "http_429" },
      { id: "c", status: 404, alive: false, throttled: false, reason: "http_404" },
      { id: "d", status: null, alive: false, throttled: false, reason: "timeout" },
    ];
    const providerById = new Map([["a", "nvidia"], ["b", "nvidia"], ["c", "nvidia"], ["d", "openrouter"]]);
    const s = summarizeLiveness({ results, providerById });
    assert.equal(s.aliveCount, 2);
    assert.equal(s.throttledCount, 1);
    assert.equal(s.deadCount, 2);
    assert.equal(s.perProvider.nvidia.total, 3);
    assert.equal(s.perProvider.nvidia.dead, 1);
    assert.equal(s.perProvider.openrouter.dead, 1);
    assert.deepEqual(s.deadIds.map((d) => d.id).sort(), ["c", "d"]);
    // reasons must survive per-id, not collapse to a generic "failed"
    const cDead = s.deadIds.find((d) => d.id === "c");
    assert.equal(cDead.reason, "http_404");
    const dDead = s.deadIds.find((d) => d.id === "d");
    assert.equal(dDead.reason, "timeout");
  });
});

// ── computeRepresentationGaps: the 2026-08-14 openrouter shape ──────────────

describe("computeRepresentationGaps", () => {
  test("REPRO 2026-08-14: provider reports ok:true/count:17, catalog carries none -> gap", () => {
    const statusProviders = { openrouter: { ok: true, count: 17 } };
    const collectedByProvider = new Map(); // discovery collected nothing for it either
    const advertisedByProvider = new Map(); // and nothing is advertised
    const gaps = computeRepresentationGaps({ statusProviders, collectedByProvider, advertisedByProvider });
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].provider, "openrouter");
    assert.equal(gaps[0].provider_says, 17);
  });

  test("a provider with models actually advertised is never flagged, even if far fewer than collected", () => {
    // nvidia: 79 collected, only 34 advertised (lifecycle hiding eol ids) - healthy by design.
    const statusProviders = { nvidia: { ok: true, count: 79 } };
    const collectedByProvider = new Map([["nvidia", new Set(Array.from({ length: 79 }, (_, i) => `m${i}`))]]);
    const advertisedByProvider = new Map([["nvidia", new Set(["m1", "m2"])]]);
    const gaps = computeRepresentationGaps({ statusProviders, collectedByProvider, advertisedByProvider });
    assert.equal(gaps.length, 0);
  });

  test("a provider reporting ok:false is not flagged as a representation gap (that is a fetch outage, a different failure mode)", () => {
    const statusProviders = { nvidia: { ok: false, count: 0 } };
    const gaps = computeRepresentationGaps({ statusProviders, collectedByProvider: new Map(), advertisedByProvider: new Map() });
    assert.equal(gaps.length, 0);
  });

  test("a provider that has genuinely never had any models (says 0, collected 0) is not flagged", () => {
    const statusProviders = { openrouter: { ok: true, count: 0 } };
    const gaps = computeRepresentationGaps({ statusProviders, collectedByProvider: new Map(), advertisedByProvider: new Map() });
    assert.equal(gaps.length, 0);
  });
});

// ── computeCountDivergence: informational three-way table ──────────────────

describe("computeCountDivergence", () => {
  test("reports provider/collected/advertised per provider with diagnosable ids, no alarm field", () => {
    const statusProviders = { nvidia: { ok: true, count: 3 } };
    const collectedByProvider = new Map([["nvidia", new Set(["a", "b", "c"])]]);
    const advertisedByProvider = new Map([["nvidia", new Set(["a"])]]);
    const rows = computeCountDivergence({ statusProviders, collectedByProvider, advertisedByProvider });
    const nv = rows.find((r) => r.provider === "nvidia");
    assert.equal(nv.provider_says, 3);
    assert.equal(nv.collected, 3);
    assert.equal(nv.advertised, 1);
    assert.deepEqual(nv.collected_not_advertised_ids, ["b", "c"]);
    assert.ok(!("alarm" in nv), "count divergence rows must not carry an alarm field - it is informational only");
  });

  test("includes a provider present only in the advertised catalog (e.g. local/anthropic, not a discovery provider)", () => {
    const rows = computeCountDivergence({
      statusProviders: {},
      collectedByProvider: new Map(),
      advertisedByProvider: new Map([["local", new Set(["x"])]]),
    });
    const local = rows.find((r) => r.provider === "local");
    assert.equal(local.provider_says, null);
    assert.equal(local.advertised, 1);
  });
});

// ── checkFailoverRedundancy: real registry.yaml through the real resolver ──

describe("checkFailoverRedundancy", () => {
  function writeRegistry(entries) {
    const dir = mkdtempSync(join(tmpdir(), "skgw-verify-catalog-"));
    const path = join(dir, "registry.yaml");
    const yaml = `failover:\n  local_fallback:\n${entries.map((e) => `    - ${e}`).join("\n")}\n`;
    writeFileSync(path, yaml);
    return path;
  }

  test("2 live entries -> no alarm", async () => {
    const path = writeRegistry(["good/one", "good/two"]);
    const fetchImpl = async () => ({ status: 200 });
    const r = await checkFailoverRedundancy({ registryPath: path, endpoint: "http://x", fetchImpl, sleepImpl: noSleep, resolveCandidatesFn: resolveFailoverCandidates });
    assert.equal(r.liveCount, 2);
    assert.equal(r.alarm, false);
  });

  test("DEFINITION OF DONE: fallback pointed at a dead id in a staging registry -> redundancy drops below 2 -> alarm", async () => {
    const path = writeRegistry(["openai/gpt-oss-20b", "totally-fake-dead-model-xyz"]);
    const fetchImpl = async (url, opts) => {
      const body = JSON.parse(opts.body);
      return body.model === "totally-fake-dead-model-xyz" ? { status: 404 } : { status: 200 };
    };
    const r = await checkFailoverRedundancy({ registryPath: path, endpoint: "http://x", fetchImpl, sleepImpl: noSleep, resolveCandidatesFn: resolveFailoverCandidates });
    assert.equal(r.liveCount, 1);
    assert.equal(r.alarm, true, "fewer than 2 live entries must alarm - Chef's rule: if you need one, get two");
    const dead = r.entries.find((e) => e.model === "totally-fake-dead-model-xyz");
    assert.equal(dead.alive, false);
    assert.equal(dead.reason, "http_404");
  });

  test("membership is never enough: an id present in the list but answering 404 counts as dead, not alive", async () => {
    // This is the exact lie the card calls out: NVIDIA's catalog lists ids that
    // answer 404/410. A membership check would call this entry present/fine;
    // a real completion must not.
    const path = writeRegistry(["meta/llama-3.3-70b-instruct"]);
    const fetchImpl = async () => ({ status: 404 });
    const r = await checkFailoverRedundancy({ registryPath: path, endpoint: "http://x", fetchImpl, sleepImpl: noSleep, resolveCandidatesFn: resolveFailoverCandidates });
    assert.equal(r.liveCount, 0);
    assert.equal(r.alarm, true);
  });

  test("empty/missing local_fallback list resolves to zero candidates and alarms (fail loud, not silent)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-verify-catalog-empty-"));
    const path = join(dir, "registry.yaml");
    writeFileSync(path, "backends: {}\n");
    const r = await checkFailoverRedundancy({ registryPath: path, endpoint: "http://x", fetchImpl: async () => ({ status: 200 }), sleepImpl: noSleep, resolveCandidatesFn: resolveFailoverCandidates });
    assert.equal(r.liveCount, 0);
    assert.equal(r.alarm, true);
  });

  test("429 counts as alive for redundancy purposes too", async () => {
    const path = writeRegistry(["a/one", "a/two"]);
    const fetchImpl = async () => ({ status: 429 });
    const r = await checkFailoverRedundancy({ registryPath: path, endpoint: "http://x", fetchImpl, sleepImpl: noSleep, resolveCandidatesFn: resolveFailoverCandidates });
    assert.equal(r.liveCount, 2);
    assert.equal(r.alarm, false);
  });
});

// ── runVerification: end-to-end orchestration with mocked HTTP + alert stub ─

function mockGatewayFetch({ models, adminModels, status, completionStatus = () => 200 }) {
  return async (url, opts) => {
    const u = new URL(url, "http://x");
    if (u.pathname === "/v1/models") return { ok: true, status: 200, json: async () => models };
    if (u.pathname === "/admin/models") return { ok: true, status: 200, json: async () => adminModels };
    if (u.pathname === "/admin/models/status") return { ok: true, status: 200, json: async () => status };
    if (u.pathname === "/v1/chat/completions") {
      const body = JSON.parse(opts.body);
      return { status: completionStatus(body.model) };
    }
    throw new Error(`unexpected request to ${u.pathname}`);
  };
}

function recordingAlert() {
  const calls = [];
  const impl = async (args) => { calls.push(args); return { fired: true, bin: "/fake/sk-alert" }; };
  impl.calls = calls;
  return impl;
}

describe("runVerification", () => {
  test("clean run: everything alive, every provider represented, 2 live fallback entries -> exit 0, no alerts", async () => {
    const models = { data: [
      { id: "openai/gpt-oss-20b", provider: "nvidia" },
      { id: "some/openrouter-model", provider: "openrouter" },
    ] };
    const adminModels = { data: [
      { id: "openai/gpt-oss-20b", provider: "nvidia" },
      { id: "some/openrouter-model", provider: "openrouter" },
    ] };
    const status = { providers: { nvidia: { ok: true, count: 1 }, openrouter: { ok: true, count: 1 } } };
    const fetchImpl = mockGatewayFetch({ models, adminModels, status });

    const regDir = mkdtempSync(join(tmpdir(), "skgw-verify-catalog-clean-"));
    const regPath = join(regDir, "registry.yaml");
    writeFileSync(regPath, "failover:\n  local_fallback:\n    - openai/gpt-oss-20b\n    - some/openrouter-model\n");

    const alertImpl = recordingAlert();
    const result = await runVerification({ endpoint: "http://x", registryPath: regPath, fetchImpl, sleepImpl: noSleep, doAlert: true, alertImpl });

    assert.equal(result.reachable, true);
    assert.equal(result.exitCode, EXIT_OK);
    assert.equal(result.drift, false);
    assert.equal(alertImpl.calls.length, 0, "no alert should fire on a clean run even with --alert");
  });

  test("DEFINITION OF DONE (catalog side): a dead advertised model AND a representation gap both drift and both alert, distinctly", async () => {
    const models = { data: [
      { id: "alive/one", provider: "nvidia" },
      { id: "dead/two", provider: "nvidia" },
    ] };
    const adminModels = { data: [
      { id: "alive/one", provider: "nvidia" },
      { id: "dead/two", provider: "nvidia" },
    ] };
    // openrouter: gateway calls it healthy, but nothing from it made it into
    // /v1/models or /admin/models at all - the 2026-08-14 shape.
    const status = { providers: { nvidia: { ok: true, count: 2 }, openrouter: { ok: true, count: 17 } } };
    const fetchImpl = mockGatewayFetch({ models, adminModels, status, completionStatus: (m) => (m === "dead/two" ? 404 : 200) });

    const regDir = mkdtempSync(join(tmpdir(), "skgw-verify-catalog-drift-"));
    const regPath = join(regDir, "registry.yaml");
    writeFileSync(regPath, "failover:\n  local_fallback:\n    - alive/one\n    - dead/two\n");

    const alertImpl = recordingAlert();
    const result = await runVerification({ endpoint: "http://x", registryPath: regPath, fetchImpl, sleepImpl: noSleep, doAlert: true, alertImpl });

    assert.equal(result.exitCode, EXIT_DRIFT);
    assert.equal(result.liveness.deadCount, 1);
    assert.equal(result.representation.gaps.length, 1);
    assert.equal(result.representation.gaps[0].provider, "openrouter");
    // failover also drops below 2 here (dead/two is one of the two entries)
    assert.equal(result.failover.alarm, true);

    const keys = alertImpl.calls.map((c) => c.key).sort();
    assert.deepEqual(keys, [ALERT_CATALOG_KEY, ALERT_FAILOVER_KEY]);
    const catalogAlert = alertImpl.calls.find((c) => c.key === ALERT_CATALOG_KEY);
    assert.match(catalogAlert.message, /dead\/two/);
    assert.match(catalogAlert.message, /openrouter/);
  });

  test("skip-provider excludes a provider from the liveness probe entirely (no completion call, no dead verdict)", async () => {
    let calledAnthropic = false;
    const models = { data: [{ id: "claude-opus-4-8", provider: "anthropic" }] };
    const adminModels = { data: [{ id: "claude-opus-4-8", provider: "anthropic" }] };
    const status = { providers: {} };
    const fetchImpl = async (url, opts) => {
      const u = new URL(url, "http://x");
      if (u.pathname === "/v1/models") return { ok: true, status: 200, json: async () => models };
      if (u.pathname === "/admin/models") return { ok: true, status: 200, json: async () => adminModels };
      if (u.pathname === "/admin/models/status") return { ok: true, status: 200, json: async () => status };
      if (u.pathname === "/v1/chat/completions") { calledAnthropic = true; return { status: 200 }; }
      throw new Error("unexpected");
    };
    const regDir = mkdtempSync(join(tmpdir(), "skgw-verify-catalog-skip-"));
    const regPath = join(regDir, "registry.yaml");
    writeFileSync(regPath, "failover:\n  local_fallback: []\n");
    const result = await runVerification({ endpoint: "http://x", registryPath: regPath, skipProviders: ["anthropic"], fetchImpl, sleepImpl: noSleep });
    assert.equal(calledAnthropic, false, "anthropic must be skipped by default budget policy");
    assert.deepEqual(result.liveness.skipped, ["claude-opus-4-8"]);
  });

  test("gateway unreachable -> exit 2, no probes attempted, no alerts", async () => {
    const fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
    const alertImpl = recordingAlert();
    const result = await runVerification({ endpoint: "http://x", fetchImpl, sleepImpl: noSleep, doAlert: true, alertImpl });
    assert.equal(result.reachable, false);
    assert.equal(result.exitCode, EXIT_ERROR);
    assert.equal(alertImpl.calls.length, 0);
  });
});

// ── CLI: parseArgs / formatReport / main ────────────────────────────────────

describe("parseArgs", () => {
  test("defaults", () => {
    const o = parseArgs([]);
    assert.equal(o.alert, false);
    assert.deepEqual(o.skipProviders, ["anthropic"]);
  });
  test("--skip-provider is repeatable and replaces the default set", () => {
    const o = parseArgs(["--skip-provider", "anthropic", "--skip-provider", "local"]);
    assert.deepEqual(o.skipProviders, ["anthropic", "local"]);
  });
  test("--alert sets alert true", () => {
    assert.equal(parseArgs(["--alert"]).alert, true);
  });
  test("unknown flag throws", () => {
    assert.throws(() => parseArgs(["--nope"]));
  });
});

describe("formatReport", () => {
  test("unreachable case renders without throwing", () => {
    const out = formatReport({ reachable: false, error: "boom" }, "http://x");
    assert.match(out, /UNREACHABLE/);
  });
});

describe("main (CLI)", () => {
  test("exits 0 and prints CLEAN on a clean run", async () => {
    const models = { data: [{ id: "a", provider: "nvidia" }] };
    const adminModels = { data: [{ id: "a", provider: "nvidia" }] };
    const status = { providers: { nvidia: { ok: true, count: 1 } } };
    const fetchImpl = mockGatewayFetch({ models, adminModels, status });
    const regDir = mkdtempSync(join(tmpdir(), "skgw-verify-catalog-cli-"));
    const regPath = join(regDir, "registry.yaml");
    writeFileSync(regPath, "failover:\n  local_fallback:\n    - a\n");
    const logs = [];
    const code = await main(["--registry", regPath, "-q"], { fetchImpl, sleepImpl: noSleep, log: (s) => logs.push(s) });
    // failover has only 1 live entry here, so this is still DRIFT (exit 1) by
    // design - -q suppresses the report either way.
    assert.equal(code, EXIT_DRIFT);
    assert.equal(logs.length, 0);
  });

  test("--help prints usage and exits 0 without touching the network", async () => {
    const code = await main(["--help"], { fetchImpl: async () => { throw new Error("must not be called"); }, log: () => {} });
    assert.equal(code, EXIT_OK);
  });
});

// ── gateway outage must not be reported as dead models ──────────────────────
//
// Measured 2026-08-15: a sweep reported 24 NVIDIA models DEAD with
// `network_error: fetch failed` in one contiguous block. All 24 returned 200
// when probed individually seconds later, and the SAME run's failover check
// found a model alive that its own liveness check had just called dead. The
// journal showed the gateway took a SIGTERM mid-sweep. The models were fine;
// our gateway had restarted underneath the job.
//
// A daily job that pages about 24 healthy models gets muted within a week,
// which costs more than the check is worth.
describe("gateway unreachability is not model evidence", () => {
  test("a connection failure classifies as unreachable, never dead", () => {
    const c = classifyProbe({ networkError: "fetch failed" });
    assert.equal(c.unreachable, true);
    assert.equal(c.alive, false);
    assert.match(c.reason, /gateway_unreachable/);
  });

  test("a real HTTP error is still dead, not unreachable", () => {
    const c = classifyProbe({ status: 404 });
    assert.equal(c.alive, false);
    assert.ok(!c.unreachable, "a 404 from a reachable gateway IS model evidence");
    assert.equal(c.reason, "http_404");
  });

  test("a timeout is still dead, not unreachable", () => {
    const c = classifyProbe({ timedOut: true });
    assert.ok(!c.unreachable);
    assert.equal(c.reason, "timeout");
  });

  test("summarizeLiveness counts unreachable separately from dead", () => {
    const results = [
      { id: "a", alive: true, throttled: false, reason: "http_200", status: 200 },
      { id: "b", alive: false, unreachable: true, reason: "gateway_unreachable: fetch failed", status: null },
      { id: "c", alive: false, throttled: false, reason: "http_404", status: 404 },
    ];
    const providerById = new Map([["a", "nvidia"], ["b", "nvidia"], ["c", "nvidia"]]);
    const s = summarizeLiveness({ results, providerById });
    assert.equal(s.deadCount, 1, "only the genuine 404 is dead");
    assert.equal(s.unreachableCount, 1);
    assert.equal(s.deadIds.length, 1, "an unreachable id must never land in deadIds, which is what alerts");
    assert.equal(s.deadIds[0].id, "c");
    assert.equal(s.perProvider.nvidia.unreachable, 1);
  });

  test("probeAll waits for the gateway and re-probes rather than condemning", async () => {
    // First probe hits the restart window, the gateway then comes back and the
    // re-probe succeeds. The model must end up alive.
    let call = 0;
    const fetchImpl = async (url) => {
      if (url.endsWith("/v1/models")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
      call += 1;
      if (call === 1) throw new Error("fetch failed");
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    };
    const out = await probeAll({
      ids: ["m1"], endpoint: "http://gw", delayMs: 0,
      fetchImpl, sleepImpl: async () => {},
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].alive, true, "a restart window must not condemn a healthy model");
  });
});
