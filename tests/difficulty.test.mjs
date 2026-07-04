/**
 * difficulty.test.mjs — Unit tests for the sk-auto DIFFICULTY scorer.
 *
 * Run with:  node --test tests/difficulty.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifyDifficulty } from "../src/classifiers/difficulty.mjs";

const userMsg = (text) => [{ role: "user", content: text }];

describe("classifyDifficulty — vision (highest precedence)", () => {
  test("image_url content part => sk-vision", () => {
    const msgs = [
      { role: "user", content: [
        { type: "text", text: "what is in this picture?" },
        { type: "image_url", image_url: { url: "https://x/y.png" } },
      ] },
    ];
    const r = classifyDifficulty(msgs);
    assert.equal(r.role, "sk-vision");
    assert.ok(r.signals.includes("image"));
  });

  test("bare {type:image} part => sk-vision", () => {
    const msgs = [{ role: "user", content: [{ type: "image", data: "..." }] }];
    assert.equal(classifyDifficulty(msgs).role, "sk-vision");
  });

  test("inline data:image string => sk-vision", () => {
    const msgs = userMsg("here: data:image/png;base64,AAAA");
    assert.equal(classifyDifficulty(msgs).role, "sk-vision");
  });

  test("image beats an otherwise-hard prompt", () => {
    const msgs = [{ role: "user", content: [
      { type: "text", text: "refactor this ```code``` and prove complexity" },
      { type: "image_url", image_url: { url: "data:image/png;base64,ZZ" } },
    ] }];
    assert.equal(classifyDifficulty(msgs).role, "sk-vision");
  });
});

describe("classifyDifficulty — hard => sk-heavy", () => {
  test("long user text (>2000 chars)", () => {
    const r = classifyDifficulty(userMsg("a".repeat(2100)));
    assert.equal(r.role, "sk-heavy");
    assert.ok(r.signals.some((s) => s.startsWith("long(")));
  });

  test("code fence + complex verb", () => {
    const r = classifyDifficulty(userMsg("Please refactor this:\n```js\nfn()\n```"));
    assert.equal(r.role, "sk-heavy");
    assert.ok(r.signals.includes("code-fence") && r.signals.includes("hard-verb"));
  });

  test("reasoning cue alone", () => {
    assert.equal(classifyDifficulty(userMsg("Walk me step by step through this")).role, "sk-heavy");
  });

  test("analyse cue", () => {
    assert.equal(classifyDifficulty(userMsg("Analyze the tradeoffs here")).role, "sk-heavy");
  });

  test("agentic: two numbered tasks", () => {
    const r = classifyDifficulty(userMsg("Do these:\n1. set up repo\n2. write tests"));
    assert.equal(r.role, "sk-heavy");
    assert.ok(r.signals.includes("agentic"));
  });

  test("agentic: then ... then chain", () => {
    assert.equal(classifyDifficulty(userMsg("first do X then do Y then finish")).role, "sk-heavy");
  });

  test("code fence WITHOUT a hard verb is NOT hard", () => {
    // fence alone should not trip sk-heavy (needs fence AND verb)
    const r = classifyDifficulty(userMsg("here is output:\n```\nhello\n```"));
    assert.equal(r.role, "sk-default");
  });
});

describe("classifyDifficulty — default", () => {
  test("simple greeting => sk-default", () => {
    const r = classifyDifficulty(userMsg("hi, what's 2+2?"));
    assert.equal(r.role, "sk-default");
    assert.equal(r.signals.length, 0);
  });

  test("empty / non-array input => sk-default (no crash)", () => {
    assert.equal(classifyDifficulty(undefined).role, "sk-default");
    assert.equal(classifyDifficulty([]).role, "sk-default");
  });

  test("system/assistant text is not counted for length", () => {
    const msgs = [
      { role: "system", content: "x".repeat(5000) },
      { role: "user", content: "hi" },
    ];
    assert.equal(classifyDifficulty(msgs).role, "sk-default");
  });
});

describe("classifyDifficulty — opts overrides", () => {
  test("lower max_easy_chars flips a short prompt to hard", () => {
    const r = classifyDifficulty(userMsg("a".repeat(50)), { max_easy_chars: 10 });
    assert.equal(r.role, "sk-heavy");
  });

  test("custom role names are honoured", () => {
    const r = classifyDifficulty(userMsg("hi"), { default_role: "sk-cheap" });
    assert.equal(r.role, "sk-cheap");
  });
});
