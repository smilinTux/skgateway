/**
 * codex-adapter tests. All fixtures are CAPTURED from the live Codex backend
 * (2026-08-22, synthetic prompts only: "Reply with exactly: ok", a weather
 * tool call, and its function_call_output turn). No network in this suite:
 * toCodexRequest/fromCodexResponse are pure, and the wire contract they pin
 * is the one measured in that session (see codex-adapter.mjs's module doc).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isCodexBackend,
  toCodexRequest,
  fromCodexResponse,
  parseCodexSSE,
  readCodexAuthHeaders,
} from "../src/proxy/codex-adapter.mjs";

function openaiBody(obj) {
  return Buffer.from(JSON.stringify(obj), "utf-8");
}

// ── isCodexBackend ────────────────────────────────────────────────────────────

test("isCodexBackend: true for codex_oauth auth and the chatgpt codex url", () => {
  assert.equal(isCodexBackend({ auth_type: "codex_oauth", url: "https://anything" }), true);
  assert.equal(isCodexBackend({ auth_type: "none", url: "https://chatgpt.com/backend-api/codex" }), true);
  assert.equal(isCodexBackend({ auth_type: "none", url: "https://api.openai.com/v1" }), false);
  assert.equal(isCodexBackend(null), false);
});

// ── toCodexRequest ────────────────────────────────────────────────────────────

test("toCodexRequest: system becomes instructions, user becomes input_text, stream forced true", () => {
  const tr = toCodexRequest(openaiBody({
    model: "gpt-5.6-sol",
    stream: false,
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "say ok" },
    ],
  }));
  assert.ok(tr, "translatable");
  const req = JSON.parse(tr.body.toString("utf-8"));
  assert.equal(req.stream, true, "backend requires stream:true");
  assert.equal(req.store, false);
  assert.equal(req.instructions, "be brief");
  assert.deepEqual(req.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "say ok" }] },
  ]);
  assert.equal(tr.path, "/responses");
  assert.equal(tr.headers.originator, "codex_cli_rs");
  assert.equal(tr.headers.accept, "text/event-stream");
  assert.equal(tr.clientStream, false, "client did not ask to stream");
});

test("toCodexRequest: clientStream records the client's own stream flag", () => {
  const tr = toCodexRequest(openaiBody({ model: "gpt-5.6-sol", stream: true, messages: [{ role: "user", content: "hi" }] }));
  assert.equal(tr.clientStream, true);
  // and the upstream body is streaming either way
  assert.equal(JSON.parse(tr.body.toString("utf-8")).stream, true);
});

test("toCodexRequest: measured-400 params are dropped and reported", () => {
  const tr = toCodexRequest(openaiBody({
    model: "gpt-5.6-sol",
    temperature: 0.3,
    max_tokens: 512,
    stop: ["x"],
    messages: [{ role: "user", content: "hi" }],
  }));
  const req = JSON.parse(tr.body.toString("utf-8"));
  assert.ok(!("temperature" in req));
  assert.ok(!("max_tokens" in req));
  assert.ok(!("stop" in req));
  assert.deepEqual(tr.dropped, ["max_tokens", "temperature", "stop"]);
});

test("toCodexRequest: tools flattened, tool_choice named form unwrapped", () => {
  const tr = toCodexRequest(openaiBody({
    model: "gpt-5.6-sol",
    messages: [{ role: "user", content: "weather?" }],
    tools: [{
      type: "function",
      function: { name: "get_weather", description: "w", parameters: { type: "object", properties: {} } },
    }],
    tool_choice: { type: "function", function: { name: "get_weather" } },
  }));
  const req = JSON.parse(tr.body.toString("utf-8"));
  // Responses tools are FLAT: name/description/parameters at the top level,
  // not nested under function (measured contract).
  assert.deepEqual(req.tools, [{
    type: "function",
    name: "get_weather",
    description: "w",
    parameters: { type: "object", properties: {} },
  }]);
  assert.deepEqual(req.tool_choice, { type: "function", name: "get_weather" });
});

test("toCodexRequest: assistant tool_calls replay as function_call items, tool results as function_call_output", () => {
  const tr = toCodexRequest(openaiBody({
    model: "gpt-5.6-sol",
    messages: [
      { role: "user", content: "weather in paris?" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
        }],
      },
      { role: "tool", tool_call_id: "call_1", content: "18C, light rain" },
    ],
  }));
  const req = JSON.parse(tr.body.toString("utf-8"));
  assert.equal(req.input.length, 3);
  assert.deepEqual(req.input[1], {
    type: "function_call",
    call_id: "call_1",
    name: "get_weather",
    arguments: "{\"city\":\"Paris\"}",
  });
  assert.deepEqual(req.input[2], {
    type: "function_call_output",
    call_id: "call_1",
    output: "18C, light rain",
  });
});

test("toCodexRequest: reasoning_effort forwarded only when the backend declares it", () => {
  const mk = (effort) => toCodexRequest(openaiBody({
    model: "gpt-5.6-sol",
    reasoning_effort: effort,
    messages: [{ role: "user", content: "hi" }],
  }));
  assert.deepEqual(JSON.parse(mk("high").body.toString("utf-8")).reasoning, { effort: "high" });
  assert.ok(!("reasoning" in JSON.parse(mk("bogus").body.toString("utf-8"))));
  const none = toCodexRequest(openaiBody({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] }));
  assert.ok(!("reasoning" in JSON.parse(none.body.toString("utf-8"))));
});

test("toCodexRequest: non-JSON and non-chat bodies return null (passthrough contract)", () => {
  assert.equal(toCodexRequest(Buffer.from("not json")), null);
  assert.equal(toCodexRequest(openaiBody({ model: "x" })), null);
});

// ── fromCodexResponse ─────────────────────────────────────────────────────────

// Captured live: plain text answer ("Reply with exactly: ok" on gpt-5.6-sol).
const TEXT_SSE = [
  'data: {"type":"response.created","response":{"id":"resp_1"}}',
  "",
  'data: {"type":"response.output_item.done","item":{"id":"msg_1","type":"message","status":"completed","role":"assistant","content":[{"type":"output_text","annotations":[],"logprobs":[],"text":"ok"}]}}',
  "",
  'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.6-sol","created_at":1787433719,"status":"completed","usage":{"input_tokens":11,"output_tokens":5,"total_tokens":16}}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

// Captured live: tool call turn (get_weather("Paris") on gpt-5.6-sol).
const TOOL_SSE = [
  'data: {"type":"response.output_item.done","item":{"id":"fc_1","type":"function_call","status":"completed","arguments":"{\\"city\\":\\"Paris\\"}","call_id":"call_AB","name":"get_weather"}}',
  "",
  'data: {"type":"response.completed","response":{"id":"resp_2","model":"gpt-5.6-sol","created_at":1787433721,"status":"completed","usage":{"input_tokens":66,"output_tokens":18,"total_tokens":84}}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

test("fromCodexResponse: buffered text answer becomes an OpenAI completion with usage", () => {
  const res = fromCodexResponse(
    { status: 200, headers: { "content-type": "text/event-stream" }, body: Buffer.from(TEXT_SSE) },
    "gpt-5.6-sol",
    false,
  );
  const oai = JSON.parse(res.body.toString("utf-8"));
  assert.equal(oai.object, "chat.completion");
  assert.equal(oai.model, "gpt-5.6-sol");
  assert.equal(oai.choices[0].message.content, "ok");
  assert.equal(oai.choices[0].finish_reason, "stop");
  assert.deepEqual(oai.usage, { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 });
  assert.equal(res.headers["content-type"], "application/json");
});

test("fromCodexResponse: function_call items become tool_calls with the call_id", () => {
  const res = fromCodexResponse(
    { status: 200, headers: {}, body: Buffer.from(TOOL_SSE) },
    "gpt-5.6-sol",
    false,
  );
  const oai = JSON.parse(res.body.toString("utf-8"));
  assert.equal(oai.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(oai.choices[0].message.tool_calls, [{
    id: "call_AB",
    type: "function",
    function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
  }]);
});

test("fromCodexResponse: stream client gets an OpenAI SSE byte stream", () => {
  const res = fromCodexResponse(
    { status: 200, headers: {}, body: Buffer.from(TEXT_SSE) },
    "gpt-5.6-sol",
    true,
  );
  assert.match(res.headers["content-type"], /^text\/event-stream/);
  assert.ok(!("content-length" in res.headers));
  const text = res.body.toString("utf-8");
  assert.ok(text.endsWith("data: [DONE]\n\n"));
  const chunks = text.split("\n\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
  assert.equal(chunks[0].choices[0].delta.role, "assistant");
  const finishChunk = chunks.find((c) => c.choices?.[0]?.finish_reason);
  assert.equal(finishChunk.choices[0].finish_reason, "stop");
  const usageChunk = chunks[chunks.length - 1];
  assert.deepEqual(usageChunk.choices, [], "usage chunk must carry an empty choices array");
  assert.deepEqual(usageChunk.usage, { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 });
});

test("fromCodexResponse: streamed tool_calls fragments carry a per-fragment index (card fc22572b follow-up)", () => {
  // Regression, incident 2026-09-03: the stream branch emitted tool_calls
  // fragments WITHOUT index, so the response contract rejected every
  // streamed Codex tool call as invalid tool-call evidence (502).
  const res = fromCodexResponse(
    { status: 200, headers: {}, body: Buffer.from(TOOL_SSE) },
    "gpt-5.6-sol",
    true,
  );
  const text = res.body.toString("utf-8");
  const chunks = text.split("\n\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
  const toolChunk = chunks.find((c) => Array.isArray(c.choices?.[0]?.delta?.tool_calls));
  assert.ok(toolChunk, "a tool_calls delta chunk must exist");
  for (const [i, fragment] of toolChunk.choices[0].delta.tool_calls.entries()) {
    assert.equal(
      fragment.index, i,
      `stream tool_calls fragment ${i} must carry its integer index for the response contract`,
    );
    assert.equal(fragment.type, "function");
    assert.ok(fragment.id, "fragment id preserved");
    assert.ok(fragment.function?.name, "fragment function name preserved");
  }
});

test("end to end: streamed Codex tool call passes the response contract (no 502)", async () => {
  const { enforceResponseContract } = await import("../src/proxy/response-contract.mjs");
  const res = enforceResponseContract(
    fromCodexResponse(
      { status: 200, headers: {}, body: Buffer.from(TOOL_SSE) },
      "gpt-5.6-sol",
      true,
    ),
    "gpt-5.6-sol",
  );
  assert.equal(res.status, 200, `contract must accept the streamed tool call, got ${res.status}: ${res.body?.toString("utf-8")?.slice(0, 200)}`);
});

test("fromCodexResponse: non-2xx FastAPI detail is reshaped into an OpenAI error, status preserved", () => {
  const res = fromCodexResponse(
    {
      status: 400,
      headers: {},
      body: Buffer.from("{\"detail\":\"Unsupported parameter: temperature\"}"),
    },
    "gpt-5.6-sol",
    false,
  );
  assert.equal(res.status, 400);
  const oai = JSON.parse(res.body.toString("utf-8"));
  assert.equal(oai.error.message, "Unsupported parameter: temperature");
});

test("fromCodexResponse: unparseable 2xx body passes through untouched", () => {
  const raw = { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") };
  const res = fromCodexResponse(raw, "m", false);
  assert.equal(res, raw);
});

test("parseCodexSSE: null for non-SSE bodies", () => {
  assert.equal(parseCodexSSE("{}"), null);
  assert.equal(parseCodexSSE(""), null);
});

// ── readCodexAuthHeaders ──────────────────────────────────────────────────────

test("readCodexAuthHeaders: codex CLI auth.json shape, flat shape, and failures", async () => {
  const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "codex-auth-"));
  try {
    const cliShape = join(dir, "auth.json");
    writeFileSync(cliShape, JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "at-123", refresh_token: "rt", account_id: "acc-1" },
    }));
    assert.deepEqual(readCodexAuthHeaders(cliShape), {
      authorization: "Bearer at-123",
      "chatgpt-account-id": "acc-1",
    });

    const flat = join(dir, "flat.json");
    writeFileSync(flat, JSON.stringify({ access_token: "at-9", account_id: "acc-9" }));
    assert.deepEqual(readCodexAuthHeaders(flat), {
      authorization: "Bearer at-9",
      "chatgpt-account-id": "acc-9",
    });

    assert.equal(readCodexAuthHeaders(join(dir, "missing.json")), null);
    const noToken = join(dir, "no-token.json");
    writeFileSync(noToken, JSON.stringify({ tokens: { refresh_token: "rt" } }));
    assert.equal(readCodexAuthHeaders(noToken), null);
    // no account id still authenticates (bearer alone); header simply absent
    const noAcc = join(dir, "no-acc.json");
    writeFileSync(noAcc, JSON.stringify({ access_token: "at-10" }));
    assert.deepEqual(readCodexAuthHeaders(noAcc), { authorization: "Bearer at-10" });
    assert.equal(readCodexAuthHeaders(null), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
