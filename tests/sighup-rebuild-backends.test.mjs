/**
 * sighup-rebuild-backends.test.mjs - SIGHUP config reload rebuilds backends.
 *
 * Incident 2026-11-02 (chiap01, v1.1.12): adding a second qwen38 replica with
 * its own capacity domain, then sending SIGHUP, logged "config reloaded" but
 * left /health and routing stuck on the old backend set until a full restart.
 *
 * These tests boot a real gateway process and prove that a SIGHUP reload:
 *   1. adds a backend and a capacity domain,
 *   2. removes a backend,
 *   3. edits a backend url for new requests,
 *   4. rejects an invalid config while the old config stays active,
 *   5. lets an in-flight request finish on its old backend object.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = join(ROOT, "src/index.mjs");

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/** Stub upstream. When hold is true the response stays open until release(). */
function startUpstream({ hold = false, model = "model-a" } = {}) {
  const state = { attempts: 0, release: null, onRequest: null };
  const pending = [];
  const server = http.createServer((req, res) => {
    req.resume();
    state.attempts += 1;
    const respond = () => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "cmpl-test",
        model,
        choices: [{ message: { role: "assistant", content: "ok" } }],
      }));
    };
    if (hold) {
      pending.push(respond);
      state.release = () => {
        const next = pending.shift();
        if (next) next();
      };
      if (state.onRequest) state.onRequest();
    } else {
      respond();
    }
  });
  return new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveListen({
        url: `http://127.0.0.1:${port}/v1`,
        get attempts() { return state.attempts; },
        release: () => state.release && state.release(),
        requestSeen: () => new Promise((res) => { state.onRequest = res; }),
        close: () => new Promise((done) => {
          for (const respond of pending.splice(0)) respond();
          server.close(done);
          server.closeAllConnections();
        }),
      });
    });
  });
}

