/**
 * Real entrypoint coverage for the sanitizer and model-limit composition.
 * Every network peer is a synthetic loopback fixture. No provider endpoint or
 * credential is present in the child process environment.
 */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const indexPath = resolve(here, "..", "src", "index.mjs");
const model = "synthetic-live-pipeline-model";

function listen(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => resolveListen(server.address().port));
  });
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolveClose) => server.close(resolveClose));
}

function bootGateway(configPath, home) {
  const child = spawn(process.execPath, [indexPath, "--config", configPath], {
    env: {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: tmpdir(),
      NODE_ENV: "test",
      SKGATEWAY_MODEL_CATALOG_STORE_PATH: join(home, "model-catalog-store.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolveBoot, rejectBoot) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) rejectBoot(new Error(`gateway did not start:\n${output}`));
    }, 15_000);
    const onData = (chunk) => {
      output += chunk.toString();
      if (!settled && output.includes("[skgateway] listening")) {
        settled = true;
        clearTimeout(timer);
        resolveBoot({ child, output: () => output });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectBoot(new Error(`gateway exited early (${code}):\n${output}`));
      }
    });
  });
}

async function stopGateway(handle) {
  if (!handle || handle.child.exitCode !== null) return;
  handle.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => handle.child.once("exit", resolveExit)),
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
  if (handle.child.exitCode === null) handle.child.kill("SIGKILL");
}

async function post(port, body) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("live v1 model limits and response sanitizer", () => {
  let dir;
  let gateway;
  let upstream;
  let port;
  const upstreamBodies = [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "skgw-live-pipeline-"));
    upstream = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      upstreamBodies.push(parsed);

      const userText = parsed.messages?.findLast?.((message) => message.role === "user")?.content || "";
      const content = userText === "clean accepted request"
        ? "clean accepted response"
        : userText === "prove core sanitizer"
          ? ""
          : "visible synthetic answer\n<|tool_calls_section_begin|>hidden synthetic markup<|tool_calls_section_end|>";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "synthetic-live-response",
        model,
        choices: [{
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        }],
      }));
    });
    const upstreamPort = await listen(upstream);
    port = await freePort();

    const configPath = join(dir, "live-pipeline.yaml");
    writeFileSync(configPath, [
      "server:",
      "  bind: 127.0.0.1",
      `  port: ${port}`,
      "dashboard:",
      "  enabled: false",
      "metrics:",
      "  enabled: false",
      "discovery:",
      "  enabled: false",
      "identity:",
      "  enabled: false",
      "classification:",
      "  enabled: false",
      "siem:",
      "  enabled: false",
      "routing:",
      "  strict_targets: false",
      "sanitizer:",
      "  max_body_bytes: 20000",
      "  max_system_bytes: 4200",
      "model_limits:",
      `  ${model}: { max_body_bytes: 20000, max_system_bytes: 4200 }`,
      "backends:",
      "  synthetic:",
      `    url: http://127.0.0.1:${upstreamPort}/v1`,
      "    auth_type: none",
      `    models: [${model}]`,
      "    priority: 1",
    ].join("\n") + "\n");

    gateway = await bootGateway(configPath, dir);
  });

  after(async () => {
    await stopGateway(gateway);
    await closeServer(upstream);
  });

  test("applies per-model trimming and sanitizes the real v1 response", async () => {
    const response = await post(port, {
      model,
      messages: [
        { role: "system", content: "s".repeat(6000) },
        { role: "user", content: "sanitize accepted request" },
      ],
      tools: [{ type: "function", function: { name: "synthetic_tool", parameters: { type: "object" } } }],
    });
    assert.equal(response.status, 200, gateway.output());
    const body = await response.json();
    assert.equal(body.choices[0].message.content, "visible synthetic answer");
    assert.equal(upstreamBodies.length, 1);
    const system = upstreamBodies[0].messages.find((message) => message.role === "system");
    assert.ok(system.content.length < 6000, "model-limit system trim did not run");
    assert.ok(Buffer.byteLength(system.content, "utf-8") <= 4200);
  });

  test("rejects an unshrinkable tool body before any backend request", async () => {
    const before = upstreamBodies.length;
    const response = await post(port, {
      model,
      messages: [{ role: "user", content: "reject this public synthetic body" }],
      tools: [{
        type: "function",
        function: {
          name: "oversized_synthetic_tool",
          description: "x".repeat(30_000),
          parameters: { type: "object" },
        },
      }],
    });
    assert.equal(response.status, 413, gateway.output());
    assert.equal((await response.json()).error.code, "model_limit_exceeded");
    assert.equal(upstreamBodies.length, before, "rejected body reached a backend");
  });

  test("invokes the core response stage after the router response contract", async () => {
    const response = await post(port, {
      model,
      messages: [{ role: "user", content: "prove core sanitizer" }],
    });
    assert.equal(response.status, 200, gateway.output());
    const body = await response.json();
    assert.match(body.choices[0].message.content, /I ran into a wall/);
  });

  test("preserves ordinary routing for an accepted clean request", async () => {
    const requestBody = {
      model,
      messages: [{ role: "user", content: "clean accepted request" }],
    };
    const response = await post(port, requestBody);
    assert.equal(response.status, 200, gateway.output());
    const body = await response.json();
    assert.equal(body.choices[0].message.content, "clean accepted response");
    assert.deepEqual(upstreamBodies.at(-1), requestBody);
  });
});
