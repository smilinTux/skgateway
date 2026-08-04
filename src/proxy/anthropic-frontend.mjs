/**
 * Anthropic Messages FRONTEND — accept /v1/messages (Anthropic wire format) and
 * translate to the gateway's internal OpenAI /v1/chat/completions shape, then
 * translate the buffered OpenAI result back to an Anthropic Messages response.
 *
 * This is the INVERSE of src/proxy/anthropic-adapter.mjs (which is the outbound
 * OpenAI->Anthropic UPSTREAM translator). Here the gateway is the SERVER of the
 * Anthropic API: a `claude` CLI pointed at ANTHROPIC_BASE_URL=http://<gw>:18780
 * POSTs /v1/messages, we route it through the existing OpenAI router to ANY
 * backend (local ornith, nvidia-free, openrouter-free, or the claude wrapper),
 * and hand back an Anthropic-shaped answer. The internal router keeps doing its
 * own OpenAI<->Anthropic-upstream translation, so this layer only bridges the
 * client-facing wire format.
 *
 * Streaming is handled by the caller via jsonToSSE() in stream.mjs (which
 * already serialises a complete Anthropic message object into the
 * message_start -> content_block_* -> message_delta -> message_stop event
 * sequence). We therefore route the internal call NON-streaming (buffer once,
 * matching the gateway's existing buffered-relay model) and let the caller
 * decide JSON vs SSE from the surfaced `stream` flag.
 */

/** Flatten an Anthropic system field (string or array of text blocks) to text. */
function flattenSystem(system) {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === "string" ? b : b?.text || ""))
      .filter((s) => s !== "")
      .join("\n");
  }
  return "";
}

/** Anthropic image source -> OpenAI image_url block (or null if unrecognised). */
function imageUrlFromSource(source) {
  if (!source || typeof source !== "object") return null;
  if (source.type === "base64" && source.media_type && source.data != null) {
    return { type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  }
  if (source.type === "url" && source.url) {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

/**
 * Translate an Anthropic Messages request body into an OpenAI chat request.
 *
 * @param {Buffer|string} anthropicBody - the raw request body.
 * @returns {{ body: Buffer, stream: boolean, model: string }|null}
 *   null when the body is not a translatable Anthropic Messages request
 *   (caller then passes it through untouched).
 */
export function fromAnthropicRequest(anthropicBody) {
  let req;
  try { req = JSON.parse(anthropicBody.toString("utf-8")); }
  catch { return null; }
  if (!req || !Array.isArray(req.messages)) return null;

  const messages = [];

  // Leading system message(s).
  const systemText = flattenSystem(req.system);
  if (systemText) messages.push({ role: "system", content: systemText });

  for (const m of req.messages) {
    const role = m.role === "assistant" ? "assistant" : "user";

    // Plain string content -> pass straight through.
    if (typeof m.content === "string") {
      messages.push({ role, content: m.content });
      continue;
    }
    if (!Array.isArray(m.content)) {
      messages.push({ role, content: String(m.content ?? "") });
      continue;
    }

    // Block content. tool_result blocks become their OWN OpenAI tool-role
    // messages; tool_use blocks (assistant) become tool_calls; text/image
    // blocks collapse into the message content.
    const toolCalls = [];
    const contentBlocks = [];

    for (const b of m.content) {
      if (!b || typeof b !== "object") {
        if (typeof b === "string" && b) contentBlocks.push({ type: "text", text: b });
        continue;
      }
      if (b.type === "text") {
        if (b.text) contentBlocks.push({ type: "text", text: b.text });
      } else if (b.type === "image") {
        const img = imageUrlFromSource(b.source);
        if (img) contentBlocks.push(img);
      } else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      } else if (b.type === "tool_result") {
        // Emit the accumulated non-tool content first (preserve ordering), then
        // the tool result as its own tool-role message.
        flushContent(messages, role, contentBlocks);
        contentBlocks.length = 0;
        const c = b.content;
        messages.push({
          role: "tool",
          tool_call_id: b.tool_use_id,
          content: typeof c === "string" ? c
            : Array.isArray(c) ? c.map((x) => (typeof x === "string" ? x : x?.text || "")).join("\n")
              : JSON.stringify(c ?? ""),
        });
      }
    }

    if (toolCalls.length) {
      const text = contentBlocks.filter((x) => x.type === "text").map((x) => x.text).join("\n");
      const msg = { role: "assistant", tool_calls: toolCalls };
      if (text) msg.content = text;
      messages.push(msg);
    } else {
      flushContent(messages, role, contentBlocks);
    }
  }

  const out = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens,
    // Internal routing is always non-streaming; the gateway buffers the whole
    // upstream response and the caller re-serialises to SSE if the client asked.
    stream: false,
  };
  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (typeof req.top_p === "number") out.top_p = req.top_p;
  if (Array.isArray(req.stop_sequences) && req.stop_sequences.length) out.stop = req.stop_sequences;

  // Tools: Anthropic input_schema -> OpenAI function parameters.
  if (Array.isArray(req.tools) && req.tools.length) {
    out.tools = req.tools
      .filter((t) => t && t.name)
      .map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } },
      }));
    const tc = req.tool_choice;
    if (tc && typeof tc === "object") {
      if (tc.type === "any") out.tool_choice = "required";
      else if (tc.type === "auto") out.tool_choice = "auto";
      else if (tc.type === "tool" && tc.name) out.tool_choice = { type: "function", function: { name: tc.name } };
    }
  }

  return {
    body: Buffer.from(JSON.stringify(out), "utf-8"),
    stream: req.stream === true,
    model: req.model,
  };
}

