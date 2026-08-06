/**
 * per-agent-routing.test.mjs - per-agent model routing (CR-5.1).
 *
 * SKGateway resolves a CapAuth agent identity per request, classifies the
 * prompt, and selects a backend by model name / registry alias. The per-agent
 * pin (a map of agent id -> a model or alias/role that OVERRIDES the model the
 * caller asked for) now lives in the skmodels registry as the `agent:<id>`
 * CONTEXT (the single source of truth), NOT a redundant `routing.per_agent`
 * config copy (removed in CR-5.1). It is read LIVE (registry.mjs re-parses on
 * mtime change) and composes with the classifier, failover, and the dead-alias
 * quarantine unchanged; a pinned target whose backend is quarantined/down still
 * falls back through the normal candidate machinery.
 *
 * Coverage:
 *   1. resolveAgentTarget() unit: reads the registry `agent:<id>` context,
 *      case-insensitively; empty / absent = no rules.
 *   2. An agent WITH a context routes to its pinned (concrete) model.
 *   3. An agent WITHOUT a context uses default model-name routing (unchanged).
 *   4. Empty registry = behaviour unchanged.
 *   5. A pin at a quarantined backend falls back to a healthy one.
 *   6. An explicit x-sk-role signal still wins over the agent pin.
 *
 * Run with:  node --test tests/per-agent-routing.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin the MODULE-DEFAULT skmodels registry to a path that does not exist BEFORE
// importing the router (registry.mjs captures REGISTRY_PATH at eval time). This
// keeps the DOWNSTREAM registry resolution (isRegistryRouted / resolveRegistry)
// empty + deterministic, so concrete-model pins route by model name and the
// x-sk-role precedence test does not depend on this host's registry.yaml. The
// per-agent CONTEXT lookup is pointed at an explicit fixture via
// config.registry_path per test.
process.env.SKMODELS_REGISTRY = "/nonexistent/skgateway-test-registry-cr51.yaml";

const { createRouter, routeAndSend } = await import("../src/proxy/router.mjs");

const fixDir = mkdtempSync(join(tmpdir(), "skgw-peragent-"));
let _fixSeq = 0;

/**
 * Write a fixture registry with the given `agent:<id> -> target` contexts and
 * return its path (unique per call so loadRegistry's mtime cache never stales).
 * @param {Record<string,string>} contexts
 * @returns {string}
 */
function writeRegistry(contexts) {
  const path = join(fixDir, `registry-${_fixSeq++}.yaml`);
  const lines = ["contexts:"];
  for (const [k, v] of Object.entries(contexts)) lines.push(`  ${k}: ${v}`);
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}

// ── fake upstream that records the model of the last request it served ───────

function startUpstream(statusRef = 200) {
  return new Promise((resolve) => {
    const state = { count: 0, lastModel: null };
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        state.count++;
        try {
          state.lastModel = JSON.parse(Buffer.concat(chunks).toString("utf-8")).model ?? null;
        } catch { state.lastModel = null; }
        const status = typeof statusRef === "function" ? statusRef() : statusRef;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: status < 400 }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(r)),
        state,
      });
    });
  });
}

const HEADERS = { "content-type": "application/json" };
const bodyFor = (model) => Buffer.from(JSON.stringify({ model, messages: [] }));

// ── 1: resolveAgentTarget unit (reads the registry agent:<id> context) ───────

describe("resolveAgentTarget (registry agent:<id> context)", () => {
  test("resolves a configured context, case-insensitively", () => {
    const registry_path = writeRegistry({ "agent:lumina": "sk-default", "agent:jarvis": "model-x" });
    const router = createRouter({
      backends: { a: { url: "http://x/v1", auth_type: "none", models: ["*"], priority: 1 } },
      registry_path,
    });
    assert.equal(router.resolveAgentTarget("lumina"), "sk-default");
    assert.equal(router.resolveAgentTarget("LUMINA"), "sk-default"); // caller-cased
    assert.equal(router.resolveAgentTarget("jarvis"), "model-x");
    assert.equal(router.resolveAgentTarget("nobody"), null);         // no context
    assert.equal(router.resolveAgentTarget(undefined), null);
  });

  test("a registry with no agent context = no rules", () => {
    // An existing registry that simply has no `agent:<id>` context yields no pin.
    // (A router with NO registry_path deliberately falls back to the production
    // default registry, so "no path" is not the same as "no rules".)
    const emptyReg = createRouter({
      backends: { a: { url: "http://x/v1", auth_type: "none", models: ["*"], priority: 1 } },
      registry_path: writeRegistry({ "agent:other": "model-x" }),
    });
    assert.equal(emptyReg.resolveAgentTarget("lumina"), null);
    assert.equal(emptyReg.resolveAgentTarget("other"), "model-x");
  });

  test("blank context targets never override routing", () => {
    const registry_path = writeRegistry({ "agent:good": "model-y", "agent:blank": '""' });
    const router = createRouter({
      backends: { a: { url: "http://x/v1", auth_type: "none", models: ["*"], priority: 1 } },
      registry_path,
    });
    assert.equal(router.resolveAgentTarget("good"), "model-y");
    assert.equal(router.resolveAgentTarget("blank"), null); // empty string -> no rule
  });
});

// ── 2-6: routeAndSend integration (real local upstreams) ─────────────────────

