import { test } from "node:test";
import assert from "node:assert/strict";
import { fetch, normalize, ZAI_MODELS_URL } from "../src/discovery/providers/zai.mjs";
import { isZaiBackend, readZaiAuthHeaders } from "../src/proxy/zai-adapter.mjs";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("z.ai normalize keeps current entitlement ids as paid cloud models", () => {
  const cards = normalize({ data: [
    { id: "glm-4.6" },
    { id: "glm-5.3", context_length: 1000000 },
  ] }, { now: () => 1234 });
  assert.deepEqual(cards.map((x) => x.id), ["glm-4.6", "glm-5.3"]);
  assert.equal(cards[0].provider, "zai");
  assert.equal(cards[0].free, false);
  assert.equal(cards[1].card.context_length, 1000000);
  assert.equal(cards[0].card.source, "zai");
});

test("z.ai fetch sends the read-only OAuth bearer to the v4 catalog", async () => {
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
  assert.equal(seen.url, ZAI_MODELS_URL);
  assert.equal(seen.opts.headers.authorization, "Bearer test-token");
});

test("z.ai OAuth credential reader accepts ZCode credentials shape and never writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "skgw-zai-auth-"));
  const oauthPath = join(dir, "credentials.json");
  const oauthOriginal = JSON.stringify({
    "oauth:zai:access_token": "access-token",
    "zcodejwttoken": "other-token",
  });
  writeFileSync(oauthPath, oauthOriginal, { mode: 0o600 });
  assert.deepEqual(readZaiAuthHeaders(oauthPath), { authorization: "Bearer access-token" });
  assert.equal(readFileSync(oauthPath, "utf8"), oauthOriginal);

  const configPath = join(dir, "config.json");
  const configOriginal = JSON.stringify({
    provider: { "builtin:zai-coding-plan": { options: { apiKey: "coding-plan-key" } } },
  });
  writeFileSync(configPath, configOriginal, { mode: 0o600 });
  assert.deepEqual(readZaiAuthHeaders(configPath), { authorization: "Bearer coding-plan-key" });
  assert.equal(readFileSync(configPath, "utf8"), configOriginal);
});

test("z.ai backend detection does not classify unrelated OpenAI endpoints", () => {
  assert.equal(isZaiBackend({ auth_type: "zai_oauth", url: "https://example.test/v1" }), true);
  assert.equal(isZaiBackend({ auth_type: "none", url: "https://api.z.ai/api/coding/paas/v4" }), true);
  assert.equal(isZaiBackend({ auth_type: "api_key", url: "https://api.openai.com/v1" }), false);
});
