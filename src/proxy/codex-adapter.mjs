/**
 * codex-adapter.mjs — translate OpenAI Chat Completions <-> the OpenAI Codex
 * Responses backend (https://chatgpt.com/backend-api/codex/responses).
 *
 * WHY THIS EXISTS. The gateway speaks the OpenAI /v1/chat/completions wire
 * format to clients, but an OpenAI *subscription* (ChatGPT Pro / ProLite, the
 * entitlement behind the Codex CLI) is NOT reachable through
 * https://api.openai.com/v1. That endpoint requires a Platform API key and
 * bills per token. The subscription quota is only served through the Codex
 * backend, which speaks the Responses API, requires SSE, and rejects several
 * standard chat-completions parameters. This adapter is the same shape of
 * bridge as anthropic-adapter.mjs (OpenAI client format in, provider-native
 * format out, buffered answer translated back), so every existing gateway
 * feature (buckets, @match ranking, sanitizer, failover, audit) composes with
 * a codex backend unchanged.
 *
 * MEASURED against the live backend 2026-08-22 (chatgpt.com, Codex CLI
 * 0.148.0 account auth, NOT assumed from docs):
 *
 *   POST /responses  requires stream:true ("Stream must be set to true").
 *   Unsupported parameters are hard 400s, not ignored:
 *     max_output_tokens ("Unsupported parameter: max_output_tokens")
 *     temperature, stop  (same shape)
 *   Accepted: reasoning.effort, tools (FLAT {type:'function', name, ...},
 *     NOT the chat-completions {type:'function', function:{...}} nesting),
 *     tool_choice ('auto' | 'required' | {type:'function', name}),
 *     parallel_tool_calls, service_tier, include, prompt_cache_key.
 *   Auth headers: authorization: Bearer <access_token> PLUS
 *     chatgpt-account-id: <account_id> (without it the bearer is rejected),
 *     plus the Codex client identity headers originator/version below.
 *   Tool calls round-trip: output item {type:'function_call', call_id, name,
 *     arguments}; the next turn replays it and the matching
 *     {type:'function_call_output', call_id, output} item. Verified with a
 *     real two-turn call.
 *   Text answers arrive as output items {type:'message', role:'assistant',
 *     content:[{type:'output_text', text}]}. The final usage block rides the
 *     response.completed SSE event, not the items.
 *   Errors are FastAPI-shaped {"detail": "..."} (for example a model slug the
 *     account cannot serve: "The 'gpt-nope' model is not supported when using
 *     Codex with a ChatGPT account."), which OpenAI SDK clients cannot parse,
 *     so fromCodexResponse() reshapes non-2xx bodies into {error:{message}}.
 *
 * TOKEN MODEL, READ-ONLY BY DESIGN. The credentials file
 * (~/.codex/auth.json, shape {auth_mode:'chatgpt', tokens:{access_token,
 * refresh_token, id_token, account_id}, last_refresh}) is OWNED by a Codex CLI
 * login on its host machine. The refresh token is single-use and ROTATES on
 * every refresh, so a second refresher (this gateway) would invalidate the
 * CLI's own next refresh and silently kill the login the gateway depends on.
 * The Claude OAuth path (_refreshOAuth in router.mjs) can write back because
 * the gateway is that token's only consumer. Here it is not: this adapter and
 * the codex auth header builder NEVER refresh and NEVER write the file. Fresh
 * tokens arrive by re-syncing the file from the login host (see the backend
 * block in config/skgateway.yaml.example); a stale token simply 401s, the
 * router counts the failure, and failover covers the gap.
 *
 * @module proxy/codex-adapter
 */

import { readFileSync } from "node:fs";

/**
 * Codex CLI version reported in the originator/version headers. The backend
 * gates /models on a client_version query param and the request identity
 * headers on a plausible CLI version, so this is functional, not cosmetic.
 * Bump together with the fleet's codex CLI.
 */
export const CODEX_CLI_VERSION = "0.148.0";

/** Codex client identity sent on every /responses call (measured from the CLI). */
export const CODEX_ORIGINATOR = "codex_cli_rs";

/** Base URL of the Codex Responses backend (no trailing slash). */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** Reasoning efforts the backend accepts (from its own /models declaration). */
const KNOWN_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

