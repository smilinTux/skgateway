/**
 * Bounded, cancellation-aware capacity-domain admission (card 8b64febc).
 */

import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { describe, test } from "node:test";

import { ConnectionPool, PoolAdmissionError } from "../src/proxy/connection-pool.mjs";

const QWEN_DOMAIN = {
  "chiap08-qwen38": {
    members: ["chiap08-qwen38", "reg:qwen38"],
    max: 4,
    maxQueue: 4,
    queueTimeoutMs: 30_000,
  },
};


describe("ConnectionPool capacity domains", () => {
  test("direct and registry aliases share one four-slot domain", async () => {
    const pool = new ConnectionPool({ capacityDomains: QWEN_DOMAIN });
    const tickets = await Promise.all([
      pool.acquire("chiap08-qwen38"),
      pool.acquire("reg:qwen38"),
      pool.acquire("chiap08-qwen38"),
      pool.acquire("reg:qwen38"),
    ]);

    assert.ok(tickets.every((ticket) => ticket.id === "chiap08-qwen38"));
    assert.deepEqual(tickets.map((ticket) => ticket.queueWaitMs), [0, 0, 0, 0]);
    assert.deepEqual(tickets.map((ticket) => ticket.inflightConcurrency), [1, 2, 3, 4]);
    assert.ok(tickets.every((ticket) => ticket.admissionOutcome === "admitted"));
    assert.equal(new Set(tickets.map((ticket) => ticket.ticketId)).size, 4);
    assert.deepEqual(pool.getStats("reg:qwen38"), pool.getStats("chiap08-qwen38"));
    assert.equal(pool.getStats("reg:qwen38").active, 4);
    assert.equal(pool.getStats("reg:qwen38").max, 4);
    assert.deepEqual(pool.getStats("reg:qwen38").members, [
      "chiap08-qwen38",
      "reg:qwen38",
    ]);
    assert.deepEqual(Object.keys(pool.getAllStats()), ["chiap08-qwen38"]);
    assert.equal(pool.getAllStats()["chiap08-qwen38"].queueTimeoutMs, 30_000);
    assert.equal(pool.getAllStats()["chiap08-qwen38"].totalTimedOut, 0);
    assert.equal(pool.getAllStats()["chiap08-qwen38"].totalDropped, 0);
    assert.equal(pool.getAllStats()["chiap08-qwen38"].totalCancelled, 0);

    for (const ticket of tickets) pool.release(ticket);
    assert.equal(pool.getStats("chiap08-qwen38").active, 0);
  });

  test("configured domains are visible while idle exactly once and stats reads stay bounded", () => {
    const pool = new ConnectionPool({ capacityDomains: QWEN_DOMAIN });

    assert.deepEqual(Object.keys(pool.getAllStats()), ["chiap08-qwen38"]);
    assert.deepEqual(pool.getAllStats()["chiap08-qwen38"], {
      capacityDomain: "chiap08-qwen38",
      members: ["chiap08-qwen38", "reg:qwen38"],
      active: 0,
      queued: 0,
      max: 4,
      maxQueue: 4,
      queueTimeoutMs: 30_000,
      totalProcessed: 0,
      totalDropped: 0,
      totalTimedOut: 0,
      totalCancelled: 0,
      peakActive: 0,
      peakQueue: 0,
    });
    assert.deepEqual(pool.getTotalStats(), {
      totalActive: 0,
      totalQueued: 0,
      totalCapacity: 4,
    });

    // Introspection of arbitrary ids must not materialize unbounded pool data.
    for (let i = 0; i < 100; i++) pool.getStats(`unknown-${i}`);
    assert.deepEqual(Object.keys(pool.getAllStats()), ["chiap08-qwen38"]);
    assert.deepEqual(pool.getTotalStats(), {
      totalActive: 0,
      totalQueued: 0,
      totalCapacity: 4,
    });
  });

  test("configured per-backend pools are visible before traffic without double-counting domains", async () => {
    const pool = new ConnectionPool({
      defaultMaxConcurrent: 20,
      perBackend: {
        codex: { max: 7, maxQueue: 3, queueTimeoutMs: 12_000 },
        "reg:qwen38": { max: 99 },
      },
      capacityDomains: QWEN_DOMAIN,
    });

    assert.deepEqual(Object.keys(pool.getAllStats()), ["codex", "chiap08-qwen38"]);
    assert.deepEqual(pool.getAllStats().codex, {
      capacityDomain: "codex",
      members: ["codex"],
      active: 0,
      queued: 0,
      max: 7,
      maxQueue: 3,
      queueTimeoutMs: 12_000,
      totalProcessed: 0,
      totalDropped: 0,
      totalTimedOut: 0,
      totalCancelled: 0,
      peakActive: 0,
      peakQueue: 0,
    });
    assert.equal(pool.getAllStats()["chiap08-qwen38"].max, 4);
    assert.deepEqual(pool.getTotalStats(), {
      totalActive: 0,
      totalQueued: 0,
      totalCapacity: 11,
    });

    const runtimeTicket = await pool.acquire("runtime-created");
    assert.deepEqual(Object.keys(pool.getAllStats()), [
      "codex",
      "chiap08-qwen38",
      "runtime-created",
    ]);
    assert.deepEqual(pool.getTotalStats(), {
      totalActive: 1,
      totalQueued: 0,
      totalCapacity: 31,
    });
    assert.equal(pool.release(runtimeTicket), true);
  });

  test("tickets are single-use and foreign, forged, or string releases cannot free a slot", async () => {
    const pool = new ConnectionPool({
      capacityDomains: {
        bounded: { members: ["bounded", "alias"], max: 1, maxQueue: 1, queueTimeoutMs: 1000 },
      },
    });
    const foreignPool = new ConnectionPool({
      capacityDomains: {
        bounded: { members: ["bounded"], max: 1, maxQueue: 0, queueTimeoutMs: 1000 },
      },
    });
    const holder = await pool.acquire("bounded");
    const foreignTicket = await foreignPool.acquire("bounded");
    assert.notEqual(holder.ticketId, foreignTicket.ticketId);
    const queued = pool.acquire("alias");

    assert.equal(pool.getStats("bounded").active, 1);
    assert.equal(pool.getStats("bounded").queued, 1);
    assert.equal(pool.release("bounded"), false, "legacy string release owns no slot");
    assert.equal(pool.release({ ...holder }), false, "a copied ticket is not the issued object");
    assert.equal(pool.release(foreignTicket), false, "another pool cannot release this pool");
    assert.equal(pool.getStats("bounded").active, 1);
    assert.equal(pool.getStats("bounded").queued, 1);

    assert.equal(pool.release(holder), true);
    const queuedTicket = await queued;
    assert.notEqual(queuedTicket.ticketId, holder.ticketId);
    assert.equal(queuedTicket.admissionOutcome, "admitted");
    assert.equal(queuedTicket.inflightConcurrency, 1);
    assert.ok(queuedTicket.queueWaitMs >= 0 && queuedTicket.queueWaitMs <= 1000);
    assert.equal(pool.release(holder), false, "duplicate release cannot free the promoted slot");
    assert.equal(pool.getStats("bounded").active, 1);
    assert.equal(pool.getStats("bounded").queued, 0);

    assert.equal(pool.release(queuedTicket), true);
    assert.equal(pool.getStats("bounded").active, 0);
    assert.equal(foreignPool.release(foreignTicket), true);
    assert.equal(foreignPool.getStats("bounded").active, 0);
  });

  test("queued waiters are promoted FIFO", async () => {
    const pool = new ConnectionPool({
      capacityDomains: {
        one: { members: ["direct", "reg:model"], max: 1, maxQueue: 2, queueTimeoutMs: 1000 },
      },
    });
    const holder = await pool.acquire("direct");
    const order = [];
    const second = pool.acquire("reg:model").then((ticket) => {
      order.push("second");
      return ticket;
    });
    const third = pool.acquire("direct").then((ticket) => {
      order.push("third");
      return ticket;
    });

    assert.equal(pool.getStats("one").queued, 2);
    pool.release(holder);
    const secondTicket = await second;
    assert.deepEqual(order, ["second"]);
    pool.release(secondTicket);
    const thirdTicket = await third;
    assert.deepEqual(order, ["second", "third"]);
    pool.release(thirdTicket);
    assert.equal(pool.getStats("one").active, 0);
    assert.equal(pool.getStats("one").queued, 0);
  });

  test("maxQueue zero means no waiting, never an unbounded queue", async () => {
    const pool = new ConnectionPool({
      capacityDomains: {
        failFast: { members: ["backend"], max: 1, maxQueue: 0, queueTimeoutMs: 1000 },
      },
    });
    const holder = await pool.acquire("backend");

    await assert.rejects(
      pool.acquire("backend"),
      (error) => {
        assert.ok(error instanceof PoolAdmissionError);
        assert.equal(error.code, "capacity_exceeded");
        assert.equal(error.capacityDomain, "failFast");
        assert.equal(error.retryAfterSeconds, 1);
        assert.equal(error.queueWaitMs, 0);
        assert.equal(error.inflightConcurrency, 1);
        assert.equal(error.admissionOutcome, "denied");
        return true;
      },
    );
    assert.equal(pool.getStats("backend").queued, 0);
    assert.equal(pool.getStats("backend").totalDropped, 1);
    pool.release(holder);
  });

  test("a domain queue timeout is distinct and leaves no active or queued leak", async () => {
    const pool = new ConnectionPool({
      capacityDomains: {
        bounded: { members: ["backend"], max: 1, maxQueue: 1, queueTimeoutMs: 20 },
      },
    });
    const holder = await pool.acquire("backend");

    await assert.rejects(
      pool.acquire("backend"),
      (error) => {
        assert.ok(error instanceof PoolAdmissionError);
        assert.equal(error.code, "queue_timeout");
        assert.equal(error.capacityDomain, "bounded");
        assert.equal(error.queueWaitMs, 20);
        assert.equal(error.inflightConcurrency, 1);
        assert.equal(error.admissionOutcome, "timeout");
        return true;
      },
    );
    assert.equal(pool.getStats("backend").queued, 0);
    assert.equal(pool.getStats("backend").totalTimedOut, 1);
    pool.release(holder);
    assert.equal(pool.getStats("backend").active, 0);
  });

  test("abort removes a waiter and its timer/listener without consuming a slot", async () => {
    const pool = new ConnectionPool({
      capacityDomains: {
        bounded: { members: ["backend"], max: 1, maxQueue: 1, queueTimeoutMs: 40 },
      },
    });
    const holder = await pool.acquire("backend");
    const controller = new AbortController();
    const waiting = pool.acquire("backend", { signal: controller.signal });
    assert.equal(pool.getStats("backend").queued, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 1);

    controller.abort();
    await assert.rejects(
      waiting,
      (error) => {
        assert.ok(error instanceof PoolAdmissionError);
        assert.equal(error.code, "client_closed");
        assert.ok(error.queueWaitMs >= 0 && error.queueWaitMs <= 40);
        assert.equal(error.inflightConcurrency, 1);
        assert.equal(error.admissionOutcome, "cancelled");
        return true;
      },
    );
    assert.equal(pool.getStats("backend").active, 1, "the holder alone owns the slot");
    assert.equal(pool.getStats("backend").queued, 0);
    assert.equal(pool.getStats("backend").totalCancelled, 1);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(pool.getStats("backend").totalTimedOut, 0, "the abort cleared its timer");
    pool.release(holder);
    const next = await pool.acquire("backend");
    assert.equal(pool.getStats("backend").active, 1);
    pool.release(next);
    assert.equal(pool.getStats("backend").active, 0);
  });
});
