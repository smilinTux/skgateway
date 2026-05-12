/**
 * core.mjs — SKGateway unified proxy core
 *
 * Merges all functionality from nvidia-proxy.mjs and skgateway.mjs into a
 * single, modular, config-driven proxy core.  Neither file is auto-starting;
 * callers use `createProxyServer()` or `handleRequest()` directly.
 *
 * Architecture
 * ============
 *  - Tool reduction  → imported from tools.mjs (pluggable via config)
 *  - Sanitization    → imported from sanitizer.mjs (pluggable via config)
 *  - Upstream relay  → imported from upstream.mjs
 *  - SSE conversion  → sendOk() in this file (pure function, no I/O side-effects
 *                      beyond writing to the provided ServerResponse)
 *  - Retry/fallback  → proxyRequest() in this file, fully configurable
 *
 * The proxy implements the following retry strategy for /chat/completions
 * requests that carry tools:
 *
 *   Attempt 1  — proactively reduces to N tools (default 16: 5 guaranteed + 11 scored)
 *   Attempt 2  — 400 "single tool-calls": reduce to 8 tools, strip tool_call history
 *   Attempt 3  — 400 again: single tool with forced tool_choice
 *   Attempt 4  — 400 again: strip all tools, text-only response
 *
 * 429 rate-limit errors are handled with exponential backoff inside each
 * attempt; they do not consume an outer retry slot.
 *
 * Response fixups applied to every 200 from upstream (when tools are present):
 *  1. Content sanitization   — strips leaked Kimi K2.5 tool markup / thinking text
 *  2. Reasoning promotion    — moves `reasoning` field → `content` when content is empty
 *  3. Empty-content fallback — injects a fallback message so the client always gets text
 *  4. Ghost tool-call fix    — finish_reason="tool_calls" with no tool_calls → "stop"
 *  5. Hallucinated tool fix  — removes tool_calls whose names don't exist in allTools
 *  6. Multi-tool trim        — trims response to the first tool_call only
 *  7. Tool-round limit       — forces text-only after N consecutive tool rounds
 *
 * All requests with no tools, or non-chat-completion endpoints, are relayed
 * transparently without modification.
 *
 * Usage
 * =====
 *   import { createProxyServer } from "./core.mjs";
 *
 *   const server = createProxyServer({ port: 18780, targetUrl: "https://..." });
 *   server.listen(18780, "127.0.0.1");
 *
 * Or for embedding inside a larger HTTP server:
 *
 *   import { handleRequest, buildConfig } from "./core.mjs";
 *
 *   const cfg = buildConfig({ targetUrl: "https://..." });
 *   http.createServer((req, res) => handleRequest(req, res, cfg)).listen(18780);
 */

import http from "node:http";
import { URL } from "node:url";

import { sendUpstream } from "./upstream.mjs";
import { reduceTools, stripToolCallHistory } from "./tools.mjs";
import { sanitizeContent } from "./sanitizer.mjs";
import { shouldForceNonStream } from "../classifiers/classifier.mjs";

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

/**
 * Default configuration object.  All fields may be overridden by the
 * caller via `buildConfig()`.
 *
 * @type {ProxyConfig}
 */
