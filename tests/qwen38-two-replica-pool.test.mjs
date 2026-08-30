/**
 * Fixture-only contract for the proposed Qwen3.8 two-replica pool.
 *
 * No server is opened and no network or provider API is called. The fixture
 * separates request names from physical capacity, then drives the real
 * ConnectionPool admission implementation with deterministic local promises.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { ConnectionPool } from "../src/proxy/connection-pool.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("./fixtures/qwen38-two-replica-pool.json", import.meta.url),
  "utf8",
));

const replicaIds = fixture.replicas.map((replica) => replica.id);
const capacityDomainIds = fixture.replicas.map((replica) => replica.capacity_domain);
const requestIds = [fixture.canonical_model, ...fixture.request_aliases];

function poolConfig() {
  return {
    capacityDomains: Object.fromEntries(fixture.replicas.map((replica) => [
      replica.capacity_domain,
      {
        members: [replica.id],
        max: replica.max_concurrent,
        maxQueue: 1,
        queueTimeoutMs: 1_000,
      },
    ])),
  };
}

test("aliases remain request names and never inflate the two physical replicas", () => {
  assert.equal(new Set(requestIds).size, 4);
  assert.equal(new Set(replicaIds).size, 2);
  assert.equal(new Set(capacityDomainIds).size, 2);
  assert.ok(requestIds.every((id) => !replicaIds.includes(id)));
  assert.deepEqual(Object.keys(poolConfig().capacityDomains), capacityDomainIds);
});

test("both independent physical capacity domains are reachable", async () => {
  const pool = new ConnectionPool(poolConfig());
  const tickets = await Promise.all(replicaIds.map((id) => pool.acquire(id)));

  assert.deepEqual(new Set(tickets.map((ticket) => ticket.backendId)), new Set(replicaIds));
  assert.deepEqual(new Set(tickets.map((ticket) => ticket.id)), new Set(capacityDomainIds));
  for (const replica of fixture.replicas) {
    assert.equal(pool.getStats(replica.id).active, 1);
    assert.equal(pool.getStats(replica.id).capacityDomain, replica.capacity_domain);
  }
  for (const ticket of tickets) assert.equal(pool.release(ticket), true);
});

test("queueing starts only after both physical domains independently saturate", async () => {
  const pool = new ConnectionPool(poolConfig());
  const holders = [];

  for (const replica of fixture.replicas) {
    for (let i = 0; i < replica.max_concurrent; i++) {
      holders.push(await pool.acquire(replica.id));
    }
    assert.equal(pool.getStats(replica.id).active, replica.max_concurrent);
    assert.equal(pool.getStats(replica.id).queued, 0);
  }

  const firstReplica = fixture.replicas[0];
  let promoted = false;
  const waiter = pool.acquire(firstReplica.id).then((ticket) => {
    promoted = true;
    return ticket;
  });
  assert.equal(pool.getStats(firstReplica.id).queued, 1);
  assert.equal(promoted, false);
  for (const replica of fixture.replicas) {
    assert.equal(pool.getStats(replica.id).active, replica.max_concurrent);
  }

  const released = holders.find((ticket) => ticket.backendId === firstReplica.id);
  assert.equal(pool.release(released), true);
  const promotedTicket = await waiter;
  assert.equal(promotedTicket.backendId, firstReplica.id);
  assert.equal(promotedTicket.id, firstReplica.capacity_domain);

  assert.equal(pool.release(promotedTicket), true);
  for (const ticket of holders) {
    if (ticket !== released) assert.equal(pool.release(ticket), true);
  }
});

test("catalog ownership is canonical and NVIDIA is absent and nonadvertised", () => {
  assert.equal(fixture.owned_by, "skgateway-qwen38-pool");
  assert.ok(fixture.replicas.every((replica) => replica.advertised === true));
  assert.ok(fixture.replicas.every((replica) => replica.owned_by === undefined));
  assert.ok(requestIds.every((id) => typeof id === "string" && id.length > 0));
  assert.deepEqual(fixture.excluded_backends, ["nvidia"]);
  assert.equal(replicaIds.includes("nvidia"), false);
  assert.equal(capacityDomainIds.includes("nvidia"), false);
});
