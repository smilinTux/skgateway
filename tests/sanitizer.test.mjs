/**
 * sanitizer.test.mjs — Unit tests for tool-pairing repair and request trim.
 *
 * Anchors the fix for the 2026-05-16 ocp-coherence-watch hallucination:
 * kimi-k2.6 returned 5538 chars of CJK + emoji noise after the proxy's
 * aggressive trim left an orphan `tool` message without its parent
 * `assistant tool_calls`. `repairToolPairing` now scrubs that shape before
 * the request goes out.
 *
 * Run with:  node --test tests/sanitizer.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  repairToolPairing,
  recoverKimiToolCalls,
  sanitizeRequest,
  sanitizeResponse,
} from "../src/proxy/sanitizer.mjs";

describe("repairToolPairing", () => {
  test("returns input unchanged when no tool messages present", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const out = repairToolPairing(msgs);
    assert.deepEqual(out, msgs);
  });

  test("drops leading orphan tool message", () => {
    const msgs = [
      { role: "tool", tool_call_id: "call_1", content: "result A" },
      { role: "assistant", content: "summary" },
      { role: "user", content: "ok thanks" },
    ];
    const out = repairToolPairing(msgs);
    assert.equal(out.length, 2);
    assert.equal(out[0].role, "assistant");
  });

  test("drops multiple leading orphan tool messages", () => {
    const msgs = [
      { role: "tool", tool_call_id: "call_1", content: "A" },
      { role: "tool", tool_call_id: "call_2", content: "B" },
      { role: "toolResult", tool_call_id: "call_3", content: "C" },
      { role: "user", content: "next" },
    ];
    const out = repairToolPairing(msgs);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, "user");
  });

  test("preserves complete assistant(tool_calls) + tool block", () => {
    const msgs = [
      { role: "user", content: "search please" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "search", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "result" },
      { role: "assistant", content: "done" },
    ];
    const out = repairToolPairing(msgs);
    assert.deepEqual(out, msgs);
  });

  test("preserves parallel tool_calls when all replies present", () => {
    const msgs = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "call_2", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "A" },
      { role: "tool", tool_call_id: "call_2", content: "B" },
    ];
    const out = repairToolPairing(msgs);
    assert.deepEqual(out, msgs);
  });

  test("drops assistant(tool_calls) when a tool reply id is missing", () => {
    const msgs = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "a", arguments: "{}" } },
          { id: "call_2", type: "function", function: { name: "b", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "A" },
      // call_2 reply missing — drop the whole block.
    ];
    const out = repairToolPairing(msgs);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, "user");
  });

  test("drops trailing assistant(tool_calls) with NO replies (cut at boundary)", () => {
    const msgs = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_x", type: "function", function: { name: "f", arguments: "{}" } }],
      },
    ];
    const out = repairToolPairing(msgs);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, "user");
  });

  test("repeats repair across multiple tool_call blocks", () => {
    const msgs = [
      { role: "tool", tool_call_id: "orphan_1", content: "X" }, // dropped
      { role: "user", content: "u1" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "good_1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "good_1", content: "G1" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "partial_1", type: "function", function: { name: "f", arguments: "{}" } },
          { id: "partial_2", type: "function", function: { name: "g", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "partial_1", content: "P1" },
      // partial_2 missing — drop the assistant + partial_1 tool.
    ];
    const out = repairToolPairing(msgs);
    assert.equal(out.length, 3);
    assert.equal(out[0].role, "user");
    assert.equal(out[1].role, "assistant");
    assert.equal(out[1].tool_calls[0].id, "good_1");
    assert.equal(out[2].role, "tool");
    assert.equal(out[2].tool_call_id, "good_1");
  });

  test("handles empty and non-array input safely", () => {
    assert.deepEqual(repairToolPairing([]), []);
    assert.deepEqual(repairToolPairing(null), null);
    assert.deepEqual(repairToolPairing(undefined), undefined);
  });

  test("ignores assistant(tool_calls) with empty tool_calls array", () => {
    const msgs = [
      { role: "user", content: "x" },
      { role: "assistant", content: "y", tool_calls: [] },
    ];
    const out = repairToolPairing(msgs);
    assert.deepEqual(out, msgs);
  });
});

describe("sanitizeRequest tail repair integration", () => {
  // Build a long conversation that forces both middle-drop and tail repair.
  function bigMsg(role, content, extras = {}) {
    return { role, content: content.repeat(500), ...extras };
  }

  test("aggressive-trim path never leaves orphan tool at slice start", () => {
    // 20 messages, ~5KB each → ~100KB body → forces aggressive trim.
    const messages = [
      { role: "system", content: "you are a helpful assistant" },
      bigMsg("user", "u0 "),
    ];
    for (let i = 1; i <= 8; i++) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: `call_${i}`,
            type: "function",
            function: { name: "f", arguments: "{}" },
          },
        ],
      });
      messages.push(bigMsg("tool", `tool_result_${i} `, { tool_call_id: `call_${i}` }));
    }
    messages.push(bigMsg("user", "final user message "));

    const body = { model: "kimi", messages: [...messages] };
    sanitizeRequest(body, { label: "test", maxBodyBytes: 18_000, keepStart: 1, keepEnd: 6 });

    // No tool message may appear before its matching assistant in the result.
    const seenAssistantToolIds = new Set();
    for (const m of body.messages) {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) seenAssistantToolIds.add(tc.id);
      }
      if (m.role === "tool" || m.role === "toolResult") {
        assert.ok(
          seenAssistantToolIds.has(m.tool_call_id),
          `orphan tool ${m.tool_call_id} appears before its parent`,
        );
      }
    }
  });

  test("trims to budget without throwing on tool-heavy history", () => {
    const body = {
      model: "kimi",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "u" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "x".repeat(50_000) },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c2", type: "function", function: { name: "f", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c2", content: "y".repeat(50_000) },
        { role: "user", content: "more" },
      ],
    };
    sanitizeRequest(body, { label: "test", maxBodyBytes: 5_000 });
    const finalSize = Buffer.byteLength(JSON.stringify(body), "utf-8");
    // Last resort path still bounded, even if slightly over budget on system msg.
    assert.ok(finalSize < 50_000, `expected aggressive trim, got ${finalSize}`);
    // No orphan tools.
    const seen = new Set();
    for (const m of body.messages) {
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) seen.add(tc.id);
      }
      if (m.role === "tool") {
        assert.ok(seen.has(m.tool_call_id), `orphan ${m.tool_call_id}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// recoverKimiToolCalls
//
// Anchors the fix for the 2026-05-16 ocp-coherence-watch 15:50 markup leak.
// kimi-k2.6 returned a 737-char text response that contained a planning
// preamble followed by a leaked tool-call section. The previous sanitizer
// stripped the markup to 153 chars (just the preamble), losing the model's
// intent. recoverKimiToolCalls parses the markup into proper tool_calls so
// the gateway can dispatch the call instead of returning the broken response.
// ---------------------------------------------------------------------------

const FIX_REAL_OCP_LEAK =
  "I'll analyze the OCP/AMERICA250 coherence watch based on the provided framework. " +
  "Let me search for recent movement on the key structural recommendations.\n\n" +
  "<|tool_calls_section_begin|>" +
  "<|tool_call_begin|>functions.search_files:0" +
  '<|tool_call_argument_begin|>{"query":"OCP America250 House expansion","limit":10}' +
  "<|tool_call_end|>" +
  "<|tool_calls_section_end|>";

describe("recoverKimiToolCalls", () => {
  test("returns passthrough when no markup present", () => {
    const text = "Just a normal response with no markup.";
    const out = recoverKimiToolCalls(text);
    assert.equal(out.content, text);
    assert.deepEqual(out.toolCalls, []);
  });

  test("handles empty/null input", () => {
    assert.deepEqual(recoverKimiToolCalls(""), { content: "", toolCalls: [] });
    assert.deepEqual(recoverKimiToolCalls(null), { content: "", toolCalls: [] });
    assert.deepEqual(recoverKimiToolCalls(undefined), { content: "", toolCalls: [] });
  });

  test("recovers a single tool call with `functions.` prefix", () => {
    const text =
      "<|tool_calls_section_begin|>" +
      "<|tool_call_begin|>functions.get_weather:0" +
      '<|tool_call_argument_begin|>{"city":"Boston"}' +
      "<|tool_call_end|>" +
      "<|tool_calls_section_end|>";
    const { content, toolCalls } = recoverKimiToolCalls(text);
    assert.equal(content, "");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].id, "functions.get_weather:0");
    assert.equal(toolCalls[0].type, "function");
    assert.equal(toolCalls[0].function.name, "get_weather");
    assert.equal(toolCalls[0].function.arguments, '{"city":"Boston"}');
  });

  test("recovers a single tool call without `functions.` prefix", () => {
    const text =
      "<|tool_call_begin|>read_file:0" +
      '<|tool_call_argument_begin|>{"path":"/etc/hosts"}' +
      "<|tool_call_end|>";
    const { content, toolCalls } = recoverKimiToolCalls(text);
    assert.equal(content, "");
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].function.name, "read_file");
    assert.equal(toolCalls[0].id, "read_file:0");
  });

  test("recovers multiple tool calls in one section", () => {
    const text =
      "<|tool_calls_section_begin|>" +
      "<|tool_call_begin|>functions.read_file:0" +
      '<|tool_call_argument_begin|>{"path":"a"}' +
      "<|tool_call_end|>" +
      "<|tool_call_begin|>functions.search_files:1" +
      '<|tool_call_argument_begin|>{"query":"x"}' +
      "<|tool_call_end|>" +
      "<|tool_calls_section_end|>";
    const { content, toolCalls } = recoverKimiToolCalls(text);
    assert.equal(content, "");
    assert.equal(toolCalls.length, 2);
    assert.equal(toolCalls[0].function.name, "read_file");
    assert.equal(toolCalls[1].function.name, "search_files");
  });

  test("preserves leading text before the tool-calls section", () => {
    const { content, toolCalls } = recoverKimiToolCalls(FIX_REAL_OCP_LEAK);
    assert.ok(content.startsWith("I'll analyze"));
    assert.ok(content.endsWith("structural recommendations."));
    assert.ok(!content.includes("<|"));
    assert.equal(toolCalls.length, 1);
    assert.equal(toolCalls[0].function.name, "search_files");
    assert.equal(
      toolCalls[0].function.arguments,
      '{"query":"OCP America250 House expansion","limit":10}'
    );
  });

  test("returns empty toolCalls when markup is incomplete (no end token)", () => {
    const text =
      "<|tool_calls_section_begin|>" +
      "<|tool_call_begin|>functions.read_file:0" +
      '<|tool_call_argument_begin|>{"path":"a"}';
    const { toolCalls } = recoverKimiToolCalls(text);
    assert.equal(toolCalls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// sanitizeResponse — integration with recoverKimiToolCalls (Step 1a)
// ---------------------------------------------------------------------------

describe("sanitizeResponse + recovery integration", () => {
  test("recovers leaked tool_calls without rewriting finish_reason", () => {
    const body = {
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: FIX_REAL_OCP_LEAK },
        },
      ],
    };
    const out = sanitizeResponse(body, { label: "test" });
    const choice = out.choices[0];
    assert.equal(choice.finish_reason, "stop");
    assert.equal(choice.message.tool_calls.length, 1);
    assert.equal(choice.message.tool_calls[0].function.name, "search_files");
    assert.ok(choice.message.content.startsWith("I'll analyze"));
    // No leaked markup should survive
    assert.ok(!choice.message.content.includes("<|"));
  });

  test("does NOT overwrite existing tool_calls when message already has them", () => {
    const existing = [
      { id: "call_proper", type: "function", function: { name: "x", arguments: "{}" } },
    ];
    const body = {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: FIX_REAL_OCP_LEAK, // markup still in text, but tool_calls already populated
            tool_calls: existing,
          },
        },
      ],
    };
    const out = sanitizeResponse(body, { label: "test" });
    const choice = out.choices[0];
    // Should NOT have been replaced — existing tool_calls preserved as-is
    assert.equal(choice.message.tool_calls.length, 1);
    assert.equal(choice.message.tool_calls[0].id, "call_proper");
    // Markup still gets stripped from content
    assert.ok(!choice.message.content.includes("<|"));
  });

  test("when only markup (no leading text), recovers and content becomes empty", () => {
    const body = {
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content:
              "<|tool_call_begin|>functions.read_file:0" +
              '<|tool_call_argument_begin|>{"path":"a"}' +
              "<|tool_call_end|>",
          },
        },
      ],
    };
    const out = sanitizeResponse(body, { label: "test" });
    const choice = out.choices[0];
    assert.equal(choice.finish_reason, "stop");
    assert.equal(choice.message.tool_calls.length, 1);
    assert.equal(choice.message.content, "");
  });

  test("passes through clean text response unchanged (no recovery side-effects)", () => {
    const body = {
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "Normal text response, no tools." },
        },
      ],
    };
    const out = sanitizeResponse(body, { label: "test" });
    const choice = out.choices[0];
    assert.equal(choice.finish_reason, "stop");
    assert.equal(choice.message.tool_calls, undefined);
    assert.equal(choice.message.content, "Normal text response, no tools.");
  });

  test("leaves recovered malformed JSON args unchanged for strict validation", () => {
    // Arguments missing a closing brace stay byte-exact and invalid.
    const body = {
      choices: [
        {
          finish_reason: "stop",
          message: {
            role: "assistant",
            content:
              "<|tool_call_begin|>functions.write_file:0" +
              '<|tool_call_argument_begin|>{"path":"a","content":"x"' +
              "<|tool_call_end|>",
          },
        },
      ],
    };
    const out = sanitizeResponse(body, { label: "test" });
    const tc = out.choices[0].message.tool_calls[0];
    assert.equal(tc.function.arguments, '{"path":"a","content":"x"');
    assert.throws(() => JSON.parse(tc.function.arguments));
  });
});
