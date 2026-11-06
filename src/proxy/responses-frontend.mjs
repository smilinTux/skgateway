/**
 * OpenAI Responses FRONTEND: accept POST /v1/responses and translate it to the
 * gateway's internal /v1/chat/completions shape, then translate the buffered
 * chat result back to a Responses object or event stream.
 *
 * WHY THIS EXISTS. Codex CLI only speaks the Responses API (wire_api = "chat"
 * was removed upstream), while the gateway's buckets and most of its backends
 * speak chat completions. This is the same shape of bridge as
 * anthropic-frontend.mjs: routing, buckets, sanitizer, failover and audit all
 * run on the chat form, unchanged, and only the client-facing wire format is
 * different. It is the INVERSE of codex-adapter.mjs, which is the outbound chat
 * to Responses UPSTREAM translator.
 *
 * WIRE CONTRACT, read from the Codex source at rust-v0.166.0 rather than
 * assumed (codex-api/src/sse/responses.rs, protocol/src/models.rs,
 * tools/src/tool_spec.rs):
 *   - Events are dispatched on the JSON `type` field. It consumes
 *     response.created, response.output_item.added, response.output_text.delta,
 *     response.custom_tool_call_input.delta, response.output_item.done,
 *     response.completed and response.incomplete. function_call_arguments.* and
 *     content_part.* are accepted and ignored, and are emitted here for other
 *     Responses clients.
 *   - A tool runs when its response.output_item.done arrives, whatever the rest
 *     of the stream says, so a call cut short by the token cap must never be
 *     emitted (see toResponsesObject).
 *   - response.completed needs response.id. usage may be null; when present it
 *     needs input_tokens, output_tokens and total_tokens.
 *   - Tool specs are function (flat), custom (freeform), namespace (a group of
 *     function/custom tools), and the hosted web_search and tool_search.
 *
 * STREAMING IS BUFFERED, the same model as the Anthropic frontend: the internal
 * call is non-streaming, and the complete answer is re-serialised as the event
 * sequence. That is what lets a backend failure keep a real HTTP status (Codex
 * retries 429 and 5xx), and failover stay invisible, since no event has been
 * sent when the router changes backend.
 *
 * STATELESS. Nothing is stored, so store:true is ignored and any request that
 * depends on server-side state (previous_response_id, conversation, an
 * item_reference) is a 400 rather than a silently context-free answer.
 *
 * REASONING IS NOT REPLAYED. The sanitizer removes reasoning from every chat
 * answer before any frontend sees it, so no reasoning item is produced, and the
 * ones a client sends back are dropped. See bucket-affinity.mjs for how a
 * provider that wants its reasoning back is handled in a bucket.
 *
 * @module proxy/responses-frontend
 */

import { randomBytes } from "node:crypto";

/** Efforts forwarded as reasoning_effort; anything else is dropped. */
const KNOWN_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

/** Request fields that need state this gateway does not keep. */
const STATEFUL_FIELDS = ["previous_response_id", "conversation"];

class UnsupportedRequest extends Error {
  constructor(message, param) {
    super(message);
    this.param = param;
  }
}

/**
 * OpenAI-style error body.
 *
 * @param {string} message
 * @param {string} code
 * @param {{ type?: string, param?: string|null }} [opts]
 * @returns {{ error: object }}
 */
export function responsesError(message, code, { type = "invalid_request_error", param = null } = {}) {
  return { error: { message, type, param, code } };
}

/** Text of one message content part, or null when the part is not text. */
function partText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return null;
  if (part.type === "input_text" || part.type === "output_text" || part.type === "text") {
    return typeof part.text === "string" ? part.text : "";
  }
  if (part.type === "refusal") return typeof part.refusal === "string" ? part.refusal : "";
  return null;
}

/** input_image part to a chat image_url block. A file_id cannot be resolved here. */
function imagePart(part) {
  const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
  if (!url) throw new UnsupportedRequest("input_image needs an image_url; file_id is not supported", "input");
  const image_url = { url };
  if (part.detail) image_url.detail = part.detail;
  return { type: "image_url", image_url };
}

