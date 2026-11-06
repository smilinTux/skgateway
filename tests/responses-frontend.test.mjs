/**
 * responses-frontend.test.mjs: POST /v1/responses for Codex CLI.
 *
 * Unit-level translation in both directions, then the REAL gateway booted as a
 * subprocess against a stub chat-only backend on ports discovered at runtime, so
 * the dispatch in index.mjs and the two-turn tool round trip are on the wire.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fromResponsesRequest,
  normalizeErrorBody,
  responsesStreamEvents,
  toResponsesObject,
} from "../src/proxy/responses-frontend.mjs";

const INDEX = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.mjs");

/** Translate a Responses request object, expecting success. */
function fr(body) {
  const out = fromResponsesRequest(Buffer.from(JSON.stringify(body), "utf-8"));
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  return { ...out, chat: JSON.parse(out.body.toString("utf-8")) };
}

/** A Codex 0.166 shaped request, from protocol/src/models.rs and common.rs. */
const codexBody = (input, extra = {}) => ({
  model: "sk-s",
  instructions: "be useful",
  input,
  tools: [{
    type: "function",
    name: "shell",
    description: "run a command",
    strict: false,
    parameters: { type: "object", properties: { command: { type: "string" } } },
  }],
  tool_choice: "auto",
  parallel_tool_calls: false,
  reasoning: { effort: "medium", summary: "auto" },
  store: false,
  stream: true,
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "abc",
  service_tier: "auto",
  ...extra,
});

const userItem = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

