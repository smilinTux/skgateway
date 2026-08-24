import { sanitizeResponse } from "./sanitizer.mjs";

function stripReasoning(value) {
  if (!value || typeof value !== "object") return value;
  const out = Array.isArray(value) ? value.map(stripReasoning) : { ...value };
  if (!Array.isArray(out)) {
    delete out.reasoning_content;
    for (const [key, child] of Object.entries(out)) out[key] = stripReasoning(child);
  }
  return out;
}

function hasVisibleContent(output) {
  const content = output.content;
  return typeof content === "string"
    ? content.trim().length > 0
    : Array.isArray(content) && content.some((part) => typeof part?.text === "string" && part.text.trim().length > 0);
}

function collectChoiceEvidence(chunk, states, ids, stream) {
  for (const [choicePosition, choice] of (chunk?.choices || []).entries()) {
    const output = choice?.delta || choice?.message || {};
    const choiceIndex = Number.isSafeInteger(choice?.index) && choice.index >= 0
      ? choice.index
      : choicePosition;
    const state = states.get(choiceIndex) || {
      visibleContent: false,
      sawToolEvidence: false,
      validToolEvidence: true,
      calls: new Map(),
      terminalReasons: [],
      terminated: false,
    };
    const visibleContent = hasVisibleContent(output);
    const hasContentEvent = Object.hasOwn(output, "content");
    const hasToolEvent = Object.hasOwn(output, "tool_calls");
    const hasTerminalEvent = Object.hasOwn(choice, "finish_reason");
    if (stream.done || (state.terminated && (hasContentEvent || hasToolEvent || hasTerminalEvent))) {
      stream.invalidCompletion = true;
    }
    state.visibleContent ||= visibleContent;
    if (Object.hasOwn(choice, "finish_reason") && choice.finish_reason !== null) {
      state.terminalReasons.push(choice.finish_reason);
      state.terminated = true;
    }
    states.set(choiceIndex, state);

    if (!hasToolEvent) continue;
    state.sawToolEvidence = true;
    if (!Array.isArray(output.tool_calls) || output.tool_calls.length === 0) {
      state.validToolEvidence = false;
      continue;
    }
    for (const fragment of output.tool_calls) {
      if (!fragment || typeof fragment !== "object" || Array.isArray(fragment)
          || !Number.isSafeInteger(fragment.index) || fragment.index < 0) {
        state.validToolEvidence = false;
        continue;
      }
      const key = fragment.index;
      const identity = `${choiceIndex}:${key}`;
      const call = state.calls.get(key) || { id: null, type: null, name: null, arguments: "", sawArguments: false };

      if (Object.hasOwn(fragment, "id")) {
        if (typeof fragment.id !== "string" || !fragment.id.trim()
            || (call.id !== null && call.id !== fragment.id)
            || (ids.has(fragment.id) && ids.get(fragment.id) !== identity)) state.validToolEvidence = false;
        else {
          call.id = fragment.id;
          ids.set(fragment.id, identity);
        }
      }
      if (Object.hasOwn(fragment, "type")) {
        if (fragment.type !== "function" || (call.type !== null && call.type !== fragment.type)) state.validToolEvidence = false;
        else call.type = fragment.type;
      }
      if (Object.hasOwn(fragment, "function")) {
        if (!fragment.function || typeof fragment.function !== "object" || Array.isArray(fragment.function)) {
          state.validToolEvidence = false;
        } else {
          if (Object.hasOwn(fragment.function, "name")) {
            const name = fragment.function.name;
            if (typeof name !== "string" || !name.trim() || (call.name !== null && call.name !== name)) state.validToolEvidence = false;
            else call.name = name;
          }
          if (Object.hasOwn(fragment.function, "arguments")) {
            if (typeof fragment.function.arguments !== "string") state.validToolEvidence = false;
            else {
              call.arguments += fragment.function.arguments;
              call.sawArguments = true;
            }
          }
        }
      }
      state.calls.set(key, call);
    }
  }
}

function hasCompletedToolCalls(calls) {
  if (calls.size === 0) return false;
  return [...calls.values()].every((call) => {
    if (!call.id || call.type !== "function" || !call.name || !call.sawArguments) return false;
    try {
      JSON.parse(call.arguments);
      return true;
    } catch {
      return false;
    }
  });
}

