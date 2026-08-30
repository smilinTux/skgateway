import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, test } from "node:test";

import {
  buildModelCatalog,
  mergeDiscoveredCatalog,
  tagLocalModels,
} from "../src/proxy/advertise.mjs";
import { attributionHeaders } from "../src/metrics/attribution.mjs";
import { getPool, resetPool } from "../src/proxy/connection-pool.mjs";
import { createRouter, routeAndSend } from "../src/proxy/router.mjs";
import { enforceResponseContract } from "../src/proxy/response-contract.mjs";

const HEADERS = { "content-type": "application/json" };

function body(model, stream = false) {
  return Buffer.from(JSON.stringify({ model, stream, messages: [{ role: "user", content: "public synthetic" }] }));
}

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

afterEach(() => resetPool());

describe("disabled placeholder catalog contract", () => {
  const backends = {
    qwen: { models: ["qwen-sovereign"] },
    nvidia: { models: ["disabled-nvidia"] },
    cloud: { enabled: false, models: ["cloud-model"] },
  };

  test("placeholders stay absent before and after reconstructed state", () => {
    for (let restart = 0; restart < 2; restart++) {
      assert.deepEqual(buildModelCatalog(backends).map((entry) => entry.id), ["qwen-sovereign"]);
      assert.deepEqual(tagLocalModels(backends).map((entry) => entry.id), ["qwen-sovereign"]);
      assert.deepEqual(
        mergeDiscoveredCatalog(buildModelCatalog(backends), [
          { id: "disabled-nvidia", provider: "nvidia", stale: true },
        ]).map((entry) => entry.id),
        ["qwen-sovereign"],
      );
    }
  });
});

describe("response attribution and sanitizer contract", () => {
  test("non-stream preserves tools, strips reasoning, and separates requested from served", () => {
    const result = enforceResponseContract({
      status: 200,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({
        model: "Qwen/Qwen3-30B-A3B",
        choices: [{ message: {
          role: "assistant",
          content: null,
          reasoning_content: "private chain",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
        } }],
      })),
    }, "sk-qwen");
    const parsed = JSON.parse(result.body);
    assert.equal(parsed.requested_model, "sk-qwen");
    assert.equal(parsed.model, "Qwen/Qwen3-30B-A3B");
    assert.equal("reasoning_content" in parsed.choices[0].message, false);
    assert.equal(parsed.choices[0].message.tool_calls[0].function.name, "lookup");
    assert.equal(result.servedModel, "Qwen/Qwen3-30B-A3B");
    assert.equal(attributionHeaders("req", result)["x-sk-model-requested"], "sk-qwen");
    assert.equal(attributionHeaders("req", result)["x-sk-model-served"], "Qwen/Qwen3-30B-A3B");
  });

  test("stream strips reasoning without damaging tool call deltas", () => {
    const chunk = {
      model: "Qwen/Qwen3-30B-A3B",
      choices: [{ delta: {
        reasoning_content: "private chain",
        tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }],
      }, finish_reason: "tool_calls" }],
    };
    const result = enforceResponseContract({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: Buffer.from(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`),
    }, "sk-qwen");
    const parsed = JSON.parse(result.body.toString().split("\n")[0].slice(5));
    assert.equal(parsed.requested_model, "sk-qwen");
    assert.equal("reasoning_content" in parsed.choices[0].delta, false);
    assert.equal(parsed.choices[0].delta.tool_calls[0].function.name, "lookup");
    assert.equal(result.servedModel, "Qwen/Qwen3-30B-A3B");
  });

  test("stream fails closed when reasoning stripping leaves no visible output", () => {
    const chunk = {
      model: "Qwen/Qwen3-30B-A3B",
      choices: [{ delta: { reasoning_content: "private chain" }, finish_reason: "stop" }],
    };
    const result = enforceResponseContract({
      status: 200,
      headers: { "content-type": "text/event-stream", "content-length": "999" },
      body: Buffer.from(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`),
    }, "sk-qwen");
    const parsed = JSON.parse(result.body);
    assert.equal(result.status, 502);
    assert.equal(result.headers["content-type"], "application/json");
    assert.equal(result.headers["content-length"], undefined);
    assert.equal(parsed.error.code, "empty_upstream_response");
    assert.equal(parsed.requested_model, "sk-qwen");
    assert.equal(result.servedModel, "Qwen/Qwen3-30B-A3B");
    assert.equal(result.body.includes(Buffer.from("private chain")), false);
    assert.equal(result.body.includes(Buffer.from("[DONE]")), false);
  });
});

