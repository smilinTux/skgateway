/**
 * difficulty.test.mjs — Unit tests for the sk-auto DIFFICULTY scorer.
 *
 * Run with:  node --test tests/difficulty.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyDifficulty } from "../src/classifiers/difficulty.mjs";
import {
  adjustWithEmpirical,
  promptClassFromResult,
  modelStats,
} from "../src/classifiers/empirical.mjs";

const userMsg = (text) => [{ role: "user", content: text }];

/** Write a ratings JSONL fixture and return its path (unique dir per call so
 *  the empirical mtime cache never serves a stale read across tests). */
function writeRatings(rows) {
  const dir = mkdtempSync(join(tmpdir(), "skratings-"));
  const path = join(dir, "ratings.jsonl");
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { path, dir };
}

const sent = (msg_id, model, prompt_class, score, ts = Date.now() / 1000) => ({
  ts,
  chat_id: "c",
  msg_id,
  model,
  prompt_class,
  prompt_hash: null,
  score,
});

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

// ---------------------------------------------------------------------------
// Empirical adjuster (coord c87faa13) — bounded nudge over the heuristic.
// ---------------------------------------------------------------------------

describe("promptClassFromResult — stable bucketing", () => {
  test("buckets by first meaningful signal", () => {
    assert.equal(promptClassFromResult({ signals: ["image"] }), "vision");
    assert.equal(promptClassFromResult({ signals: ["code-fence", "hard-verb"] }), "code");
    assert.equal(promptClassFromResult({ signals: ["reasoning-cue"] }), "reasoning");
    assert.equal(promptClassFromResult({ signals: ["agentic"] }), "agentic");
    assert.equal(promptClassFromResult({ signals: ["long(2100>2000)"] }), "long");
    assert.equal(promptClassFromResult({ signals: [] }), "general");
  });
});

describe("adjustWithEmpirical", () => {
  const resolveModel = (role) => (role === "sk-default" ? "ornith" : "opus");
  const base = (role) => ({ role, reason: "heuristic", signals: ["seed"] });

  test("no ratings file => baseline unchanged", () => {
    const r = adjustWithEmpirical(base("sk-default"), {
      promptClass: "general",
      ratingsPath: "/nonexistent/ratings.jsonl",
      resolveModel,
    });
    assert.equal(r.role, "sk-default");
    assert.deepEqual(r.signals, ["seed"]);
  });

  test("ESCALATE: sk-default model scores low for the class => sk-heavy", () => {
    const { path, dir } = writeRatings([
      sent("a", "ornith", "code", 1),
      sent("b", "ornith", "code", 2),
      sent("c", "ornith", "code", 1),
      sent("d", "ornith", "code", 2),
      sent("e", "ornith", "code", 2),
      sent("f", "ornith", "code", 1),
      sent("g", "ornith", "code", 2),
    ]);
    try {
      const r = adjustWithEmpirical(base("sk-default"), {
        promptClass: "code",
        ratingsPath: path,
        resolveModel,
      });
      assert.equal(r.role, "sk-heavy");
      assert.ok(r.signals.some((s) => s.startsWith("empirical:escalate(ornith")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("below minSamples => no escalation despite low mean", () => {
    const { path, dir } = writeRatings([
      sent("a", "ornith", "code", 1),
      sent("b", "ornith", "code", 1),
    ]);
    try {
      const r = adjustWithEmpirical(base("sk-default"), {
        promptClass: "code",
        ratingsPath: path,
        resolveModel,
      });
      assert.equal(r.role, "sk-default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DE-ESCALATE: heuristic sk-heavy but default model scores fine => sk-default", () => {
    const { path, dir } = writeRatings([
      sent("a", "ornith", "code", 4),
      sent("b", "ornith", "code", 5),
      sent("c", "ornith", "code", 4),
      sent("d", "ornith", "code", 4),
      sent("e", "ornith", "code", 5),
    ]);
    try {
      const r = adjustWithEmpirical(base("sk-heavy"), {
        promptClass: "code",
        ratingsPath: path,
        resolveModel,
      });
      assert.equal(r.role, "sk-default");
      assert.ok(r.signals.some((s) => s.startsWith("empirical:de-escalate(ornith")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mid-range mean => no change (bounded)", () => {
    const { path, dir } = writeRatings([
      sent("a", "ornith", "code", 3),
      sent("b", "ornith", "code", 3),
      sent("c", "ornith", "code", 3),
      sent("d", "ornith", "code", 3),
      sent("e", "ornith", "code", 3),
    ]);
    try {
      assert.equal(
        adjustWithEmpirical(base("sk-default"), { promptClass: "code", ratingsPath: path, resolveModel }).role,
        "sk-default",
      );
      assert.equal(
        adjustWithEmpirical(base("sk-heavy"), { promptClass: "code", ratingsPath: path, resolveModel }).role,
        "sk-heavy",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("vision role is never touched by empirical", () => {
    const { path, dir } = writeRatings([sent("a", "ornith", "vision", 1)]);
    try {
      const r = adjustWithEmpirical(base("sk-vision"), {
        promptClass: "vision",
        ratingsPath: path,
        resolveModel,
      });
      assert.equal(r.role, "sk-vision");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no resolveModel => cannot map, baseline unchanged", () => {
    const { path, dir } = writeRatings([
      sent("a", "ornith", "code", 1),
      sent("b", "ornith", "code", 1),
      sent("c", "ornith", "code", 1),
      sent("d", "ornith", "code", 1),
      sent("e", "ornith", "code", 1),
    ]);
    try {
      const r = adjustWithEmpirical(base("sk-default"), { promptClass: "code", ratingsPath: path });
      assert.equal(r.role, "sk-default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("modelStats aggregates by model + class, last N window", () => {
    const { path, dir } = writeRatings([
      sent("a", "ornith", "code", 1, 1),
      sent("c", "opus", "code", 5, 2),
      sent("d", "ornith", "reasoning", 5, 3),
      sent("b", "ornith", "code", 5, 4), // newest, so window:1 keeps this
    ]);
    try {
      const s = modelStats("ornith", "code", { path });
      assert.equal(s.n, 2);
      assert.equal(s.mean, 3);
      // window is applied over ALL recent rated rows, THEN filtered by model/class.
      const w = modelStats("ornith", "code", { path, window: 1 });
      assert.equal(w.n, 1);
      assert.equal(w.mean, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