export const DEFAULT_CONFIG = {
  /** Port the proxy HTTP server listens on (used by createProxyServer only). */
  port: parseInt(process.env.SKGATEWAY_PORT || process.env.NVIDIA_PROXY_PORT || "18780", 10),

  /** Bind address for the HTTP server (used by createProxyServer only). */
  bindHost: "127.0.0.1",

  /** Base URL of the upstream API (strip trailing /v1 if present). */
  targetUrl: process.env.SKGATEWAY_TARGET || process.env.NVIDIA_PROXY_TARGET || "https://integrate.api.nvidia.com/v1",

  /**
   * Maximum number of outer retry attempts per request.
   * Each attempt may consume several 429-retry slots internally.
   */
  maxRetries: 4,

  /** Maximum number of 429 retries per outer attempt. */
  max429Retries: 3,

  /** Base delay (ms) for 429 backoff.  Multiplied by (r429+1) each round. */
  rateLimitDelayMs: 2000,

  /**
   * Maximum byte length of the full request body before conversation
   * history trimming kicks in.
   */
  maxBodyBytes: 120000,

  /**
   * Maximum total byte length of all system messages before system
   * prompt trimming kicks in.
   */
  maxSystemBytes: 40000,

  /**
   * Tool count threshold for proactive reduction on the first attempt.
   * If the client sends more tools than this, the proxy reduces to this
   * count before the first upstream call.
   */
  proactiveToolLimit: 16,

  /**
   * Number of consecutive tool-call rounds (user→tool result→…) before
   * the proxy strips all tools and forces a text-only response.
   * nvidia-proxy.mjs used 20; skgateway.mjs used 10.
   * We default to the more conservative 20 (matches the more evolved file).
   */
  toolRoundLimit: 20,

  /**
   * Fallback text injected when the model returns an empty response with
   * no tool calls.  Override to customise per-deployment.
   */
  emptyResponseFallback:
    "I ran into a wall on that one — could you give me a bit more context or rephrase? I want to help but I'm not sure how to proceed.",

  /**
   * Minimum character length of `reasoning` content before it is
   * promoted to `content`.  nvidia-proxy.mjs used 300; skgateway.mjs used 150.
   * We default to 300 (the more conservative, less chatty threshold).
   */
  reasoningPromoteThreshold: 300,

  /**
   * Logger interface.  Replace with a structured logger if needed.
   * Must expose `log(msg)`, `warn(msg)`, `error(msg)`.
   */
  logger: {
    log: (msg) => console.log(`[skgateway] ${msg}`),
    warn: (msg) => console.warn(`[skgateway] ${msg}`),
    error: (msg) => console.error(`[skgateway] ${msg}`),
  },

  /**
   * Per-model body/system byte limits.  Keys are exact model IDs.
   * When a request matches, maxBodyBytes and maxSystemBytes are overridden
   * for that request only — global defaults apply to everything else.
   *
   * Example YAML:
   *   model_limits:
   *     moonshotai/kimi-k2.6: { max_body_bytes: 800000, max_system_bytes: 320000 }
   *
   * @type {Record<string, { maxBodyBytes?: number, maxSystemBytes?: number }>}
   */
  modelLimits: {},

  /**
   * Tag used in log lines.  Defaults to "skgateway".
   * Set to "nvidia-proxy" when running in legacy compatibility mode.
   */
  logTag: "skgateway",

  /**
   * Pluggable tool reducer.  Receives `(tools, messages, max)` and
   * returns the reduced array.  Defaults to reduceTools from tools.mjs.
   * @type {function(Array, Array, number): Array}
   */
  toolReducer: null, // resolved to reduceTools in buildConfig()

  /**
   * Pluggable content sanitizer.  Receives `(text)` and returns cleaned
   * text.  Defaults to sanitizeContent from sanitizer.mjs.
   * @type {function(string): string}
   */
  sanitizer: null, // resolved to sanitizeContent in buildConfig()

  /**
   * Streaming → non-streaming auto-flip policy.  Consumed by
   * shouldForceNonStream() to decide when a client's `stream:true` request
   * should be buffered upstream and re-emitted as SSE.  Overridable via
   * buildConfig({ streaming: {...} }) or the YAML config.
   */
  streaming: {
    default: true,
    force_header: "x-skgateway-nonstream",
    auto_nonstream: {
      enabled: true,
      trigger_if_body_bytes_ge: 40000,
      trigger_if_messages_ge: 6,
      trigger_if_tool_call_history_ge: 3,
      aggressive_models: [
        "nvidia/moonshotai/kimi-k2-instruct-0905",
        "kimi-k2.5",
        "kimi-k2-instruct",
      ],
    },
  },

  /**
   * Optional SIEM event hook.  Called as `siem({ event, ...fields })` on
   * notable gateway decisions (non-stream flip, tool reduction, etc.).
   * Left null by default — index.mjs injects a real hook.
   * @type {?function(object): void}
   */
  siem: null,
};

/**
 * @typedef {typeof DEFAULT_CONFIG} ProxyConfig
 */

/**
 * Build a fully-resolved config by merging caller overrides with defaults.
 * This is the canonical way to create a config object — it resolves
 * pluggable function defaults so callers don't have to import them.
 *
 * @param {Partial<ProxyConfig>} overrides
 * @returns {ProxyConfig}
 */
export function buildConfig(overrides = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };

  // Resolve pluggable defaults after merge so caller can still override.
  //
  // The scaffold tools.mjs `reduceTools` has signature:
  //   reduceTools(tools, messages, config, max)
  // Core calls the reducer as:
  //   cfg.toolReducer(tools, messages, max)
  // We wrap to bridge the two signatures so the scaffold implementation works
  // as the default without modification.
  if (!cfg.toolReducer) {
    cfg.toolReducer = (tools, messages, max) => reduceTools(tools, messages, {}, max);
  }
  if (!cfg.sanitizer)   cfg.sanitizer = sanitizeContent;

  // Normalise targetUrl: always a URL object pointing at the origin (no /v1)
  if (typeof cfg.targetUrl === "string") {
    cfg.targetUrl = new URL(cfg.targetUrl.replace(/\/v1\/?$/, ""));
  }

  // Build a tagged logger if the caller passed a plain logTag with no logger override
  if (!overrides.logger && overrides.logTag && overrides.logTag !== DEFAULT_CONFIG.logTag) {
    cfg.logger = {
      log:   (msg) => console.log(`[${cfg.logTag}] ${msg}`),
      warn:  (msg) => console.warn(`[${cfg.logTag}] ${msg}`),
      error: (msg) => console.error(`[${cfg.logTag}] ${msg}`),
    };
  }

  return cfg;
}

// ---------------------------------------------------------------------------
// System instruction injected into every tool request
// ---------------------------------------------------------------------------

const SINGLE_TOOL_INSTRUCTION =
  "You MUST call exactly ONE tool per response. Never call multiple tools at once.";

// ---------------------------------------------------------------------------
// Per-model tool-call round counters
// Keyed by model name.  Counts consecutive tool result turns since the last
// user message.  Shared across all requests in the same process.
// ---------------------------------------------------------------------------

const toolCallCounters = new Map();

// ---------------------------------------------------------------------------
// SSE / response sending
// ---------------------------------------------------------------------------

