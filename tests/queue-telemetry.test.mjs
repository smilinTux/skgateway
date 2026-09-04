import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionPool } from "../src/proxy/connection-pool.mjs";
import { exposeKimiQueueStats } from "../src/operator/queue-telemetry.mjs";

test("idle Kimi queue snapshot exposes both configured domains and models", () => {
  const pool = new ConnectionPool({
    capacityDomains: {
      "kimi-coding": { members: ["kimi-coding"], max: 2, maxQueue: 3, queueTimeoutMs: 1000 },
      "kimi-k3": { members: ["kimi-k3"], max: 1, maxQueue: 2, queueTimeoutMs: 2000 },
    },
  });
  const stats = exposeKimiQueueStats(pool.getAllStats(), pool, {
    pooling: { capacity_domains: {
      "kimi-coding": {},
      "kimi-k3": {},
    } },
    backends: { kimi: { models: ["kimi-for-coding", "kimi-k3"] } },
  });

  assert.deepEqual(Object.keys(stats), ["kimi-coding", "kimi-k3"]);
  assert.equal(stats["kimi-coding"].active, 0);
  assert.equal(stats["kimi-coding"].queued, 0);
  assert.equal(stats["kimi-coding"].max, 2);
  assert.equal(stats["kimi-k3"].maxQueue, 2);
  assert.deepEqual(stats["kimi-coding"].attributions.map((row) => row.requestedModel), [
    "kimi-for-coding", "kimi-k3",
  ]);
  assert.ok(stats["kimi-coding"].attributions.every((row) => row.provider === "kimi-coding"));
});
