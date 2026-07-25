/**
 * parity-check.test.mjs - declared-vs-working parity check with drift alerting.
 *
 * SKGateway card 7c99c856. Drives the pure delta computation and the end-to-end
 * runner with mocked /health + /v1/models responses and a mocked config, proving
 * each drift class is detected, exit codes are correct, parity exits clean, and
 * the alert fires ONLY when enabled.
 *
 * Run with:  node --test tests/parity-check.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeParity,
  declaredModelIndex,
  matchesWildcard,
  backendServing,
  fetchLive,
  runParityCheck,
  parseArgs,
  main,
  EXIT_OK,
  EXIT_DRIFT,
  EXIT_ERROR,
} from "../scripts/parity-check.mjs";

// ── canonical declared config used across cases ──
const DECLARED = {
  local: { models: ["ornith-1.0-9b", "qwen3.6-27b"] },
  nvidia: { models: ["moonshotai/kimi-k2.6", "deepseek-ai/deepseek-v4"] },
  ollama: { models: ["dolphin-*"] }, // wildcard pattern
};

// A fully-healthy live state that matches DECLARED exactly (parity).
const healthAllUp = {
  backends: {
    local: { status: "up", quarantined: false },
    nvidia: { status: "up", quarantined: false },
    ollama: { status: "up", quarantined: false },
  },
};
const modelsAll = {
  data: [
    { id: "ornith-1.0-9b", owned_by: "local" },
    { id: "qwen3.6-27b", owned_by: "local" },
    { id: "moonshotai/kimi-k2.6", owned_by: "nvidia" },
    { id: "deepseek-ai/deepseek-v4", owned_by: "nvidia" },
    { id: "dolphin-2.9", owned_by: "ollama" }, // matches wildcard → declared
  ],
};

// ── helper: build a fetch mock keyed by path ──
function mockFetch(map) {
  return async (url) => {
    const path = new URL(url).pathname;
    if (path in map) {
      const v = map[path];
      if (v instanceof Error) throw v;
      return { ok: true, status: 200, json: async () => v };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

describe("declaredModelIndex + wildcard matching", () => {
  test("splits concrete models from wildcard patterns and maps owners", () => {
    const idx = declaredModelIndex(DECLARED);
    assert.equal(idx.models.has("ornith-1.0-9b"), true);
    assert.equal(idx.models.has("dolphin-*"), false); // wildcard excluded
    assert.deepEqual(idx.wildcards, ["dolphin-*"]);
    assert.deepEqual(idx.owner.get("ornith-1.0-9b"), ["local"]);
  });

  test("matchesWildcard honors trailing-star patterns", () => {
    assert.equal(matchesWildcard("dolphin-2.9", ["dolphin-*"]), true);
    assert.equal(matchesWildcard("llama-3", ["dolphin-*"]), false);
  });

  test("backendServing: up/degraded serve, down/quarantined/missing do not", () => {
    assert.equal(backendServing({ status: "up" }), true);
    assert.equal(backendServing({ status: "degraded" }), true);
    assert.equal(backendServing({ status: "down" }), false);
    assert.equal(backendServing({ status: "up", quarantined: true }), false);
    assert.equal(backendServing(undefined), false);
  });
});

describe("computeParity - parity (no drift)", () => {
  test("declared exactly matches live → no drift, all classes empty", () => {
    const r = computeParity({
      declaredBackends: DECLARED,
      liveHealth: healthAllUp,
      liveModels: modelsAll,
    });
    assert.equal(r.drift, false);
    assert.equal(r.classes.declared_not_working.length, 0);
    assert.equal(r.classes.working_not_declared.length, 0);
    assert.equal(r.classes.quarantined.length, 0);
    assert.equal(r.classes.unreachable.length, 0);
  });
});

describe("computeParity - drift class: declared_not_working", () => {
  test("declared model not advertised by live gateway (config edited, not reloaded)", () => {
    const models = {
      data: modelsAll.data.filter((m) => m.id !== "deepseek-ai/deepseek-v4"),
    };
    const r = computeParity({ declaredBackends: DECLARED, liveHealth: healthAllUp, liveModels: models });
    assert.equal(r.drift, true);
    const hit = r.classes.declared_not_working.find((d) => d.model === "deepseek-ai/deepseek-v4");
    assert.ok(hit, "deepseek flagged");
    assert.equal(hit.reason, "not_advertised");
    assert.deepEqual(hit.backends, ["nvidia"]);
  });

  test("declared+advertised but owning backend down → backend_not_serving", () => {
    const health = {
      backends: { ...healthAllUp.backends, nvidia: { status: "down", quarantined: false } },
    };
    const r = computeParity({ declaredBackends: DECLARED, liveHealth: health, liveModels: modelsAll });
    assert.equal(r.drift, true);
    const hit = r.classes.declared_not_working.find((d) => d.model === "moonshotai/kimi-k2.6");
    assert.ok(hit);
    assert.equal(hit.reason, "backend_not_serving");
  });
});

describe("computeParity - drift class: quarantined", () => {
  test("quarantined backend surfaces in quarantined class + fails its models", () => {
    const health = {
      backends: { ...healthAllUp.backends, nvidia: { status: "up", quarantined: true } },
    };
    const r = computeParity({ declaredBackends: DECLARED, liveHealth: health, liveModels: modelsAll });
    assert.equal(r.drift, true);
    assert.deepEqual(
      r.classes.quarantined.map((q) => q.backend),
      ["nvidia"],
    );
    assert.equal(r.classes.quarantined[0].status, "quarantined");
    // its declared models are now not-working too
    assert.ok(r.classes.declared_not_working.some((d) => d.backends.includes("nvidia")));
  });
});

describe("computeParity - drift class: unreachable (backend unknown to live)", () => {
  test("declared backend absent from /health is flagged unreachable", () => {
    const health = { backends: { local: healthAllUp.backends.local, ollama: healthAllUp.backends.ollama } };
    const r = computeParity({ declaredBackends: DECLARED, liveHealth: health, liveModels: modelsAll });
    assert.equal(r.drift, true);
    assert.deepEqual(r.classes.unreachable, ["nvidia"]);
    // models owned only by the missing backend → backend_unreachable reason
    const hit = r.classes.declared_not_working.find((d) => d.model === "moonshotai/kimi-k2.6");
    assert.equal(hit.reason, "backend_unreachable");
  });
});

describe("computeParity - drift class: working_not_declared", () => {
  test("live advertises a model config does not declare - reported, not drift by default", () => {
    const models = { data: [...modelsAll.data, { id: "ghost-model-v1", owned_by: "nvidia" }] };
    const r = computeParity({ declaredBackends: DECLARED, liveHealth: healthAllUp, liveModels: models });
    assert.deepEqual(r.classes.working_not_declared, ["ghost-model-v1"]);
    assert.equal(r.drift, false, "extra advertised model is informational by default");
  });

  test("strictUndeclared promotes working_not_declared to drift", () => {
    const models = { data: [...modelsAll.data, { id: "ghost-model-v1", owned_by: "nvidia" }] };
    const r = computeParity({
      declaredBackends: DECLARED,
      liveHealth: healthAllUp,
      liveModels: models,
      strictUndeclared: true,
    });
    assert.equal(r.drift, true);
  });

  test("wildcard-matched live model is NOT counted as undeclared", () => {
    const models = { data: [...modelsAll.data, { id: "dolphin-3.0", owned_by: "ollama" }] };
    const r = computeParity({ declaredBackends: DECLARED, liveHealth: healthAllUp, liveModels: models });
    assert.equal(r.classes.working_not_declared.length, 0);
    assert.equal(r.drift, false);
  });
});

describe("computeParity - gateway unreachable", () => {
  test("reachable=false → drift, gateway marker, all declared unverifiable", () => {
    const r = computeParity({ declaredBackends: DECLARED, reachable: false });
    assert.equal(r.drift, true);
    assert.equal(r.reachable, false);
    assert.deepEqual(r.classes.unreachable, ["<gateway>"]);
    assert.equal(
      r.classes.declared_not_working.every((d) => d.reason === "gateway_unreachable"),
      true,
    );
  });
});

describe("fetchLive", () => {
  test("returns reachable + parsed bodies on success", async () => {
    const f = mockFetch({ "/health": healthAllUp, "/v1/models": modelsAll });
    const live = await fetchLive("http://localhost:18780", { fetchImpl: f });
    assert.equal(live.reachable, true);
    assert.deepEqual(live.health, healthAllUp);
    assert.deepEqual(live.models, modelsAll);
  });

  test("connection failure → reachable=false with error", async () => {
    const f = mockFetch({ "/health": new Error("ECONNREFUSED") });
    const live = await fetchLive("http://localhost:18780", { fetchImpl: f });
    assert.equal(live.reachable, false);
    assert.match(live.error, /ECONNREFUSED/);
  });
});

describe("runParityCheck - exit codes + gated alerting", () => {
  test("parity → exit 0, no alert even if enabled", async () => {
    const f = mockFetch({ "/health": healthAllUp, "/v1/models": modelsAll });
    let alertCalls = 0;
    const { exitCode, alerted } = await runParityCheck({
      declaredBackends: DECLARED,
      fetchImpl: f,
      doAlert: true,
      alertImpl: () => alertCalls++,
    });
    assert.equal(exitCode, EXIT_OK);
    assert.equal(alerted, false);
    assert.equal(alertCalls, 0, "no alert on parity");
  });

  test("drift → exit 1", async () => {
    const models = { data: modelsAll.data.filter((m) => m.id !== "qwen3.6-27b") };
    const f = mockFetch({ "/health": healthAllUp, "/v1/models": models });
    const { exitCode } = await runParityCheck({ declaredBackends: DECLARED, fetchImpl: f });
    assert.equal(exitCode, EXIT_DRIFT);
  });

  test("gateway unreachable → exit 2", async () => {
    const f = mockFetch({ "/health": new Error("ECONNREFUSED") });
    const { exitCode } = await runParityCheck({ declaredBackends: DECLARED, fetchImpl: f });
    assert.equal(exitCode, EXIT_ERROR);
  });

  test("alert fires ONLY when enabled AND drift present", async () => {
    const models = { data: modelsAll.data.filter((m) => m.id !== "qwen3.6-27b") };
    const f = mockFetch({ "/health": healthAllUp, "/v1/models": models });

    // disabled → no alert
    let disabledCalls = 0;
    await runParityCheck({ declaredBackends: DECLARED, fetchImpl: f, doAlert: false, alertImpl: () => disabledCalls++ });
    assert.equal(disabledCalls, 0);

    // enabled → alert with payload (no secrets, just classes + counts)
    const captured = [];
    const { alerted } = await runParityCheck({
      declaredBackends: DECLARED,
      fetchImpl: f,
      doAlert: true,
      alertLevel: "error",
      alertImpl: (event, payload, level) => captured.push({ event, payload, level }),
    });
    assert.equal(alerted, true);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].event, "parity.drift");
    assert.equal(captured[0].level, "error");
    assert.equal(captured[0].payload.counts.declared_not_working, 1);
    assert.ok(!JSON.stringify(captured[0].payload).match(/api_key|secret|password/i), "no secrets in alert");
  });
});

describe("parseArgs", () => {
  test("defaults, then flag overrides", () => {
    const d = parseArgs([]);
    assert.equal(d.endpoint, process.env.SKGATEWAY_PARITY_ENDPOINT || "http://localhost:18780");
    assert.equal(d.alert, process.env.SKGATEWAY_PARITY_ALERT === "1");
    const o = parseArgs(["--endpoint", "http://x:1/", "--alert", "--strict-undeclared", "--json", "--timeout", "999"]);
    assert.equal(o.endpoint, "http://x:1/");
    assert.equal(o.alert, true);
    assert.equal(o.strictUndeclared, true);
    assert.equal(o.json, true);
    assert.equal(o.timeoutMs, 999);
  });

  test("unknown flag throws", () => {
    assert.throws(() => parseArgs(["--bogus"]), /unknown flag/);
  });
});

describe("main - end to end with injected config + fetch", () => {
  const fakeLoadConfig = async () => ({ current: () => ({ backends: DECLARED }) });

  test("parity path returns 0 and prints RESULT: PARITY", async () => {
    const f = mockFetch({ "/health": healthAllUp, "/v1/models": modelsAll });
    const out = [];
    const code = await main([], { loadConfig: fakeLoadConfig, fetchImpl: f, log: (s) => out.push(s) });
    assert.equal(code, EXIT_OK);
    assert.match(out.join("\n"), /PARITY/);
  });

  test("drift path returns 1 and prints RESULT: DRIFT", async () => {
    const models = { data: modelsAll.data.filter((m) => m.id !== "qwen3.6-27b") };
    const f = mockFetch({ "/health": healthAllUp, "/v1/models": models });
    const out = [];
    const code = await main([], { loadConfig: fakeLoadConfig, fetchImpl: f, log: (s) => out.push(s) });
    assert.equal(code, EXIT_DRIFT);
    assert.match(out.join("\n"), /DRIFT/);
  });

  test("--json emits parseable structured output", async () => {
    const f = mockFetch({ "/health": healthAllUp, "/v1/models": modelsAll });
    const out = [];
    const code = await main(["--json"], { loadConfig: fakeLoadConfig, fetchImpl: f, log: (s) => out.push(s) });
    assert.equal(code, EXIT_OK);
    const parsed = JSON.parse(out.join("\n"));
    assert.equal(parsed.drift, false);
    assert.equal(parsed.endpoint, process.env.SKGATEWAY_PARITY_ENDPOINT || "http://localhost:18780");
  });

  test("config load failure returns exit 2", async () => {
    const badLoad = async () => {
      throw new Error("bad yaml");
    };
    const errs = [];
    const code = await main([], { loadConfig: badLoad, errLog: (s) => errs.push(s) });
    assert.equal(code, EXIT_ERROR);
    assert.match(errs.join("\n"), /config error/);
  });
});
