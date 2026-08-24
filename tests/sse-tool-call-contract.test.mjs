import assert from "node:assert/strict";
import http from "node:http";
import { describe, test } from "node:test";

import { createRouter, routeAndSend } from "../src/proxy/router.mjs";
import { enforceResponseContract } from "../src/proxy/response-contract.mjs";

const MODEL = "Qwen/Qwen3-30B-A3B";
const REQUESTED = "sk-qwen";

function sseBody(deltas) {
  const frames = deltas.map((entry) => `data: ${JSON.stringify({
    model: MODEL,
    choices: [{ index: 0, delta: entry.delta, finish_reason: entry.finishReason ?? null }],
  })}`);
  return Buffer.from([...frames, "data: [DONE]", ""].join("\n\n"));
}

function response(deltas) {
  return enforceResponseContract({
    status: 200,
    headers: { "content-type": "text/event-stream", "content-length": "999" },
    body: sseBody(deltas),
  }, REQUESTED);
}

function choicesResponse(chunks) {
  const frames = chunks.map((choices) => `data: ${JSON.stringify({ model: MODEL, choices })}`);
  return enforceResponseContract({
    status: 200,
    headers: { "content-type": "text/event-stream", "content-length": "999" },
    body: Buffer.from([...frames, "data: [DONE]", ""].join("\n\n")),
  }, REQUESTED);
}

function assertRejected(deltas) {
  const result = response(deltas);
  assert.equal(result.status, 502);
  assert.equal(result.headers["content-type"], "application/json");
  assert.equal(result.headers["content-length"], undefined);
  assert.equal(JSON.parse(result.body).error.code, "invalid_upstream_tool_calls");
  assert.equal(result.body.includes(Buffer.from("[DONE]")), false);
  assert.equal(result.body.includes(Buffer.from("private chain")), false);
}

function assertCompletionRejected(result) {
  assert.equal(result.status, 502);
  assert.equal(result.headers["content-type"], "application/json");
  assert.equal(result.headers["content-length"], undefined);
  assert.equal(JSON.parse(result.body).error.code, "invalid_upstream_completion");
  assert.equal(result.body.includes(Buffer.from("[DONE]")), false);
  assert.equal(result.body.includes(Buffer.from("private chain")), false);
}

function assertBoundedRejected(result) {
  assert.equal(result.status, 502);
  assert.equal(result.headers["content-type"], "application/json");
  assert.equal(result.headers["content-length"], undefined);
  assert.match(JSON.parse(result.body).error.code, /^invalid_upstream_(completion|tool_calls)$/);
  assert.equal(result.body.includes(Buffer.from("[DONE]")), false);
  assert.equal(result.body.includes(Buffer.from("private chain")), false);
}

function rawResponse(lines) {
  return enforceResponseContract({
    status: 200,
    headers: { "content-type": "text/event-stream", "content-length": "999" },
    body: Buffer.from([...lines, ""].join("\n\n")),
  }, REQUESTED);
}

function contentFrame(finishReason, content = "PUBLIC_SYNTHETIC_OK", index = 0) {
  const choice = { index, delta: content === null ? {} : { content } };
  if (finishReason !== undefined) choice.finish_reason = finishReason;
  return `data: ${JSON.stringify({ model: MODEL, choices: [choice] })}`;
}

