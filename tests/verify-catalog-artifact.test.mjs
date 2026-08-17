/**
 * verify-catalog-artifact.test.mjs — the artifact skwatchdog consumes.
 *
 * Card 99c33052. skgateway owns the probe and stays the SINGLE prober;
 * skwatchdog reads the result rather than running its own. That division was
 * chosen deliberately: this week produced four separate incidents of one fact
 * having two sources of truth that drifted while both kept answering
 * confidently (capauth.__version__ vs the installed package, capauth's
 * hardcoded root vs the signing key, a skos manifest vs its adapter, a skos
 * test vs an integrity fix). A watchdog re-probing what the gateway already
 * probes would have been the fifth and worst, because both probes would look
 * authoritative.
 *
 * The contract has to make three states distinguishable, and the third is the
 * one that matters:
 *
 *   1. checked, all roles faithful
 *   2. checked, a role was substituted
 *   3. COULD NOT CHECK
 *
 * Conflating 3 with 1 is exactly how .100 stayed invisible for four hours: a
 * dead node behind a healthy-looking answer. So the artifact is written even
 * when the gateway is unreachable, and it always carries `finished_at` so a
 * reader can decide staleness for itself rather than inferring health from a
 * file that merely exists.
 *
 * Run with:  node --test tests/verify-catalog-artifact.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVerification, ARTIFACT_VERSION } from "../scripts/verify-catalog.mjs";

const REGISTRY = `backends:
  ornith:
    url: http://192.168.0.100:8082/v1
    model: ornith-1.0-9b
    kind: chat
  qwen38:
    url: http://100.81.238.58:11439/v1
    model: qwen3.8-27b-huihui-abliterated-q4_k_m
    kind: chat
roles:
  sk-default: ornith
  sk-creative: qwen38
defaults:
  role: sk-default
`;

function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), "skgw-artifact-"));
  const registryPath = join(dir, "registry.yaml");
  writeFileSync(registryPath, REGISTRY);
  return { registryPath, artifactPath: join(dir, "catalog-verify.json") };
}

function gateway(servedByRole, { reachable = true } = {}) {
  return async (url, opts) => {
    if (!reachable) throw new Error("connect ECONNREFUSED");
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
    throw new Error(`unexpected ${u.pathname}`);
  };
}

const FAITHFUL = { "sk-default": "ornith-1.0-9b", "sk-creative": "qwen3.8-27b-huihui-abliterated-q4_k_m" };

describe("the skwatchdog artifact", () => {
  test("carries a version and finished_at so a reader can refuse it or age it", async () => {
    const { registryPath, artifactPath } = fixtures();
    await runVerification({
      endpoint: "http://x", registryPath, artifactPath,
      fetchImpl: gateway(FAITHFUL), sleepImpl: async () => {},
    });

    const a = JSON.parse(readFileSync(artifactPath, "utf8"));
    assert.equal(a.artifact_version, ARTIFACT_VERSION);
    assert.ok(a.finished_at, "finished_at is how a reader computes staleness itself");
    assert.doesNotThrow(() => new Date(a.finished_at).toISOString());
    assert.equal(a.checked, true);
    assert.equal(a.role_fidelity.alarm, false);
  });

  test("a substituted role is recorded per role, with both sides named", async () => {
    const { registryPath, artifactPath } = fixtures();
    await runVerification({
      endpoint: "http://x", registryPath, artifactPath,
      fetchImpl: gateway({ ...FAITHFUL, "sk-creative": "openai/gpt-oss-20b" }),
      sleepImpl: async () => {},
    });

    const a = JSON.parse(readFileSync(artifactPath, "utf8"));
    assert.equal(a.role_fidelity.alarm, true);
    const m = a.role_fidelity.mismatches.find((x) => x.role === "sk-creative");
    assert.ok(m, "the substituted role must be named");
    assert.equal(m.expected, "qwen3.8-27b-huihui-abliterated-q4_k_m");
    assert.equal(m.served, "openai/gpt-oss-20b");
  });

  test("AN UNREACHABLE GATEWAY STILL WRITES ONE, marked not-checked", async () => {
    const { registryPath, artifactPath } = fixtures();
    await runVerification({
      endpoint: "http://x", registryPath, artifactPath,
      fetchImpl: gateway(FAITHFUL, { reachable: false }), sleepImpl: async () => {},
    });

    assert.ok(existsSync(artifactPath), "no artifact means the reader cannot tell 'unchecked' from 'never ran'");
    const a = JSON.parse(readFileSync(artifactPath, "utf8"));
    // The distinction the whole contract exists for: this is NOT an all-clear.
    assert.equal(a.checked, false, "an unreachable gateway must never read as healthy");
    assert.ok(a.error, "and it must say why");
    assert.equal(a.role_fidelity, null, "no result is not the same as a clean result");
    assert.ok(a.finished_at, "still timestamped, so staleness still works");
  });
});