/**
 * Message content to chat content: a plain string when all text, a block array
 * when it carries an image. Content the backend would never see is a 400, so a
 * caller does not get an answer that silently ignored its file.
 */
function chatContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks = [];
  for (const part of content) {
    const text = partText(part);
    if (text !== null) {
      if (text) blocks.push({ type: "text", text });
    } else if (part?.type === "input_image") {
      blocks.push(imagePart(part));
    } else {
      throw new UnsupportedRequest(`Content part type ${JSON.stringify(part?.type)} is not supported`, "input");
    }
  }
  return blocks.every((b) => b.type === "text") ? blocks.map((b) => b.text).join("\n") : blocks;
}

/**
 * function_call_output `output` (a string, or content items) to the tool
 * message text, plus any images. Most chat backends only take a string in a
 * tool message, so images travel in a user message right after it.
 */
function toolOutput(output) {
  if (typeof output === "string") return { text: output, images: [] };
  if (!Array.isArray(output)) return { text: JSON.stringify(output ?? ""), images: [] };
  const texts = [];
  const images = [];
  for (const part of output) {
    const text = partText(part);
    if (text !== null) texts.push(text);
    else if (part?.type === "input_image") images.push(imagePart(part));
  }
  return { text: texts.join("\n"), images };
}

/** Chat name of a tool: a namespaced tool's name is prefixed by its namespace. */
function qualifiedName(namespace, name) {
  return namespace ? `${namespace}${name}` : name;
}

/** Freeform tool to a function tool taking its raw text as one string argument. */
function customToChat(tool, chatName) {
  const format = tool.format?.definition
    ? ` Format (${tool.format.syntax || "grammar"}):\n${tool.format.definition}`
    : "";
  return {
    type: "function",
    function: {
      name: chatName,
      description: tool.description || "",
      parameters: {
        type: "object",
        properties: { input: { type: "string", description: `The raw tool input.${format}` } },
        required: ["input"],
      },
    },
  };
}

function functionToChat(tool, chatName) {
  const fn = {
    name: chatName,
    description: tool.description || "",
    parameters: tool.parameters || { type: "object", properties: {} },
  };
  if (tool.strict === true) fn.strict = true;
  return { type: "function", function: fn };
}

/**
 * Responses tools to chat tools. Hosted tools (web_search, tool_search,
 * image_generation, local_shell) have no meaning on a chat backend and are left
 * out. Returns the chat-name map needed to translate calls back.
 */
function translateTools(tools) {
  const chatTools = [];
  /** @type {Record<string, { kind: "function"|"custom", name: string, namespace?: string }>} */
  const toolMap = {};
  const add = (tool, namespace) => {
    if (!tool?.name) return;
    const chatName = qualifiedName(namespace, tool.name);
    const kind = tool.type === "custom" ? "custom" : "function";
    chatTools.push(kind === "custom" ? customToChat(tool, chatName) : functionToChat(tool, chatName));
    toolMap[chatName] = { kind, name: tool.name, ...(namespace ? { namespace } : {}) };
  };
  for (const t of Array.isArray(tools) ? tools : []) {
    if (t?.type === "function" && t.function?.name) add({ type: "function", ...t.function });
    else if (t?.type === "function" || t?.type === "custom") add(t);
    else if (t?.type === "namespace") {
      for (const inner of Array.isArray(t.tools) ? t.tools : []) {
        if (inner?.type === "function" || inner?.type === "custom") add(inner, t.name);
      }
    }
  }
  return { chatTools, toolMap };
}

function translateToolChoice(choice, toolMap) {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (choice && typeof choice === "object" && (choice.type === "function" || choice.type === "custom")) {
    const name = choice.function?.name || choice.name;
    if (name && toolMap[name]) return { type: "function", function: { name } };
  }
  return undefined;
}

/** text.format to a chat response_format. Plain text needs no field at all. */
function translateTextFormat(format) {
  if (format?.type === "json_object") return { type: "json_object" };
  if (format?.type === "json_schema") {
    const json_schema = { name: format.name, schema: format.schema };
    if (typeof format.strict === "boolean") json_schema.strict = format.strict;
    return { type: "json_schema", json_schema };
  }
  return undefined;
}

