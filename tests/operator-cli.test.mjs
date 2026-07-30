/**
 * Tests for the skgateway operator facet + CLI (R2.12).
 *
 * The operator facet is the Node mirror of Atlas's skgateway adapter's
 * explain / observe / act contract. Every probe / runner / actuator is injected,
 * so nothing here touches a live gateway, real systemd, or the network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import * as op from "../src/operator/operator.mjs";
import { run } from "../bin/skgateway.mjs";

// --- helpers -----------------------------------------------------------------

/** Map an observe() result's conditions to {type: status}. */
function conditionMap(result) {
  return Object.fromEntries(result.conditions.map((c) => [c.type, c.status]));
}

/** Run the CLI capturing stdout + stderr + exit code. */
async function runCli(argv) {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  process.stdout.write = (s) => {
    stdout += s;
    return true;
  };
  process.stderr.write = (s) => {
    stderr += s;
    return true;
  };
  try {
    const code = await run(argv);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// --- explain -----------------------------------------------------------------

test("explain shape matches the adapter contract", () => {
  const spec = op.explain();
  assert.deepEqual(spec.kinds, ["upstream", "pool"]);
  assert.deepEqual(spec.conditions, ["UpstreamServing", "PoolHealthy"]);

  const byName = Object.fromEntries(spec.actions.map((a) => [a.name, a]));
  assert.deepEqual(Object.keys(byName).sort(), [
    "quarantine_dead_alias",
    "raise_pool_limit",
    "restart_service",
  ]);

  // The two reversible standard actions.
  for (const n of ["restart_service", "quarantine_dead_alias"]) {
    const a = byName[n];
    assert.equal(a.standard, true);
    assert.equal(a.reversible, true);
    assert.equal(a.blast_radius, "low");
    assert.deepEqual(a.kedb_refs, []);
  }

  // raise_pool_limit: NOT standard, reversible, medium blast (forces escalation).
  const raise = byName.raise_pool_limit;
  assert.equal(raise.standard, false);
  assert.equal(raise.reversible, true);
  assert.equal(raise.blast_radius, "medium");
});

test("explain CLI emits the contract JSON", async () => {
  const { code, stdout } = await runCli(["operator", "explain"]);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.deepEqual(payload.conditions, op.CONDITIONS);
  assert.equal(payload.actions.length, 3);
});

// --- observe -----------------------------------------------------------------

test("observe reports all healthy", async () => {
  const probe = () => ({ upstream_serving: true, pool_healthy: true });
  const conds = conditionMap(await op.observe(probe));
  assert.deepEqual(conds, { UpstreamServing: "True", PoolHealthy: "True" });
});

test("observe UpstreamServing fires when a backend is down", async () => {
  const probe = () => ({ upstream_serving: false, pool_healthy: true });
  const conds = conditionMap(await op.observe(probe));
  assert.equal(conds.UpstreamServing, "False");
  assert.equal(conds.PoolHealthy, "True");
});

test("observe PoolHealthy fires when the pool is saturated/quarantined", async () => {
  const probe = () => ({ upstream_serving: true, pool_healthy: false });
  const conds = conditionMap(await op.observe(probe));
  assert.equal(conds.UpstreamServing, "True");
  assert.equal(conds.PoolHealthy, "False");
});

test("observe carries the adapter object names", async () => {
  const result = await op.observe(() => ({ upstream_serving: true, pool_healthy: true }));
  const byType = Object.fromEntries(result.conditions.map((c) => [c.type, c.object]));
  assert.equal(byType.UpstreamServing, "upstreams");
  assert.equal(byType.PoolHealthy, "connection-pool");
});

test("observe defaults to healthy when the probe yields nothing (fail safe)", async () => {
  const conds = conditionMap(await op.observe(() => ({})));
  assert.deepEqual(conds, { UpstreamServing: "True", PoolHealthy: "True" });
});

test("defaultProbe fails safe (healthy) when the gateway is unreachable", async () => {
  const prev = process.env.SKOPERATOR_GATEWAY;
  // An unroutable port so fetch fails fast; the probe must swallow it -> healthy.
  process.env.SKOPERATOR_GATEWAY = "http://127.0.0.1:1/v1";
  try {
    const st = await op.defaultProbe();
    assert.deepEqual(st, { upstream_serving: true, pool_healthy: true });
  } finally {
    if (prev === undefined) delete process.env.SKOPERATOR_GATEWAY;
    else process.env.SKOPERATOR_GATEWAY = prev;
  }
});

test("observe CLI emits conditions JSON (fail-safe, no live gateway)", async () => {
  // Point the default probe at an unreachable host so the CLI observe path fails
  // safe to healthy and stays hermetic (never touches the live gateway on :18780).
  const prev = process.env.SKOPERATOR_GATEWAY;
  process.env.SKOPERATOR_GATEWAY = "http://127.0.0.1:1/v1";
  try {
    const { code, stdout } = await runCli(["operator", "observe"]);
    assert.equal(code, 0);
    const payload = JSON.parse(stdout);
    assert.equal(payload.conditions.length, 2);
    assert.equal(payload.conditions[0].type, "UpstreamServing");
  } finally {
    if (prev === undefined) delete process.env.SKOPERATOR_GATEWAY;
    else process.env.SKOPERATOR_GATEWAY = prev;
  }
});

// --- act ---------------------------------------------------------------------

test("act restart_service runs the injected runner with the systemd command", async () => {
  const calls = [];
  const runner = (cmd) => {
    calls.push(cmd);
    return { ok: true, returncode: 0 };
  };
  const result = await op.act("restart_service", { runner });
  assert.equal(result.performed, true);
  assert.equal(result.unit, "skgateway.service");
  assert.deepEqual(calls, [["systemctl", "--user", "restart", "skgateway.service"]]);
  assert.equal(result.result.ok, true);
});

test("act restart_service honors a --unit override", async () => {
  const calls = [];
  const runner = (cmd) => {
    calls.push(cmd);
    return { ok: true, returncode: 0 };
  };
  const result = await op.act("restart_service", { runner, unit: "skgateway@lumina.service" });
  assert.equal(result.unit, "skgateway@lumina.service");
  assert.deepEqual(calls, [["systemctl", "--user", "restart", "skgateway@lumina.service"]]);
});

test("act quarantine_dead_alias runs the injected actuator with the alias", async () => {
  const seen = [];
  const actuator = (alias) => {
    seen.push(alias);
    return { ok: true, quarantined: alias };
  };
  const result = await op.act("quarantine_dead_alias", { actuator, alias: "nvidia" });
  assert.equal(result.performed, true);
  assert.equal(result.alias, "nvidia");
  assert.deepEqual(seen, ["nvidia"]);
  assert.equal(result.result.ok, true);
});

test("act quarantine_dead_alias default actuator is a clearly-marked stub", async () => {
  const result = await op.act("quarantine_dead_alias", { alias: "openrouter" });
  assert.equal(result.performed, true);
  assert.equal(result.result.stub, true);
  assert.equal(result.result.ok, false);
});

test("act raise_pool_limit refuses and escalates, never actuating", async () => {
  let ran = false;
  const result = await op.act("raise_pool_limit", {
    runner: () => {
      ran = true;
    },
    actuator: () => {
      ran = true;
    },
  });
  assert.equal(result.performed, false);
  assert.equal(result.escalate, "MAJOR");
  assert.match(result.reason.toLowerCase(), /major|escalat/);
  assert.equal(ran, false);
});

test("act unknown action throws cleanly", async () => {
  await assert.rejects(() => op.act("nuke_everything", { runner: () => {} }), /unknown skgateway operator action/);
});

test("act CLI raise_pool_limit reports escalation", async () => {
  const { code, stdout } = await runCli(["operator", "act", "raise_pool_limit"]);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.performed, false);
  assert.equal(payload.escalate, "MAJOR");
});

test("act CLI unknown action exits non-zero with a clean error", async () => {
  const { code, stderr } = await runCli(["operator", "act", "nuke_everything"]);
  assert.equal(code, 1);
  assert.match(stderr, /unknown skgateway operator action/);
});

test("act CLI missing action exits 2", async () => {
  const { code, stderr } = await runCli(["operator", "act"]);
  assert.equal(code, 2);
  assert.match(stderr, /missing <action>/);
});

// --- dispatcher --------------------------------------------------------------

test("CLI unknown command exits 2 with usage", async () => {
  const { code, stderr } = await runCli(["bogus"]);
  assert.equal(code, 2);
  assert.match(stderr, /unknown command/);
});

test("CLI no args prints usage and exits 0", async () => {
  const { code, stdout } = await runCli([]);
  assert.equal(code, 0);
  assert.match(stdout, /operator <explain\|observe\|act>/);
});