describe("completed SSE tool-call structure", () => {
  test("parent blocker rejects visible content with no terminal reason", () => {
    assertCompletionRejected(rawResponse([contentFrame(undefined), "data: [DONE]"]));
  });

  test("parent blocker rejects duplicate visible-content terminal reasons", () => {
    assertCompletionRejected(rawResponse([contentFrame("stop"), contentFrame("stop", null), "data: [DONE]"]));
  });

  test("parent blocker rejects conflicting visible-content terminal reasons", () => {
    assertCompletionRejected(rawResponse([contentFrame("stop"), contentFrame("length", null), "data: [DONE]"]));
  });

  test("parent blocker rejects unsupported visible-content terminal reason", () => {
    assertCompletionRejected(rawResponse([contentFrame("unsupported"), "data: [DONE]"]));
  });

  test("parent blocker rejects filtered visible-content success", () => {
    assertCompletionRejected(rawResponse([contentFrame("content_filter"), "data: [DONE]"]));
  });

  test("rejects semantic events after a choice terminal", () => {
    const tool = { index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } };
    for (const frame of [
      contentFrame(null, "LATE"),
      `data: ${JSON.stringify({ model: MODEL, choices: [{ index: 0, delta: { content: "" }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ model: MODEL, choices: [{ index: 0, delta: { content: null }, finish_reason: null }] })}`,
      contentFrame(null, null),
      contentFrame("length", null),
      `data: ${JSON.stringify({ model: MODEL, choices: [{ index: 0, delta: { tool_calls: [tool] }, finish_reason: null }] })}`,
      `data: ${JSON.stringify({ model: MODEL, choices: [{ index: 0, delta: { reasoning_content: "private chain" } }] })}`,
      `data: ${JSON.stringify({ model: MODEL, choices: [{ index: 0, delta: { role: "assistant" } }] })}`,
      `data: ${JSON.stringify({ model: MODEL, choices: [{ index: 0, delta: {} }] })}`,
    ]) {
      assertBoundedRejected(rawResponse([contentFrame("stop"), frame, "data: [DONE]"]));
    }
  });

  test("rejects semantic data after DONE while preserving transport lines", () => {
    const usage = `data: ${JSON.stringify({ model: MODEL, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`;
    assertCompletionRejected(rawResponse([contentFrame("stop"), "data: [DONE]", usage]));
    assertCompletionRejected(rawResponse([contentFrame("stop"), "data: [DONE]", "data: {not-json}"]));
    assertCompletionRejected(rawResponse([contentFrame("stop"), "data: [DONE]", "data:"]));
    const result = rawResponse([contentFrame("stop"), "data: [DONE]", "", ": transport keepalive"]);
    assert.equal(result.status, 200);
    assert.match(result.body.toString(), /transport keepalive/);
  });

  test("accepts one bounded usage frame and rejects invalid usage", () => {
    const usageFrame = (usage, choices = []) => `data: ${JSON.stringify({ model: MODEL, choices, usage })}`;
    const valid = usageFrame({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    const result = rawResponse([contentFrame("stop"), valid, "data: [DONE]"]);
    assert.equal(result.status, 200);
    assert.match(result.body.toString(), /"total_tokens":5/);

    for (const usage of [
      null,
      [],
      { prompt_tokens: 1 },
      { prompt_tokens: 1, completion_tokens: "1", total_tokens: 2 },
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 },
      { prompt_tokens: 1, input_tokens: 1, completion_tokens: 1 },
      { prompt_tokens: 1_000_000_001, completion_tokens: 0 },
      { prompt_tokens: 600_000_000, completion_tokens: 600_000_000 },
    ]) assertCompletionRejected(rawResponse([contentFrame("stop"), usageFrame(usage), "data: [DONE]"]));

    assertCompletionRejected(rawResponse([contentFrame("stop"), valid, valid, "data: [DONE]"]));
  });

  test("rejects DONE before every choice completes and any choice after DONE", () => {
    assertCompletionRejected(rawResponse([
      contentFrame(null),
      "data: [DONE]",
      contentFrame("stop", null),
    ]));
    assertCompletionRejected(rawResponse([
      contentFrame("stop"),
      "data: [DONE]",
      contentFrame(null, "LATE"),
    ]));
  });

  test("rejects missing and duplicate DONE markers", () => {
    assertCompletionRejected(rawResponse([contentFrame("stop")]));
    assertCompletionRejected(rawResponse([contentFrame("stop"), "data: [DONE]", "data: [DONE]"]));
  });

  test("keeps terminal state independent across interleaved choices", () => {
    const result = choicesResponse([
      [
        { index: 0, delta: { content: "CHOICE_ZERO" }, finish_reason: null },
        { index: 1, delta: { content: "CHOICE_ONE" }, finish_reason: null },
      ],
      [{ index: 1, delta: {}, finish_reason: "length" }],
      [{ index: 0, delta: {}, finish_reason: "stop" }],
    ]);
    assert.equal(result.status, 200);
    assert.match(result.body.toString(), /CHOICE_ZERO/);
    assert.match(result.body.toString(), /CHOICE_ONE/);
  });

  test("rejects tool completion without same-choice call evidence", () => {
    assertRejected([{ delta: { content: "PUBLIC_SYNTHETIC_OK" }, finishReason: "tool_calls" }]);
  });

  test("rejects a completed call with stop", () => {
    const call = { index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } };
    assertRejected([{ delta: { tool_calls: [call] }, finishReason: "stop" }]);
  });

  test("rejects a completed call with length", () => {
    const call = { index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } };
    assertRejected([{ delta: { tool_calls: [call] }, finishReason: "length" }]);
  });

  test("rejects missing, duplicate, conflicting, and unsupported tool terminal reasons", () => {
    const call = { index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } };
    assertRejected([{ delta: { tool_calls: [call] } }]);
    assertRejected([
      { delta: { tool_calls: [call] }, finishReason: "tool_calls" },
      { delta: {}, finishReason: "tool_calls" },
    ]);
    assertRejected([
      { delta: { tool_calls: [call] }, finishReason: "tool_calls" },
      { delta: {}, finishReason: "stop" },
    ]);
    assertRejected([{ delta: { tool_calls: [call] }, finishReason: "content_filter" }]);
    assertRejected([{ delta: { tool_calls: [call] }, finishReason: "unsupported" }]);
  });

  test("rejects cross-choice output and terminal borrowing", () => {
    const result = choicesResponse([
      [
        { index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: null },
        { index: 1, delta: { content: "PUBLIC_SYNTHETIC_OK" }, finish_reason: "tool_calls" },
      ],
    ]);
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.body).error.code, "invalid_upstream_tool_calls");
  });

  test("rejects cross-choice visible-output borrowing", () => {
    const result = choicesResponse([[
      { index: 0, delta: { content: "PUBLIC_SYNTHETIC_OK" }, finish_reason: "stop" },
      { index: 1, delta: {}, finish_reason: "stop" },
    ]]);
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.body).error.code, "empty_upstream_response");
  });

  test("preserves independent content and interleaved tool choices", () => {
    const result = choicesResponse([
      [
        { index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{" } }] }, finish_reason: null },
        { index: 1, delta: { content: "PUBLIC_SYNTHETIC_OK" }, finish_reason: null },
      ],
      [
        { index: 1, delta: {}, finish_reason: "stop" },
        { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" },
      ],
    ]);
    assert.equal(result.status, 200);
    assert.match(result.body.toString(), /PUBLIC_SYNTHETIC_OK/);
    assert.match(result.body.toString(), /call_1/);
  });

  test("preserves ordinary content-only stop and length", () => {
    for (const finishReason of ["stop", "length"]) {
      const result = response([{ delta: { content: "PUBLIC_SYNTHETIC_OK" }, finishReason }]);
      assert.equal(result.status, 200);
      assert.match(result.body.toString(), /PUBLIC_SYNTHETIC_OK/);
    }
  });

  test("reproduces and rejects an empty tool-call entry", () => {
    assertRejected([{ delta: { tool_calls: [{}] } }]);
  });

  test("rejects empty and non-array tool-call collections", () => {
    assertRejected([{ delta: { tool_calls: [] } }]);
    assertRejected([{ delta: { tool_calls: {} } }]);
  });

  test("rejects missing or unsupported identity and type", () => {
    assertRejected([{ delta: { tool_calls: [{ index: 0, type: "function", function: { name: "lookup", arguments: "{}" } }] } }]);
    assertRejected([{ delta: { tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] } }]);
    assertRejected([{ delta: { tool_calls: [{ index: -1, id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] } }]);
    assertRejected([{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "computer", function: { name: "lookup", arguments: "{}" } }] } }]);
  });

  test("rejects missing function, name, and arguments", () => {
    assertRejected([{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function" }] } }]);
    assertRejected([{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { arguments: "{}" } }] } }]);
    assertRejected([{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup" } }] } }]);
  });

  test("rejects incomplete and invalid JSON arguments", () => {
    assertRejected([{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"term\":" } }] } }]);
    assertRejected([{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "not json" } }] } }]);
  });

  test("rejects conflicting fragments and duplicate identities", () => {
    assertRejected([
      { delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{" } }] } },
      { delta: { tool_calls: [{ index: 0, id: "call_2", type: "function", function: { arguments: "}" } }] } },
    ]);
    assertRejected([
      { delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] } },
      { delta: { tool_calls: [{ index: 1, id: "call_1", type: "function", function: { name: "search", arguments: "{}" } }] } },
    ]);
    assertRejected([
      { delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } }] } },
      { delta: { tool_calls: [{ index: 0, type: "computer", function: { name: "search", arguments: {} } }] } },
    ]);
  });

  test("rejects mixed visible content and malformed tool evidence", () => {
    assertRejected([{ delta: { content: "PUBLIC_SYNTHETIC_OK", reasoning_content: "private chain", tool_calls: [{}] } }]);
  });

  test("preserves a valid fragmented call", () => {
    const result = response([
      { delta: { reasoning_content: "private chain", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"term\":" } }] } },
      { delta: { tool_calls: [{ index: 0, function: { arguments: "\"public\"}" } }] } },
      { delta: {}, finishReason: "tool_calls" },
    ]);
    assert.equal(result.status, 200);
    assert.match(result.body.toString(), /call_1/);
    assert.match(result.body.toString(), /PUBLIC|public/);
    assert.equal(result.body.includes(Buffer.from("private chain")), false);
    assert.equal(result.servedModel, MODEL);
  });

  test("preserves valid fragmented parallel calls", () => {
    const result = response([
      { delta: { tool_calls: [
        { index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{" } },
        { index: 1, id: "call_2", type: "function", function: { name: "search", arguments: "{\"q\":" } },
      ] } },
      { delta: { tool_calls: [
        { index: 1, function: { arguments: "\"public\"}" } },
        { index: 0, function: { arguments: "}" } },
      ] } },
      { delta: {}, finishReason: "tool_calls" },
    ]);
    assert.equal(result.status, 200);
    assert.match(result.body.toString(), /call_1/);
    assert.match(result.body.toString(), /call_2/);
    assert.equal(result.servedModel, MODEL);
  });

  test("rejects ordinary visible content without a terminal reason", () => {
    const result = response([{ delta: { content: "PUBLIC_SYNTHETIC_OK", reasoning_content: "private chain" } }]);
    assertCompletionRejected(result);
  });

  test("shared route returns bounded failure and sanitized audit", async () => {
    const upstream = http.createServer((request, serverResponse) => {
      request.resume();
      serverResponse.writeHead(200, { "content-type": "text/event-stream" });
      serverResponse.end(sseBody([{ delta: { reasoning_content: "private chain", tool_calls: [{}] } }]));
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${upstream.address().port}/v1`;
      const router = createRouter({ backends: { qwen: { url, auth_type: "none", models: [REQUESTED] } } });
      const events = [];
      const result = await routeAndSend(router, { model: REQUESTED, agentId: "repair" },
        "/chat/completions", "POST", { "content-type": "application/json" },
        Buffer.from(JSON.stringify({ model: REQUESTED, stream: true, messages: [] })), false,
        (event) => events.push(event));
      assert.equal(result.status, 502);
      assert.equal(JSON.parse(result.body).error.code, "invalid_upstream_tool_calls");
      assert.equal(events.findLast((event) => event.event_type === "response").details.status, 502);
      assert.equal(JSON.stringify(events).includes("private chain"), false);
    } finally {
      await new Promise((resolve) => upstream.close(resolve));
    }
  });
});
