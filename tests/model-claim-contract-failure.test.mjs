/**
 * model-claim-contract-failure.test.mjs: a response-contract failure (a 2xx
 * upstream whose body fails enforceResponseContract, rewritten to a gateway
 * 502) must accumulate toward the exact model-claim's quarantine counter,
 * not be recorded as a claim success.
 *
 * Regression for the bug where routeAndSend's claimTransition call passed
 * `upstreamStatus` (the original 2xx) into recordModelClaimOutcome() instead
 * of `res.status` (the gateway's 502) whenever modelContractFailure was
 * true. recordModelClaimOutcome() treats any 2xx as a success and deletes
 * the failure entry, so every malformed-completion 502 was silently
 * recorded as a clean claim success and the per-model quarantine counter
 * could never accumulate. Live evidence: backend chiap08-qwen38 ran at
 * totalRequests 3941 / totalErrors 80 (about 8 percent) while reporting
 * quarantined false, consecutiveFailures 0 on the model-claim side, because
 * every invalid_upstream_completion / invalid_upstream_tool_calls / non
 * budget empty_upstream_response was counted as success there.
 *
 * The fix does not touch `healthy` (the shared backend transport health
 * signal) - a contract failure after a genuine 2xx still means the
 * transport worked, so `healthy` stays true and the shared backend must not
 * be marked down or quarantined for it. Only the argument passed to
 * recordModelClaimOutcome() changes.
 *
 * Run with:  node --test --import ./tests/_setup.mjs tests/model-claim-contract-failure.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createRouter, routeAndSend } from "../src/proxy/router.mjs";

const HEADERS = { "content-type": "application/json" };
const bodyFor = (model) => Buffer.from(JSON.stringify({
  model, messages: [{ role: "user", content: "hi" }],
}));

// A malformed body: empty public content plus a leaked private field, the
// same shape tests/nonstream-response-contract.test.mjs already proves the
// response contract rejects with a 502 invalid_upstream_completion (i.e.
// recoveryFailureClass "malformed_response" at the router.mjs call site
// under test, since the error code is not "empty_upstream_response").
function malformedBody(model) {
  return JSON.stringify({
    model,
    choices: [{
      index: 0,
      finish_reason: "length",
      message: { role: "assistant", content: "", reasoning_content: "private chain" },
    }],
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
  });
}

function validBody(model) {
  return JSON.stringify({
    model,
    choices: [{
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "ok" },
    }],
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
  });
}

/**
 * A controllable upstream. `state.mode` is read per-request so a single
 * server can flip from a bad completion to a good one (or a real transport
 * error) mid-test.
 *   "malformed" -> 200 with a contract-invalid body (drives modelContractFailure)
 *   "valid"     -> 200 with a well-formed completion
 *   "error"     -> a genuine transport-level 500 (no contract involvement)
 */
function startUpstream(state) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const { model } = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (state.mode === "error") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "boom" } }));
          return;
        }
        const body = state.mode === "valid" ? validBody(model) : malformedBody(model);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