/** Push a user/assistant message for the accumulated text/image blocks, if any. */
function flushContent(messages, role, blocks) {
  if (!blocks.length) return;
  // All-text -> a plain string; mixed (has an image) -> keep the block array.
  if (blocks.every((b) => b.type === "text")) {
    const text = blocks.map((b) => b.text).join("\n");
    if (text) messages.push({ role, content: text });
  } else {
    messages.push({ role, content: blocks });
  }
}

/**
 * Build the body for GET /v1/models/:id (a single-model retrieve). Claude Code
 * preflights every selected model here to validate it before a completion; if
 * the gateway does not answer this (it 404s via the catch-all), Claude Code
 * rejects the model as "may not exist". We answer with a hybrid Anthropic
 * (type:"model") + OpenAI (object:"model") model object so both client families
 * accept it.
 *
 * @param {string} id - the model id from the path.
 * @param {object|null} entry - the matching /v1/models catalog entry, if any.
 * @returns {object} model-retrieve body.
 */
export function modelRetrieveObject(id, entry) {
  const e = entry || {};
  return {
    id,
    type: "model",
    object: "model",
    display_name: e.display_name || id,
    created: e.created ?? 0,
    created_at: e.created_at || "2025-01-01T00:00:00Z",
    owned_by: e.owned_by || e.provider || "skgateway",
    provider: e.provider || "skgateway",
  };
}

/** OpenAI finish_reason -> Anthropic stop_reason. */
const STOP_REASON = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  content_filter: "end_turn",
};

/**
 * Translate a buffered OpenAI chat.completion object into an Anthropic Messages
 * response object (type:"message"). Suitable for direct JSON return OR for
 * handing to jsonToSSE() to serialise as an Anthropic event stream.
 *
 * @param {object} openai - parsed OpenAI chat.completion body.
 * @param {string} fallbackModel - the model id the client requested (used when
 *   the upstream omits `model`).
 * @returns {object} Anthropic Messages response object.
 */
export function toAnthropicMessage(openai, fallbackModel) {
  const choice = openai?.choices?.[0] || {};
  const msg = choice.message || {};

  const content = [];
  if (typeof msg.content === "string" && msg.content) {
    content.push({ type: "text", text: msg.content });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { input = {}; }
      content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
    }
  }
  // Anthropic messages always carry >=1 content block.
  if (content.length === 0) content.push({ type: "text", text: "" });

  const hasTools = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
  const stopReason = hasTools ? "tool_use" : (STOP_REASON[choice.finish_reason] || "end_turn");

  const usage = openai?.usage || {};
  return {
    id: openai?.id || ("msg_" + (openai?.created || "")),
    type: "message",
    role: "assistant",
    model: openai?.model || fallbackModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}
