import assert from "node:assert/strict";
import http from "node:http";
import { afterEach, describe, test } from "node:test";

import { resetPool } from "../src/proxy/connection-pool.mjs";
import { enforceResponseContract } from "../src/proxy/response-contract.mjs";
import { createRouter, routeAndSend } from "../src/proxy/router.mjs";

const MODEL = "qwen3.8-27b-huihui-abliterated-q4_k_m";
const REQUESTED = "sovereign-qwen";
const USAGE = {
  completion_tokens: 32,
  prompt_tokens: 70,
  total_tokens: 102,
  prompt_tokens_details: { cached_tokens: 0 },
};

afterEach(() => resetPool());

function response(choices, extra = {}) {
  return enforceResponseContract({
    status: 200,
    headers: { "content-type": "application/json", "content-length": "999" },
    body: Buffer.from(JSON.stringify({
      id: "sanitized-live-qwen",
      object: "chat.completion",
      model: MODEL,
      choices,
      usage: USAGE,
      ...extra,
    })),
  }, REQUESTED);
}

function assertRejected(result) {
  assert.equal(result.status, 502);
  assert.equal(result.headers["content-type"], "application/json");
  assert.equal(result.headers["content-length"], undefined);
  const parsed = JSON.parse(result.body);
  assert.match(parsed.error.code, /^(?:empty_upstream_response|invalid_upstream_(?:completion|tool_calls))$/);
  assert.equal(parsed.requested_model, REQUESTED);
  assert.equal(parsed.served_model, MODEL);
}

describe("non-stream public output contract", () => {
  test("rejects the exact sanitized live Qwen reasoning-only length response", () => {
    const result = response([{
      finish_reason: "length",
      index: 0,
      message: { role: "assistant", content: "" },
      _hadReasoning: true,
    }]);

    assertRejected(result);
    assert.equal(result.body.includes(Buffer.from("_hadReasoning")), false);
  });

  test("rejects every empty public-output shape and unsupported terminal reason", () => {
    const emptyMessages = [
      { role: "assistant", content: "" },
      { role: "assistant", content: " \n\t " },
      { role: "assistant", content: null },
      { role: "assistant" },
      { role: "assistant", content: [], reasoning_content: "private chain" },
    ];
    for (const message of emptyMessages) {
      for (const finish_reason of ["length", "stop", "tool_calls", "content_filter", null, undefined]) {
        const choice = { index: 0, message };
        if (finish_reason !== undefined) choice.finish_reason = finish_reason;
        assertRejected(response([choice]));
      }
    }
  });

  test("accepts non-empty public content without rewriting its terminal reason", () => {
    for (const finish_reason of ["stop", "length", "tool_calls", "content_filter", null, undefined]) {
      const choice = { index: 0, message: { role: "assistant", content: "PUBLIC_SYNTHETIC_OK" } };
      if (finish_reason !== undefined) choice.finish_reason = finish_reason;
      const result = response([choice]);
      assert.equal(result.status, 200);
      const parsed = JSON.parse(result.body);
      if (finish_reason === undefined) assert.equal(Object.hasOwn(parsed.choices[0], "finish_reason"), false);
      else assert.equal(parsed.choices[0].finish_reason, finish_reason);
      assert.equal(parsed.choices[0].message.content, "PUBLIC_SYNTHETIC_OK");
      assert.deepEqual(parsed.usage, USAGE);
      assert.equal(parsed.requested_model, REQUESTED);
      assert.equal(result.servedModel, MODEL);
    }
  });

  test("accepts complete single and parallel tool calls without rewriting their terminal reason", () => {
    const tool_calls = [
      { id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } },
      { id: "call_2", type: "function", function: { name: "search", arguments: "{\"term\":\"public\"}" } },
    ];
    for (const finish_reason of ["tool_calls", "stop", "length", "content_filter", null, undefined]) {
      const choice = { index: 0, message: { role: "assistant", content: null, tool_calls } };
      if (finish_reason !== undefined) choice.finish_reason = finish_reason;
      const result = response([choice]);
      assert.equal(result.status, 200);
      const parsed = JSON.parse(result.body);
      assert.deepEqual(parsed.choices[0].message.tool_calls, tool_calls);
      if (finish_reason === undefined) assert.equal(Object.hasOwn(parsed.choices[0], "finish_reason"), false);
      else assert.equal(parsed.choices[0].finish_reason, finish_reason);
    }
  });

  test("rejects malformed tool evidence and any invalid choice in a multi-choice response", () => {
    const malformed = [
      [],
      [{}],
      [{ id: "", type: "function", function: { name: "lookup", arguments: "{}" } }],
      [{ id: "call_1", type: "computer", function: { name: "lookup", arguments: "{}" } }],
      [{ id: "call_1", type: "function", function: { name: "", arguments: "{}" } }],
      [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "not-json" } }],
      [
        { id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } },
        { id: "call_1", type: "function", function: { name: "search", arguments: "{}" } },
      ],
    ];
    for (const tool_calls of malformed) {
      assertRejected(response([{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls } }]));
    }

    assertRejected(response([
      { index: 0, finish_reason: "stop", message: { role: "assistant", content: "PUBLIC_SYNTHETIC_OK" } },
      { index: 1, finish_reason: "length", message: { role: "assistant", content: " " }, _hadReasoning: true },
    ]));
  });

  test("strips private reasoning markers without promoting or fabricating content", () => {
    const result = response([{
      index: 0,
      finish_reason: "stop",
      message: {
        role: "assistant",
        content: "PUBLIC_SYNTHETIC_OK",
        reasoning_content: "PRIVATE_REASONING_MUST_NOT_LEAK",
      },
      _hadReasoning: true,
    }]);
    assert.equal(result.status, 200);
    const text = result.body.toString("utf8");
    assert.equal(text.includes("PRIVATE_REASONING_MUST_NOT_LEAK"), false);
    assert.equal(text.includes("_hadReasoning"), false);
    assert.equal(JSON.parse(text).choices[0].message.content, "PUBLIC_SYNTHETIC_OK");
  });

  test("routes the bounded failure through sanitized response audit", async () => {
    const upstream = http.createServer((request, serverResponse) => {
      request.resume();
      serverResponse.writeHead(200, { "content-type": "application/json" });
      serverResponse.end(JSON.stringify({
        model: MODEL,
        choices: [{
          index: 0,
          finish_reason: "length",
          message: { role: "assistant", content: "", reasoning_content: "private chain" },
          _hadReasoning: true,
        }],
        usage: USAGE,
      }));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${upstream.address().port}/v1`;
      const router = createRouter({ backends: { qwen: { url, auth_type: "none", models: [REQUESTED] } } });
      const events = [];
      const result = await routeAndSend(router, { model: REQUESTED, agentId: "public-synthetic" },
        "/chat/completions", "POST", { "content-type": "application/json" },
        Buffer.from(JSON.stringify({ model: REQUESTED, messages: [{ role: "user", content: "public synthetic" }] })),
        false, (event) => events.push(event));

      assertRejected(result);
      const audit = events.findLast((event) => event.event_type === "response");
      assert.equal(audit.details.status, 502);
      assert.equal(JSON.stringify(events).includes("private chain"), false);
      assert.equal(JSON.stringify(events).includes("_hadReasoning"), false);
    } finally {
      await new Promise((resolve) => upstream.close(resolve));
    }
  });
});
