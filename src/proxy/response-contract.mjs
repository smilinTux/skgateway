import { sanitizeResponse } from "./sanitizer.mjs";

const MAX_USAGE_TOKENS = 1_000_000_000;
const MAX_SSE_JSON_DEPTH = 64;
const MAX_SSE_JSON_MEMBERS = 4_096;
const MAX_SSE_JSON_KEY_UNITS = 1_024;

function readJsonString(input, start) {
  let decoded = "";
  let decodedUnits = 0;
  const append = (value) => {
    decodedUnits += value.length;
    if (decodedUnits <= MAX_SSE_JSON_KEY_UNITS) decoded += value;
  };
  for (let index = start + 1; index < input.length;) {
    const character = input[index++];
    if (character === '"') return {
      decoded: decodedUnits <= MAX_SSE_JSON_KEY_UNITS ? decoded : null,
      end: index,
    };
    if (character === "\\") {
      if (index >= input.length) return null;
      const escape = input[index++];
      if ('"\\/bfnrt'.includes(escape)) {
        append(escape === "b" ? "\b"
          : escape === "f" ? "\f"
            : escape === "n" ? "\n"
              : escape === "r" ? "\r"
                : escape === "t" ? "\t"
                  : escape);
        continue;
      }
      if (escape !== "u" || index + 4 > input.length) return null;
      const hex = input.slice(index, index + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
      index += 4;
      const unit = Number.parseInt(hex, 16);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        if (input.slice(index, index + 2) !== "\\u") return null;
        const lowHex = input.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(lowHex)) return null;
        const low = Number.parseInt(lowHex, 16);
        if (low < 0xdc00 || low > 0xdfff) return null;
        append(String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + low - 0xdc00));
        index += 6;
      } else {
        if (unit >= 0xdc00 && unit <= 0xdfff) return null;
        append(String.fromCharCode(unit));
      }
      continue;
    }
    const unit = character.charCodeAt(0);
    if (unit <= 0x1f) return null;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index >= input.length) return null;
      const low = input.charCodeAt(index);
      if (low < 0xdc00 || low > 0xdfff) return null;
      append(character + input[index++]);
    } else {
      if (unit >= 0xdc00 && unit <= 0xdfff) return null;
      append(character);
    }
  }
  return null;
}

// This is only a bounded string and object-scope guard. JSON.parse remains the value parser.
function hasUniqueJsonMembers(input) {
  const stack = [];
  let memberCount = 0;
  for (let index = 0; index < input.length;) {
    const character = input[index];
    if (character === '"') {
      const string = readJsonString(input, index);
      if (!string) return false;
      let next = string.end;
      while (/\s/.test(input[next] || "")) next++;
      if (input[next] === ":") {
        const object = stack.at(-1);
        if (object?.type !== "object" || string.decoded === null
            || ++memberCount > MAX_SSE_JSON_MEMBERS
            || object.keys.has(string.decoded)) return false;
        object.keys.add(string.decoded);
      }
      index = string.end;
      continue;
    }
    if (character === "{" || character === "[") {
      if (stack.length >= MAX_SSE_JSON_DEPTH) return false;
      stack.push(character === "{" ? { type: "object", keys: new Set() } : { type: "array" });
    } else if (character === "}" || character === "]") {
      const expected = character === "}" ? "object" : "array";
      if (stack.pop()?.type !== expected) return false;
    } else if (character.charCodeAt(0) <= 0x1f && !"\t\n\r".includes(character)) {
      return false;
    }
    index++;
  }
  return stack.length === 0;
}

function stripReasoning(value) {
  if (!value || typeof value !== "object") return value;
  const out = Array.isArray(value) ? value.map(stripReasoning) : { ...value };
  if (!Array.isArray(out)) {
    delete out.reasoning_content;
    delete out._hadReasoning;
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
    const hasToolEvent = Object.hasOwn(output, "tool_calls");
    if (state.terminated) stream.invalidCompletion = true;
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

function hasValidUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  const keys = Object.keys(usage);
  if (!keys.includes("prompt_tokens") || !keys.includes("completion_tokens")
      || keys.some((key) => !["prompt_tokens", "completion_tokens", "total_tokens", "prompt_tokens_details"].includes(key))) return false;
  const values = [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens]
    .filter((value) => value !== undefined);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0 || value > MAX_USAGE_TOKENS)) return false;
  if (usage.prompt_tokens + usage.completion_tokens > MAX_USAGE_TOKENS) return false;
  if (Object.hasOwn(usage, "total_tokens")
      && usage.total_tokens !== usage.prompt_tokens + usage.completion_tokens) return false;
  if (Object.hasOwn(usage, "prompt_tokens_details")) {
    const details = usage.prompt_tokens_details;
    if (!details || typeof details !== "object" || Array.isArray(details)
        || Object.keys(details).length !== 1 || !Object.hasOwn(details, "cached_tokens")
        || !Number.isSafeInteger(details.cached_tokens) || details.cached_tokens < 0
        || details.cached_tokens > usage.prompt_tokens) return false;
  }
  return true;
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

function hasValidNonStreamToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false;
  const ids = new Set();
  return toolCalls.every((call) => {
    if (!call || typeof call !== "object" || Array.isArray(call)
        || typeof call.id !== "string" || !call.id.trim() || ids.has(call.id)
        || call.type !== "function"
        || !call.function || typeof call.function !== "object" || Array.isArray(call.function)
        || typeof call.function.name !== "string" || !call.function.name.trim()
        || typeof call.function.arguments !== "string") return false;
    ids.add(call.id);
    try {
      JSON.parse(call.function.arguments);
      return true;
    } catch {
      return false;
    }
  });
}

function rejectNonStream(response, requestedModel, servedModel, code) {
  const headers = { ...response.headers, "content-type": "application/json", "cache-control": "no-store" };
  delete headers["content-length"];
  delete headers["Content-Length"];
  return {
    ...response,
    status: 502,
    headers,
    body: Buffer.from(JSON.stringify({
      error: {
        message: code === "invalid_upstream_tool_calls"
          ? "Upstream returned invalid tool-call evidence"
          : code === "empty_upstream_response"
            ? "Upstream returned no visible content or tool calls"
            : "Upstream returned invalid completion evidence",
        code,
        type: "upstream_error",
      },
      ...(requestedModel ? { requested_model: requestedModel } : {}),
      ...(servedModel ? { served_model: servedModel } : {}),
    }), "utf8"),
  };
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
    const stream = { done: false, doneCount: 0, invalidCompletion: false, usageSeen: false };
    const lines = body.toString("utf8").split("\n").map((line) => {
      if (!line.startsWith("data:")) return line;
      const payload = line.slice(5).trim();
      if (stream.done) stream.invalidCompletion = true;
      if (!payload) return line;
      if (payload === "[DONE]") {
        stream.doneCount++;
        if (stream.done || [...choiceStates.values()].some((state) => !hasValidCompletion(state))) {
          stream.invalidCompletion = true;
        }
        stream.done = true;
        return line;
      }
      if (!hasUniqueJsonMembers(payload)) {
        stream.invalidCompletion = true;
        return line;
      }
      try {
        const parsed = JSON.parse(payload);
        if (!servedModel && typeof parsed.model === "string" && parsed.model) servedModel = parsed.model;
        if (Object.hasOwn(parsed, "usage")) {
          if (stream.usageSeen || !hasValidUsage(parsed.usage)
              || !Array.isArray(parsed.choices) || parsed.choices.length !== 0
              || choiceStates.size === 0
              || [...choiceStates.values()].some((state) => !hasValidCompletion(state))) stream.invalidCompletion = true;
          stream.usageSeen = true;
        }
        const clean = stripReasoning(parsed);
        collectChoiceEvidence(clean, choiceStates, toolIds, stream);
        if (requestedModel) clean.requested_model = requestedModel;
        return `data: ${JSON.stringify(clean)}`;
      } catch {
        stream.invalidCompletion = true;
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
      if (response.status >= 200 && response.status < 300 && Object.hasOwn(clean, "choices")) {
        const choices = Array.isArray(clean.choices) ? clean.choices : [];
        const malformedTools = choices.some((choice) => {
          const message = choice?.message;
          return message && Object.hasOwn(message, "tool_calls")
            && !hasValidNonStreamToolCalls(message.tool_calls);
        });
        const emptyChoice = choices.length === 0 || choices.some((choice) => {
          const message = choice?.message;
          return !message || (!hasVisibleContent(message) && !hasValidNonStreamToolCalls(message.tool_calls));
        });
        if (malformedTools || emptyChoice) {
          response = rejectNonStream(response, requestedModel, servedModel,
            malformedTools ? "invalid_upstream_tool_calls" : "empty_upstream_response");
          body = response.body;
        } else {
          if (requestedModel) clean.requested_model = requestedModel;
          body = Buffer.from(JSON.stringify(clean), "utf8");
        }
      } else {
        if (requestedModel) clean.requested_model = requestedModel;
        body = Buffer.from(JSON.stringify(clean), "utf8");
      }
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