/**
 * Responses `input` items to chat messages. One assistant turn is spread over
 * several items (message, function_call, function_call), so they gather in
 * `assistant` and are flushed when the next non-assistant item arrives. Chat
 * backends reject a tool message that does not directly follow the assistant
 * message holding its call, so this merge is what makes a parallel call valid.
 */
function translateInput(input) {
  const messages = [];
  let assistant = null;
  const flush = () => {
    // An assistant item with no text and no call is not a valid chat message.
    if (assistant && (assistant.content !== null || assistant.tool_calls)) messages.push(assistant);
    assistant = null;
  };
  const openAssistant = () => (assistant ??= { role: "assistant", content: null });
  const addToolCall = (id, name, args) => {
    openAssistant();
    (assistant.tool_calls ??= []).push({ id, type: "function", function: { name, arguments: args } });
  };

  const items = typeof input === "string" ? [{ type: "message", role: "user", content: input }] : input;
  for (const item of items) {
    if (typeof item === "string") {
      flush();
      messages.push({ role: "user", content: item });
      continue;
    }
    // An EasyInputMessage ({role, content}) may leave out the type.
    const type = item?.type ?? (item?.role ? "message" : undefined);
    if (type === "message") {
      const content = chatContent(item.content);
      if (item.role === "assistant") {
        if (assistant?.tool_calls) flush();
        openAssistant();
        if (typeof content === "string" && typeof assistant.content === "string") {
          assistant.content = content ? `${assistant.content}\n${content}` : assistant.content;
        } else if (content !== "") {
          assistant.content = content;
        }
      } else {
        flush();
        // Chat backends do not all know `developer`; it means system to them,
        // and normalizeSystemMessageOrder then folds it into the leading one.
        const role = item.role === "developer" || item.role === "system" ? "system" : "user";
        if (content !== "") messages.push({ role, content });
      }
    } else if (type === "function_call") {
      addToolCall(item.call_id, qualifiedName(item.namespace, item.name), normalizedArguments(item.arguments));
    } else if (type === "custom_tool_call") {
      addToolCall(item.call_id, qualifiedName(item.namespace, item.name), JSON.stringify({ input: item.input ?? "" }));
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      flush();
      const { text, images } = toolOutput(item.output);
      messages.push({ role: "tool", tool_call_id: item.call_id, content: text });
      if (images.length) messages.push({ role: "user", content: images });
    } else if (type === "item_reference") {
      throw new UnsupportedRequest("item_reference needs stored responses, and this gateway stores none", "input");
    }
    // Everything else (reasoning, and hosted tool items the gateway never
    // produces) carries nothing a chat backend can use.
  }
  flush();
  return messages;
}

/** Call arguments as a JSON string. An empty string is not valid tool input. */
function normalizedArguments(args) {
  if (typeof args === "string") return args || "{}";
  return JSON.stringify(args ?? {});
}

/**
 * Translate a Responses request body into a chat completions request.
 *
 * @param {Buffer|string} rawBody
 * @returns {{ body: Buffer, stream: boolean, model?: string, toolMap: object }
 *   | { status: number, error: object }} the translation, or the 400 to answer.
 */