describe("model-claim quarantine counts a contract failure as a failure", () => {
  test("a 2xx-then-502 contract failure increments the claim counter instead of clearing it", async () => {
    const state = { mode: "malformed" };
    const upstream = await startUpstream(state);
    try {
      const modelId = `test/contract-fail-${Date.now()}`;
      const router = createRouter({
        backends: {
          qwen: {
            url: upstream.base, auth_type: "none", models: [modelId], priority: 1,
            model_claim_quarantine_threshold: 5,
          },
        },
      });
      const backend = router.getBackend("qwen");

      const result = await routeAndSend(router, { model: modelId, agentId: "test" },
        "/chat/completions", "POST", HEADERS, bodyFor(modelId), false);
      assert.equal(result.status, 502);

      const health = backend.getModelClaimHealth(modelId);
      assert.equal(health.failures, 1,
        "a content-invalid completion must accumulate toward model-claim quarantine, " +
        "not be wiped as a claim success");
      assert.equal(health.quarantined, false);
    } finally {
      await upstream.close();
    }
  });

  test("repeated contract failures quarantine the model claim, and a genuine success readmits it", async () => {
    const state = { mode: "malformed" };
    const upstream = await startUpstream(state);
    try {
      const modelId = `test/contract-quarantine-${Date.now()}`;
      const router = createRouter({
        backends: {
          qwen: {
            url: upstream.base, auth_type: "none", models: [modelId], priority: 1,
            model_claim_quarantine_threshold: 2,
            model_claim_quarantine_cooldown_ms: 1,
          },
        },
      });
      const backend = router.getBackend("qwen");

      await routeAndSend(router, { model: modelId, agentId: "test" },
        "/chat/completions", "POST", HEADERS, bodyFor(modelId), false);
      assert.equal(backend.getModelClaimHealth(modelId).quarantined, false);

      await routeAndSend(router, { model: modelId, agentId: "test" },
        "/chat/completions", "POST", HEADERS, bodyFor(modelId), false);
      assert.equal(backend.getModelClaimHealth(modelId).quarantined, true,
        "two consecutive contract failures at threshold 2 must quarantine the claim");

      // Cooldown is 1ms: after it elapses, isModelClaimAvailable() admits
      // exactly one probe. Flip the upstream to a genuine good completion
      // and confirm that probe readmits the claim.
      await new Promise((r) => setTimeout(r, 5));
      state.mode = "valid";
      const result = await routeAndSend(router, { model: modelId, agentId: "test" },
        "/chat/completions", "POST", HEADERS, bodyFor(modelId), false);
      assert.equal(result.status, 200);
      assert.equal(backend.getModelClaimHealth(modelId).quarantined, false,
        "a genuine success must readmit a quarantined model claim");
    } finally {
      await upstream.close();
    }
  });

  test("shared backend transport health is unchanged by a contract failure", async () => {
    const state = { mode: "malformed" };
    const upstream = await startUpstream(state);
    try {
      const modelId = `test/contract-transport-${Date.now()}`;
      const router = createRouter({
        backends: {
          qwen: { url: upstream.base, auth_type: "none", models: [modelId], priority: 1 },
        },
      });
      const backend = router.getBackend("qwen");

      for (let i = 0; i < 3; i++) {
        // eslint-disable-next-line no-await-in-loop
        await routeAndSend(router, { model: modelId, agentId: "test" },
          "/chat/completions", "POST", HEADERS, bodyFor(modelId), false);
      }

      const health = backend.getHealth();
      assert.equal(health.quarantined, false,
        "the shared backend must not be quarantined by a model-specific contract fault");
      assert.equal(health.consecutiveFailures, 0,
        "healthy=true on a contract failure must keep resetting consecutive transport failures");
      assert.equal(health.status, "up");

      // But the model claim itself did accumulate all 3 failures.
      assert.equal(backend.getModelClaimHealth(modelId).failures, 3);
    } finally {
      await upstream.close();
    }
  });

  test("a real transport 5xx still behaves as before (unaffected by this fix)", async () => {
    const state = { mode: "error" };
    const upstream = await startUpstream(state);
    try {
      const modelId = `test/transport-500-${Date.now()}`;
      const router = createRouter({
        backends: {
          qwen: { url: upstream.base, auth_type: "none", models: [modelId], priority: 1 },
        },
      });
      const backend = router.getBackend("qwen");

      const result = await routeAndSend(router, { model: modelId, agentId: "test" },
        "/chat/completions", "POST", HEADERS, bodyFor(modelId), false);
      assert.equal(result.status, 500);

      // A genuine transport 500 is not a "fast model-claim failure" status
      // (only 404/410/502 are, see isFastModelClaimFailure) so it never
      // touches the per-model claim counter at all.
      const claimHealth = backend.getModelClaimHealth(modelId);
      assert.equal(claimHealth.failures, 0);
      assert.equal(claimHealth.quarantined, false);

      // The shared transport health DOES record the failure, exactly as
      // before this fix (healthy = res.status < 500 is false here).
      const health = backend.getHealth();
      assert.equal(health.consecutiveFailures, 1);
      assert.equal(health.totalErrors, 1);
    } finally {
      await upstream.close();
    }
  });
});
