/**
 * verify-role-fidelity.test.mjs — card ba782c14, the open acceptance criterion:
 * "response.model is asserted to belong to the backend the role resolved to,
 * per role, and fails when it does not".
 *
 * WHY THIS CHECK EXISTS, in one measured incident (2026-08-16):
 *
 *   model=sk-creative -> HTTP 200, response.model = openai/gpt-oss-20b
 *
 * sk-creative is the abliterated, uncensored role. Its sovereign backend was
 * refused, so local-failover answered it from a guardrailed cloud model and
 * returned 200. Separately, during a ~4h outage of .100, sk-default returned 200
 * the whole time, also served from cloud, which HID the outage completely.
 *
 * No existing check could see either one:
 *   - LIVENESS sweeps GET /v1/models, and roles are not in that catalog at all.
 *   - Both roles were, in the only sense liveness measures, perfectly ALIVE.
 *
 * The failure is not "no answer", it is "an answer from something else". So the
 * assertion has to compare what the role RESOLVES to against what actually
 * SERVED it. Everything else stays green through a silent substitution.
 *
 * Run with:  node --test tests/verify-role-fidelity.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRoleFidelity } from "../scripts/verify-catalog.mjs";

const REGISTRY = `backends:
  ornith:
    url: http://192.168.0.100:8082/v1
    model: ornith-1.0-9b
    kind: chat
  qwen38:
    url: http://100.81.238.58:11439/v1
    model: qwen3.8-27b-huihui-abliterated-q4_k_m
    kind: chat
  mxbai:
    url: http://192.168.0.100:11438/v1/embeddings
    model: mxbai-embed-large
    kind: embed
roles:
  sk-default: ornith
  sk-creative: qwen38
  sk-embed: mxbai
  sk-auto: auto
defaults:
  role: sk-default
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "skgw-role-"));
  const p = join(dir, "registry.yaml");
  writeFileSync(p, REGISTRY);
  return p;
}

/** A gateway that answers every role with `servedModel`. */
function fakeGateway(servedByRole) {
  return async (_url, opts) => {
    const body = JSON.parse(opts.body);
    const served = servedByRole[body.model] ?? body.model;
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === "x-sk-model-served" ? served : null) },
      json: async () => ({ model: served, choices: [{ message: { content: "ok" } }] }),
    };
  };
}

describe("checkRoleFidelity", () => {
  test("a role served by its own backend's model is faithful", async () => {
    const res = await checkRoleFidelity({
      registryPath: fixture(),
      endpoint: "http://gw",
      fetchImpl: fakeGateway({
        "sk-default": "ornith-1.0-9b",
        "sk-creative": "qwen3.8-27b-huihui-abliterated-q4_k_m",
      }),
      sleepImpl: async () => {},
    });
    assert.equal(res.mismatches.length, 0, `expected no mismatches, got ${JSON.stringify(res.mismatches)}`);
    assert.equal(res.alarm, false);
  });

  test("THE INCIDENT: a role silently served by a cloud model is caught", async () => {
    const res = await checkRoleFidelity({
      registryPath: fixture(),
      endpoint: "http://gw",
      // Exactly what was measured: 200 OK, wrong model, no error anywhere.
      fetchImpl: fakeGateway({
        "sk-default": "ornith-1.0-9b",
        "sk-creative": "openai/gpt-oss-20b",
      }),
      sleepImpl: async () => {},
    });
    assert.equal(res.alarm, true, "a substituted role MUST alarm");
    assert.equal(res.mismatches.length, 1);
    const m = res.mismatches[0];
    assert.equal(m.role, "sk-creative");
    assert.equal(m.expected, "qwen3.8-27b-huihui-abliterated-q4_k_m");
    assert.equal(m.served, "openai/gpt-oss-20b");
  });

  test("non-chat and marker roles are skipped, not reported as broken", async () => {
    const res = await checkRoleFidelity({
      registryPath: fixture(),
      endpoint: "http://gw",
      fetchImpl: fakeGateway({
        "sk-default": "ornith-1.0-9b",
        "sk-creative": "qwen3.8-27b-huihui-abliterated-q4_k_m",
      }),
      sleepImpl: async () => {},
    });
    const checked = res.entries.map((e) => e.role);
    assert.ok(!checked.includes("sk-auto"), "sk-auto is a marker, it resolves per-request");
    assert.ok(!checked.includes("sk-embed"), "embeddings are not chat completions");
    assert.deepEqual(checked.sort(), ["sk-creative", "sk-default"]);
  });
});

