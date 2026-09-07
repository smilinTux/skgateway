/**
 * Anthropic adapter — translate OpenAI Chat Completions <-> Anthropic Messages.
 *
 * The gateway speaks the OpenAI /v1/chat/completions wire format to clients,
 * but Anthropic only exposes the Messages API (/v1/messages) with a different
 * request/response schema.  When a request is routed to an OAuth (Claude Code)
 * Anthropic backend, we translate in both directions here.
 *
 * OAuth (sk-ant-oat...) tokens additionally require:
 *   - header  anthropic-version: 2023-06-01
 *   - header  anthropic-beta: oauth-2025-04-20
 *   - the Claude Code system-prompt prefix as the FIRST system block, or the
 *     API rejects the call with a generic rate_limit_error.
 */

const CLAUDE_CODE_SYSTEM =
  "You are Claude Code, Anthropic's official CLI for Claude.";

// Per-model OUTPUT-token ceilings (max_tokens). Anthropic rejects requests above
// these with HTTP 400. Unknown models fall back to 128000 (never truncates a
// legitimate ≤128k request; the family's current maximum).
const MAX_OUTPUT_TOKENS = {
  "claude-opus-4-8": 128000,
  "claude-opus-4-7": 32000,
  "claude-sonnet-4-6": 64000,
  "claude-haiku-4-5": 32000,
};

/** Is this backend one we must speak the Anthropic Messages API to? */
export function isAnthropicBackend(backend) {
  if (!backend) return false;
  const url = backend.url || "";
  return backend.auth_type === "oauth" || /api\.anthropic\.com/.test(url);
}

/**
 * Does this MODEL ID belong to a paid Anthropic/Claude family, regardless of
 * which backend serves it?
 *
 * The gateway routes claude-* through a LOCAL wrapper backend (claude-code-api
 * :18782, auth_type "none", loopback url) so it bills as first-party
 * subscription usage. That backend is OpenAI-compatible, so isAnthropicBackend()
 * deliberately does NOT flag it (no Messages-API translation needed). But the
 * completions still cost real money (they draw down the Claude plan), so the
 * free flag on /v1/models must be decided by the MODEL, not only the backend
 * shape: otherwise the skchat model picker offers paid Claude models as "free"
 * (a cost footgun). Detect the family by id so it holds under any backend.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function isAnthropicModelId(id) {
  if (typeof id !== "string") return false;
  const s = id.toLowerCase();
  return s.startsWith("claude-") || s.startsWith("claude.") || s.includes("anthropic/");
}

/**
 * Translate an OpenAI chat-completions request body into an Anthropic Messages
 * request.  Returns { path, headers, body } to hand to sendUpstream, or null
 * if the body is not a translatable JSON chat request (passed through as-is).
 */
export function toAnthropicRequest(openaiBody, extraHeaders = {}) {
  let req;
  try { req = JSON.parse(openaiBody.toString("utf-8")); }
  catch { return null; }
  if (!req || !Array.isArray(req.messages)) return null;

  // Split system messages out; translate assistant tool_calls -> tool_use blocks
  // and OpenAI role:"tool" results -> Anthropic tool_result blocks (merged into a
  // user turn) so multi-turn tool loops work through the gateway.
  const systemBlocks = [];
  const messages = [];
  let pendingToolResults = null;
  const flushToolResults = () => {
    if (pendingToolResults && pendingToolResults.length) {
      messages.push({ role: "user", content: pendingToolResults });
      pendingToolResults = null;
    }
  };
  // System blocks are text-only — collapse to a plain string.
  const flatten = (content) =>
    typeof content === "string" ? content
      : Array.isArray(content)
        ? content.map((c) => (typeof c === "string" ? c : c.text || "")).join("\n")
        : String(content ?? "");

  // OpenAI image_url -> Anthropic image source. Supports data: URIs (base64)
  // and http(s) URLs. Returns null for anything unrecognised.
  const imageBlockFromUrl = (url) => {
    if (typeof url !== "string") return null;
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
    if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
    return null;
  };

  // Translate OpenAI message content into Anthropic content. Plain text stays a
  // string; multimodal content becomes an array of text/image blocks so images
  // (e.g. forwarded X-post/YouTube thumbnails) reach vision-capable models
  // instead of being flattened to an empty string (which Anthropic 400s on with
  // "user messages must have non-empty content").
  const translateContent = (content) => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return String(content ?? "");
    const blocks = [];
    for (const c of content) {
      if (typeof c === "string") { if (c) blocks.push({ type: "text", text: c }); continue; }
      if (!c || typeof c !== "object") continue;
      if (c.type === "text" && c.text) blocks.push({ type: "text", text: c.text });
      else if (c.type === "image_url") {
        const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
        const b = imageBlockFromUrl(url);
        if (b) blocks.push(b);
      } else if (c.type === "image" && c.source) blocks.push(c); // already Anthropic
      else if (c.text) blocks.push({ type: "text", text: c.text });
    }
    if (blocks.length === 0) return "";
    if (blocks.every((b) => b.type === "text")) return blocks.map((b) => b.text).join("\n");
    return blocks;
  };

  // True when translated content is empty (would trigger an Anthropic 400).
  const isEmptyContent = (c) =>
    (typeof c === "string" && c.trim() === "") ||
    (Array.isArray(c) && c.length === 0);

  for (const m of req.messages) {
    if (m.role === "system") {
      systemBlocks.push({ type: "text", text: flatten(m.content) });
      continue;
    }
    if (m.role === "tool") {
      // tool result — accumulate into the next user turn
      (pendingToolResults ||= []).push({
        type: "tool_result",
        tool_use_id: m.tool_call_id || m.tool_call_id,
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      });
      continue;
    }
    flushToolResults();
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const content = [];
      const txt = (typeof m.content === "string" ? m.content : "").trim();
      if (txt) content.push({ type: "text", text: txt });
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { input = {}; }
        content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = translateContent(m.content);
    // Drop empty messages — Anthropic rejects empty user/assistant content.
    if (isEmptyContent(content)) continue;
    messages.push({ role, content });
  }
  flushToolResults();

  // Never send an empty messages array (Anthropic requires ≥1 message).
  if (messages.length === 0) messages.push({ role: "user", content: "(no content)" });

  // Claude Code system prompt MUST be first for OAuth tokens.
  const system = [{ type: "text", text: CLAUDE_CODE_SYSTEM }, ...systemBlocks];

  // Anthropic 400s when max_tokens exceeds a model's OUTPUT ceiling. Clients that
  // configure a large *context* window (e.g. "500K tokens") often send that as
  // max_tokens by mistake → every request fails. Clamp to the model's output cap.
  const cap = MAX_OUTPUT_TOKENS[req.model] ?? 128000;
  const out = {
    model: req.model,
    max_tokens: Math.min(req.max_tokens || 1024, cap),
    messages,
    system,
  };

  // Translate OpenAI function tools -> Anthropic tools (input_schema).
  if (Array.isArray(req.tools) && req.tools.length) {
    out.tools = req.tools
      .filter((t) => t && t.type === "function" && t.function && t.function.name)
      .map((t) => ({
        name: t.function.name,
        description: t.function.description || "",
        input_schema: t.function.parameters || { type: "object", properties: {} },
      }));
    if (req.tool_choice === "required" || req.tool_choice === "any")
      out.tool_choice = { type: "any" };
    else if (req.tool_choice === "auto")
      out.tool_choice = { type: "auto" };
    else if (req.tool_choice && req.tool_choice.function)
      out.tool_choice = { type: "tool", name: req.tool_choice.function.name };
  }
  // Anthropic's newest models (e.g. claude-opus-4-8) deprecate `temperature`
  // and `top_p` and reject them with HTTP 400. Omit unsupported sampling
  // params and let Anthropic use its defaults.
  if (Array.isArray(req.stop)) out.stop_sequences = req.stop;
  else if (typeof req.stop === "string") out.stop_sequences = [req.stop];
  // Streaming not translated here — force non-stream and let caller buffer.

  const headers = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "oauth-2025-04-20",
    ...extraHeaders,
  };

  return {
    path: "/v1/messages",
    headers,
    body: Buffer.from(JSON.stringify(out), "utf-8"),
  };
}