export function fromResponsesRequest(rawBody) {
  let req;
  try { req = JSON.parse(rawBody.toString("utf-8")); }
  catch { return { status: 400, error: responsesError("Request body is not valid JSON", "invalid_json") }; }
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    return { status: 400, error: responsesError("Request body must be a JSON object", "invalid_request") };
  }
  for (const field of STATEFUL_FIELDS) {
    if (req[field]) {
      return {
        status: 400,
        error: responsesError(`${field} needs stored responses, and this gateway stores none. Send the full input.`, "unsupported_parameter", { param: field }),
      };
    }
  }
  if (req.background === true) {
    return { status: 400, error: responsesError("background responses are not supported", "unsupported_parameter", { param: "background" }) };
  }
  if (typeof req.input !== "string" && !Array.isArray(req.input)) {
    return { status: 400, error: responsesError("input must be a string or an array of items", "invalid_request", { param: "input" }) };
  }

  let messages;
  try {
    messages = translateInput(req.input);
  } catch (err) {
    if (!(err instanceof UnsupportedRequest)) throw err;
    return { status: 400, error: responsesError(err.message, "unsupported_content", { param: err.param }) };
  }
  if (typeof req.instructions === "string" && req.instructions) {
    messages.unshift({ role: "system", content: req.instructions });
  }

  // Internal routing is always non-streaming; see the module header.
  const out = { model: req.model, messages, stream: false };
  if (Number.isFinite(req.max_output_tokens)) out.max_tokens = req.max_output_tokens;
  if (typeof req.temperature === "number") out.temperature = req.temperature;
  if (typeof req.top_p === "number") out.top_p = req.top_p;

  const effort = req.reasoning?.effort;
  if (typeof effort === "string" && KNOWN_EFFORTS.has(effort)) out.reasoning_effort = effort;

  const responseFormat = translateTextFormat(req.text?.format);
  if (responseFormat) out.response_format = responseFormat;

  const { chatTools, toolMap } = translateTools(req.tools);
  if (chatTools.length) {
    out.tools = chatTools;
    const toolChoice = translateToolChoice(req.tool_choice, toolMap);
    if (toolChoice !== undefined) out.tool_choice = toolChoice;
    if (typeof req.parallel_tool_calls === "boolean") out.parallel_tool_calls = req.parallel_tool_calls;
  }

  return {
    body: Buffer.from(JSON.stringify(out), "utf-8"),
    stream: req.stream === true,
    model: req.model,
    toolMap,
  };
}

/** Chat usage to Responses usage; null when the backend reported none. */
function translateUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: {
      cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
    },
    output_tokens: output,
    output_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    },
    total_tokens: usage.total_tokens ?? input + output,
  };
}

/** Finish reasons that mean the answer was cut short. */
const INCOMPLETE_REASON = { length: "max_output_tokens", content_filter: "content_filter" };

/** One chat tool call to the output item Codex dispatches. */
function toolCallItem(tc, index, suffix, toolMap) {
  const chatName = tc.function?.name;
  const spec = toolMap[chatName];
  const call_id = tc.id || `call_${suffix}_${index}`;
  const namespace = spec?.namespace ? { namespace: spec.namespace } : {};
  const name = spec?.name ?? chatName;
  const args = normalizedArguments(tc.function?.arguments);
  if (spec?.kind === "custom") {
    let input = args;
    try {
      const parsed = JSON.parse(args);
      if (typeof parsed?.input === "string") input = parsed.input;
    } catch { /* not the JSON we asked for: hand over what the model wrote */ }
    return { id: `ctc_${suffix}_${index}`, type: "custom_tool_call", status: "completed", call_id, name, ...namespace, input };
  }
  return { id: `fc_${suffix}_${index}`, type: "function_call", status: "completed", call_id, name, ...namespace, arguments: args };
}

/**
 * Translate a buffered chat.completion into a Responses object.
 *
 * A truncated answer drops its tool calls: Codex runs a tool as soon as its
 * output_item.done arrives, before it sees response.incomplete, so a call cut by
 * the token cap would otherwise execute with whatever arguments survived.
 *
 * @param {object} chat - parsed chat.completion body (already sanitized).
 * @param {string|undefined} fallbackModel - the model the client requested.
 * @param {object} [toolMap] - from fromResponsesRequest.
 * @returns {object} Responses object.
 */
