import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createRouter, routeAndSend } from "../src/proxy/router.mjs";

const HEADERS = { "content-type": "application/json" };
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function body(model) {
  return Buffer.from(JSON.stringify({
    model,
    messages: [{ role: "user", content: "public synthetic" }],
  }));
}

async function startServer(status = 200) {
  let attempts = 0;
  const server = http.createServer((req, res) => {
    attempts++;
    req.resume();
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "sovereign-model", choices: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    get attempts() { return attempts; },
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

async function bootGateway(configPath, port, home) {
  const child = spawn(process.execPath, [
    join(ROOT, "src/index.mjs"), "--config", configPath, "--port", String(port),
  ], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, SKCAPSTONE_HOME: join(home, ".skcapstone") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  await new Promise((resolveBoot, rejectBoot) => {
    const timer = setTimeout(() => rejectBoot(new Error(`gateway boot timeout:\n${output}`)), 5000);
    const inspect = () => {
      if (!output.includes("[skgateway] listening")) return;
      clearTimeout(timer);
      resolveBoot();
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectBoot(new Error(`gateway exited early (${code}):\n${output}`));
    });
  });

  return {
    output: () => output,
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    },
  };
}

describe("disabled backend routing contract", () => {
  test("disabled and placeholder backends are absent after startup", () => {
    const router = createRouter({ backends: {
      sovereign: { url: "http://127.0.0.1:1/v1", models: ["sovereign-model"] },
      disabled: { enabled: false, url: "http://127.0.0.1:2/v1", models: ["external-model"] },
      placeholder: { url: "http://127.0.0.1:3/v1", models: ["disabled-placeholder"] },
    } });

    assert.deepEqual(router.getBackends().map((backend) => backend.id), ["sovereign"]);
    assert.deepEqual(Object.keys(router.getHealth()), ["sovereign"]);
  });

  test("a disabled backend is never an explicit or fallback attempt", async () => {
    const active = await startServer(502);
    const disabled = await startServer(200);
    try {
      const router = createRouter({ backends: {
        active: { url: active.url, models: ["shared-model"], priority: 1 },
        disabled: { enabled: false, url: disabled.url, models: ["shared-model"], priority: 2 },
      } });

      const result = await routeAndSend(router, { model: "shared-model" },
        "/chat/completions", "POST", HEADERS, body("shared-model"), false);

      assert.equal(result.status, 502);
      assert.equal(active.attempts, 1);
      assert.equal(disabled.attempts, 0);
    } finally {
      await active.close();
      await disabled.close();
    }
  });

  test("runtime disablement removes an existing backend", () => {
    const router = createRouter({ backends: {
      external: { url: "http://127.0.0.1:1/v1", models: ["external-model"] },
    } });

    router.addBackend({
      id: "external",
      enabled: false,
      url: "http://127.0.0.1:1/v1",
      models: ["external-model"],
    });

    assert.equal(router.getBackend("external"), null);
    assert.deepEqual(router.getBackends(), []);
    assert.deepEqual(router.getHealth(), {});
  });

  test("live outage and restart never restore disabled routes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "skgw-disabled-route-"));
    const port = await reservePort();
    const configPath = join(dir, "gateway.yaml");
    const auditPath = join(dir, "audit.jsonl");
    writeFileSync(configPath, [
      "server:", "  bind: 127.0.0.1", `  port: ${port}`, `  dashboard_port: ${port + 1}`,
      "dashboard:", "  enabled: false",
      "metrics:", "  enabled: false",
      "discovery:", "  enabled: false",
      "identity:", "  enabled: false",
      "siem:", "  enabled: true", "  outputs:", `    - { type: file, path: \"${auditPath}\" }`,
      "backends:",
      "  nvidia:", "    enabled: false", "    models: [disabled-nvidia]",
      "  anthropic:", "    enabled: false", "    models: [disabled-anthropic]",
      "  ollama:", "    enabled: false", "    models: [disabled-ollama]",
      "  openrouter:", "    enabled: false", "    models: [disabled-openrouter]",
      "  sovereign:", "    url: http://127.0.0.1:9/v1", "    auth_type: none",
      "    priority: 1", "    models: [sovereign-model]", "",
    ].join("\n"));

    for (let restart = 0; restart < 2; restart++) {
      const gateway = await bootGateway(configPath, port, dir);
      try {
        const catalog = await fetch(`http://127.0.0.1:${port}/v1/models`).then((res) => res.json());
        assert.deepEqual(catalog.data.map((entry) => entry.id), ["sovereign-model"]);

        const disabledResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers: HEADERS,
          body: body("disabled-openrouter"),
        });
        assert.equal(disabledResponse.status, 404);

        const outageResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: "POST",
          headers: HEADERS,
          body: body("sovereign-model"),
        });
        assert.equal(outageResponse.status, 502);
      } finally {
        await gateway.stop();
      }
    }

    const audit = readFileSync(auditPath, "utf8");
    assert.match(audit, /"status":404/);
    assert.match(audit, /"status":502/);
  });
});
