/**
 * codex discovery provider tests. The /models fixture mirrors the live
 * backend's response shape (measured 2026-08-22): slugs, context_window,
 * supported_reasoning_levels, visibility, supported_in_api, input_modalities.
 * No network: normalize() is pure.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize } from "../src/discovery/providers/codex.mjs";

const FIXTURE = {
  models: [
    {
      slug: "gpt-5.6-sol",
      context_window: 272000,
      visibility: "list",
      supported_in_api: true,
      supported_reasoning_levels: [
        { effort: "low" }, { effort: "medium" }, { effort: "high" },
        { effort: "xhigh" }, { effort: "max" }, { effort: "ultra" },
      ],
      input_modalities: ["text", "image"],
      description: "Latest frontier agentic coding model.",
    },
    {
      slug: "gpt-5.3-codex-spark",
      context_window: 128000,
      visibility: "list",
      supported_in_api: false, // CLI-only: /responses rejects it
      supported_reasoning_levels: [{ effort: "low" }],
      input_modalities: ["text"],
    },
    {
      slug: "codex-auto-review",
      context_window: 272000,
      visibility: "hide", // internal slug, never advertised
      supported_in_api: true,
      supported_reasoning_levels: [{ effort: "low" }],
      input_modalities: ["text", "image"],
    },
    {
      slug: "gpt-5.4-mini",
      context_window: 272000,
      visibility: "list",
      supported_in_api: true,
      supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
      input_modalities: ["text", "image"],
    },
  ],
};

test("normalize: keeps public API-capable slugs, excludes hidden and CLI-only ones", () => {
  const cards = normalize(FIXTURE, { now: () => 1234 });
  const ids = cards.map((c) => c.id);
  assert.deepEqual(ids.sort(), ["gpt-5.4-mini", "gpt-5.6-sol"]);
});

test("normalize: card carries provider-declared facts, never guesses", () => {
  const [sol] = normalize(FIXTURE, { now: () => 1234 });
  assert.equal(sol.provider, "codex");
  assert.equal(sol.free, false, "subscription inference is paid, no free tier exists");
  const card = sol.card;
  assert.equal(card.source, "codex");
  assert.equal(card.context_length, 272000);
  assert.equal(card.reasoning, true);
  assert.ok(card.supported_parameters.includes("tools"));
  assert.ok(card.supported_parameters.includes("reasoning"));
  assert.equal(card.modality, "text+image->text");
  assert.equal(card.tier, "paid-cloud");
  assert.equal(card.fetched_at, 1234);
  // never guessed: params/size/pricing stay null
  assert.equal(card.params_b, null);
  assert.equal(card.size_class, null);
  assert.equal(card.pricing, null);
});

test("normalize: text-only model derives a text modality, not an image claim", () => {
  // spark itself is excluded by the API-capability rule (see above); a copy
  // with supported_in_api true isolates just the modality derivation.
  const apiCapableSpark = { ...FIXTURE.models[1], supported_in_api: true };
  const [spark] = normalize({ models: [apiCapableSpark] });
  assert.equal(spark.card.modality, "text->text");
});

test("normalize: malformed payloads yield [] (fail-soft, never throw)", () => {
  assert.deepEqual(normalize({}), []);
  assert.deepEqual(normalize(null), []);
  assert.deepEqual(normalize({ models: "nope" }), []);
});
