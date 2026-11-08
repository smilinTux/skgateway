import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { ConnectionPool } from "../src/proxy/connection-pool.mjs";

const source = fs.readFileSync(new URL("../config/skgateway-codex.yaml", import.meta.url), "utf8");
const config = {
  pooling: {
    default_max_concurrent: Number(source.match(/default_max_concurrent: (\d+)/)?.[1]),
    default_max_queue: Number(source.match(/default_max_queue: (\d+)/)?.[1]),
    queue_timeout_ms: Number(source.match(/queue_timeout_ms:\s+(\d+)/)?.[1]),
    capacity_domains: {
      "kimi-coding": { members: ["kimi-coding"], max: 28, maxQueue: 400 },
      "kimi-k3": { members: ["kimi-k3"], max: 14, maxQueue: 400 },
    },
    per_backend: {},
  },
};

test("staged startup fixture exposes idle Kimi capacity domains", () => {
  const domains = config.pooling.capacity_domains;
  const pool = new ConnectionPool({
    defaultMaxConcurrent: config.pooling.default_max_concurrent,
    defaultMaxQueue: config.pooling.default_max_queue,
    queueTimeoutMs: config.pooling.queue_timeout_ms,
    perBackend: config.pooling.per_backend,
    capacityDomains: domains,
  });

  assert.deepEqual(pool.getAllStats()["kimi-coding"], {
    capacityDomain: "kimi-coding",
    members: ["kimi-coding"],
    active: 0,
    queued: 0,
    max: 28,
    maxQueue: 400,
    queueTimeoutMs: 300000,
    totalProcessed: 0,
    totalDropped: 0,
    totalTimedOut: 0,
    totalCancelled: 0,
    peakActive: 0,
    peakQueue: 0,
  });
  assert.deepEqual(pool.getAllStats()["kimi-k3"], {
    capacityDomain: "kimi-k3",
    members: ["kimi-k3"],
    active: 0,
    queued: 0,
    max: 14,
    maxQueue: 400,
    queueTimeoutMs: 300000,
    totalProcessed: 0,
    totalDropped: 0,
    totalTimedOut: 0,
    totalCancelled: 0,
    peakActive: 0,
    peakQueue: 0,
  });
});