/**
 * Chat-completions parameters the Codex backend hard-rejects with 400
 * "Unsupported parameter: <name>" (each measured live, see module doc).
 * Dropped from the translated request and never forwarded.
 */
const DROPPED_PARAMS = [
  "max_tokens",
  "max_completion_tokens",
  "max_output_tokens",
  "temperature",
  "top_p",
  "stop",
  "stop_sequences",
  "presence_penalty",
  "frequency_penalty",
  "logit_bias",
  "logprobs",
  "top_logprobs",
  "n",
  "seed",
  "user",
  "response_format",
  "stream_options",
];

/** Is this backend one we must speak the Codex Responses API to? */
export function isCodexBackend(backend) {
  if (!backend) return false;
  if (backend.auth_type === "codex_oauth") return true;
  return /chatgpt\.com\/backend-api\/codex/.test(backend.url || "");
}

/**
 * Read a Codex CLI credentials file and return the auth headers the Codex
 * backend requires. Accepts both the CLI's on-disk shape
 * ({auth_mode, tokens:{access_token, account_id}}) and a flat
 * {access_token, account_id} file. Returns null when unreadable or when no
 * access token is present; NEVER throws and NEVER writes (see the module doc
 * for why refresh ownership stays with the Codex CLI).
 *
 * @param {string} path
 * @returns {{authorization: string, "chatgpt-account-id": string}|null}
 */
export function readCodexAuthHeaders(path) {
  if (!path) return null;
  try {
    const filePath = path.replace(/^~/, process.env.HOME || "");
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    const tokens = parsed && typeof parsed === "object" && parsed.tokens
      ? parsed.tokens
      : parsed;
    const accessToken = tokens.access_token || tokens.accessToken;
    const accountId = tokens.account_id || tokens.accountId;
    if (!accessToken) return null;
    const headers = { authorization: `Bearer ${accessToken}` };
    if (accountId) headers["chatgpt-account-id"] = accountId;
    return headers;
  } catch {
    return null;
  }
}

/**
 * Translate an OpenAI chat-completions request body into a Codex Responses
 * API request. Returns { path, headers, body, clientStream } for sendUpstream,
 * or null when the body is not a translatable JSON chat request (the caller
 * passes such bodies through untouched, matching the Anthropic adapter's
 * contract).
 *
 * `clientStream` reports whether the ORIGINAL client asked for stream:true.
 * The upstream call always streams (the backend rejects stream:false), so the
 * response side needs this flag to know whether to hand the client buffered
 * JSON or re-serialised SSE.
 *
 * @param {Buffer} openaiBody
 * @returns {{path: string, headers: Record<string,string>, body: Buffer, clientStream: boolean, dropped: string[]}|null}
 */
