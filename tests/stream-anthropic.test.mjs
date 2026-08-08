import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonToSSE } from "../src/proxy/stream.mjs";

// A minimal capturing SSEWriter stand-in: records every (event, parsed-data)
// pair jsonToSSE emits so we can assert the Anthropic event sequence without a
// real HTTP response.
function captureWriter() {
  const events = [];
  return {
    events,
    write(payload, eventType) {
      let data = payload;
      if (typeof payload === "string") {
        try { data = JSON.parse(payload); } catch { /* keep raw */ }
      }
      events.push({ event: eventType, data });
    },
    writeDone() { events.push({ event: "done", data: "[DONE]" }); },
  };
}

function blockStartFor(events, index) {
  return events.find(
    (e) => e.event === "content_block_start" && e.data?.index === index,
  );
}

// Regression: streaming a tool_use response must put the tool id + name on the
// content_block_start. The bug shipped a text-shaped block ({type, text:""}) for
// every block, so a tool_use arrived at Claude Code with no name -> "No such tool
// available: undefined". Non-streaming toAnthropicMessage was correct; only this
// streaming re-serialisation dropped id/name.
test("streaming tool_use: content_block_start carries id + name + empty input", () => {
  const w = captureWriter();
  jsonToSSE(w, {
    type: "message",
    role: "assistant",
    model: "ornith",
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "NYC" } },
    ],
    usage: { output_tokens: 5 },
  });

  const start = blockStartFor(w.events, 0);
  assert.ok(start, "expected a content_block_start for index 0");
  assert.equal(start.data.content_block.type, "tool_use");
  assert.equal(start.data.content_block.name, "get_weather");
  assert.equal(start.data.content_block.id, "tu_1");
  // Anthropic streams tool input as an empty object at start, filled by
  // input_json_delta; it must NOT carry a bogus `text` field.
  assert.deepEqual(start.data.content_block.input, {});
  assert.ok(!("text" in start.data.content_block),
    "tool_use content_block_start must not have a text field");

  // the input still streams as a single input_json_delta (unchanged behaviour)
  const delta = w.events.find((e) => e.event === "content_block_delta");
  assert.equal(delta.data.delta.type, "input_json_delta");
  assert.equal(delta.data.delta.partial_json, JSON.stringify({ city: "NYC" }));
});

// A text block must be unaffected by the fix: {type:"text", text:""} at start,
// then text_delta chunks.
test("streaming text block: content_block_start stays text-shaped", () => {
  const w = captureWriter();
  jsonToSSE(w, {
    type: "message",
    role: "assistant",
    model: "ornith",
    stop_reason: "end_turn",
    content: [{ type: "text", text: "hello world" }],
    usage: { output_tokens: 2 },
  });

  const start = blockStartFor(w.events, 0);
  assert.ok(start);
  assert.equal(start.data.content_block.type, "text");
  assert.equal(start.data.content_block.text, "");
  assert.ok(!("name" in start.data.content_block));

  const delta = w.events.find((e) => e.event === "content_block_delta");
  assert.equal(delta.data.delta.type, "text_delta");
  assert.equal(delta.data.delta.text, "hello world");
});