describe("fromResponsesRequest", () => {
  test("string input and instructions -> system then user", () => {
    const { chat, stream } = fr({ model: "sk-s", instructions: "terse", input: "hi" });
    assert.deepEqual(chat.messages, [
      { role: "system", content: "terse" },
      { role: "user", content: "hi" },
    ]);
    assert.equal(stream, false);
    assert.equal(chat.stream, false);
  });

  test("the Codex request shape translates, and client-only fields do not leak", () => {
    const { chat, stream } = fr(codexBody([userItem("list files")]));
    assert.equal(stream, true, "stream flag surfaced to the caller");
    assert.equal(chat.stream, false, "internal routing is buffered");
    assert.deepEqual(chat.tools, [{
      type: "function",
      function: {
        name: "shell",
        description: "run a command",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    }]);
    assert.equal(chat.tool_choice, "auto");
    assert.equal(chat.parallel_tool_calls, false);
    assert.equal(chat.reasoning_effort, "medium");
    for (const field of ["store", "include", "prompt_cache_key", "service_tier", "reasoning", "input", "instructions"]) {
      assert.equal(field in chat, false, `${field} must not reach a chat backend`);
    }
  });

  test("max_output_tokens, temperature and top_p map across", () => {
    const { chat } = fr({ model: "m", input: "x", max_output_tokens: 99, temperature: 0.2, top_p: 0.5 });
    assert.equal(chat.max_tokens, 99);
    assert.equal(chat.temperature, 0.2);
    assert.equal(chat.top_p, 0.5);
    assert.equal("max_output_tokens" in chat, false);
  });

  test("developer role becomes system; a typeless message item is accepted", () => {
    const { chat } = fr({ model: "m", input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] },
      { role: "user", content: "hello" },
    ] });
    assert.deepEqual(chat.messages, [
      { role: "system", content: "rules" },
      { role: "user", content: "hello" },
    ]);
  });

  test("replayed tool turn: reasoning dropped, text and calls merge, outputs follow", () => {
    const { chat } = fr({ model: "m", input: [
      userItem("do two things"),
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] },
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{\"command\":\"ls\"}" },
      { type: "reasoning", id: "rs_2", summary: [] },
      { type: "function_call", call_id: "c2", name: "shell", arguments: "" },
      { type: "function_call_output", call_id: "c1", output: "a.txt" },
      { type: "function_call_output", call_id: "c2", output: [{ type: "input_text", text: "ok" }] },
    ] });
    assert.deepEqual(chat.messages, [
      { role: "user", content: "do two things" },
      {
        role: "assistant",
        content: "on it",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "shell", arguments: "{\"command\":\"ls\"}" } },
          { id: "c2", type: "function", function: { name: "shell", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "a.txt" },
      { role: "tool", tool_call_id: "c2", content: "ok" },
    ]);
  });

  test("an assistant item with nothing in it does not become an invalid message", () => {
    const { chat } = fr({ model: "m", input: [
      userItem("hi"),
      { type: "message", role: "assistant", content: [] },
      userItem("still there?"),
    ] });
    assert.deepEqual(chat.messages.map((m) => m.role), ["user", "user"]);
  });

  test("images: input_image -> image_url; a tool output image follows as a user message", () => {
    const { chat } = fr({ model: "m", input: [
      { type: "message", role: "user", content: [
        { type: "input_text", text: "look" },
        { type: "input_image", image_url: "data:image/png;base64,AAAB", detail: "low" },
      ] },
      { type: "function_call", call_id: "c1", name: "view", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: [
        { type: "input_text", text: "here" },
        { type: "input_image", image_url: "data:image/png;base64,BBBB" },
      ] },
    ] });
    assert.deepEqual(chat.messages[0].content[1], {
      type: "image_url", image_url: { url: "data:image/png;base64,AAAB", detail: "low" },
    });
    assert.deepEqual(chat.messages[2], { role: "tool", tool_call_id: "c1", content: "here" });
    assert.deepEqual(chat.messages[3], {
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } }],
    });
  });

  test("tool_choice forms; dropped entirely when no tool survives", () => {
    const tools = [{ type: "function", name: "f", parameters: {} }];
    assert.equal(fr({ model: "m", input: "x", tools, tool_choice: "required" }).chat.tool_choice, "required");
    assert.deepEqual(
      fr({ model: "m", input: "x", tools, tool_choice: { type: "function", name: "f" } }).chat.tool_choice,
      { type: "function", function: { name: "f" } },
    );
    const hostedOnly = fr({ model: "m", input: "x", tools: [{ type: "web_search" }], tool_choice: "required", parallel_tool_calls: true }).chat;
    for (const field of ["tools", "tool_choice", "parallel_tool_calls"]) {
      assert.equal(field in hostedOnly, false, `${field} is meaningless with no tools`);
    }
  });

  test("custom and namespace tools flatten to chat functions and map back", () => {
    const { chat, toolMap } = fr({ model: "m", input: "x", tools: [
      { type: "custom", name: "apply_patch", description: "patch", format: { type: "grammar", syntax: "lark", definition: "start: /.+/" } },
      { type: "namespace", name: "mcp__fs__", description: "fs", tools: [
        { type: "function", name: "read", description: "read a file", parameters: { type: "object" } },
      ] },
    ] });
    assert.deepEqual(chat.tools.map((t) => t.function.name), ["apply_patch", "mcp__fs__read"]);
    assert.deepEqual(chat.tools[0].function.parameters.required, ["input"]);
    assert.match(chat.tools[0].function.parameters.properties.input.description, /start: \/\.\+\//);

    const out = toResponsesObject({
      choices: [{ finish_reason: "tool_calls", message: { tool_calls: [
        { id: "a", function: { name: "apply_patch", arguments: "{\"input\":\"*** patch\"}" } },
        { id: "b", function: { name: "mcp__fs__read", arguments: "{\"path\":\"/x\"}" } },
      ] } }],
    }, "m", toolMap);
    assert.equal(out.output[0].type, "custom_tool_call");
    assert.equal(out.output[0].input, "*** patch");
    assert.equal(out.output[1].type, "function_call");
    assert.equal(out.output[1].name, "read");
    assert.equal(out.output[1].namespace, "mcp__fs__");

    // And replayed on the next turn, under the same chat names.
    const replay = fr({ model: "m", input: [
      { type: "custom_tool_call", call_id: "a", name: "apply_patch", input: "*** patch" },
      { type: "custom_tool_call_output", call_id: "a", output: "done" },
      { type: "function_call", call_id: "b", name: "read", namespace: "mcp__fs__", arguments: "{}" },
      { type: "function_call_output", call_id: "b", output: "data" },
    ] }).chat;
    assert.equal(replay.messages[0].tool_calls[0].function.arguments, "{\"input\":\"*** patch\"}");
    assert.equal(replay.messages[2].tool_calls[0].function.name, "mcp__fs__read");
  });

  test("namespaced tool names are readable, within 64 chars, and stable across a replay", () => {
    const longNamespace = "mcp__codex_apps__codex_document_control";
    const longName = "_get_document_tool_schemas_and_more";
    const { chat, toolMap } = fr({ model: "m", input: "x", tools: [
      { type: "namespace", name: "mcp__skmemory", tools: [{ type: "function", name: "memory_health" }] },
      { type: "namespace", name: "mcp__apps", tools: [{ type: "function", name: "_adopt" }] },
      { type: "namespace", name: longNamespace, tools: [{ type: "function", name: longName }] },
    ] });
    const names = chat.tools.map((t) => t.function.name);
    assert.equal(names[0], "mcp__skmemory__memory_health");
    assert.equal(names[1], "mcp__apps_adopt");
    assert.ok(names[2].length <= 64, names[2]);
    assert.deepEqual(toolMap[names[2]], { kind: "function", name: longName, namespace: longNamespace });

    const replay = fr({ model: "m", input: [
      { type: "function_call", call_id: "c", name: longName, namespace: longNamespace, arguments: "{}" },
    ] }).chat;
    assert.equal(replay.messages[0].tool_calls[0].function.name, names[2]);
  });

  test("text.format json_schema -> response_format", () => {
    const schema = { type: "object" };
    const { chat } = fr({ model: "m", input: "x", text: { format: { type: "json_schema", name: "out", schema, strict: true } } });
    assert.deepEqual(chat.response_format, { type: "json_schema", json_schema: { name: "out", schema, strict: true } });
  });

  test("what cannot be honored is a 400, never a silently degraded answer", () => {
    const rejected = (body) => {
      const out = fromResponsesRequest(Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
      assert.equal(out.status, 400);
      assert.equal(typeof out.error.error.message, "string");
      return out.error.error;
    };
    assert.equal(rejected("not json").code, "invalid_json");
    assert.equal(rejected({ model: "m" }).param, "input");
    assert.equal(rejected({ model: "m", input: "x", previous_response_id: "resp_1" }).param, "previous_response_id");
    assert.equal(rejected({ model: "m", input: "x", background: true }).param, "background");
    assert.equal(rejected({ model: "m", input: [{ type: "item_reference", id: "x" }] }).code, "unsupported_content");
    assert.equal(rejected({ model: "m", input: [{ role: "user", content: [{ type: "input_file", file_id: "f" }] }] }).code, "unsupported_content");
  });
});

