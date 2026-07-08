import { test } from "node:test";
import assert from "node:assert/strict";
import { toAnthropicRequest } from "../src/proxy/anthropic-adapter.mjs";

/** Helper: build an OpenAI request buffer and translate it. */
function tr(body) {
  const out = toAnthropicRequest(Buffer.from(JSON.stringify(body), "utf-8"));
  assert.ok(out, "expected a translatable request");
  return JSON.parse(out.body.toString("utf-8"));
}

test("plain string content is preserved as a string", () => {
  const a = tr({ model: "claude-opus-4-8", messages: [{ role: "user", content: "hello" }] });
  assert.equal(a.messages[0].content, "hello");
});

test("data-URI image_url block -> anthropic base64 image block", () => {
  const a = tr({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: [
      { type: "text", text: "ingest this" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAB" } },
    ] }],
  });
  const blocks = a.messages[0].content;
  assert.ok(Array.isArray(blocks), "multimodal content must stay an array of blocks");
  assert.deepEqual(blocks[0], { type: "text", text: "ingest this" });
  assert.deepEqual(blocks[1], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAB" },
  });
});

test("http(s) image_url -> anthropic url image source", () => {
  const a = tr({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "https://x.com/pic.jpg" } },
    ] }],
  });
  const blocks = a.messages[0].content;
  assert.ok(Array.isArray(blocks));
  assert.deepEqual(blocks[0], { type: "image", source: { type: "url", url: "https://x.com/pic.jpg" } });
});

test("image-only message yields non-empty content (no 400)", () => {
  const a = tr({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: [
      { type: "image_url", image_url: { url: "data:image/jpeg;base64,ZZZZ" } },
    ] }],
  });
  const c = a.messages[0].content;
  // Must not be an empty string and must carry the image
  assert.notEqual(c, "");
  assert.ok(Array.isArray(c) && c.some((b) => b.type === "image"));
});

test("genuinely empty user message is dropped (never emits empty content)", () => {
  const a = tr({
    model: "claude-opus-4-8",
    messages: [
      { role: "user", content: "" },
      { role: "user", content: "actual question" },
    ],
  });
  // No message may have empty/whitespace content
  for (const m of a.messages) {
    const c = m.content;
    if (typeof c === "string") assert.notEqual(c.trim(), "");
    else assert.ok(Array.isArray(c) && c.length > 0);
  }
  assert.ok(a.messages.some((m) => m.content === "actual question"));
});

test("already-anthropic image block passes through", () => {
  const a = tr({
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/webp", data: "QQQ" } },
    ] }],
  });
  const blocks = a.messages[0].content;
  assert.ok(Array.isArray(blocks));
  assert.deepEqual(blocks[0], { type: "image", source: { type: "base64", media_type: "image/webp", data: "QQQ" } });
});

test("system split + Claude Code prefix still first", () => {
  const a = tr({
    model: "claude-opus-4-8",
    messages: [
      { role: "system", content: "You are Lumina." },
      { role: "user", content: "hi" },
    ],
  });
  assert.equal(a.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.equal(a.system[1].text, "You are Lumina.");
});

test("at least one message always survives (all-empty degenerate case)", () => {
  const a = tr({ model: "claude-opus-4-8", messages: [{ role: "user", content: "" }] });
  assert.ok(a.messages.length >= 1, "must keep at least one message");
  const c = a.messages[0].content;
  if (typeof c === "string") assert.notEqual(c.trim(), "");
});
