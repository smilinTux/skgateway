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

/** Is this backend one we must speak the Anthropic Messages API to? */
export function isAnthropicBackend(backend) {
  if (!backend) return false;
  const url = backend.url || "";
  return backend.auth_type === "oauth" || /api\.anthropic\.com/.test(url);
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

  // Split system messages out of the messages array.
  const systemBlocks = [];
  const messages = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((c) => (typeof c === "string" ? c : c.text || "")).join("\n")
          : String(m.content ?? "");
      systemBlocks.push({ type: "text", text });
      continue;
    }
    // Anthropic only allows user/assistant roles.
    const role = m.role === "assistant" ? "assistant" : "user";
    let content = m.content;
    if (typeof content !== "string") {
      content = Array.isArray(content)
        ? content.map((c) => (typeof c === "string" ? c : c.text || "")).join("\n")
        : String(content ?? "");
    }
    messages.push({ role, content });
  }

  // Claude Code system prompt MUST be first for OAuth tokens.
  const system = [{ type: "text", text: CLAUDE_CODE_SYSTEM }, ...systemBlocks];

  const out = {
    model: req.model,
    max_tokens: req.max_tokens || 1024,
    messages,
    system,
  };
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

  const stopMap = {
    end_turn: "stop",
    max_tokens: "length",
    stop_sequence: "stop",
    tool_use: "tool_calls",
  };

  const openai = {
    id: msg.id || ("chatcmpl-" + Date.now()),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: msg.model || model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: stopMap[msg.stop_reason] || "stop",
    }],
    usage: {
      prompt_tokens: msg.usage?.input_tokens ?? 0,
      completion_tokens: msg.usage?.output_tokens ?? 0,
      total_tokens: (msg.usage?.input_tokens ?? 0) + (msg.usage?.output_tokens ?? 0),
    },
  };

  const body = Buffer.from(JSON.stringify(openai), "utf-8");
  return {
    ...anthropicRes,
    headers: { ...anthropicRes.headers, "content-type": "application/json", "content-length": body.length },
    body,
  };
}