/**
 * Sanitize and send a successful (200) response to the client.
 *
 * When `asSSE` is true the JSON non-streaming response is converted to a
 * Server-Sent Events stream (data: [chunk]\\n\\n … data: [DONE]\\n\\n) so that
 * clients which requested `stream: true` receive the expected format.
 *
 * The function applies the following fixups before sending:
 *  - Content sanitization via config.sanitizer
 *  - `reasoning` → `content` promotion when content is empty
 *  - Empty-content fallback injection
 *
 * @param {http.ServerResponse} clientRes
 * @param {object} resBody  Parsed JSON response body from upstream.
 * @param {Record<string, string>} headers  Upstream response headers.
 * @param {boolean} asSSE  Whether to re-emit as SSE (client asked for stream).
 * @param {ProxyConfig} cfg  Active proxy config.
 */
export function sendOk(clientRes, resBody, headers, asSSE, cfg) {
  const log = cfg.logger.log.bind(cfg.logger);
  const sanitize = cfg.sanitizer;
  const choice = resBody.choices?.[0];

  // --- 1. Sanitize main content ---
  if (choice?.message?.content) {
    choice.message.content = sanitize(choice.message.content);
  }

  // --- 2. Track whether original response had reasoning BEFORE we delete it ---
  // This is important: if the entire response was reasoning (no content, no tool
  // calls), we must NOT inject the fallback text — it would be visible to the
  // user and is misleading when the model was just "thinking between rounds".
  const hadReasoning = !!(choice?.message?.reasoning || choice?.message?.reasoning_content);

  // --- 3. Promote reasoning → content when content is empty ---
  // Kimi K2.5 sometimes puts its actual user-facing response in `reasoning`
  // instead of `content`.  Only promote if it's substantial and looks like
  // a real answer (not inner monologue like "Let me call the tool").
  if (choice?.message && !choice.message.content && choice.message.reasoning) {
    const cleaned = sanitize(choice.message.reasoning.trim());
    if (cleaned.length > cfg.reasoningPromoteThreshold) {
      choice.message.content = cleaned;
      log(`promoted reasoning→content (${cleaned.length} chars)`);
    } else if (cleaned.length > 0) {
      log(`suppressed short reasoning (${cleaned.length} chars): ${cleaned.slice(0, 80)}...`);
    } else {
      log(`suppressed empty reasoning after sanitization`);
    }
    delete choice.message.reasoning;
  }

  // --- 4. Inject fallback when model returns empty text with no tool calls ---
  // But suppress the fallback for reasoning-only turns (K2.5 "thinking between
  // rounds") — the gateway will handle this as an empty assistant turn.
  if (choice?.message && !choice.message.tool_calls?.length && choice.finish_reason !== "tool_calls") {
    if (!choice.message.content || choice.message.content.trim().length === 0) {
      if (hadReasoning) {
        // K2.5 thinking between rounds — leave empty, don't inject visible fallback
        log(`suppressed reasoning-only turn (no content, no tool calls)`);
      } else {
        choice.message.content = cfg.emptyResponseFallback;
        log(`injected fallback for empty text response`);
      }
    }
  }

  // --- 5. Send the response ---
  if (asSSE) {
    // Client requested streaming — convert the buffered JSON response to SSE
    if (!clientRes.headersSent) {
      const sseHeaders = { ...headers };
      sseHeaders["content-type"] = "text/event-stream; charset=utf-8";
      delete sseHeaders["content-length"];
      delete sseHeaders["transfer-encoding"];
      sseHeaders["cache-control"] = "no-cache";
      clientRes.writeHead(200, sseHeaders);
    }

    const base = {
      id:      resBody.id,
      object:  "chat.completion.chunk",
      created: resBody.created,
      model:   resBody.model,
    };
    const sseChoice = resBody.choices?.[0];

    if (!sseChoice) {
      clientRes.write("data: [DONE]\n\n");
      clientRes.end();
      return;
    }

    const msg = sseChoice.message || {};

    // Chunk 1: role delta
    clientRes.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: msg.role || "assistant" }, finish_reason: null }],
      })}\n\n`,
    );

    // Chunk 2: content (split into 100-char pieces for proper streaming behaviour)
    const content = msg.content || "";
    if (content) {
      const chunkSize = 100;
      for (let i = 0; i < content.length; i += chunkSize) {
        clientRes.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: { content: content.slice(i, i + chunkSize) }, finish_reason: null }],
          })}\n\n`,
        );
      }
    }

    // Chunk 3: tool calls (sent as a single delta — client must handle the full array)
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      clientRes.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: { tool_calls: msg.tool_calls }, finish_reason: null }],
        })}\n\n`,
      );
    }

    // Chunk 4: finish chunk (with optional usage)
    if (resBody.usage) {
      clientRes.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: sseChoice.finish_reason || "stop" }],
          usage: resBody.usage,
        })}\n\n`,
      );
    } else {
      clientRes.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: sseChoice.finish_reason || "stop" }],
        })}\n\n`,
      );
    }

    clientRes.write("data: [DONE]\n\n");
    clientRes.end();
  } else {
    // Non-streaming: send as a plain JSON response
    const outBody = Buffer.from(JSON.stringify(resBody), "utf-8");
    const outHeaders = { ...headers };
    outHeaders["content-length"] = outBody.length;
    clientRes.writeHead(200, outHeaders);
    clientRes.end(outBody);
  }
}

// ---------------------------------------------------------------------------
// Conversation history trimming
// ---------------------------------------------------------------------------

/**
 * Trim tool-result message content that is excessively large.
 * Modifies `parsed.messages` in place.
 * Truncates string content at 1500 chars; array content items at 1500 chars each.
 *
 * @param {object} parsed  Parsed request body (mutated in place).
 */
function truncateLargeToolResults(parsed) {
  if (!Array.isArray(parsed.messages)) return;
  for (const m of parsed.messages) {
    if (m.role === "tool" || m.role === "toolResult") {
      if (typeof m.content === "string" && m.content.length > 1500) {
        m.content = m.content.slice(0, 1500) + "\n...[truncated]";
      } else if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === "text" && typeof c.text === "string" && c.text.length > 1500) {
            c.text = c.text.slice(0, 1500) + "\n...[truncated]";
          }
        }
      }
    }
  }
}

/**
 * Trim conversation history to keep the total body size under
 * `cfg.maxBodyBytes`.
 *
 * Strategy (in order):
 *  1. Truncate large tool result messages (1500 char cap per result).
 *  2. Drop middle messages (keep first 2 + last N non-system messages).
 *     N starts at min(12, len-2) and decreases until size is under budget.
 *  3. Aggressive fallback: system + first user + last 4 non-system.
 *  4. Aggressive fallback: system + first user + last 2 non-system.
 *  5. Absolute last resort: system + first user + last 2.
 *
 * Always preserves system messages and the very first non-system messages
 * so identity / rehydration context survives trimming.
 *
 * @param {object} parsed  Parsed request body (mutated in place).
 * @param {ProxyConfig} cfg
 */
export function trimConversationHistory(parsed, cfg) {
  if (!Array.isArray(parsed.messages) || parsed.messages.length < 6) return;

  const log = cfg.logger.log.bind(cfg.logger);
  const roleSummary = parsed.messages.map((m) => m.role).join(",");
  log(`conversation roles (${parsed.messages.length} msgs): ${roleSummary}`);

  // Pass 1: truncate large tool results
  truncateLargeToolResults(parsed);

  let bodySize = Buffer.byteLength(JSON.stringify(parsed), "utf-8");
  if (bodySize <= cfg.maxBodyBytes) return;

  const msgs = parsed.messages;
  const system    = msgs.filter((m) => m.role === "system");
  const nonSystem = msgs.filter((m) => m.role !== "system");

  if (nonSystem.length <= 4) return; // not enough to safely trim

  const keepStart = 2;
  let keepEnd = Math.min(12, nonSystem.length - keepStart);

  // Pass 2: reduce middle, progressively shrink tail
  while (keepEnd >= 2) {
    const dropped = nonSystem.length - keepStart - keepEnd;
    const trimmed = [
      ...system,
      ...nonSystem.slice(0, keepStart),
      ...(dropped > 0
        ? [{ role: "system", content: `[${dropped} earlier messages trimmed to save context]` }]
        : []),
      ...nonSystem.slice(-keepEnd),
    ];
    const candidateSize = Buffer.byteLength(JSON.stringify({ ...parsed, messages: trimmed }), "utf-8");
    if (candidateSize <= cfg.maxBodyBytes) {
      parsed.messages = trimmed;
      log(`trimmed history: dropped ${dropped} middle messages, keepEnd=${keepEnd}, bodyLen now ~${candidateSize}`);
      return;
    }
    keepEnd--;
  }

  // Pass 3 & 4: aggressive — system + first user + last N non-system
  // (N=4 covers tool_call + result + next tool_call + result pairs)
  const firstUser = nonSystem.find((m) => m.role === "user");
  for (const tailSize of [4, 2]) {
    const lastN = nonSystem.slice(-tailSize);
    const minimal = [
      ...system,
      ...(firstUser && !lastN.includes(firstUser)
        ? [firstUser, { role: "system", content: "[earlier messages trimmed — answer the user's request using tool results below]" }]
        : []),
      ...lastN,
    ];
    const candidateSize = Buffer.byteLength(JSON.stringify({ ...parsed, messages: minimal }), "utf-8");
    if (candidateSize <= cfg.maxBodyBytes) {
      parsed.messages = minimal;
      log(`trimmed history: AGGRESSIVE — kept system + first user + last ${tailSize}, bodyLen now ~${candidateSize}`);
      return;
    }
  }

  // Pass 5: absolute last resort
  const lastTwo = nonSystem.slice(-2);
  const minimal = [
    ...system,
    ...(firstUser && !lastTwo.includes(firstUser)
      ? [firstUser, { role: "system", content: "[earlier messages trimmed — answer the user's request using tool results below]" }]
      : []),
    ...lastTwo,
  ];
  parsed.messages = minimal;
  bodySize = Buffer.byteLength(JSON.stringify(parsed), "utf-8");
  log(`trimmed history: AGGRESSIVE — kept system + first user + last 2, bodyLen now ~${bodySize}`);
}

/**
 * Trim system messages to keep total system content under
 * `cfg.maxSystemBytes`.
 *
 * Finds the largest system message(s) and truncates them, keeping the
 * first 3000 chars + last 1000 chars with a notice in the middle.
 * Only messages larger than 4000 chars are candidates for trimming.
 *
 * @param {object} parsed  Parsed request body (mutated in place).
 * @param {ProxyConfig} cfg
 */
export function trimSystemMessages(parsed, cfg) {
  if (!Array.isArray(parsed.messages)) return;

  const log = cfg.logger.log.bind(cfg.logger);
  const systemMsgs = parsed.messages.filter(
    (m) => m.role === "system" && typeof m.content === "string",
  );
  if (systemMsgs.length === 0) return;

  const before = systemMsgs.reduce((sum, m) => sum + Buffer.byteLength(m.content, "utf-8"), 0);
  if (before <= cfg.maxSystemBytes) return;

  // Sort largest first — trim in descending size order
  const sorted = [...systemMsgs].sort((a, b) => b.content.length - a.content.length);
  let trimmedCount = 0;

  for (const msg of sorted) {
    // Re-measure after each trim to avoid over-trimming
    const currentTotal = parsed.messages
      .filter((m) => m.role === "system" && typeof m.content === "string")
      .reduce((sum, m) => sum + Buffer.byteLength(m.content, "utf-8"), 0);
    if (currentTotal <= cfg.maxSystemBytes) break;

    // Skip messages already small enough
    if (msg.content.length <= 4000) break;

    const head = msg.content.slice(0, 3000);
    const tail = msg.content.slice(-1000);
    msg.content =
      head +
      "\n\n[...content trimmed to save context — use skmemory_ritual tool for full identity...]\n\n" +
      tail;
    trimmedCount++;
  }

  if (trimmedCount > 0) {
    const after = parsed.messages
      .filter((m) => m.role === "system" && typeof m.content === "string")
      .reduce((sum, m) => sum + Buffer.byteLength(m.content, "utf-8"), 0);
    log(`trimmed system prompt: ${before} → ${after} bytes (${trimmedCount} messages trimmed)`);
  }
}

// ---------------------------------------------------------------------------
// SSE keep-alive helpers
// ---------------------------------------------------------------------------

/**
 * Start sending SSE keep-alive comment frames (`: keep-alive\n\n`) to the
 * client every 5 seconds while the upstream call is in progress.
 *
 * This prevents the client's connection from timing out during long NVIDIA
 * NIM inference calls and keeps the UI "typing" indicator alive.
 *
 * Must be paired with `stopSSEKeepAlive()`.
 *
 * @param {http.ServerResponse} clientRes
 * @param {{ sseStarted: boolean, keepAliveTimer: NodeJS.Timeout|null }} state
 *   Mutable state object shared with `stopSSEKeepAlive`.
 * @param {boolean} wasStreaming  Whether the original client request had `stream: true`.
 */
function startSSEKeepAlive(clientRes, state, wasStreaming) {
  if (!wasStreaming || state.sseStarted) return;
  state.sseStarted = true;
  clientRes.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  state.keepAliveTimer = setInterval(() => {
    try { clientRes.write(": keep-alive\n\n"); } catch { /* client disconnected */ }
  }, 5000);
}

/**
 * Stop the SSE keep-alive interval started by `startSSEKeepAlive`.
 *
 * @param {{ keepAliveTimer: NodeJS.Timeout|null }} state
 */
function stopSSEKeepAlive(state) {
  if (state.keepAliveTimer) {
    clearInterval(state.keepAliveTimer);
    state.keepAliveTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Core request handler
// ---------------------------------------------------------------------------

/**
 * Handle a single incoming HTTP request.
 *
 * This is the primary entry point when embedding the proxy core inside a
 * larger HTTP server.  `createProxyServer()` calls this internally.
 *
 * Requests that are not `/chat/completions` POST with a JSON body, or that
 * carry no tools, are relayed transparently without any modification.
 *
 * @param {http.IncomingMessage} clientReq  Incoming request from the client.
 * @param {http.ServerResponse}  clientRes  Response to write to the client.
 * @param {ProxyConfig}          cfg        Resolved proxy configuration.
 * @returns {Promise<void>}
 */
export async function handleRequest(clientReq, clientRes, cfg) {
  const log   = cfg.logger.log.bind(cfg.logger);
  const warn  = cfg.logger.warn.bind(cfg.logger);
  const error = cfg.logger.error.bind(cfg.logger);

  // --- Buffer the full request body ---
  const chunks = [];
  for await (const chunk of clientReq) chunks.push(chunk);
  let body = Buffer.concat(chunks);

  const contentType = clientReq.headers["content-type"] || "";
  const isChatCompletion =
    contentType.includes("application/json") &&
    clientReq.url.includes("/chat/completions");

  // --- Attempt to parse as JSON for chat completion requests ---
  let parsed = null;
  if (isChatCompletion) {
    try {
      parsed = JSON.parse(body.toString("utf-8"));
    } catch {
      // Parse failure — fall through to transparent relay
    }
  }

  // --- Transparent relay for non-tool or non-chat requests ---
  // Before handing off, check the non-streaming classifier: large non-tool
  // chat/completions on flaky upstreams (NVIDIA NIM) benefit from the same
  // buffer-and-reemit strategy the tool path uses below.  This keeps the
  // client-side SSE contract intact while removing the mid-stream-drop
  // failure mode.
  if (!parsed || !parsed.tools || !Array.isArray(parsed.tools) || parsed.tools.length === 0) {
    if (parsed && isChatCompletion) {
      const decision = shouldForceNonStream(
        parsed, clientReq.headers, body.length, cfg.streaming || {},
      );
      if (decision.force && parsed.stream) {
        const wasStreaming = true;
        parsed.stream = false;
        delete parsed.stream_options;
        log(`non-stream flip: model=${parsed.model || "?"} reason=${decision.reason} bodyLen=${body.length}`);
        if (typeof cfg.siem === "function") {
          try {
            cfg.siem({
              event: "nonstream_flip",
              model: parsed.model || null,
              reason: decision.reason,
              body_bytes: body.length,
              messages: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
              ts: new Date().toISOString(),
            });
          } catch (e) { warn(`siem hook failed: ${e.message}`); }
        }

        const sseState = { sseStarted: false, keepAliveTimer: null };
        if (wasStreaming) startSSEKeepAlive(clientRes, sseState, wasStreaming);

        const reqBody = Buffer.from(JSON.stringify(parsed), "utf-8");
        const res = await sendUpstream(
          clientReq.url, clientReq.method, clientReq.headers, reqBody, cfg.targetUrl,
        );
        stopSSEKeepAlive(sseState);

        if (res.status === 200) {
          let resBody;
          try {
            resBody = JSON.parse(res.body.toString("utf-8"));
          } catch (e) {
            error(`non-stream flip: upstream returned non-JSON despite stream:false: ${e.message}`);
            if (!clientRes.headersSent) {
              clientRes.writeHead(res.status, res.headers);
            }
            clientRes.end(res.body);
            return;
          }
          sendOk(clientRes, resBody, res.headers, wasStreaming, cfg);
          return;
        }

        // Non-200: pass through as-is.  If SSE headers already sent via
        // keep-alive start, fall back to an error data frame + [DONE].
        if (clientRes.headersSent) {
          const errPayload = { error: { message: res.body.toString("utf-8"), code: res.status } };
          clientRes.write(`data: ${JSON.stringify(errPayload)}\n\n`);
          clientRes.write("data: [DONE]\n\n");
          clientRes.end();
        } else {
          clientRes.writeHead(res.status, res.headers);
          clientRes.end(res.body);
        }
        return;
      }
    }

    const res = await sendUpstream(
      clientReq.url, clientReq.method, clientReq.headers, body, cfg.targetUrl,
    );
    clientRes.writeHead(res.status, res.headers);
    clientRes.end(res.body);
    return;
  }

  // --- Tool request processing ---
  const allTools = [...parsed.tools]; // preserve original full tool list for validation

  // Force non-streaming: the proxy must buffer the full response to inspect
  // and fix tool calls.  The SSE keep-alive mechanism compensates on the
  // client side by sending comment frames while we wait.
  const wasStreaming = parsed.stream;
  parsed.stream = false;
  delete parsed.stream_options;

  // Disable parallel tool calls (NVIDIA NIM ignores this, but it's a hint)
  parsed.parallel_tool_calls = false;

  // --- Proactive tool reduction ---
  // With 94 tools the model almost always tries parallel calls.
  // Reduce to proactiveToolLimit most relevant tools on first attempt.
  if (allTools.length > cfg.proactiveToolLimit) {
    parsed.tools = cfg.toolReducer(allTools, parsed.messages, cfg.proactiveToolLimit);
    const names = parsed.tools.map((t) => t.function?.name).join(",");
    log(`proactive reduction: ${allTools.length}→${parsed.tools.length} tools [${names}]`);
  }

  // --- Inject single-tool instruction (idempotent) ---
  if (Array.isArray(parsed.messages)) {
    const hasInstruction = parsed.messages.some(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes("ONE tool at a time"),
    );
    if (!hasInstruction) {
      parsed.messages.unshift({ role: "system", content: SINGLE_TOOL_INSTRUCTION });
    }
  }

  // --- Resolve per-model limits (overrides global maxBodyBytes / maxSystemBytes) ---
  const perModel = cfg.modelLimits?.[parsed.model || ""];
  const effectiveCfg = perModel ? { ...cfg, ...perModel } : cfg;

  // --- Trim system messages first (to free budget for history) ---
  trimSystemMessages(parsed, effectiveCfg);

  // --- Trim conversation history ---
  trimConversationHistory(parsed, effectiveCfg);

  // --- Tool round limit check ---
  // Track consecutive tool result turns per model to prevent infinite loops.
  if (Array.isArray(parsed.messages) && parsed.tools?.length > 0) {
    const modelKey     = parsed.model || "unknown";
    const nonSystemMsgs = parsed.messages.filter((m) => m.role !== "system");
    const lastNonSystem = nonSystemMsgs[nonSystemMsgs.length - 1];
    const hasToolResult = lastNonSystem?.role === "tool" || lastNonSystem?.role === "toolResult";

    let counter = toolCallCounters.get(modelKey) || 0;
    if (hasToolResult) {
      counter++;
    } else if (lastNonSystem?.role === "user") {
      // New user turn resets the counter
      counter = 0;
    }
    toolCallCounters.set(modelKey, counter);

    if (counter >= cfg.toolRoundLimit) {
      log(`TOOL LIMIT: ${counter} consecutive tool rounds (${modelKey}) — stripping tools, forcing text response`);
      parsed.tools = [];
      delete parsed.tool_choice;
      parsed.messages.push({
        role: "system",
        content:
          `STOP calling tools. You have made ${cfg.toolRoundLimit}+ tool calls already. ` +
          "NOW respond to the user with a comprehensive text answer based on what you've gathered. " +
          "Do NOT call any more tools. Do NOT output any special tokens or markup like " +
          "<|tool_call_begin|> or <|tool_calls_section_begin|>. Write plain text only. " +
          "Start your response with a greeting or summary — no XML, no special tokens, just normal language.",
      });
      toolCallCounters.set(modelKey, 0);
    }
  }

  const model = parsed.model || "unknown";

  // --- SSE keep-alive state ---
  const sseState = { sseStarted: false, keepAliveTimer: null };

  // --- Retry loop ---
  for (let attempt = 1; attempt <= cfg.maxRetries; attempt++) {
    const currentToolCount = parsed.tools ? parsed.tools.length : 0;
    const reqBody = Buffer.from(JSON.stringify(parsed), "utf-8");
    log(
      `${new Date().toISOString()} attempt=${attempt} model=${model} ` +
      `tools=${currentToolCount} bodyLen=${reqBody.length}`,
    );

    // Start SSE keep-alive while upstream processes (only if client wanted streaming)
    if (wasStreaming) startSSEKeepAlive(clientRes, sseState, wasStreaming);

    // --- Inner 429 retry loop ---
    let res;
    for (let r429 = 0; r429 <= cfg.max429Retries; r429++) {
      res = await sendUpstream(
        clientReq.url, clientReq.method, clientReq.headers, reqBody, cfg.targetUrl,
      );
      if (res.status !== 429 || r429 === cfg.max429Retries) break;
      const delay = cfg.rateLimitDelayMs * (r429 + 1);
      log(`429 rate limited, waiting ${delay}ms (retry ${r429 + 1}/${cfg.max429Retries})...`);
      await new Promise((r) => setTimeout(r, delay));
    }

    // --- Handle 400 "single tool-calls" rejection ---
    // NVIDIA NIM returns a 400 with the text "single tool-calls" when the
    // model's training causes it to attempt parallel tool calls despite our
    // instruction.  We progressively reduce and retry.
    if (res.status === 400) {
      const errText = res.body.toString("utf-8");
      if (errText.includes("single tool-calls") && attempt < cfg.maxRetries) {
        log(`400 parallel tool-calls rejected, retrying (${attempt}/${cfg.maxRetries})...`);

        if (attempt === 1) {
          // Attempt 2: reduce to 8 tools + strip tool_call history.
          // Tool call history in prior turns "teaches" the model to call
          // multiple tools, so stripping it is critical here.
          parsed.tools = cfg.toolReducer(allTools, parsed.messages, 8);
          stripToolCallHistory(parsed.messages);
          const toolNames = parsed.tools.map((t) => t.function?.name).join(",");
          log(`retry: ${parsed.tools.length} tools [${toolNames}], stripped history`);
        } else if (attempt === 2) {
          // Attempt 3: single tool with forced tool_choice
          parsed.tools = cfg.toolReducer(allTools, parsed.messages, 1);
          const topTool = parsed.tools[0]?.function?.name;
          if (topTool) {
            parsed.tool_choice = { type: "function", function: { name: topTool } };
          }
          log(`retry: 1 tool, forced=${topTool}`);
        } else {
          // Attempt 4 (final): strip all tools, text-only response
          delete parsed.tools;
          delete parsed.tool_choice;
          delete parsed.parallel_tool_calls;
          stripToolCallHistory(parsed.messages);
          log(`final retry: stripped all tools, text-only`);
        }
        continue;
      }
    }

    // --- Log tool call / text response summary ---
    if (res.status === 200) {
      try {
        const peek = JSON.parse(res.body.toString("utf-8"));
        const tc = peek.choices?.[0]?.message?.tool_calls;
        if (tc && tc.length > 0) {
          const names = tc.map((c) => c.function?.name).join(", ");
          log(`model called: [${names}] (${tc.length} calls)`);
        } else {
          const content  = peek.choices?.[0]?.message?.content;
          const fr       = peek.choices?.[0]?.finish_reason;
          log(`model response: text (${content ? content.length : 0} chars) finish_reason=${fr}`);
          if (!content || content.length === 0) {
            log(`EMPTY RESPONSE DEBUG: ${JSON.stringify(peek.choices?.[0]).slice(0, 500)}`);
          }
        }
      } catch {
        // Body is not JSON (shouldn't happen — we forced stream: false) — ignore
      }
    }

    // --- Fixup: Ghost tool calls ---
    // finish_reason says "tool_calls" but there are no tool_calls in the message.
    // Fix by resetting finish_reason to "stop" and delivering the text response.
    if (res.status === 200 && parsed.tools) {
      try {
        const resBody = JSON.parse(res.body.toString("utf-8"));
        const choice  = resBody.choices?.[0];
        if (
          choice &&
          (choice.finish_reason === "tool_calls" || choice.finish_reason === "function_call") &&
          !choice.message?.tool_calls?.length
        ) {
          warn(`GHOST TOOL CALL: finish_reason=${choice.finish_reason} but no tool_calls — fixing to stop`);
          choice.finish_reason = "stop";
          stopSSEKeepAlive(sseState);
          sendOk(clientRes, resBody, res.headers, wasStreaming, cfg);
          return;
        }
      } catch {
        // Not JSON — pass through
      }
    }

    // --- Fixup: Hallucinated / invalid tool names ("callauto" bug) ---
    // Some models (notably Kimi K2.5) occasionally invent tool names that
    // were never in the provided tool list.  Strip invalid calls; if all
    // calls are invalid, fall back to text-only.
    if (res.status === 200 && parsed.tools) {
      try {
        const resBody = JSON.parse(res.body.toString("utf-8"));
        const choice  = resBody.choices?.[0];
        if (choice?.message?.tool_calls) {
          // Validate against the FULL original tool list, not the reduced set
          const allToolNames = new Set(allTools.map((t) => t.function?.name));
          const invalidCalls = choice.message.tool_calls.filter(
            (tc) => !tc.function?.name || !allToolNames.has(tc.function.name),
          );
          if (invalidCalls.length > 0) {
            const badNames = invalidCalls.map((tc) => tc.function?.name || "(empty)").join(", ");
            warn(`CALLAUTO DETECTED: invalid tool names [${badNames}] — stripping tool_calls, returning text-only`);
            choice.message.tool_calls = choice.message.tool_calls.filter(
              (tc) => tc.function?.name && allToolNames.has(tc.function.name),
            );
            if (choice.message.tool_calls.length === 0) {
              delete choice.message.tool_calls;
              choice.finish_reason = "stop";
            }
            stopSSEKeepAlive(sseState);
            sendOk(clientRes, resBody, res.headers, wasStreaming, cfg);
            return;
          }
        }
      } catch {
        // Not JSON — pass through
      }
    }

    // --- Fixup: Multi-tool response trim ---
    // Even after all our efforts, the model may return multiple tool_calls.
    // We trim to just the first one.  This is the last line of defence.
    if (res.status === 200 && parsed.tools) {
      try {
        const resBody = JSON.parse(res.body.toString("utf-8"));
        const choice  = resBody.choices?.[0];
        if (choice?.message?.tool_calls && choice.message.tool_calls.length > 1) {
          log(
            `trimming ${choice.message.tool_calls.length} tool_calls to 1 ` +
            `(${choice.message.tool_calls[0].function?.name})`,
          );
          choice.message.tool_calls = [choice.message.tool_calls[0]];
          stopSSEKeepAlive(sseState);
          sendOk(clientRes, resBody, res.headers, wasStreaming, cfg);
          return;
        }
      } catch {
        // Not JSON or parse error — pass through as-is
      }
    }

    // --- Final dispatch: success or non-retryable error ---
    stopSSEKeepAlive(sseState);

    if (res.status >= 400) {
      error(`${res.status} ERROR: ${res.body.toString("utf-8").slice(0, 300)}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(res.status, res.headers);
      }
      clientRes.end(res.body);
      return;
    }

    log(`${res.status} OK (attempt ${attempt})`);

    if (wasStreaming && res.status === 200) {
      try {
        const resBody = JSON.parse(res.body.toString("utf-8"));
        sendOk(clientRes, resBody, res.headers, true, cfg);
      } catch {
        // Can't parse as JSON — send raw body as-is
        if (!clientRes.headersSent) {
          clientRes.writeHead(res.status, res.headers);
        }
        clientRes.end(res.body);
      }
    } else {
      if (!clientRes.headersSent) {
        clientRes.writeHead(res.status, res.headers);
      }
      clientRes.end(res.body);
    }
    return;
  }
  // Exhausted all attempts without returning — should not happen in practice
  // (the last attempt always falls through to the final dispatch above).
  stopSSEKeepAlive(sseState);
  if (!clientRes.headersSent) {
    clientRes.writeHead(503, { "content-type": "application/json" });
  }
  clientRes.end(JSON.stringify({ error: { message: "All upstream attempts exhausted" } }));
}