export function toResponsesObject(chat, fallbackModel, toolMap = {}) {
  const choice = chat?.choices?.[0] || {};
  const msg = choice.message || {};
  const suffix = randomBytes(12).toString("hex");
  const incompleteReason = INCOMPLETE_REASON[choice.finish_reason];
  const itemStatus = incompleteReason ? "incomplete" : "completed";

  const output = [];
  const text = typeof msg.content === "string"
    ? msg.content
    : Array.isArray(msg.content) ? msg.content.map((p) => p?.text || "").join("") : "";
  if (text) {
    output.push({
      id: `msg_${suffix}`,
      type: "message",
      status: itemStatus,
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  if (!incompleteReason && Array.isArray(msg.tool_calls)) {
    msg.tool_calls.forEach((tc, i) => output.push(toolCallItem(tc, i, suffix, toolMap)));
  }

  return {
    id: `resp_${suffix}`,
    object: "response",
    created_at: Number.isFinite(chat?.created) ? chat.created : Math.floor(Date.now() / 1000),
    status: incompleteReason ? "incomplete" : "completed",
    error: null,
    incomplete_details: incompleteReason ? { reason: incompleteReason } : null,
    model: chat?.model || fallbackModel,
    output,
    usage: translateUsage(chat?.usage),
  };
}

/** The in-progress form of an item, as carried by output_item.added. */
function addedItem(item) {
  const base = { ...item, status: "in_progress" };
  if (item.type === "message") return { ...base, content: [] };
  if (item.type === "function_call") return { ...base, arguments: "" };
  return { ...base, input: "" };
}

/**
 * The streaming event sequence for a complete Responses object. Text is one
 * delta: the answer is already complete, and cutting it into pieces could split
 * a surrogate pair, which is invalid JSON to Codex's parser.
 *
 * @param {object} response - from toResponsesObject.
 * @returns {Array<object>} events, each with `type` and `sequence_number`.
 */
export function responsesStreamEvents(response) {
  const events = [];
  const emit = (type, fields) => events.push({ type, sequence_number: events.length, ...fields });
  const inProgress = { ...response, status: "in_progress", incomplete_details: null, output: [], usage: null };

  emit("response.created", { response: inProgress });
  emit("response.in_progress", { response: inProgress });

  response.output.forEach((item, output_index) => {
    const at = { item_id: item.id, output_index };
    emit("response.output_item.added", { output_index, item: addedItem(item) });
    if (item.type === "message") {
      const part = item.content[0];
      const content_index = 0;
      emit("response.content_part.added", { ...at, content_index, part: { ...part, text: "" } });
      emit("response.output_text.delta", { ...at, content_index, delta: part.text });
      emit("response.output_text.done", { ...at, content_index, text: part.text });
      emit("response.content_part.done", { ...at, content_index, part });
    } else if (item.type === "function_call") {
      emit("response.function_call_arguments.delta", { ...at, delta: item.arguments });
      emit("response.function_call_arguments.done", { ...at, arguments: item.arguments });
    } else {
      emit("response.custom_tool_call_input.delta", { ...at, call_id: item.call_id, delta: item.input });
      emit("response.custom_tool_call_input.done", { ...at, call_id: item.call_id, input: item.input });
    }
    emit("response.output_item.done", { output_index, item });
  });

  emit(response.status === "incomplete" ? "response.incomplete" : "response.completed", { response });
  return events;
}

/**
 * Reshape a non-2xx gateway or upstream body into the OpenAI error form, keeping
 * the fields it already has. Upstreams are not uniform: the Codex backend sends
 * {"detail": ...}, and a proxy in the path can send plain text or HTML.
 *
 * @param {Buffer|string|null|undefined} rawBody
 * @param {number} status
 * @returns {{ error: object }}
 */
export function normalizeErrorBody(rawBody, status) {
  const text = rawBody == null ? "" : rawBody.toString("utf-8");
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  const type = status >= 500 ? "server_error" : "invalid_request_error";
  const err = parsed?.error;
  if (err && typeof err === "object") {
    return {
      error: {
        ...err,
        message: typeof err.message === "string" ? err.message : `Upstream error ${status}`,
        type: err.type ?? type,
        param: err.param ?? null,
        code: err.code ?? null,
      },
    };
  }
  const message = typeof err === "string" ? err
    : typeof parsed?.detail === "string" ? parsed.detail
      : typeof parsed?.message === "string" ? parsed.message
        : text.slice(0, 500) || `Upstream error ${status}`;
  return responsesError(message, typeof parsed?.code === "string" ? parsed.code : null, { type });
}