function buildConfig({ backends, capacityDomains = null }) {
  const lines = [
    "server:",
    "  bind: 127.0.0.1",
    "discovery:",
    "  enabled: false",
    "dashboard:",
    "  enabled: false",
    "metrics:",
    "  enabled: false",
    "identity:",
    "  enabled: false",
    "siem:",
    "  enabled: false",
  ];
  lines.push("backends:");
  for (const [id, cfg] of Object.entries(backends)) {
    lines.push(`  ${id}:`);
    lines.push(`    url: ${cfg.url}`);
    lines.push(`    auth_type: ${cfg.auth_type || "none"}`);
    lines.push(`    priority: ${cfg.priority}`);
    lines.push("    models:");
    for (const model of cfg.models) lines.push(`      - ${model}`);
  }
  if (capacityDomains) {
    lines.push("pooling:");
    lines.push("  capacity_domains:");
    for (const [id, cfg] of Object.entries(capacityDomains)) {
      lines.push(`    ${id}:`);
      lines.push(`      max: ${cfg.max}`);
      lines.push(`      maxQueue: ${cfg.maxQueue}`);
      lines.push(`      queueTimeoutMs: ${cfg.queueTimeoutMs}`);
      lines.push("      members:");
      for (const member of cfg.members) lines.push(`        - ${member}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function bootGateway(cfgPath, port, home) {
  const child = spawn(process.execPath, [INDEX, "--config", cfgPath, "--port", String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: home,
      SKCAPSTONE_HOME: join(home, ".skcapstone"),
      SKGATEWAY_MODEL_CATALOG_STORE_PATH: join(home, "model_catalog_store.json"),
      SKGATEWAY_MODEL_CATALOG_CACHE_PATH: join(home, "model_catalog_cache.json"),
      SKGATEWAY_CAPACITY_STORE_PATH: join(home, "capacity_store.json"),
      SKMODELS_REGISTRY: join(home, "nonexistent-registry.yaml"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const onData = (chunk) => { output += chunk; };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  return new Promise((resolveBoot, rejectBoot) => {
    const timer = setTimeout(() => rejectBoot(new Error(`gateway boot timeout:\n${output}`)), 20000);
    const inspect = () => {
      if (!output.includes("[skgateway] listening")) return;
      clearTimeout(timer);
      resolveBoot({
        child,
        output: () => output,
        stop: () => new Promise((done) => {
          child.once("exit", done);
          child.kill("SIGTERM");
        }),
      });
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectBoot(new Error(`gateway exited early (${code}):\n${output}`));
    });
  });
}

function waitForOutput(gw, predicate, timeoutMs = 8000) {
  const startedAt = Date.now();
  return new Promise((res, rej) => {
    const timer = setInterval(() => {
      if (predicate(gw.output())) { clearInterval(timer); res(); return; }
      if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        rej(new Error(`timed out waiting for output. captured:\n${gw.output()}`));
      }
    }, 25);
  });
}

async function reload(gw, expectOk = true) {
  const before = gw.output().length;
  gw.child.kill("SIGHUP");
  const marker = expectOk ? "[skgateway] config reloaded" : "Reload failed";
  await waitForOutput(gw, (out) => out.slice(before).includes(marker));
}

async function getHealth(port) {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  return res.json();
}

async function getModels(port) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(res.status, 200);
  return res.json();
}

async function getQueue(port) {
  const res = await fetch(`http://127.0.0.1:${port}/queue`);
  assert.equal(res.status, 200);
  return res.json();
}

function completion(port, model) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("SIGHUP rebuilds backend-derived structures", () => {
  test("adds a backend and capacity domain, then removes a backend", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-sighup-add-"));
    tmpDirs.push(dir);
    const port = await freePort();
    const cfgPath = join(dir, "gw.yaml");

    const upA = await startUpstream({ model: "model-a" });
    const upB = await startUpstream({ model: "model-b" });
    const upC = await startUpstream({ model: "qwen38-c" });
    try {
      writeFileSync(cfgPath, buildConfig({
        backends: {
          "old-a": { url: upA.url, priority: 1, models: ["model-a"] },
          "old-b": { url: upB.url, priority: 2, models: ["model-b"] },
        },
      }));

      const gw = await bootGateway(cfgPath, port, dir);
      try {
        const before = await getHealth(port);
        assert.deepEqual(
          Object.keys(before.backends).sort(),
          ["old-a", "old-b"],
        );

        writeFileSync(cfgPath, buildConfig({
          backends: {
            "old-a": { url: upA.url, priority: 1, models: ["model-a"] },
            "old-b": { url: upB.url, priority: 2, models: ["model-b"] },
            "ziowk01-qwen38": { url: upC.url, priority: 3, models: ["qwen38-c"] },
          },
          capacityDomains: {
            "ziowk01-qwen38": { max: 4, maxQueue: 4, queueTimeoutMs: 30000, members: ["ziowk01-qwen38"] },
          },
        }));
        await reload(gw);

        const added = await getHealth(port);
        assert.deepEqual(
          Object.keys(added.backends).sort(),
          ["old-a", "old-b", "ziowk01-qwen38"],
        );

        const catalog = await getModels(port);
        const ids = catalog.data.map((entry) => entry.id);
        assert.ok(ids.includes("qwen38-c"), `expected qwen38-c in catalog, got ${ids.join(",")}`);

        const queue = await getQueue(port);
        assert.ok(
          Object.keys(queue.backends).includes("ziowk01-qwen38"),
          `expected new capacity domain in /queue, got ${Object.keys(queue.backends).join(",")}`,
        );

        writeFileSync(cfgPath, buildConfig({
          backends: {
            "old-a": { url: upA.url, priority: 1, models: ["model-a"] },
            "ziowk01-qwen38": { url: upC.url, priority: 3, models: ["qwen38-c"] },
          },
          capacityDomains: {
            "ziowk01-qwen38": { max: 4, maxQueue: 4, queueTimeoutMs: 30000, members: ["ziowk01-qwen38"] },
          },
        }));
        await reload(gw);

        const removed = await getHealth(port);
        assert.deepEqual(
          Object.keys(removed.backends).sort(),
          ["old-a", "ziowk01-qwen38"],
        );
      } finally {
        await gw.stop();
      }
    } finally {
      await upA.close();
      await upB.close();
      await upC.close();
    }
  });

  test("edits a backend url so new requests use the new target", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-sighup-edit-"));
    tmpDirs.push(dir);
    const port = await freePort();
    const cfgPath = join(dir, "gw.yaml");

    const upOld = await startUpstream({ model: "model-a" });
    const upNew = await startUpstream({ model: "model-a" });
    try {
      writeFileSync(cfgPath, buildConfig({
        backends: { "old-a": { url: upOld.url, priority: 1, models: ["model-a"] } },
      }));
      const gw = await bootGateway(cfgPath, port, dir);
      try {
        writeFileSync(cfgPath, buildConfig({
          backends: { "old-a": { url: upNew.url, priority: 1, models: ["model-a"] } },
        }));
        await reload(gw);

        const res = await completion(port, "model-a");
        assert.equal(res.status, 200);
        assert.equal(upOld.attempts, 0, "old url must not receive new requests");
        assert.equal(upNew.attempts, 1, "new url must receive new requests");
      } finally {
        await gw.stop();
      }
    } finally {
      await upOld.close();
      await upNew.close();
    }
  });

  test("rejects an invalid reload and keeps the old backends active", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-sighup-invalid-"));
    tmpDirs.push(dir);
    const port = await freePort();
    const cfgPath = join(dir, "gw.yaml");

    const upA = await startUpstream({ model: "model-a" });
    try {
      writeFileSync(cfgPath, buildConfig({
        backends: { "old-a": { url: upA.url, priority: 1, models: ["model-a"] } },
      }));
      const gw = await bootGateway(cfgPath, port, dir);
      try {
        const before = await getHealth(port);
        assert.deepEqual(Object.keys(before.backends), ["old-a"]);

        writeFileSync(cfgPath, "backends: [broken\n");
        await reload(gw, false);

        const after = await getHealth(port);
        assert.deepEqual(Object.keys(after.backends), ["old-a"]);

        const res = await completion(port, "model-a");
        assert.equal(res.status, 200);
        assert.equal(upA.attempts, 1);
      } finally {
        await gw.stop();
      }
    } finally {
      await upA.close();
    }
  });

  test("in-flight request finishes on its old backend across a SIGHUP edit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-sighup-inflight-"));
    tmpDirs.push(dir);
    const port = await freePort();
    const cfgPath = join(dir, "gw.yaml");

    const slow = await startUpstream({ hold: true, model: "model-a" });
    const fast = await startUpstream({ model: "model-a" });
    try {
      writeFileSync(cfgPath, buildConfig({
        backends: { "old-a": { url: slow.url, priority: 1, models: ["model-a"] } },
      }));
      const gw = await bootGateway(cfgPath, port, dir);
      try {
        const seen = slow.requestSeen();
        const inFlight = completion(port, "model-a");
        await seen;

        writeFileSync(cfgPath, buildConfig({
          backends: { "old-a": { url: fast.url, priority: 1, models: ["model-a"] } },
        }));
        await reload(gw);
        slow.release();

        const res = await inFlight;
        assert.equal(res.status, 200);
        assert.equal(slow.attempts, 1, "in-flight request must finish on the old backend");

        const next = await completion(port, "model-a");
        assert.equal(next.status, 200);
        assert.equal(slow.attempts, 1, "the old backend must not receive new requests");
        assert.equal(fast.attempts, 1, "new requests must use the new backend");
      } finally {
        await gw.stop();
      }
    } finally {
      await slow.close();
      await fast.close();
    }
  });

  test("unchanged pooling on SIGHUP keeps in-flight accounting: next request queues", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-sighup-pool-same-"));
    tmpDirs.push(dir);
    const port = await freePort();
    const cfgPath = join(dir, "gw.yaml");
    const slow = await startUpstream({ hold: true, model: "model-a" });
    const cfg = () => buildConfig({
      backends: { "old-a": { url: slow.url, priority: 1, models: ["model-a"] } },
      capacityDomains: {
        "old-a": { max: 1, maxQueue: 4, queueTimeoutMs: 30000, members: ["old-a"] },
      },
    });
    try {
      writeFileSync(cfgPath, cfg());
      const gw = await bootGateway(cfgPath, port, dir);
      try {
        const seen = slow.requestSeen();
        const first = completion(port, "model-a");
        await seen;
        assert.equal((await getQueue(port)).backends["old-a"].active, 1);

        writeFileSync(cfgPath, `${cfg()}# touched\n`);
        await reload(gw);

        const q = (await getQueue(port)).backends["old-a"];
        assert.equal(q.active, 1, "in-flight request must still count after reload");
        assert.equal(q.max, 1);

        const second = completion(port, "model-a");
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(slow.attempts, 1, "second request must queue, not run concurrently");
        assert.equal((await getQueue(port)).backends["old-a"].queued, 1);

        slow.release();
        assert.equal((await first).status, 200);
        const seen2 = slow.requestSeen();
        await seen2;
        slow.release();
        assert.equal((await second).status, 200);
        assert.equal(slow.attempts, 2);
      } finally {
        await gw.stop();
      }
    } finally {
      await slow.close();
    }
  });

  test("a pooling limit change keeps in-flight accounting and applies the new limit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-sighup-pool-change-"));
    tmpDirs.push(dir);
    const port = await freePort();
    const cfgPath = join(dir, "gw.yaml");
    const slow = await startUpstream({ hold: true, model: "model-a" });
    const cfg = (max) => buildConfig({
      backends: { "old-a": { url: slow.url, priority: 1, models: ["model-a"] } },
      capacityDomains: {
        "old-a": { max, maxQueue: 4, queueTimeoutMs: 30000, members: ["old-a"] },
      },
    });
    try {
      writeFileSync(cfgPath, cfg(1));
      const gw = await bootGateway(cfgPath, port, dir);
      try {
        const seen = slow.requestSeen();
        const first = completion(port, "model-a");
        await seen;

        writeFileSync(cfgPath, cfg(2));
        await reload(gw);
        const q = (await getQueue(port)).backends["old-a"];
        assert.equal(q.active, 1, "in-flight accounting must carry over a limit change");
        assert.equal(q.max, 2);

        const seen2 = slow.requestSeen();
        const second = completion(port, "model-a");
        await seen2;
        assert.equal(slow.attempts, 2, "raised limit admits a second concurrent request");
        assert.equal((await getQueue(port)).backends["old-a"].active, 2);

        slow.release();
        slow.release();
        assert.equal((await first).status, 200);
        assert.equal((await second).status, 200);
      } finally {
        await gw.stop();
      }
    } finally {
      await slow.close();
    }
  });
});
