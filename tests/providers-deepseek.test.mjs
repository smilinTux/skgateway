import { test } from "node:test";
import assert from "node:assert/strict";
import { fetch, normalize, DEEPSEEK_MODELS_URL } from "../src/discovery/providers/deepseek.mjs";

test("deepseek normalize keeps string ids as paid cloud models and only retained fields", () => {
  const cards = normalize({ data: [
    { id: "deepseek-chat" },
    { id: "deepseek-reasoner", context_length: 65536, max_output_tokens: 8192, modality: "text->text", description: "Reasoning model" },
  ] }, { now: () => 1234 });
  assert.deepEqual(cards.map((x) => x.id), ["deepseek-chat", "deepseek-reasoner"]);
  assert.equal(cards[0].provider, "deepseek");
  assert.equal(cards[0].free, false);
  assert.equal(cards[0].card.context_length, null);
  assert.equal(cards[1].card.context_length, 65536);
  assert.equal(cards[1].card.max_output_tokens, 8192);
  assert.equal(cards[1].card.modality, "text->text");
  assert.equal(cards[1].card.description, "Reasoning model");
  assert.equal(cards[0].card.source, "deepseek");
  assert.equal(cards[0].card.tier, "paid-cloud");
  assert.equal(cards[0].card.fetched_at, 1234);
  assert.equal(cards[1].card.fetched_at, 1234);
  assert.equal(cards[0].card.modality, null);
  assert.equal(cards[0].card.pricing, null);
});

test("deepseek normalize drops non-string ids and malformed data to empty", () => {
  assert.deepEqual(normalize({ data: [{ id: 42 }, { id: null }, { no_id: true }] }), []);
  assert.deepEqual(normalize(null), []);
  assert.deepEqual(normalize({}), []);
  assert.deepEqual(normalize({ data: "not-an-array" }), []);
});

test("deepseek normalize rejects noncanonical and duplicate ids", () => {
  const cards = normalize({ data: [
    { id: "deepseek-chat", owned_by: "deepseek" },
    { id: "deepseek-chat", owned_by: "DeepSeek" },
    { id: " deepseek-reasoner" },
    { id: "deepseek reasoner" },
    { id: "" },
  ] });
  assert.deepEqual(cards.map((entry) => entry.id), ["deepseek-chat"]);
});

test("deepseek normalize rejects foreign owners and malformed numeric limits", () => {
  const cards = normalize({ data: [
    { id: "foreign", owned_by: "other" },
    { id: "owner-wrong-type", owned_by: 42 },
    { id: "string-limit", context_length: "65536" },
    { id: "negative-limit", max_output_tokens: -1 },
    { id: "infinite-limit", context_length: Number.POSITIVE_INFINITY },
    { id: "valid", owned_by: "DEEPSEEK", context_length: 0, max_output_tokens: 0 },
  ] });
  assert.deepEqual(cards.map((entry) => entry.id), ["valid"]);
});

test("deepseek fetch authenticates with the bearer to the v1 models catalog", async () => {
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

test("deepseek fetch rejects a missing key before calling fetch", async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    return { ok: true, json: async () => ({ data: [] }) };
  };
  try {
    await assert.rejects(fetch({}), /deepseek no-credentials/);
    await assert.rejects(fetch(), /deepseek no-credentials/);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(called, false);
});

test("deepseek fetch surfaces non-ok with provider and status", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403 });
  try {
    await assert.rejects(fetch({ authorization: "Bearer test-token" }), /deepseek 403/);
  } finally {
    globalThis.fetch = original;
  }
});