export function toCodexRequest(openaiBody) {
  let req;
  try { req = JSON.parse(openaiBody.toString("utf-8")); }
  catch { return null; }
  if (!req || !Array.isArray(req.messages)) return null;

  // System messages become the Responses `instructions` field.
  const systemTexts = [];
  const items = [];
  for (const m of req.messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system" || m.role === "developer") {
      const text = flattenContent(m.content);
      if (text) systemTexts.push(text);
      continue;
    }
    if (m.role === "tool") {
      // tool result -> function_call_output. OpenAI puts the call id on
      // tool_call_id; content may be a string or structured parts.
      const output = typeof m.content === "string"
        ? m.content
        : JSON.stringify(m.content ?? "");
      items.push({
        type: "function_call_output",
        call_id: m.tool_call_id || m.call_id || "",
        output,
      });
      continue;
    }
    if (m.role === "assistant") {
      const text = flattenContent(m.content);
      if (text) {
        items.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
        if (!tc || !tc.function) continue;
        items.push({
          type: "function_call",
          call_id: tc.id || "",
          name: tc.function.name || "",
          arguments: typeof tc.function.arguments === "string"
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments ?? {}),
        });
      }
      continue;
    }
    // user (and anything unknown defaults to user, mirroring the Anthropic
    // adapter): text stays input_text, image_url parts become input_image.
    items.push({ type: "message", role: "user", content: toUserContent(m.content) });
  }

  const out = {
    model: req.model,
    input: items,
    // The backend requires streaming; we buffer upstream SSE in sendUpstream
    // and re-serialise for the client only when the client asked for SSE.
    stream: true,
    store: false,
  };
  if (systemTexts.length) out.instructions = systemTexts.join("\n\n");

  if (Array.isArray(req.tools) && req.tools.length) {
    const tools = req.tools
      .filter((t) => t && t.type === "function" && t.function && t.function.name)
      .map((t) => ({
        type: "function",
        name: t.function.name,
        description: t.function.description || "",
        parameters: t.function.parameters || { type: "object", properties: {} },
      }));
    if (tools.length) out.tools = tools;
  }

  if (req.tool_choice !== undefined) {
    const tc = req.tool_choice;
    if (tc === "auto" || tc === "none" || tc === "required") out.tool_choice = tc;
    else if (tc && typeof tc === "object" && tc.type === "function") {
      const name = tc.function?.name || tc.name;
      if (name) out.tool_choice = { type: "function", name };
    }
  }

  // Reasoning effort: the chat-completions field is reasoning_effort; Codex
  // config also uses model_reasoning_effort. Only forward efforts the
  // backend's own /models list declares (an unknown effort is a 400).
  const effort = req.reasoning_effort || req.model_reasoning_effort;
  if (typeof effort === "string" && KNOWN_EFFORTS.has(effort)) {
    out.reasoning = { effort };
  }

  // Measured-safe passthroughs.
  if (typeof req.parallel_tool_calls === "boolean") out.parallel_tool_calls = req.parallel_tool_calls;
  if (typeof req.service_tier === "string") out.service_tier = req.service_tier;

  // Drop hard-rejected params (measured 400s, see DROPPED_PARAMS) rather than
  // letting one unsupported knob fail the whole request.
  const dropped = [];
  for (const k of DROPPED_PARAMS) {
    if (k in req) dropped.push(k);
  }

  return {
    path: "/responses",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      originator: CODEX_ORIGINATOR,
      version: CODEX_CLI_VERSION,
    },
    body: Buffer.from(JSON.stringify(out), "utf-8"),
    clientStream: req.stream === true,
    dropped,
  };
}

/** Flatten OpenAI message content (string | parts array) to plain text. */
function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : (c && typeof c.text === "string" ? c.text : "")))
      .filter((s) => s !== "")
      .join("\n");
  }
  return String(content ?? "");
}

/** Translate OpenAI user content into Responses input content parts. */
function toUserContent(content) {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  if (Array.isArray(content)) {
    const parts = [];
    for (const c of content) {
      if (typeof c === "string") { if (c) parts.push({ type: "input_text", text: c }); continue; }
      if (!c || typeof c !== "object") continue;
      if (c.type === "text" && c.text) parts.push({ type: "input_text", text: c.text });
      else if (c.type === "image_url") {
        const url = typeof c.image_url === "string" ? c.image_url : c.image_url?.url;
        if (url) parts.push({ type: "input_image", image_url: url });
      }
    }
    if (parts.length) return parts;
  }
  return [{ type: "input_text", text: String(content ?? "") }];
}

/**
 * Parse a buffered Codex SSE stream into the complete final response object
 * and its assembled output items. Pure: text in, {response, items} out.
 * Returns null when the body is not parseable as Codex SSE.
 *
 * Items are taken from response.output_item.done events (verified to carry
 * complete message and function_call items) rather than the
 * response.completed payload's own output array, which was observed empty for
 * text answers on the live backend.
 *
 * @param {Buffer|string} body
 * @returns {{response: object, items: Array<object>}|null}
 */
export function parseCodexSSE(body) {
  const text = Buffer.isBuffer(body) ? body.toString("utf-8") : String(body || "");
  if (!text.includes("data:")) return null;
  const items = [];
  let response = null;
  let failed = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let evt;
    try { evt = JSON.parse(payload); } catch { continue; }
    if (evt.type === "response.output_item.done" && evt.item) items.push(evt.item);
    else if (evt.type === "response.completed" && evt.response) response = evt.response;
    else if (evt.type === "response.failed" || evt.type === "response.incomplete") {
      failed = evt.response || evt;
    }
  }
  if (!response && !failed && items.length === 0) return null;
  return { response: response || failed || {}, items, failed };
}