/**
 * Translate an Anthropic Messages response (buffered { status, headers, body })
 * back into an OpenAI chat-completion response.  Non-2xx bodies are passed
 * through unchanged so the client sees the real upstream error.
 */
export function toOpenAIResponse(anthropicRes, model) {
  if (!anthropicRes || anthropicRes.status >= 300) return anthropicRes;
  let msg;
  try { msg = JSON.parse(anthropicRes.body.toString("utf-8")); }
  catch { return anthropicRes; }
  if (!msg || msg.type === "error") return anthropicRes;

  const text = Array.isArray(msg.content)
    ? msg.content.filter((b) => b.type === "text").map((b) => b.text).join("")
    : "";

  // Extract tool_use blocks -> OpenAI tool_calls.
  const toolUse = Array.isArray(msg.content)
    ? msg.content.filter((b) => b.type === "tool_use") : [];
  const toolCalls = toolUse.map((b, i) => ({
    id: b.id || ("call_" + i),
    type: "function",
    function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
  }));

  const stopMap = {
    end_turn: "stop",
    max_tokens: "length",
    stop_sequence: "stop",
    tool_use: "tool_calls",
  };

  const message = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const openai = {
    id: msg.id || ("chatcmpl-" + Date.now()),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: msg.model || model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length ? "tool_calls" : (stopMap[msg.stop_reason] || "stop"),
    }],
    usage: {
      prompt_tokens: msg.usage?.input_tokens ?? 0,
      completion_tokens: msg.usage?.output_tokens ?? 0,
      total_tokens: (msg.usage?.input_tokens ?? 0) + (msg.usage?.output_tokens ?? 0),
      // Preserve Anthropic's prompt-cache fields on the translated usage
      // object instead of dropping them. input_tokens/prompt_tokens above
      // counts ONLY the uncached portion of the prompt; without these,
      // anything reading the OpenAI-shaped usage (e.g. token-ratio.mjs)
      // sees a prompt_tokens that silently omits the cached majority of a
      // cache-hit request. Additive only: prompt_tokens/completion_tokens/
      // total_tokens keep their existing meaning for other consumers.
      // Only present when Anthropic reported them, matching collector.mjs's
      // existing lookup of these same field names off body.usage.
      ...(msg.usage?.cache_read_input_tokens != null
        ? { cache_read_input_tokens: msg.usage.cache_read_input_tokens } : {}),
      ...(msg.usage?.cache_creation_input_tokens != null
        ? { cache_creation_input_tokens: msg.usage.cache_creation_input_tokens } : {}),
    },
  };

  const body = Buffer.from(JSON.stringify(openai), "utf-8");
  return {
    ...anthropicRes,
    headers: { ...anthropicRes.headers, "content-type": "application/json", "content-length": body.length },
    body,
  };
}
