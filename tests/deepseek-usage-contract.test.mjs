/**
 * deepseek-usage-contract.test.mjs — response-contract.mjs reconciliation for
 * chi's unmerged DeepSeek usage support (inventory item 7), rebased onto
 * main's already-merged explicit-null tolerance (6e684df/d094be9) instead of
 * copying chi's older response-contract.mjs/stream.mjs, which predate that
 * fix and would silently revert it.
 *
 * Covers the two behaviors actually added here:
 *   1. DeepSeek's prompt_cache_hit_tokens/prompt_cache_miss_tokens usage keys
 *      are accepted (happy path), while an unrelated unknown key is still
 *      rejected (failure case) — the allowlist grew, it did not open up.
 *   2. An explicit top-level `usage: null` on a non-final SSE chunk is
 *      treated as "no usage yet", not malformed evidence (edge case),
 *      extending the same null==absent tolerance the G1 fix already gives
 *      the nested prompt_tokens_details/completion_tokens_details blocks.
 *
 * The stream.mjs null-stripping chi also carries (stripping an explicit
 * `prompt_tokens_details: null`/`completion_tokens_details: null` before
 * re-emitting a flipped response as SSE) is proven unnecessary here and
 * deliberately NOT ported: tests/usage-null-details.test.mjs already round-
 * trips a completion with those keys explicitly null through
 * openAIJsonToSSEBuffer() -> enforceResponseContract() and asserts 200,
 * using stream.mjs completely unmodified, because response-contract.mjs's
 * hasValidUsage() already tolerates the null value on the receiving end.
 *
 * Run with: node --test tests/deepseek-usage-contract.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceResponseContract } from "../src/proxy/response-contract.mjs";

const MODEL = "deepseek-chat";

function sseResponse(frames) {
  return enforceResponseContract({
    status: 200,
    headers: { "content-type": "text/event-stream", "content-length": "999" },
    body: Buffer.from([...frames, "data: [DONE]", ""].join("\n\n")),
  }, "sk-deepseek");
}

function contentFrame(finishReason, content = "hi") {
  return `data: ${JSON.stringify({
    model: MODEL, choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
  })}`;
}

function usageFrame(usage) {
  return `data: ${JSON.stringify({ model: MODEL, choices: [], usage })}`;
}

test("happy path: DeepSeek's cache hit/miss usage keys are accepted", () => {
  const result = sseResponse([
    contentFrame(null),
    contentFrame("stop"),
    usageFrame({
      prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20,
    }),
  ]);
  assert.equal(result.status, 200);
  assert.match(result.body.toString(), /"prompt_cache_hit_tokens":80/);
  assert.match(result.body.toString(), /"prompt_cache_miss_tokens":20/);
});

test("failure case: an unrelated unknown usage key is still rejected (the allowlist grew, not opened up)", () => {
  const result = sseResponse([
    contentFrame(null),
    contentFrame("stop"),
    usageFrame({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, made_up_field: 1 }),
  ]);
  assert.equal(result.status, 502);
  assert.equal(JSON.parse(result.body).error.code, "invalid_upstream_completion");
});

test("edge case: a non-final chunk's top-level usage: null does not poison an otherwise valid completion", () => {
  const result = sseResponse([
    contentFrame(null),
    usageFrame(null), // DeepSeek-style "no usage in this frame yet"
    contentFrame("stop"),
    usageFrame({ prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }),
  ]);
  assert.equal(result.status, 200);
});
