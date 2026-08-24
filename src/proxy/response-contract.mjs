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

function hasVisibleContent(chunk) {
  return chunk?.choices?.some((choice) => {
    const output = choice?.delta || choice?.message || {};
    const content = output.content;
    return typeof content === "string"
      ? content.trim().length > 0
      : Array.isArray(content) && content.some((part) => typeof part?.text === "string" && part.text.trim().length > 0);
  }) === true;
}

function collectToolCallFragments(chunk, calls, ids) {
  let valid = true;
  for (const [choicePosition, choice] of (chunk?.choices || []).entries()) {
    const output = choice?.delta || choice?.message || {};
    if (!Object.hasOwn(output, "tool_calls")) continue;
    if (!Array.isArray(output.tool_calls) || output.tool_calls.length === 0) {
      valid = false;
      continue;
    }
    const choiceIndex = Number.isSafeInteger(choice?.index) && choice.index >= 0
      ? choice.index
      : choicePosition;
    for (const fragment of output.tool_calls) {
      if (!fragment || typeof fragment !== "object" || Array.isArray(fragment)
          || !Number.isSafeInteger(fragment.index) || fragment.index < 0) {
        valid = false;
        continue;
      }
      const key = `${choiceIndex}:${fragment.index}`;
      const call = calls.get(key) || { id: null, type: null, name: null, arguments: "", sawArguments: false };

      if (Object.hasOwn(fragment, "id")) {
        if (typeof fragment.id !== "string" || !fragment.id.trim()
            || (call.id !== null && call.id !== fragment.id)
            || (ids.has(fragment.id) && ids.get(fragment.id) !== key)) valid = false;
        else {
          call.id = fragment.id;
          ids.set(fragment.id, key);
        }
      }
      if (Object.hasOwn(fragment, "type")) {
        if (fragment.type !== "function" || (call.type !== null && call.type !== fragment.type)) valid = false;
        else call.type = fragment.type;
      }
      if (Object.hasOwn(fragment, "function")) {
        if (!fragment.function || typeof fragment.function !== "object" || Array.isArray(fragment.function)) {
          valid = false;
        } else {
          if (Object.hasOwn(fragment.function, "name")) {
            const name = fragment.function.name;
            if (typeof name !== "string" || !name.trim() || (call.name !== null && call.name !== name)) valid = false;
            else call.name = name;
          }
          if (Object.hasOwn(fragment.function, "arguments")) {
            if (typeof fragment.function.arguments !== "string") valid = false;
            else {
              call.arguments += fragment.function.arguments;
              call.sawArguments = true;
            }
          }
        }
      }
      calls.set(key, call);
    }
  }
  return valid;
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

/** Preserve requested alias separately while exposing the upstream model exactly. */
export function enforceResponseContract(response, requestedModel) {
  if (!response?.body) return { ...response, requestedModel, servedModel: null };
  const contentType = String(response.headers?.["content-type"] || response.headers?.["Content-Type"] || "");
  let servedModel = null;
  let body = response.body;

  if (contentType.includes("text/event-stream") || body.toString("utf8").includes("data:")) {
    let visibleContent = false;
    let validToolEvidence = true;
    const toolCalls = new Map();
    const toolIds = new Map();
    const lines = body.toString("utf8").split("\n").map((line) => {
      if (!line.startsWith("data:")) return line;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return line;
      try {
        const parsed = JSON.parse(payload);
        if (!servedModel && typeof parsed.model === "string" && parsed.model) servedModel = parsed.model;
        const clean = stripReasoning(parsed);
        visibleContent ||= hasVisibleContent(clean);
        validToolEvidence = collectToolCallFragments(clean, toolCalls, toolIds) && validToolEvidence;
        if (requestedModel) clean.requested_model = requestedModel;
        return `data: ${JSON.stringify(clean)}`;
      } catch {
        return line;
      }
    });
    body = Buffer.from(lines.join("\n"), "utf8");
    const completedToolCalls = hasCompletedToolCalls(toolCalls);
    const invalidToolCalls = !validToolEvidence || (toolCalls.size > 0 && !completedToolCalls);
    if (response.status >= 200 && response.status < 300 && (invalidToolCalls || (!visibleContent && !completedToolCalls))) {
      const headers = { ...response.headers, "content-type": "application/json", "cache-control": "no-store" };
      delete headers["content-length"];
      delete headers["Content-Length"];
      body = Buffer.from(JSON.stringify({
        error: {
          message: invalidToolCalls
            ? "Upstream returned invalid tool-call evidence"
            : "Upstream returned no visible content or tool calls",
          code: invalidToolCalls ? "invalid_upstream_tool_calls" : "empty_upstream_response",
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