describe("router qualification repairs", () => {
  test("shared route preserves visible SSE and rejects empty-visible SSE", async () => {
    const sse = (delta) => Buffer.from([
      `data: ${JSON.stringify({ model: "Qwen/Qwen3-30B-A3B", choices: [{ delta, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ model: "Qwen/Qwen3-30B-A3B", choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n\n"));
    let upstreamBody = sse({ content: "PUBLIC_SYNTHETIC_OK" });
    const upstream = await startServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(upstreamBody);
    });
    try {
      const router = createRouter({ backends: { qwen: { url: upstream.url, auth_type: "none", models: ["sk-qwen"] } } });
      const events = [];
      const visible = await routeAndSend(router, { model: "sk-qwen", agentId: "canary" },
        "/chat/completions", "POST", HEADERS, body("sk-qwen", true), false, (event) => events.push(event));
      assert.equal(visible.status, 200);
      assert.match(visible.body.toString(), /PUBLIC_SYNTHETIC_OK/);
      assert.equal(visible.servedModel, "Qwen/Qwen3-30B-A3B");

      events.length = 0;
      upstreamBody = sse({ reasoning_content: "private chain" });
      const empty = await routeAndSend(router, { model: "sk-qwen", agentId: "canary" },
        "/chat/completions", "POST", HEADERS, body("sk-qwen", true), false, (event) => events.push(event));
      assert.equal(empty.status, 502);
      assert.equal(JSON.parse(empty.body).error.code, "empty_upstream_response");
      assert.equal(empty.servedModel, "Qwen/Qwen3-30B-A3B");
      assert.equal(empty.body.includes(Buffer.from("private chain")), false);
      assert.equal(empty.body.includes(Buffer.from("[DONE]")), false);
      assert.equal(events.findLast((event) => event.event_type === "response").details.status, 502);
      assert.equal(JSON.stringify(events).includes("private chain"), false);
    } finally {
      await upstream.close();
    }
  });

  test("requested alias and exact upstream served model cross body and audit", async () => {
    const upstream = await startServer((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "Qwen/Qwen3-30B-A3B", choices: [{ message: { content: "ok" } }] }));
    });
    try {
      const router = createRouter({ backends: { qwen: { url: upstream.url, auth_type: "none", models: ["sk-qwen"] } } });
      const events = [];
      const result = await routeAndSend(router, { model: "sk-qwen", agentId: "canary" },
        "/chat/completions", "POST", HEADERS, body("sk-qwen"), false, (event) => events.push(event));
      assert.equal(result.servedModel, "Qwen/Qwen3-30B-A3B");
      assert.equal(JSON.parse(result.body).requested_model, "sk-qwen");
      const audit = events.findLast((event) => event.event_type === "response");
      assert.equal(audit.details.requested_model, "sk-qwen");
      assert.equal(audit.details.served_model, "Qwen/Qwen3-30B-A3B");
    } finally {
      await upstream.close();
    }
  });

  test("unknown model fails before any upstream attempt", async () => {
    let attempts = 0;
    const upstream = await startServer((_req, res) => { attempts++; res.end(); });
    try {
      const router = createRouter({ backends: { qwen: { url: upstream.url, auth_type: "none", models: ["sk-qwen"] } } });
      const result = await routeAndSend(router, { model: "not-a-model", agentId: "canary" },
        "/chat/completions", "POST", HEADERS, body("not-a-model"), false);
      assert.equal(result.status, 404);
      assert.equal(JSON.parse(result.body).error.code, "unknown_model");
      assert.equal(attempts, 0);
    } finally {
      await upstream.close();
    }
  });

  test("every pool admission 503 emits a response audit event", async () => {
    getPool({ defaultMaxConcurrent: 1, defaultMaxQueue: 0 });
    const held = await getPool().acquire("qwen");
    const router = createRouter({ backends: { qwen: { url: "http://127.0.0.1:9/v1", auth_type: "none", models: ["sk-qwen"] } } });
    const events = [];
    try {
      const result = await routeAndSend(router, { model: "sk-qwen", agentId: "canary" },
        "/chat/completions", "POST", HEADERS, body("sk-qwen"), true, (event) => events.push(event));
      assert.equal(result.status, 503);
      const audit = events.find((event) => event.event_type === "response" && event.details.status === 503);
      assert.equal(audit.details.admission_rejected, true);
      assert.equal(audit.details.code, "capacity_exceeded");
    } finally {
      getPool().release(held);
    }
  });
});
