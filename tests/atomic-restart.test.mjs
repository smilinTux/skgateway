import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DrainTimeoutError,
  activateReplacement,
  assertActiveRevision,
  prepareConfigRevision,
  sha256,
} from "../src/restart/atomic-activation.mjs";

async function fixtureConfig(text = "capacity_domain: new\n") {
  const dir = await mkdtemp(join(tmpdir(), "skgateway-activation-"));
  const path = join(dir, "gateway.yaml");
  await writeFile(path, text);
  return path;
}

function listener(revision, events, options = {}) {
  return {
    revision,
    stopAccepting: async () => events.push("old:stop-accepting"),
    drain: options.drain || (async () => events.push("old:drained")),
    retire: async () => events.push("old:retired"),
    restore: async () => events.push("old:restored"),
    observe: async () => ({
      healthy: true,
      accepting: !events.includes("old:stop-accepting") || events.includes("old:restored"),
      active_requests: 0,
      queue_depth: 0,
      completed_requests: 12,
      loaded_revision: revision,
    }),
  };
}

const observe = (target) => target.observe();

test("pre-bind preparation hashes and fully loads the exact file bytes", async () => {
  const path = await fixtureConfig();
  let loaded;
  const prepared = await prepareConfigRevision(path, async (bytes) => {
    loaded = Buffer.from(bytes);
    return { capacity_domain: "new" };
  });

  assert.equal(prepared.revision, sha256(loaded));
  assert.deepEqual(prepared.config, { capacity_domain: "new" });
  assert.ok(Object.isFrozen(prepared));
});

test("stale-config race cannot publish or serve a mismatched listener", async () => {
  const events = [];
  const evidence = [];
  const path = await fixtureConfig();
  const prepared = await prepareConfigRevision(path, async () => ({ capacity_domain: "new" }));
  const prior = listener("old-revision", events);
  const candidate = {
    bind: async () => {
      events.push("new:bound");
      return { pid: 4201, revision: "stale-revision" };
    },
    stop: async () => events.push("new:stopped"),
    observe: async () => ({ healthy: true, accepting: true, active_requests: 0, queue_depth: 0,
      completed_requests: 12, loaded_revision: "stale-revision" }),
  };

  await assert.rejects(
    activateReplacement({ prior, candidate, prepared, timeoutMs: 50, evidence: async (e) => evidence.push(e), observe }),
    /differs from activation revision/,
  );
  assert.deepEqual(events, ["old:stop-accepting", "old:drained", "new:bound", "new:stopped", "old:restored"]);
  assert.equal(evidence.at(-1).event, "config_activation_rollback");
  assert.throws(() => assertActiveRevision("stale-revision", prepared.revision), { code: "SKGW_REVISION_MISMATCH" });
});

test("successful handoff drains before bind and binds PID to exact revision", async () => {
  const events = [];
  const evidence = [];
  const path = await fixtureConfig();
  const prepared = await prepareConfigRevision(path, async () => ({ capacity_domain: "new" }));
  const prior = listener("old-revision", events);
  const candidate = {
    bind: async (_config, revision) => {
      events.push("new:bound");
      return { pid: 4202, revision };
    },
    observe: async () => ({ healthy: true, accepting: true, active_requests: 0, queue_depth: 0,
      completed_requests: 12, loaded_revision: prepared.revision }),
  };

  const activation = await activateReplacement({
    prior, candidate, prepared, timeoutMs: 50, evidence: async (e) => evidence.push(e), observe,
  });

  assert.deepEqual(events, ["old:stop-accepting", "old:drained", "new:bound", "old:retired"]);
  assert.deepEqual(activation, {
    event: "config_activation", pid: 4202, revision: prepared.revision, config_path: path,
    baseline: { healthy: true, accepting: true, active_requests: 0, queue_depth: 0,
      completed_requests: 12, loaded_revision: "old-revision" },
    drained: { healthy: true, accepting: false, active_requests: 0, queue_depth: 0,
      completed_requests: 12, loaded_revision: "old-revision" },
    active: { healthy: true, accepting: true, active_requests: 0, queue_depth: 0,
      completed_requests: 12, loaded_revision: prepared.revision },
  });
  assert.deepEqual(evidence, [activation]);
  assert.doesNotThrow(() => assertActiveRevision(prepared.revision, activation.revision));
});

test("drain timeout fails closed and restores prior listener and config", async () => {
  const events = [];
  const evidence = [];
  const path = await fixtureConfig();
  const prepared = await prepareConfigRevision(path, async () => ({ capacity_domain: "new" }));
  const prior = listener("old-revision", events, { drain: () => new Promise(() => {}) });
  let bound = false;
  const candidate = {
    bind: async () => { bound = true; },
    observe: async () => ({ healthy: false, accepting: false, active_requests: 0, queue_depth: 0,
      completed_requests: 0, loaded_revision: prepared.revision }),
  };

  await assert.rejects(
    activateReplacement({ prior, candidate, prepared, timeoutMs: 5, evidence: async (e) => evidence.push(e), observe }),
    DrainTimeoutError,
  );
  assert.equal(bound, false);
  assert.deepEqual(events, ["old:stop-accepting", "old:restored"]);
  assert.deepEqual(evidence.at(-1), {
    event: "config_activation_rollback",
    revision: prepared.revision,
    prior_revision: "old-revision",
    restored: { healthy: true, accepting: true, active_requests: 0, queue_depth: 0,
      completed_requests: 12, loaded_revision: "old-revision" },
    reason: "listener did not drain within 5ms",
  });
});