describe("toResponsesObject", () => {
  test("text answer -> a message item, usage and completed status", () => {
    const r = toResponsesObject({
      id: "chatcmpl-1",
      model: "served-model",
      created: 1700000000,
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } },
    }, "sk-s");
    assert.equal(r.object, "response");
    assert.equal(r.status, "completed");
    assert.equal(r.model, "served-model");
    assert.equal(r.created_at, 1700000000);
    assert.match(r.id, /^resp_/);
    assert.equal(r.output.length, 1);
    assert.equal(r.output[0].type, "message");
    assert.equal(r.output[0].content[0].type, "output_text");
    assert.equal(r.output[0].content[0].text, "hello");
    assert.deepEqual(r.usage, {
      input_tokens: 5,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 7,
    });
  });

  test("tool call -> function_call item; empty arguments become an empty object", () => {
    const r = toResponsesObject({
      choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [
        { id: "call_9", type: "function", function: { name: "shell", arguments: "" } },
      ] } }],
    }, "sk-s");
    assert.equal(r.model, "sk-s", "falls back to the requested model");
    assert.equal(r.usage, null, "no usage reported stays unknown, not zero");
    assert.equal(r.output[0].type, "function_call");
    assert.equal(r.output[0].call_id, "call_9");
    assert.equal(r.output[0].name, "shell");
    assert.equal(r.output[0].arguments, "{}");
  });

  test("a truncated answer is incomplete and never carries a tool call Codex would run", () => {
    const r = toResponsesObject({
      choices: [{ finish_reason: "length", message: { content: "partial", tool_calls: [
        { id: "c", function: { name: "shell", arguments: "{\"command\":\"rm -rf /tm" } },
      ] } }],
    }, "m");
    assert.equal(r.status, "incomplete");
    assert.deepEqual(r.incomplete_details, { reason: "max_output_tokens" });
    assert.deepEqual(r.output.map((i) => i.type), ["message"]);
    assert.equal(r.output[0].status, "incomplete");
  });

  test("content_filter -> incomplete with its own reason", () => {
    const r = toResponsesObject({ choices: [{ finish_reason: "content_filter", message: { content: "" } }] }, "m");
    assert.deepEqual(r.incomplete_details, { reason: "content_filter" });
  });
});

