import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectionPool, PoolAdmissionError } from "../src/proxy/connection-pool.mjs";
import { exposeKimiQueueStats } from "../src/operator/queue-telemetry.mjs";

const KIMI_CONFIG = {
  pooling: {
    capacity_domains: {
      "kimi-coding": { members: ["kimi-coding"], max: 1, maxQueue: 1, queueTimeoutMs: 20 },
      "kimi-k3": { members: ["kimi-k3"], max: 1, maxQueue: 1, queueTimeoutMs: 20 },
    },
  },
  backends: { kimi: { models: ["kimi-for-coding", "kimi-k3"] } },
};

const KIMI_DOMAINS = {
  "kimi-coding": KIMI_CONFIG.pooling.capacity_domains["kimi-coding"],
  "kimi-k3": KIMI_CONFIG.pooling.capacity_domains["kimi-k3"],
};

const ATTRIBUTION = {
  provider: "kimi",
  requestedModel: "kimi-for-coding",
  servedModel: "kimi-k2.7",
};

function snapshot(pool) {
  return exposeKimiQueueStats(pool.getAllStats(), pool, KIMI_CONFIG);
}

test("idle Kimi queue snapshot exposes both configured domains and models", () => {
  const pool = new ConnectionPool({
    capacityDomains: { ...KIMI_DOMAINS, "kimi-coding": { ...KIMI_DOMAINS["kimi-coding"], max: 2, maxQueue: 3 }, "kimi-k3": { ...KIMI_DOMAINS["kimi-k3"], maxQueue: 2 } },
  });
  const stats = snapshot(pool);

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

test("Kimi admission telemetry covers active, queued, success and upstream error", async () => {
  const pool = new ConnectionPool({ capacityDomains: KIMI_DOMAINS });
  const holder = await pool.acquire("kimi-coding", { attribution: ATTRIBUTION });
  const waiting = pool.acquire("kimi-coding", { attribution: ATTRIBUTION });
  assert.equal(snapshot(pool)["kimi-coding"].active, 1);
  assert.equal(snapshot(pool)["kimi-coding"].queued, 1);
  pool.recordOutcome(holder, { status: 502 });
  pool.release(holder);
  const promoted = await waiting;
  pool.recordOutcome(promoted, { status: 200 });
  pool.release(promoted);
  const row = snapshot(pool)["kimi-coding"].attributions[0];
  assert.deepEqual(row, { ...ATTRIBUTION, totalProcessed: 2, totalDropped: 0, totalTimedOut: 0, totalCancelled: 0, totalErrors: 1 });
});

test("Kimi queue-full drop and timeout are attributed without leaking capacity", async () => {
  const pool = new ConnectionPool({ capacityDomains: KIMI_DOMAINS });
  const holder = await pool.acquire("kimi-k3", { attribution: ATTRIBUTION });
  const waiting = pool.acquire("kimi-k3", { attribution: ATTRIBUTION });
  await assert.rejects(
    pool.acquire("kimi-k3", { attribution: ATTRIBUTION }),
    (error) => error instanceof PoolAdmissionError && error.code === "capacity_exceeded",
  );
  await assert.rejects(
    waiting,
    (error) => error instanceof PoolAdmissionError && error.code === "queue_timeout",
  );
  pool.release(holder);
  const stats = snapshot(pool)["kimi-k3"];
  assert.equal(stats.active, 0);
  assert.equal(stats.queued, 0);
  assert.deepEqual(stats.attributions[0], { ...ATTRIBUTION, totalProcessed: 1, totalDropped: 1, totalTimedOut: 1, totalCancelled: 0, totalErrors: 0 });
});

test("Kimi queued cancellation is attributed and removes the waiter", async () => {
  const pool = new ConnectionPool({ capacityDomains: KIMI_DOMAINS });
  const holder = await pool.acquire("kimi-coding", { attribution: ATTRIBUTION });
  const controller = new AbortController();
  const waiting = pool.acquire("kimi-coding", { signal: controller.signal, attribution: ATTRIBUTION });
  controller.abort();
  await assert.rejects(waiting, (error) => error instanceof PoolAdmissionError && error.code === "client_closed");
  pool.release(holder);
  const stats = snapshot(pool)["kimi-coding"];
  assert.equal(stats.active, 0);
  assert.equal(stats.queued, 0);
  assert.equal(stats.attributions[0].totalCancelled, 1);
});

test("Kimi restart/readback returns deterministic zero counters", () => {
  const first = new ConnectionPool({ capacityDomains: KIMI_DOMAINS });
  const before = snapshot(first);
  const restarted = new ConnectionPool({ capacityDomains: KIMI_DOMAINS });
  const after = snapshot(restarted);
  assert.deepEqual(after, before);
  for (const stats of Object.values(after)) {
    assert.equal(stats.active, 0);
    assert.equal(stats.queued, 0);
    assert.ok(stats.attributions.every((row) => Object.values(row).slice(3).every((value) => value === 0)));
  }
});
