import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fromAnthropicRequest,
  toAnthropicMessage,
} from "../src/proxy/anthropic-frontend.mjs";

// ─── fromAnthropicRequest: Anthropic Messages request -> OpenAI chat body ───

/** Helper: translate an Anthropic Messages request object to an OpenAI body. */
function fr(body) {
  const out = fromAnthropicRequest(Buffer.from(JSON.stringify(body), "utf-8"));
  assert.ok(out, "expected a translatable Anthropic request");
  return { ...out, openai: JSON.parse(out.body.toString("utf-8")) };
}

test("plain string user content -> OpenAI user message string", () => {
  const { openai } = fr({
    model: "ornith-big",
    max_tokens: 256,
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(openai.model, "ornith-big");
  assert.equal(openai.max_tokens, 256);
  assert.deepEqual(openai.messages, [{ role: "user", content: "hello" }]);
});

test("system string -> a leading OpenAI system message", () => {
  const { openai } = fr({
    model: "ornith-big",
    system: "be terse",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(openai.messages[0].role, "system");
  assert.equal(openai.messages[0].content, "be terse");
  assert.equal(openai.messages[1].role, "user");
});

test("system as text blocks -> flattened system message", () => {
  const { openai } = fr({
    model: "ornith-big",
    system: [
      { type: "text", text: "line one" },
      { type: "text", text: "line two" },
    ],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(openai.messages[0].role, "system");
  assert.equal(openai.messages[0].content, "line one\nline two");
});

test("base64 image block -> OpenAI image_url data URI", () => {
  const { openai } = fr({
    model: "ornith-big",
    messages: [{ role: "user", content: [
      { type: "text", text: "look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAB" } },
    ] }],
  });
  const content = openai.messages[0].content;
  assert.ok(Array.isArray(content), "multimodal content stays an array");
  assert.deepEqual(content[0], { type: "text", text: "look" });
  assert.deepEqual(content[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,AAAB" },
  });
});

test("url image block -> OpenAI image_url http url", () => {
  const { openai } = fr({
    model: "ornith-big",
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "url", url: "https://x.com/p.jpg" } },
    ] }],
  });
  assert.deepEqual(openai.messages[0].content[0], {
    type: "image_url",
    image_url: { url: "https://x.com/p.jpg" },
  });
});

test("assistant tool_use block -> OpenAI assistant tool_calls", () => {
  const { openai } = fr({
    model: "ornith-big",
    messages: [
      { role: "user", content: "weather?" },
      { role: "assistant", content: [
        { type: "text", text: "checking" },
        { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "NYC" } },
      ] },
    ],
  });
  const asst = openai.messages[1];
  assert.equal(asst.role, "assistant");
  assert.equal(asst.content, "checking");
  assert.equal(asst.tool_calls.length, 1);
  assert.deepEqual(asst.tool_calls[0], {
    id: "tu_1",
    type: "function",
    function: { name: "get_weather", arguments: JSON.stringify({ city: "NYC" }) },
  });
});

test("user tool_result block -> OpenAI tool-role message", () => {
  const { openai } = fr({
    model: "ornith-big",
    messages: [
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "72F sunny" },
      ] },
    ],
  });
  assert.deepEqual(openai.messages[0], {
    role: "tool",
    tool_call_id: "tu_1",
    content: "72F sunny",
  });
});

test("tool_result plus trailing text -> tool message then user message", () => {
  const { openai } = fr({
    model: "ornith-big",
    messages: [
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "done" },
        { type: "text", text: "now summarize" },
      ] },
    ],
  });
  assert.equal(openai.messages[0].role, "tool");
  assert.equal(openai.messages[0].tool_call_id, "tu_1");
  assert.equal(openai.messages[1].role, "user");
  assert.equal(openai.messages[1].content, "now summarize");
});

test("tools with input_schema -> OpenAI function tools", () => {
  const schema = { type: "object", properties: { city: { type: "string" } } };
  const { openai } = fr({
    model: "ornith-big",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "get_weather", description: "weather", input_schema: schema }],
    tool_choice: { type: "auto" },
  });
  assert.deepEqual(openai.tools[0], {
    type: "function",
    function: { name: "get_weather", description: "weather", parameters: schema },
  });
  assert.equal(openai.tool_choice, "auto");
});

test("tool_choice any -> required, tool -> named function", () => {
  const { openai: anyReq } = fr({
    model: "ornith-big",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "f", input_schema: {} }],
    tool_choice: { type: "any" },
  });
  assert.equal(anyReq.tool_choice, "required");

  const { openai: namedReq } = fr({
    model: "ornith-big",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "f", input_schema: {} }],
    tool_choice: { type: "tool", name: "f" },
  });
  assert.deepEqual(namedReq.tool_choice, { type: "function", function: { name: "f" } });
});

test("stop_sequences -> stop; stream captured and forced off internally", () => {
  const out = fromAnthropicRequest(Buffer.from(JSON.stringify({
    model: "ornith-big",
    stream: true,
    stop_sequences: ["STOP"],
    messages: [{ role: "user", content: "hi" }],
  })));
  assert.equal(out.stream, true, "stream flag surfaced to the caller");
  assert.equal(out.model, "ornith-big");
  const openai = JSON.parse(out.body.toString("utf-8"));
  assert.deepEqual(openai.stop, ["STOP"]);
  assert.equal(openai.stream, false, "internal routing must be non-streaming (we buffer)");
});

test("non-JSON or missing messages -> null (pass-through)", () => {
  assert.equal(fromAnthropicRequest(Buffer.from("not json")), null);
  assert.equal(fromAnthropicRequest(Buffer.from(JSON.stringify({ model: "x" }))), null);
});

// ─── toAnthropicMessage: OpenAI chat.completion -> Anthropic Messages object ───

test("text completion -> Anthropic message with a text block", () => {
  const a = toAnthropicMessage({
    id: "chatcmpl-1",
    model: "ornith-1.0-35b",
    choices: [{ index: 0, message: { role: "assistant", content: "hi there" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  }, "ornith-big");
  assert.equal(a.type, "message");
  assert.equal(a.role, "assistant");
  assert.equal(a.model, "ornith-1.0-35b");
  assert.deepEqual(a.content, [{ type: "text", text: "hi there" }]);
  assert.equal(a.stop_reason, "end_turn");
  assert.equal(a.stop_sequence, null);
  assert.deepEqual(a.usage, { input_tokens: 5, output_tokens: 2 });
  assert.ok(a.id, "id present");
});

test("tool_calls -> tool_use blocks and stop_reason tool_use", () => {
  const a = toAnthropicMessage({
    id: "chatcmpl-2",
    model: "ornith-1.0-35b",
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_1", type: "function",
          function: { name: "get_weather", arguments: JSON.stringify({ city: "NYC" }) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
  }, "ornith-big");
  assert.equal(a.stop_reason, "tool_use");
  const tu = a.content.find((b) => b.type === "tool_use");
  assert.deepEqual(tu, { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "NYC" } });
});

test("finish_reason length -> max_tokens; model falls back to request id", () => {
  const a = toAnthropicMessage({
    choices: [{ index: 0, message: { role: "assistant", content: "..." }, finish_reason: "length" }],
  }, "ornith-big");
  assert.equal(a.stop_reason, "max_tokens");
  assert.equal(a.model, "ornith-big");
});

test("empty content -> a single empty text block (never empty content array)", () => {
  const a = toAnthropicMessage({
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
  }, "ornith-big");
  assert.equal(a.content.length, 1);
  assert.deepEqual(a.content[0], { type: "text", text: "" });
});