describe("per-agent routing via routeAndSend", () => {
  let backendA, backendB;
  let aStatus = 200;

  before(async () => {
    backendA = await startUpstream(() => aStatus);
    backendB = await startUpstream(() => 200);
  });

  after(async () => {
    await backendA.close();
    await backendB.close();
  });

  test("an agent WITH a context is pinned to its configured model", async () => {
    const router = createRouter({
      backends: {
        a: { url: backendA.base, auth_type: "none", models: ["model-a"], priority: 1 },
        b: { url: backendB.base, auth_type: "none", models: ["model-b"], priority: 2 },
      },
      registry_path: writeRegistry({ "agent:agenta": "model-a" }),
      failover: false,
    });

    // Caller asks for model-b, but agenta is pinned to model-a → backend a.
    const r = await routeAndSend(
      router, { model: "model-b", agentId: "agenta" },
      "/v1/chat/completions", "POST", HEADERS, bodyFor("model-b"), false,
    );
    assert.equal(r.status, 200);
    assert.equal(r.backendId, "a", "pinned to model-a's backend, not the requested model-b");
    assert.equal(backendA.state.lastModel, "model-a", "outgoing model was rewritten to the pinned target");
  });

  test("an agent WITHOUT a context uses normal model-name routing", async () => {
    const router = createRouter({
      backends: {
        a: { url: backendA.base, auth_type: "none", models: ["model-a"], priority: 1 },
        b: { url: backendB.base, auth_type: "none", models: ["model-b"], priority: 2 },
      },
      registry_path: writeRegistry({ "agent:agenta": "model-a" }),
      failover: false,
    });

    // A different agent (no context) asking for model-b routes to backend b.
    const r = await routeAndSend(
      router, { model: "model-b", agentId: "someone-else" },
      "/v1/chat/completions", "POST", HEADERS, bodyFor("model-b"), false,
    );
    assert.equal(r.status, 200);
    assert.equal(r.backendId, "b", "un-pinned agent routes by requested model");
    assert.equal(backendB.state.lastModel, "model-b", "model untouched for an un-pinned agent");
  });

  test("empty registry leaves routing unchanged", async () => {
    const router = createRouter({
      backends: {
        a: { url: backendA.base, auth_type: "none", models: ["model-a"], priority: 1 },
        b: { url: backendB.base, auth_type: "none", models: ["model-b"], priority: 2 },
      },
      registry_path: writeRegistry({}),
      failover: false,
    });
    const r = await routeAndSend(
      router, { model: "model-b", agentId: "agenta" },
      "/v1/chat/completions", "POST", HEADERS, bodyFor("model-b"), false,
    );
    assert.equal(r.backendId, "b", "no contexts → requested model wins");
  });

  test("a pin at a quarantined backend falls back to a healthy one", async () => {
    const router = createRouter({
      backends: {
        // Both serve the pinned model; primary is priority 1, fallback priority 2.
        primary:  { url: backendA.base, auth_type: "none", models: ["pinned"], priority: 1 },
        fallback: { url: backendB.base, auth_type: "none", models: ["pinned"], priority: 2 },
      },
      registry_path: writeRegistry({ "agent:pinnedagent": "pinned" }),
      quarantine: { threshold: 3, cooldown_ms: 10_000 },
      failover: true,
    });

    // Drive the primary into quarantine deterministically (3 consecutive fails).
    const prim = router.getBackend("primary");
    prim.recordOutcome(false, 1);
    prim.recordOutcome(false, 1);
    assert.equal(prim.recordOutcome(false, 1)?.transition, "quarantined");
    assert.equal(router.getHealth().primary.quarantined, true);

    const before = backendA.state.count;

    // pinnedagent is pinned to "pinned"; primary is quarantined → must serve
    // straight from the fallback with no failover attempt on the primary.
    const r = await routeAndSend(
      router, { model: "does-not-matter", agentId: "pinnedagent" },
      "/v1/chat/completions", "POST", HEADERS, bodyFor("does-not-matter"), false,
    );
    assert.equal(r.status, 200);
    assert.equal(r.backendId, "fallback", "pinned target's quarantined backend fell back");
    assert.equal(r.failover, false, "quarantined primary was skipped in selection, not failed over");
    assert.equal(backendA.state.count, before, "quarantined primary received no request");
    assert.equal(backendB.state.lastModel, "pinned", "fallback still received the pinned model");
  });

  test("an explicit x-sk-role signal wins over the agent pin", async () => {
    const router = createRouter({
      backends: {
        a: { url: backendA.base, auth_type: "none", models: ["model-a"], priority: 1 },
        b: { url: backendB.base, auth_type: "none", models: ["model-b"], priority: 2 },
      },
      registry_path: writeRegistry({ "agent:agenta": "model-a" }),
      failover: false,
    });

    // With an explicit role signal present, the per-agent pin must NOT rewrite
    // the model (deliberate per-request routing intent wins). Registry resolution
    // for the role finds no registry file at the MODULE default path, so it falls
    // through to normal model-name routing on the ORIGINAL model-b → backend b.
    const r = await routeAndSend(
      router, { model: "model-b", agentId: "agenta", role: "sk-code" },
      "/v1/chat/completions", "POST", HEADERS, bodyFor("model-b"), false,
    );
    assert.equal(r.backendId, "b", "explicit role signal suppressed the agent pin");
  });
});