// ---------------------------------------------------------------------------
// HTTP server factory
// ---------------------------------------------------------------------------

/**
 * Create an HTTP server pre-wired to the proxy request handler.
 *
 * The server is NOT started (no `.listen()` call).  The caller is responsible
 * for calling `server.listen(port, host)` and handling `SIGINT`/`SIGTERM`.
 *
 * @param {Partial<ProxyConfig>} configOverrides
 *   Optional config overrides merged with `DEFAULT_CONFIG` via `buildConfig()`.
 * @returns {{ server: http.Server, cfg: ProxyConfig }}
 *   The HTTP server instance and the resolved config (useful for logging bind address).
 *
 * @example
 * const { server, cfg } = createProxyServer({ port: 18780 });
 * server.listen(cfg.port, cfg.bindHost, () => {
 *   console.log(`Listening on http://${cfg.bindHost}:${cfg.port}`);
 * });
 */
export function createProxyServer(configOverrides = {}) {
  const cfg = buildConfig(configOverrides);
  const server = http.createServer((req, res) => handleRequest(req, res, cfg));
  return { server, cfg };
}

/**
 * Convenience: create AND start the proxy server, logging startup info.
 *
 * Attaches `SIGINT`/`SIGTERM` handlers for graceful shutdown.
 *
 * @param {Partial<ProxyConfig>} configOverrides
 * @returns {{ server: http.Server, cfg: ProxyConfig }}
 */
export function startProxyServer(configOverrides = {}) {
  const { server, cfg } = createProxyServer(configOverrides);
  const log = cfg.logger.log.bind(cfg.logger);

  server.listen(cfg.port, cfg.bindHost, () => {
    log(`listening on http://${cfg.bindHost}:${cfg.port}`);
    log(`proxying to ${cfg.targetUrl.origin}`);
    log(
      `retry strategy: ${cfg.proactiveToolLimit} tools (5 guaranteed)` +
      `→8 tools→1 tool (forced)→text-only (max ${cfg.maxRetries} attempts)`,
    );
    log(`also trims multi-tool responses to single tool call`);
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log(`${sig} received, shutting down`);
      server.close(() => process.exit(0));
    });
  }

  return { server, cfg };
}
