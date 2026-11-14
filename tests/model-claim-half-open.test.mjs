// Exact-claim half-open recovery (card 566f659d). Uses a backend outside
// the zai/codex provider capacity gate so the generic exact-claim layer is
// isolated. Both cases fail on the pre-566f659d router (3 requests reach a
// recovering claim; a quarantined claim is advertised available).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRouter, routeAndSend } from "../src/proxy/router.mjs";
import { isModelAvailable } from "../src/proxy/advertise.mjs";

const HEADERS = { "content-type": "application/json" };
const MODEL = "claim-proof-model";
const body = () => Buffer.from(JSON.stringify({
  model: MODEL, messages: [{ role: "user", content: "alive" }],
}));

function upstream() {
  let status = 502;
  let delay = 0;
  const requests = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => setTimeout(() => {
        requests.push(raw);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(status === 200 ? {
          id: "x", object: "chat.completion", created: 0, model: MODEL,
          choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        } : { error: { code: "invalid_upstream_completion" } }));
      }, delay));
    });
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      requests,
      set(s, d = 0) { status = s; delay = d; },
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

async function quarantinedRouter(up) {
  const router = createRouter({ backends: { exact: {
    url: up.url, models: [MODEL], auth_type: "none", priority: 1,
    quarantine_threshold: 0, cooldown_ms: 1,
    model_claim_quarantine_threshold: 3, model_claim_quarantine_cooldown_ms: 200,
  } } });
  for (let i = 0; i < 3; i++) {
    await routeAndSend(router, { model: MODEL }, "/v1/chat/completions", "POST", HEADERS, body(), false);
  }
  assert.equal(router.getBackend("exact").getModelClaimHealth(MODEL).quarantined, true);
  return router;
}

test("after cooldown exactly one concurrent request reaches a recovering claim", async () => {
  const up = await upstream();
  try {
    const router = await quarantinedRouter(up);
    await new Promise((r) => setTimeout(r, 250));
    up.set(200, 30);
    const before = up.requests.length;
    await Promise.allSettled([1, 2, 3].map(() => routeAndSend(
      router, { model: MODEL }, "/v1/chat/completions", "POST", HEADERS, body(), false)));
    assert.equal(up.requests.length - before, 1,
      "only one half-open probe may reach upstream; the rest stay suppressed");
    assert.equal(router.getBackend("exact").getModelClaimHealth(MODEL).quarantined, false);
  } finally { await up.close(); }
});

test("catalog availability reflects an exact-claim quarantine on a real router", async () => {
  const up = await upstream();
  try {
    const router = await quarantinedRouter(up);
    assert.equal(isModelAvailable(MODEL, router), false,
      "a quarantined exact claim must not be advertised as available");
  } finally { await up.close(); }
});

test("a probe lease taken by route() without a send cannot pin the claim forever", async () => {
  const up = await upstream();
  try {
    const router = await quarantinedRouter(up);
    await new Promise((r) => setTimeout(r, 250));
    // Resolve candidates and discard them, as the lifecycle-gate and @match
    // paths do. This takes the half-open lease with no upstream attempt.
    const discarded = await router.route({ model: MODEL });
    assert.equal(discarded.length, 1);
    assert.equal(router.getBackend("exact").getModelClaimHealth(MODEL).probing, true);
    // Within the same window the lease still excludes a second probe.
    await assert.rejects(router.route({ model: MODEL }));
    // After one more cooldown window the abandoned lease expires.
    await new Promise((r) => setTimeout(r, 250));
    up.set(200);
    const result = await routeAndSend(
      router, { model: MODEL }, "/v1/chat/completions", "POST", HEADERS, body(), false);
    assert.equal(result.status, 200);
    assert.equal(router.getBackend("exact").getModelClaimHealth(MODEL).quarantined, false);
  } finally { await up.close(); }
});