/**
 * Translate a buffered Codex /responses upstream answer (SSE text, or a
 * FastAPI error JSON on non-2xx) back into an OpenAI chat-completion
 * response the gateway can hand to any OpenAI client. Mirrors
 * toOpenAIResponse() in anthropic-adapter.mjs: non-2xx bodies are reshaped
 * (not invented) so SDK clients can parse them, 2xx bodies are translated.
 *
 * When clientStream is true the returned body is instead an OpenAI SSE byte
 * stream (role chunk, content chunks, tool_calls chunk, finish chunk with
 * usage, [DONE]), matching what stream.mjs emits for re-serialised JSON, so
 * clients that asked stream:true keep their wire contract.
 *
 * @param {{status:number, headers:object, body:Buffer}} raw buffered upstream result
 * @param {string} model model id to report when the upstream does not name one
 * @param {boolean} [clientStream=false] original client asked for stream:true
 * @returns {{status:number, headers:Record<string,string>, body:Buffer}}
 */
export function fromCodexResponse(raw, model, clientStream = false) {
  if (!raw) return raw;

  if (raw.status >= 300) {
    // {"detail": "..."} -> {"error": {"message": "..."}} (keep the status).
    let message = raw.body ? raw.body.toString("utf-8") : "";
    try {
      const parsed = JSON.parse(message);
      if (parsed && typeof parsed.detail === "string") message = parsed.detail;
    } catch { /* keep raw body text */ }
    const body = Buffer.from(JSON.stringify({
      error: { message, code: raw.status },
    }), "utf-8");
    return {
      ...raw,
      headers: { ...raw.headers, "content-type": "application/json", "content-length": body.length },
      body,
    };
  }

  const parsed = parseCodexSSE(raw.body);
  if (!parsed) return raw; // not SSE we understand: pass through untouched

  const { response, items } = parsed;
  let text = "";
  const toolCalls = [];
  for (const item of items) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part.type === "output_text" && typeof part.text === "string") text += part.text;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || "",
        type: "function",
        function: { name: item.name || "", arguments: item.arguments || "{}" },
      });
    }
  }

  const u = response.usage || {};
  const usage = {
    prompt_tokens: u.input_tokens ?? 0,
    completion_tokens: u.output_tokens ?? 0,
    total_tokens: u.total_tokens ?? ((u.input_tokens ?? 0) + (u.output_tokens ?? 0)),
  };

  const finish = toolCalls.length
    ? "tool_calls"
    : (response.status === "incomplete" ? "length" : "stop");

  const message = { role: "assistant", content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;

  const completion = {
    id: response.id || ("chatcmpl-codex-" + Date.now()),
    object: "chat.completion",
    created: typeof response.created_at === "number" ? response.created_at : Math.floor(Date.now() / 1000),
    model: response.model || model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage,
  };

  if (!clientStream) {
    const body = Buffer.from(JSON.stringify(completion), "utf-8");
    return {
      ...raw,
      headers: {
        ...raw.headers,
        "content-type": "application/json",
        "content-length": body.length,
      },
      body,
    };
  }

  // Client asked for SSE: serialise the buffered completion as OpenAI chunks
  // (same chunking scheme stream.mjs uses for JSON->SSE re-emission).
  const chunks = [];
  const base = {
    id: completion.id,
    object: "chat.completion.chunk",
    created: completion.created,
    model: completion.model,
  };
  chunks.push({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
  for (let i = 0; i < text.length; i += 100) {
    chunks.push({
      ...base,
      choices: [{ index: 0, delta: { content: text.slice(i, i + 100) }, finish_reason: null }],
    });
  }
  if (toolCalls.length) {
    chunks.push({ ...base, choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }] });
  }
  chunks.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
    usage,
  });

  const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const body = Buffer.from(sse, "utf-8");
  const headers = { ...raw.headers };
  delete headers["content-length"];
  headers["content-type"] = "text/event-stream; charset=utf-8";
  return { ...raw, headers, body };
}
