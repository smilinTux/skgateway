import { test } from "node:test";
import assert from "node:assert/strict";
import { openAIJsonToSSEBuffer } from "../src/proxy/stream.mjs";
import { enforceResponseContract } from "../src/proxy/response-contract.mjs";

// Qwen/vLLM emits explicit nulls when no token breakdown is available.
const completion = {
  id: "qwen-readiness", object: "chat.completion", created: 1,
  model: "qwen3.8-27b-huihui-abliterated-q4_k_m",
  choices: [{ index: 0, message: { role: "assistant", content: null,
    tool_calls: [{ id: "call_1", type: "function", function: {
      name: "verify", arguments: '{"token":"ready","sum":43}',
    } }],
  }, finish_reason: "tool_calls" }],
  usage: { prompt_tokens: 310, completion_tokens: 48, total_tokens: 358,
    prompt_tokens_details: null, completion_tokens_details: null },
};

function check(usage) {
  return enforceResponseContract({ status: 200,
    headers: { "content-type": "text/event-stream" },
    body: openAIJsonToSSEBuffer({ ...completion, usage }),
  }, completion.model);
}

test("buffered Qwen tool completion accepts absent nullable usage details", () => {
  const result = check(completion.usage);
  assert.equal(result.status, 200);
  const frames = result.body.toString().split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(frames.find((frame) => frame.usage).usage,
    { prompt_tokens: 310, completion_tokens: 48, total_tokens: 358 });
  assert.equal(completion.usage.prompt_tokens_details, null);
  assert.match(result.body.toString(), /"name":"verify"/);
  assert.match(result.body.toString(), /"finish_reason":"tool_calls"/);
});

test("nullable details do not permit invalid accounting or malformed detail values", () => {
  for (const patch of [
    { total_tokens: 999 },
    { prompt_tokens_details: false },
    { completion_tokens_details: [] },
    { prompt_tokens_details: { cached_tokens: 311 } },
    { completion_tokens_details: { reasoning_tokens: 49 } },
  ]) {
    assert.equal(check({ ...completion.usage, ...patch }).status, 502);
  }
});
