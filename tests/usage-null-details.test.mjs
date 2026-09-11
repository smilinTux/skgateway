/**
 * Explicit-null usage detail blocks (incident 2026-09-11, agent cron 502 storm).
 *
 * `hasValidUsage` gated its detail checks on `Object.hasOwn(usage, key)` and then
 * did `if (!details) return false`. An upstream that reports "no details" the
 * common OpenAI-compatible way -- the key PRESENT with an explicit `null`, which
 * is what the qwen3.8 server on chiap08 emits -- therefore failed usage
 * validation, which set `stream.invalidCompletion` and rewrote a perfectly good
 * 200 into `502 invalid_upstream_completion`.
 *
 * Why it only bit streaming callers: the non-stream path never runs this check,
 * so the SAME completion validated 200 as buffered JSON and 502 once re-emitted
 * as SSE. Hermes always streams, so every agentic cron job routed at qwen38
 * failed 5/5 retries while a hand-run curl of the identical body succeeded --
 * which is what made this look like a flaky backend for hours.
 *
 * `null` means "no details", exactly like omitting the key. It must validate the
 * same. A non-null but malformed details object must still be rejected.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceResponseContract } from "../src/proxy/response-contract.mjs";
import { openAIJsonToSSEBuffer } from "../src/proxy/stream.mjs";

const completion = (usage) => ({
  id: "chatcmpl-test", object: "chat.completion", created: 1789130429, model: "test-model",
  choices: [{
    index: 0, finish_reason: "tool_calls",
    message: {
      role: "assistant", content: "",
      tool_calls: [{
        id: "call-1", type: "function",
        function: { name: "terminal", arguments: '{"command": "ls"}' },
      }],
    },
  }],
  usage,
});

const statusOf = (usage) => {
  const res = enforceResponseContract(
    { status: 200, headers: { "content-type": "text/event-stream" }, body: openAIJsonToSSEBuffer(completion(usage)) },
    "sk-default",
  );
  if (res.status === 200) return "200";
  try { return JSON.parse(res.body.toString("utf8")).error.code; } catch { return `${res.status}`; }
};

const BASE = { prompt_tokens: 36009, completion_tokens: 60, total_tokens: 36069 };

test("explicit null detail blocks validate like omitted ones", () => {
  assert.equal(
    statusOf({ ...BASE, prompt_tokens_details: null, completion_tokens_details: null }), "200",
    "usage with null detail blocks (what chiap08's qwen3.8 sends) must be accepted",
  );
  assert.equal(statusOf({ ...BASE, prompt_tokens_details: null }), "200");
  assert.equal(statusOf({ ...BASE, completion_tokens_details: null }), "200");
});

test("omitted and well-formed detail blocks still pass", () => {
  assert.equal(statusOf({ ...BASE }), "200");
  assert.equal(
    statusOf({ ...BASE, prompt_tokens_details: { cached_tokens: 0 },
               completion_tokens_details: { reasoning_tokens: 0 } }), "200");
});

test("a malformed non-null detail block is still rejected", () => {
  // Wrong key, extra key, wrong type, and out-of-range must all stay invalid —
  // null-tolerance must not become "skip the check".
  assert.notEqual(statusOf({ ...BASE, prompt_tokens_details: { wrong_key: 1 } }), "200");
  assert.notEqual(statusOf({ ...BASE, prompt_tokens_details: { cached_tokens: 0, extra: 1 } }), "200");
  assert.notEqual(statusOf({ ...BASE, prompt_tokens_details: { cached_tokens: "0" } }), "200");
  assert.notEqual(statusOf({ ...BASE, prompt_tokens_details: { cached_tokens: 999999999 } }), "200");
  assert.notEqual(statusOf({ ...BASE, completion_tokens_details: { reasoning_tokens: -1 } }), "200");
});
