import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { sendUpstream } from "../src/proxy/upstream.mjs";

// Regression guard for the 2026-09-19 kimi-for-coding wedge.
//
// `timeout_ms` is applied as a Node socket IDLE timer, which resets on any
// socket activity. An upstream that dribbles bytes therefore never trips it and
// hangs forever. Because the router records backend health only from a
// COMPLETED attempt, a request that never resolves never reaches
// recordOutcome(), so /health reported kimi-for-coding "up, 0% errors,
// 486 requests, 0 failures" while every request to it was wedged.
//
// The hard deadline exists to make a wedge OBSERVABLE, not merely survivable.

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port }));
  });
}

async function call(port, { timeoutMs = 0, hardMs = 0 } = {}) {
  const startedAt = Date.now();
  const res = await sendUpstream(
    "/v1/chat/completions", "POST", {}, Buffer.from("{}"),
    new URL(`http://127.0.0.1:${port}`), timeoutMs, null, 0, hardMs,
  );
  let code = null;
  try { code = JSON.parse(res.body.toString())?.error?.code ?? null; } catch { /* non-JSON body */ }
  return { status: res.status, code, ms: Date.now() - startedAt };
}

// Writes one byte every 500ms and never ends: keeps the socket continuously
// active, so the idle timer can never fire. This is the wedge shape.
const dribble = (req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  const t = setInterval(() => { try { res.write(" "); } catch { clearInterval(t); } }, 500);
  res.on("close", () => clearInterval(t));
};

test("a dribbling upstream terminates at the derived wall-clock ceiling", async (t) => {
  const { server, port } = await listen(dribble);
  t.after(() => server.close());
  const r = await call(port, { timeoutMs: 2000 });
  assert.equal(r.status, 504);
  assert.equal(r.code, "upstream_deadline");
  // Derived as timeout_ms * HARD_DEADLINE_MULTIPLIER (3) = 6000ms.
  assert.ok(r.ms >= 5500 && r.ms < 9000, `expected ~6000ms, got ${r.ms}`);
});

test("an explicit hardTimeoutMs overrides the derived ceiling", async (t) => {
  const { server, port } = await listen(dribble);
  t.after(() => server.close());
  const r = await call(port, { timeoutMs: 2000, hardMs: 3000 });
  assert.equal(r.code, "upstream_deadline");
  assert.ok(r.ms >= 2600 && r.ms < 5000, `expected ~3000ms, got ${r.ms}`);
});

test("a fully silent upstream still trips the idle timer first", async (t) => {
  const { server, port } = await listen(() => { /* never responds */ });
  t.after(() => server.close());
  const r = await call(port, { timeoutMs: 2000 });
  assert.equal(r.status, 504);
  // Must remain upstream_timeout, not upstream_deadline: the pre-existing
  // idle path is unchanged and still the faster of the two.
  assert.equal(r.code, "upstream_timeout");
  assert.ok(r.ms < 4000, `expected ~2000ms, got ${r.ms}`);
});

test("a healthy response is unaffected", async (t) => {
  const { server, port } = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  t.after(() => server.close());
  const r = await call(port, { timeoutMs: 2000 });
  assert.equal(r.status, 200);
  assert.ok(r.ms < 1000, `expected a fast reply, got ${r.ms}`);
});

test("timeout_ms=0 derives no ceiling and keeps the existing behaviour", async (t) => {
  const { server, port } = await listen(dribble);
  t.after(() => server.close());
  // A backend that declares no idle timeout is not given one implicitly.
  const outcome = await Promise.race([
    call(port, { timeoutMs: 0 }).then(() => "settled"),
    new Promise((r) => setTimeout(() => r("still-open"), 4000)),
  ]);
  assert.equal(outcome, "still-open");
});
