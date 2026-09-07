/** Regression: tool-result continuity through the trim path.
 *
 * Fleet incident 2026-09-03: cards 364a5f47 and 54cb62db failed with OpenAI
 * 400 "No tool output found for function call" after the history trim left
 * an assistant tool_call (kept in the head slice) whose tool reply lived in
 * the dropped middle. And tool results were truncated to 1500 chars even
 * when the body was far under budget, silently and deterministically.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { trimHistoryToBudget } from "../src/proxy/sanitizer.mjs";
import { trimConversationHistory } from "../src/proxy/core.mjs";

function overBudgetFixture() {
  const msgs = [{ role: "system", content: "s" }];
  for (let i = 1; i <= 7; i++) {
    msgs.push({ role: "user", content: "u" + i });
    msgs.push({ role: "assistant", content: "a" + i });
  }
  msgs.splice(2, 0, { role: "assistant", content: null,
    tool_calls: [{ id: "call_X", type: "function", function: { name: "read_file", arguments: "{}" } }] });
  msgs.splice(3, 0, { role: "tool", tool_call_id: "call_X", content: "config contents here" });
  return { model: "m", messages: msgs };
}

const noOrphans = (msgs) => !msgs.some((m, i) =>
  m.tool_calls?.length && !msgs.slice(i + 1).some(n => n.tool_call_id === m.tool_calls[0].id));

test("head-slice tool_call whose reply dropped in the middle never orphans", () => {
  const out = trimHistoryToBudget(overBudgetFixture(),
    { maxBodyBytes: 500, keepStart: 2, keepEnd: 12, label: "t", log: () => {}, aggressiveNotice: "[t]" });
  assert.ok(noOrphans(out.messages), "assembled messages must contain no orphan tool_calls: " +
    JSON.stringify(out.messages.map(m => m.role)));
});

test("aggressive pass also produces no orphans", () => {
  const out = trimHistoryToBudget(overBudgetFixture(),
    { maxBodyBytes: 220, keepStart: 2, keepEnd: 12, label: "t", log: () => {}, aggressiveNotice: "[t]" });
  assert.ok(noOrphans(out.messages));
});

test("tool results are NOT truncated when the body is under budget", () => {
  const body = { model: "x", messages: [
    { role: "system", content: "s" },
    { role: "user", content: "q1" }, { role: "assistant", content: "a1" },
    { role: "user", content: "q2" }, { role: "assistant", content: "a2" },
    { role: "user", content: "q3" },
    { role: "tool", tool_call_id: "t1", content: "T".repeat(5000) },
  ] };
  trimConversationHistory(body, { maxBodyBytes: 10_000_000, maxSystemBytes: 100000,
    logger: { log: () => {} } });
  assert.equal(body.messages[6].content.length, 5000,
    "under-budget tool result must pass through untouched");
});

test("tool results ARE truncated when over budget, and it logs", () => {
  const body = { model: "x", messages: [
    { role: "system", content: "s" },
    { role: "user", content: "q1" }, { role: "assistant", content: "a1" },
    { role: "user", content: "q2" }, { role: "assistant", content: "a2" },
    { role: "user", content: "q3" },
    { role: "tool", tool_call_id: "t1", content: "T".repeat(5000) },
  ] };
  const logged = [];
  trimConversationHistory(body, { maxBodyBytes: 200, maxSystemBytes: 100000,
    logger: { log: (m) => logged.push(m) } });
  assert.ok(body.messages.some(m => m.role === "tool" && m.content.length <= 1515),
    "over-budget path still truncates");
  assert.ok(logged.some(l => l.includes("truncated")), "truncation is logged");
});
