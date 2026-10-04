import { test } from "node:test";
import assert from "node:assert/strict";
import { fetch, normalize, DEEPSEEK_MODELS_URL } from "../src/discovery/providers/deepseek.mjs";

test("deepseek normalize keeps canonical ids as paid cloud models (happy path)", () => {
  const cards = normalize({ data: [
    { id: "deepseek-chat" },
    { id: "deepseek-reasoner", context_length: 128000, max_output_tokens: 8000 },
  ] }, { now: () => 1234 });
  assert.deepEqual(cards.map((x) => x.id), ["deepseek-chat", "deepseek-reasoner"]);
  assert.equal(cards[0].provider, "deepseek");
  assert.equal(cards[0].free, false);
  assert.equal(cards[0].card.source, "deepseek");
  assert.equal(cards[0].card.tier, "paid-cloud");
  assert.equal(cards[0].card.fetched_at, 1234);
  assert.equal(cards[1].card.context_length, 128000);
  assert.equal(cards[1].card.max_output_tokens, 8000);
});

test("deepseek normalize rejects malformed/absent ids and duplicates (edge case)", () => {
  const cards = normalize({ data: [
    { id: "" },
    { id: "  padded  " },
    { id: "has space" },
    { id: null },
    {},
    { id: "deepseek-chat" },
    { id: "deepseek-chat" }, // duplicate
  ] });
  assert.deepEqual(cards.map((x) => x.id), ["deepseek-chat"]);
});

test("deepseek normalize rejects a foreign owned_by and a malformed numeric limit (failure case)", () => {
  const cards = normalize({ data: [
    { id: "not-deepseek", owned_by: "openai" },
    { id: "ok-owned-by", owned_by: "DeepSeek" },
    { id: "bad-context", context_length: -1 },
    { id: "bad-output", max_output_tokens: "a lot" },
  ] });
  assert.deepEqual(cards.map((x) => x.id), ["ok-owned-by"]);
});

test("deepseek normalize tolerates a missing/malformed response body", () => {
  assert.deepEqual(normalize(null), []);
  assert.deepEqual(normalize({}), []);
  assert.deepEqual(normalize({ data: "not-an-array" }), []);
});

test("deepseek fetch sends the caller's bearer to the /v1/models endpoint (happy path)", async () => {
  const original = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, opts) => {
    seen = { url: String(url), opts };
    return { ok: true, json: async () => ({ data: [] }) };
  };
  try {
    await fetch({ authorization: "Bearer test-token" });
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(seen.url, DEEPSEEK_MODELS_URL);
  assert.equal(seen.opts.headers.authorization, "Bearer test-token");
});

test("deepseek fetch refuses to call out with no credentials (failure case)", async () => {
  await assert.rejects(() => fetch(undefined), /no-credentials/);
  await assert.rejects(() => fetch({}), /no-credentials/);
});

test("deepseek fetch surfaces a non-OK upstream status rather than swallowing it (failure case)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  try {
    await assert.rejects(() => fetch({ authorization: "Bearer x" }), /deepseek 503/);
  } finally {
    globalThis.fetch = original;
  }
});