describe("responsesStreamEvents", () => {
  test("text answer: the event sequence Codex consumes, in order", () => {
    const response = toResponsesObject({
      choices: [{ finish_reason: "stop", message: { content: "hi 😀" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }, "m");
    const events = responsesStreamEvents(response);
    assert.deepEqual(events.map((e) => e.type), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    assert.deepEqual(events.map((e) => e.sequence_number), events.map((_, i) => i));
    assert.equal(events[0].response.id, response.id);
    assert.deepEqual(events[0].response.output, []);
    assert.equal(events[2].item.status, "in_progress");
    assert.deepEqual(events[2].item.content, []);
    assert.equal(events[4].delta, "hi 😀", "whole text, so no surrogate pair is ever split");
    assert.equal(events[4].item_id, response.output[0].id);
    assert.equal(events[7].item.content[0].text, "hi 😀");
    assert.equal(events[8].response.status, "completed");
    assert.equal(events[8].response.usage.total_tokens, 2);
  });

  test("tool call: added with empty arguments, full arguments on done", () => {
    const events = responsesStreamEvents(toResponsesObject({
      choices: [{ finish_reason: "tool_calls", message: { tool_calls: [
        { id: "c1", function: { name: "shell", arguments: "{\"command\":\"ls\"}" } },
      ] } }],
    }, "m"));
    assert.deepEqual(events.map((e) => e.type), [
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    assert.equal(events[2].item.arguments, "");
    assert.equal(events[2].item.call_id, "c1");
    assert.equal(events[4].arguments, "{\"command\":\"ls\"}");
    assert.equal(events[5].item.arguments, "{\"command\":\"ls\"}");
  });

  test("custom tool: its input deltas carry the call id Codex looks up", () => {
    const { toolMap } = fr({ model: "m", input: "x", tools: [{ type: "custom", name: "apply_patch" }] });
    const events = responsesStreamEvents(toResponsesObject({
      choices: [{ finish_reason: "tool_calls", message: { tool_calls: [
        { id: "c1", function: { name: "apply_patch", arguments: "{\"input\":\"p\"}" } },
      ] } }],
    }, "m", toolMap));
    const delta = events.find((e) => e.type === "response.custom_tool_call_input.delta");
    assert.equal(delta.call_id, "c1");
    assert.equal(delta.delta, "p");
    assert.equal(events.find((e) => e.type === "response.output_item.added").item.input, "");
  });

  test("a truncated answer ends with response.incomplete, not response.completed", () => {
    const events = responsesStreamEvents(toResponsesObject({
      choices: [{ finish_reason: "length", message: { content: "part" } }],
    }, "m"));
    const last = events.at(-1);
    assert.equal(last.type, "response.incomplete");
    assert.equal(last.response.incomplete_details.reason, "max_output_tokens");
    assert.equal(events.some((e) => e.type === "response.completed"), false);
    assert.equal(events[0].response.incomplete_details, null);
  });
});

describe("normalizeErrorBody", () => {
  test("an OpenAI-shaped error keeps its fields", () => {
    const { error } = normalizeErrorBody(JSON.stringify({ error: { message: "slow down", type: "rate_limit_error", code: "rate_limit_exceeded" } }), 429);
    assert.equal(error.message, "slow down");
    assert.equal(error.type, "rate_limit_error");
    assert.equal(error.code, "rate_limit_exceeded");
  });

  test("FastAPI detail, a string error and plain text are all reshaped", () => {
    assert.equal(normalizeErrorBody(JSON.stringify({ detail: "Not Found" }), 404).error.message, "Not Found");
    assert.equal(normalizeErrorBody(JSON.stringify({ error: "bad" }), 400).error.message, "bad");
    const html = normalizeErrorBody(Buffer.from("<html>bad gateway</html>"), 502).error;
    assert.equal(html.message, "<html>bad gateway</html>");
    assert.equal(html.type, "server_error");
    assert.equal(normalizeErrorBody(null, 503).error.message, "Upstream error 503");
  });
});

// ─── live gateway against a stub chat-only backend ──────────────────────────

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

/** Parse an SSE body into its events, checking each `event:` matches its data. */
function parseSSE(text) {
  return text.split("\n\n").filter(Boolean).map((frame) => {
    const event = frame.match(/^event: (.*)$/m)?.[1];
    const data = JSON.parse(frame.match(/^data: (.*)$/m)[1]);
    assert.equal(event, data.type);
    return data;
  });
}

describe("POST /v1/responses through the real gateway", () => {
  let stub, child, dir, base;
  const seen = [];
  /** The next stub answer; each test sets its own. */
  let answer = () => ({ status: 500, body: {} });

  before(async () => {
    stub = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        // A chat-only backend: the frontend must never reach it on another path.
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        seen.push({ path: req.url, body: parsed });
        const { status, body, headers = {} } = req.url.endsWith("/chat/completions")
          ? answer(parsed)
          : { status: 404, body: { detail: "Not Found" } };
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));

    dir = mkdtempSync(join(tmpdir(), "skgw-responses-"));
    const port = await freePort();
    const dashPort = await freePort();
    const cfgPath = join(dir, "gw.yaml");
    writeFileSync(cfgPath, [
      "server:",
      "  bind: 127.0.0.1",
      `  port: ${port}`,
      `  dashboard_port: ${dashPort}`,
      "discovery:",
      "  enabled: false",
      "dashboard:",
      `  port: ${dashPort}`,
      "identity:",
      "  enabled: false",
      "metrics:",
      "  enabled: false",
      "backends:",
      "  stub:",
      `    url: http://127.0.0.1:${stub.address().port}/v1`,
      "    auth_type: none",
      "    priority: 1",
      "    models:",
      "      - stub-model",
      "",
    ].join("\n"));
    base = `http://127.0.0.1:${port}`;

    child = spawn(process.execPath, [INDEX, "--config", cfgPath, "--port", String(port)], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((res, rej) => {
      let out = "";
      const timer = setTimeout(() => rej(new Error(`gateway did not start:\n${out}`)), 20000);
      const onData = (buf) => {
        out += buf;
        if (out.includes("listening on")) { clearTimeout(timer); res(); }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
    });
  });

  after(async () => {
    child?.kill("SIGKILL");
    await new Promise((r) => stub.close(r));
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (body, headers = {}) => fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

  test("streamed text answer", async () => {
    answer = () => ({ status: 200, body: {
      id: "c1", object: "chat.completion", model: "stub-model",
      choices: [{ index: 0, message: { role: "assistant", content: "<think>hidden</think>ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    } });
    const res = await post({ model: "stub-model", input: "say ok", stream: true });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    const raw = await res.text();
    assert.equal(raw.includes("[DONE]"), false, "the Responses stream has no [DONE]");
    const events = parseSSE(raw);
    assert.equal(events[0].type, "response.created");
    assert.equal(events.find((e) => e.type === "response.output_text.delta").delta, "ok", "the sanitizer ran on the chat form");
    const done = events.at(-1);
    assert.equal(done.type, "response.completed");
    assert.equal(done.response.usage.input_tokens, 4);
    assert.equal(done.response.output[0].content[0].text, "ok");
    assert.equal(seen.at(-1).path, "/v1/chat/completions");
    assert.equal(seen.at(-1).body.stream, false);
  });

  test("non-streaming returns one Responses object with attribution headers", async () => {
    answer = () => ({ status: 200, body: {
      id: "c2", model: "stub-model",
      choices: [{ index: 0, message: { role: "assistant", content: "plain" }, finish_reason: "stop" }],
    } });
    const res = await post({ model: "stub-model", input: "hi" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-sk-backend"), "stub");
    const body = await res.json();
    assert.equal(body.object, "response");
    assert.equal(body.output[0].content[0].text, "plain");
  });

  test("two-turn tool-call round trip, fed back the way Codex replays it", async () => {
    answer = (chat) => {
      const toolMsg = chat.messages.find((m) => m.role === "tool");
      if (!toolMsg) {
        return { status: 200, body: {
          id: "c3", model: "stub-model",
          choices: [{ index: 0, finish_reason: "tool_calls", message: {
            role: "assistant", content: null,
            tool_calls: [{ id: "call_abc", type: "function", function: { name: "shell", arguments: "{\"command\":\"ls\"}" } }],
          } }],
        } };
      }
      return { status: 200, body: {
        id: "c4", model: "stub-model",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `files: ${toolMsg.content}` } }],
      } };
    };

    const input = [userItem("list the files")];
    const first = parseSSE(await (await post(codexBody(input, { model: "stub-model" }))).text());
    const callItem = first.find((e) => e.type === "response.output_item.done").item;
    assert.equal(callItem.type, "function_call");
    assert.equal(callItem.call_id, "call_abc");
    assert.equal(callItem.name, "shell");
    assert.equal(callItem.arguments, "{\"command\":\"ls\"}");
    assert.equal(first.at(-1).type, "response.completed");

    input.push(callItem, { type: "function_call_output", call_id: callItem.call_id, output: "a.txt" });
    const second = parseSSE(await (await post(codexBody(input, { model: "stub-model" }))).text());
    assert.equal(second.find((e) => e.type === "response.output_text.delta").delta, "files: a.txt");

    const replayed = seen.at(-1).body.messages;
    assert.deepEqual(replayed.map((m) => m.role), ["system", "user", "assistant", "tool"]);
    assert.equal(replayed[2].tool_calls[0].id, "call_abc");
    assert.equal(replayed[3].tool_call_id, "call_abc");
    assert.deepEqual(seen.at(-1).body.tools[0].function.name, "shell");
  });

  test("Codex's several developer items reach the backend as one leading system message", async () => {
    answer = () => ({ status: 200, body: {
      id: "c5", model: "stub-model",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    } });
    const res = await post({ model: "stub-model", input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "one" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "two" }] },
      userItem("hi"),
    ] });
    assert.equal(res.status, 200);
    assert.deepEqual(seen.at(-1).body.messages, [
      { role: "system", content: "one\n\ntwo" },
      { role: "user", content: "hi" },
    ]);
  });

  // Last dispatching test: the router then counts the backend as throttled.
  test("a backend 429 on a stream request is an HTTP 429 with JSON, keeping retry-after", async () => {
    answer = () => ({
      status: 429,
      headers: { "retry-after": "7" },
      body: { error: { message: "slow down", type: "rate_limit_error", code: "rate_limit_exceeded" } },
    });
    const res = await post({ model: "stub-model", input: "x", stream: true });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "7");
    assert.match(res.headers.get("content-type"), /application\/json/);
    const { error } = await res.json();
    assert.equal(typeof error.message, "string", "the router's own message, in a shape Codex parses");
    assert.ok(error.message.length > 0);
  });

  test("a stateful request is a local 400; the backend is not called", async () => {
    const before = seen.length;
    const res = await post({ model: "stub-model", input: "x", previous_response_id: "resp_1" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.param, "previous_response_id");
    assert.equal((await post("not json")).status, 400);
    assert.equal(seen.length, before);
  });

  test("a missing model is the gateway's usual 400 model_required", async () => {
    const res = await post({ input: "x" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "model_required");
  });
});
