/** /queue inFlight: the working-vs-hung discriminator (2026-09-03 lessons). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMetricsCollector } from "../src/metrics/collector.mjs";
import { loadConfig } from "../src/config.mjs";

await loadConfig({ configPath: "/nonexistent/skgw-inflight-test.yaml", silent: true });

const dir = mkdtempSync(join(tmpdir(), "skgw-inflight-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const cfg = () => ({ enabled: true, db_path: join(dir, "metrics.db") });

test("inFlightRequests returns live ages and empties on completion", () => {
  const c = createMetricsCollector(cfg());
  const id = c.recordRequest({ agentId: "worker-a", model: "sk-codex", backend: "codex" });
  let live = c.inFlightRequests();
  assert.equal(live.length, 1);
  assert.equal(live[0].agentId, "worker-a");
  assert.equal(live[0].model, "sk-codex");
  assert.ok(live[0].ageMs >= 0);
  c.recordResponse({ reqId: id, statusCode: 200, totalMs: 10 });
  live = c.inFlightRequests();
  assert.equal(live.length, 0, "completed request leaves the in-flight view");
  c.close();
});

test("ages grow for still-open requests (the hung signal)", async () => {
  const c = createMetricsCollector(cfg());
  const id = c.recordRequest({ agentId: "worker-b", model: "sk-codex" });
  await new Promise((r) => setTimeout(r, 60));
  const live = c.inFlightRequests();
  assert.ok(live[0].ageMs >= 50, "age must advance while the request stays open");
  c.recordResponse({ reqId: id, statusCode: 200, totalMs: 70 });
  c.close();
});