function hasValidCompletion(state) {
  if (state.terminalReasons.length !== 1) return false;
  const reason = state.terminalReasons[0];
  if (state.sawToolEvidence) {
    return state.validToolEvidence && hasCompletedToolCalls(state.calls) && reason === "tool_calls";
  }
  return state.visibleContent && (reason === "stop" || reason === "length");
}

/** Preserve requested alias separately while exposing the upstream model exactly. */
export function enforceResponseContract(response, requestedModel) {
  if (!response?.body) return { ...response, requestedModel, servedModel: null };
  const contentType = String(response.headers?.["content-type"] || response.headers?.["Content-Type"] || "");
  let servedModel = null;
  let body = response.body;

  if (contentType.includes("text/event-stream") || body.toString("utf8").includes("data:")) {
    const choiceStates = new Map();
    const toolIds = new Map();
    const stream = { done: false, doneCount: 0, invalidCompletion: false };
    const lines = body.toString("utf8").split("\n").map((line) => {
      if (!line.startsWith("data:")) return line;
      const payload = line.slice(5).trim();
      if (!payload) return line;
      if (payload === "[DONE]") {
        stream.doneCount++;
        if (stream.done || [...choiceStates.values()].some((state) => !hasValidCompletion(state))) {
          stream.invalidCompletion = true;
        }
        stream.done = true;
        return line;
      }
      try {
        const parsed = JSON.parse(payload);
        if (!servedModel && typeof parsed.model === "string" && parsed.model) servedModel = parsed.model;
        const clean = stripReasoning(parsed);
        collectChoiceEvidence(clean, choiceStates, toolIds, stream);
        if (requestedModel) clean.requested_model = requestedModel;
        return `data: ${JSON.stringify(clean)}`;
      } catch {
        return line;
      }
    });
    body = Buffer.from(lines.join("\n"), "utf8");
    const states = [...choiceStates.values()];
    const invalidToolCalls = states.some((state) => {
      const toolCompletion = state.terminalReasons.includes("tool_calls");
      if (!state.sawToolEvidence && !toolCompletion) return false;
      return !state.validToolEvidence
        || !hasCompletedToolCalls(state.calls)
        || state.terminalReasons.length !== 1
        || state.terminalReasons[0] !== "tool_calls";
    });
    const emptyChoice = states.length === 0 || states.some((state) =>
      !state.visibleContent && !hasCompletedToolCalls(state.calls));
    const invalidCompletion = stream.invalidCompletion
      || stream.doneCount !== 1
      || states.some((state) => state.visibleContent && !state.sawToolEvidence && !hasValidCompletion(state));
    if (response.status >= 200 && response.status < 300 && (invalidToolCalls || invalidCompletion || emptyChoice)) {
      const headers = { ...response.headers, "content-type": "application/json", "cache-control": "no-store" };
      delete headers["content-length"];
      delete headers["Content-Length"];
      body = Buffer.from(JSON.stringify({
        error: {
          message: invalidToolCalls
            ? "Upstream returned invalid tool-call evidence"
            : emptyChoice
              ? "Upstream returned no visible content or tool calls"
              : "Upstream returned invalid completion evidence",
          code: invalidToolCalls
            ? "invalid_upstream_tool_calls"
            : emptyChoice
              ? "empty_upstream_response"
              : "invalid_upstream_completion",
          type: "upstream_error",
        },
        ...(requestedModel ? { requested_model: requestedModel } : {}),
        ...(servedModel ? { served_model: servedModel } : {}),
      }), "utf8");
      response = { ...response, status: 502, headers };
    }
  } else {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      if (typeof parsed.model === "string" && parsed.model) servedModel = parsed.model;
      const clean = stripReasoning(sanitizeResponse(parsed, { thinkMode: "strip", label: "response-contract" }));
      if (requestedModel) clean.requested_model = requestedModel;
      body = Buffer.from(JSON.stringify(clean), "utf8");
    } catch {
      // Non-JSON error bodies remain byte-identical.
    }
  }

  return {
    ...response,
    body,
    requestedModel,
    servedModel: servedModel || null,
  };
}