// ── the alert, not just the exit code ───────────────────────────────────────
//
// Check 5 first shipped setting `drift` (exit 1) and firing NO alert. The
// scheduled job runs with `notify: off` and depends entirely on this script's
// own sk-alert call, so a substituted role would have been detected daily and
// reported to nobody. That is the same defect the check exists to catch, one
// layer up, so it gets its own regression test rather than a comment.

import { runVerification, ALERT_ROLE_KEY, EXIT_DRIFT } from "../scripts/verify-catalog.mjs";

function gatewayWithRoles(servedByRole) {
  return async (url, opts) => {
    const u = new URL(url, "http://x");
    const empty = { data: [] };
    if (u.pathname === "/v1/models") return { ok: true, status: 200, json: async () => empty };
    if (u.pathname === "/admin/models") return { ok: true, status: 200, json: async () => empty };
    if (u.pathname === "/admin/models/status") return { ok: true, status: 200, json: async () => ({ providers: {} }) };
    if (u.pathname === "/v1/chat/completions") {
      const body = JSON.parse(opts.body);
      const served = servedByRole[body.model] ?? body.model;
      return {
        ok: true,
        status: 200,
        headers: { get: (h) => (h.toLowerCase() === "x-sk-model-served" ? served : null) },
        json: async () => ({ model: served, choices: [{ message: { content: "ok" } }] }),
      };
    }
    throw new Error(`unexpected request to ${u.pathname}`);
  };
}

describe("role substitution PAGES, it does not merely set an exit code", () => {
  test("a substituted role fires sk-alert under its own dedupe key", async () => {
    const calls = [];
    const alertImpl = async (args) => { calls.push(args); return { fired: true, bin: "/fake/sk-alert" }; };

    const result = await runVerification({
      endpoint: "http://x",
      registryPath: fixture(),
      fetchImpl: gatewayWithRoles({
        "sk-default": "ornith-1.0-9b",
        "sk-creative": "openai/gpt-oss-20b", // the measured incident
      }),
      sleepImpl: async () => {},
      doAlert: true,
      alertImpl,
    });

    assert.equal(result.exitCode, EXIT_DRIFT, "a substitution is drift");
    const keys = calls.map((c) => c.key);
    assert.ok(keys.includes(ALERT_ROLE_KEY), `expected a page under ${ALERT_ROLE_KEY}, got ${JSON.stringify(keys)}`);
    const page = calls.find((c) => c.key === ALERT_ROLE_KEY);
    assert.equal(page.level, "crit");
    // The message has to name both sides or it is not actionable at 3am.
    assert.match(page.message, /sk-creative/);
    assert.match(page.message, /openai\/gpt-oss-20b/);
  });

  test("a faithful run pages nobody", async () => {
    const calls = [];
    const alertImpl = async (args) => { calls.push(args); return { fired: true }; };
    await runVerification({
      endpoint: "http://x",
      registryPath: fixture(),
      fetchImpl: gatewayWithRoles({
        "sk-default": "ornith-1.0-9b",
        "sk-creative": "qwen3.8-27b-huihui-abliterated-q4_k_m",
      }),
      sleepImpl: async () => {},
      doAlert: true,
      alertImpl,
    });
    assert.equal(calls.filter((c) => c.key === ALERT_ROLE_KEY).length, 0);
  });
});
