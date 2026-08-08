/**
 * SKGateway — SSE/JSON Stream Handler
 *
 * Provides four primitives for working with Server-Sent Events in the proxy:
 *
 *   SSEWriter          — Write SSE events to an HTTP response (with keep-alive)
 *   jsonToSSE          — Convert a complete JSON response object into SSE chunks
 *   SSEParser          — Parse incoming SSE from an upstream backend
 *   passthroughStream  — Forward an upstream SSE stream to the client with optional inspection
 *
 * All functions are ES module exports. Node.js streams (Transform, PassThrough)
 * are used where appropriate so callers can pipe rather than buffer.
 *
 * Format compatibility:
 *   - OpenAI  chat/completions  (object: "chat.completion" / "chat.completion.chunk")
 *   - Anthropic messages API    (type: "message" / delta events)
 *
 * @module stream
 */

import { Transform, PassThrough } from "node:stream";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Interval (ms) between keep-alive comment frames when waiting for a slow backend. */
const KEEPALIVE_INTERVAL_MS = 5000;

/** Number of characters per synthetic content chunk when splitting long text. */
const CONTENT_CHUNK_SIZE = 100;

/** SSE headers emitted at the start of every streaming response. */
const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  "connection": "keep-alive",
  "x-accel-buffering": "no", // Disable nginx proxy buffering
};

// ---------------------------------------------------------------------------
// SSEWriter
// ---------------------------------------------------------------------------

/**
 * Manages writing SSE frames to an HTTP ServerResponse, including keep-alive
 * comments while waiting for a slow backend and final [DONE] termination.
 *
 * Usage:
 *   const writer = new SSEWriter(res);
 *   writer.start();                         // send headers + begin keep-alive timer
 *   writer.write({ data: "..." });          // send a data event
 *   writer.writeComment("keepalive");       // send a comment frame
 *   writer.writeDone();                     // send [DONE] and end response
 *   writer.stop();                          // stop keep-alive timer (if not yet done)
 *
 * @class
 */
export class SSEWriter {
  /**
   * @param {import("node:http").ServerResponse} res - HTTP response to write to.
   * @param {object} [opts]
   * @param {number} [opts.keepAliveMs=5000] - Keep-alive comment interval in ms.
   * @param {string} [opts.keepAliveComment="keepalive"] - Comment text for keep-alive frames.
   * @param {object} [opts.extraHeaders={}] - Additional headers merged into SSE headers.
   */
  constructor(res, opts = {}) {
    this._res = res;
    this._keepAliveMs = opts.keepAliveMs ?? KEEPALIVE_INTERVAL_MS;
    this._keepAliveComment = opts.keepAliveComment ?? "keepalive";
    this._extraHeaders = opts.extraHeaders ?? {};
    this._timer = null;
    this._started = false;
    this._ended = false;
  }

  /**
   * Write SSE response headers and start the keep-alive comment timer.
   * Safe to call multiple times — only acts on the first call.
   *
   * @param {object} [upstreamHeaders={}] - Upstream response headers to merge/filter.
   */
  start(upstreamHeaders = {}) {
    if (this._started || this._res.headersSent) return;
    this._started = true;

    // Merge upstream headers, then apply SSE overrides and extras.
    // Drop headers that conflict with SSE framing.
    const merged = { ...upstreamHeaders };
    delete merged["content-length"];
    delete merged["transfer-encoding"];
    Object.assign(merged, SSE_HEADERS, this._extraHeaders);

    this._res.writeHead(200, merged);
    this._startKeepAlive();
  }

  /**
   * Start the keep-alive timer. Writes `: keepalive\n\n` comment frames on
   * interval so the client's connection does not time out during long waits.
   * @private
   */
  _startKeepAlive() {
    if (this._timer !== null || this._keepAliveMs <= 0) return;
    this._timer = setInterval(() => {
      this.writeComment(this._keepAliveComment);
    }, this._keepAliveMs);
  }

  /**
   * Stop the keep-alive timer. Called automatically by writeDone().
   */
  stop() {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Write a comment frame (`: text\n\n`). These are ignored by EventSource
   * clients but keep TCP connections and nginx buffers alive.
   *
   * @param {string} [text=""] - Comment text (no newlines).
   */
  writeComment(text = "") {
    if (this._ended) return;
    try {
      this._res.write(`: ${text}\n\n`);
    } catch {
      // Client disconnected — suppress and let the caller detect via socket events.
    }
  }

  /**
   * Write a `data:` SSE event frame.
   *
   * @param {string|object} payload - If object, will be JSON-serialised.
   * @param {string} [eventType] - Optional `event:` field (e.g. "message_delta").
   * @param {string|number} [id] - Optional `id:` field.
   */
  write(payload, eventType, id) {
    if (this._ended) return;
    const data = typeof payload === "string" ? payload : JSON.stringify(payload);
    let frame = "";
    if (id !== undefined) frame += `id: ${id}\n`;
    if (eventType) frame += `event: ${eventType}\n`;
    frame += `data: ${data}\n\n`;
    try {
      this._res.write(frame);
    } catch {
      // Client disconnected.
    }
  }

  /**
   * Write the `[DONE]` sentinel frame and end the response.
   * Also stops the keep-alive timer.
   */
  writeDone() {
    if (this._ended) return;
    this._ended = true;
    this.stop();
    try {
      this._res.write("data: [DONE]\n\n");
      this._res.end();
    } catch {
      // Client disconnected.
    }
  }

  /** Whether the response has been fully ended. */
  get ended() {
    return this._ended;
  }
}

// ---------------------------------------------------------------------------
// jsonToSSE — Convert a complete JSON response into SSE chunks
// ---------------------------------------------------------------------------

/**
 * Convert a complete (non-streaming) JSON response body into a sequence of
 * SSE `data:` frames matching the OpenAI streaming format, then write [DONE].
 *
 * Supports:
 *   - OpenAI chat/completions   (object: "chat.completion")
 *   - Anthropic messages API    (type: "message") — normalised to OpenAI chunks
 *
 * The function detects the response format automatically.  For OpenAI it emits:
 *   1. Role chunk    — delta: { role }
 *   2. Content chunks — delta: { content } in CONTENT_CHUNK_SIZE slices
 *   3. Tool call chunk (if present) — delta: { tool_calls }
 *   4. Finish chunk  — delta: {}, finish_reason, optional usage
 *   5. [DONE]
 *
 * @param {SSEWriter} writer - Initialised SSEWriter (start() already called).
 * @param {object} resBody - Parsed JSON response object.
 * @param {object} [opts]
 * @param {number} [opts.chunkSize=100] - Characters per content chunk.
 */
export function jsonToSSE(writer, resBody, opts = {}) {
  const chunkSize = opts.chunkSize ?? CONTENT_CHUNK_SIZE;

  // Detect Anthropic messages format
  if (resBody.type === "message" || resBody.object === undefined && resBody.content !== undefined) {
    _anthropicJsonToSSE(writer, resBody, chunkSize);
    return;
  }

  // Default: OpenAI chat.completion format
  _openaiJsonToSSE(writer, resBody, chunkSize);
}

/**
 * Emit OpenAI-format SSE chunks from a complete chat.completion JSON body.
 * @private
 */
function _openaiJsonToSSE(writer, resBody, chunkSize) {
  const base = {
    id: resBody.id,
    object: "chat.completion.chunk",
    created: resBody.created,
    model: resBody.model,
  };

  const choice = resBody.choices?.[0];
  if (!choice) {
    writer.writeDone();
    return;
  }

  const msg = choice.message || {};

  // 1. Role chunk
  writer.write({
    ...base,
    choices: [{ index: 0, delta: { role: msg.role || "assistant" }, finish_reason: null }],
  });

  // 2. Content chunks — split for realistic streaming feel
  const content = msg.content || "";
  if (content) {
    for (let i = 0; i < content.length; i += chunkSize) {
      writer.write({
        ...base,
        choices: [{ index: 0, delta: { content: content.slice(i, i + chunkSize) }, finish_reason: null }],
      });
    }
  }

  // 3. Tool call chunk — emitted as a single delta containing all calls
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    writer.write({
      ...base,
      choices: [{ index: 0, delta: { tool_calls: msg.tool_calls }, finish_reason: null }],
    });
  }

  // 4. Finish chunk (with optional usage)
  const finishChunk = {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || "stop" }],
  };
  if (resBody.usage) finishChunk.usage = resBody.usage;
  writer.write(finishChunk);

  // 5. [DONE]
  writer.writeDone();
}

/**
 * Emit Anthropic-format SSE events from a complete messages API JSON body,
 * normalised to the Anthropic streaming event sequence:
 *   message_start → content_block_start → content_block_delta* →
 *   content_block_stop → message_delta → message_stop
 *
 * @private
 */
function _anthropicJsonToSSE(writer, resBody, chunkSize) {
  // message_start
  writer.write(
    JSON.stringify({ type: "message_start", message: { ...resBody, content: [] } }),
    "message_start",
  );

  const blocks = Array.isArray(resBody.content) ? resBody.content : [];

  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
    const block = blocks[blockIdx];

    // content_block_start — the shape depends on the block type. A text block
    // opens empty ({type,text:""}) and fills via text_delta; a tool_use block
    // MUST carry its id + name here (input opens empty, filled by
    // input_json_delta). Emitting the text shape for a tool_use dropped the name,
    // so Claude Code saw a nameless tool -> "No such tool available: undefined".
    const startBlock = block.type === "tool_use"
      ? { type: "tool_use", id: block.id, name: block.name, input: {} }
      : { type: block.type, text: "" };
    writer.write(
      JSON.stringify({ type: "content_block_start", index: blockIdx, content_block: startBlock }),
      "content_block_start",
    );

    if (block.type === "text" && block.text) {
      // content_block_delta — split text into chunks
      for (let i = 0; i < block.text.length; i += chunkSize) {
        writer.write(
          JSON.stringify({
            type: "content_block_delta",
            index: blockIdx,
            delta: { type: "text_delta", text: block.text.slice(i, i + chunkSize) },
          }),
          "content_block_delta",
        );
      }
    } else if (block.type === "tool_use") {
      // Emit tool input as a single input_json_delta
      const inputJson = typeof block.input === "string" ? block.input : JSON.stringify(block.input || {});
      writer.write(
        JSON.stringify({
          type: "content_block_delta",
          index: blockIdx,
          delta: { type: "input_json_delta", partial_json: inputJson },
        }),
        "content_block_delta",
      );
    }

    // content_block_stop
    writer.write(
      JSON.stringify({ type: "content_block_stop", index: blockIdx }),
      "content_block_stop",
    );
  }

  // message_delta (stop reason + usage)
  writer.write(
    JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: resBody.stop_reason || "end_turn", stop_sequence: resBody.stop_sequence ?? null },
      usage: { output_tokens: resBody.usage?.output_tokens ?? 0 },
    }),
    "message_delta",
  );

  // message_stop
  writer.write(JSON.stringify({ type: "message_stop" }), "message_stop");

  writer.writeDone();
}

// ---------------------------------------------------------------------------
// SSEParser — Parse incoming SSE from upstream backends
// ---------------------------------------------------------------------------

/**
 * Streaming SSE parser implemented as a Node.js Transform stream.
 *
 * Accepts raw upstream response bytes, parses the SSE protocol
 * (line buffering, `data:` extraction, `[DONE]` detection), accumulates
 * the parsed chunks into a final response object, and emits events:
 *
 *   "chunk"     — emitted for each parsed SSE data frame   (payload: parsed object or raw string)
 *   "done"      — emitted when [DONE] sentinel is received  (payload: accumulated response object)
 *   "error"     — parse error on a non-JSON data frame      (payload: Error)
 *
 * The stream also passes all raw bytes through so it can be used inline
 * in a pipe without consuming the data.
 *
 * @class
 * @extends Transform
 *
 * @example
 * const parser = new SSEParser({ format: "openai" });
 * parser.on("chunk", (chunk) => console.log("chunk:", chunk));
 * parser.on("done", (response) => console.log("complete response:", response));
 * upstreamRes.pipe(parser);
 */
export class SSEParser extends Transform {
  /**
   * @param {object} [opts]
   * @param {string} [opts.format="openai"] - Response format: "openai" | "anthropic".
   *   Controls how chunks are accumulated into a final response object.
   */
  constructor(opts = {}) {
    super({ readableObjectMode: false, writableObjectMode: false });
    this._format = opts.format ?? "openai";
    this._lineBuf = "";
    this._accumulated = this._format === "anthropic" ? _emptyAnthropicResponse() : _emptyOpenAIResponse();
    this._done = false;
  }

  /**
   * Transform chunk — buffer bytes and process complete SSE lines.
   * @override
   */
  _transform(chunk, _encoding, callback) {
    // Pass raw bytes through (so the stream can be piped to the client simultaneously)
    this.push(chunk);

    this._lineBuf += chunk.toString("utf-8");
    let newlineIdx;
    while ((newlineIdx = this._lineBuf.indexOf("\n")) !== -1) {
      const line = this._lineBuf.slice(0, newlineIdx).replace(/\r$/, ""); // strip CR
      this._lineBuf = this._lineBuf.slice(newlineIdx + 1);
      this._processLine(line);
    }

    callback();
  }

  /** Flush any remaining buffered line on stream end. @override */
  _flush(callback) {
    if (this._lineBuf.trim()) {
      this._processLine(this._lineBuf.trim());
      this._lineBuf = "";
    }
    callback();
  }

  /**
   * Process a single decoded SSE line.
   * @private
   * @param {string} line
   */
  _processLine(line) {
    // Skip comments and blank lines
    if (line.startsWith(":") || line === "") return;

    if (line.startsWith("data:")) {
      const raw = line.slice(5).trimStart();

      if (raw === "[DONE]") {
        this._done = true;
        this.emit("done", this._accumulated);
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        this.emit("error", new Error(`SSEParser: invalid JSON in data frame: ${raw.slice(0, 120)}`));
        return;
      }

      // Accumulate into response object
      if (this._format === "anthropic") {
        _accumAnthropicChunk(this._accumulated, parsed);
      } else {
        _accumOpenAIChunk(this._accumulated, parsed);
      }

      this.emit("chunk", parsed);
    }
    // Ignore other field types (event:, id:, retry:) — not needed for proxy use
  }

  /** Whether [DONE] has been received. */
  get done() {
    return this._done;
  }

  /** The accumulated response object built from all received chunks. */
  get accumulated() {
    return this._accumulated;
  }
}

// ---------------------------------------------------------------------------
// Accumulation helpers — build a complete response from streaming chunks
// ---------------------------------------------------------------------------

/**
 * Create an empty OpenAI-format response skeleton for accumulation.
 * @private
 */
function _emptyOpenAIResponse() {
  return {
    id: null,
    object: "chat.completion",
    created: null,
    model: null,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "", tool_calls: [] },
        finish_reason: null,
      },
    ],
    usage: null,
  };
}

/**
 * Merge an OpenAI streaming chunk into the accumulated response object.
 * Handles delta.content concatenation and delta.tool_calls accumulation.
 *
 * @private
 * @param {object} acc - Accumulated response object (mutated in place).
 * @param {object} chunk - Parsed SSE data chunk.
 */
function _accumOpenAIChunk(acc, chunk) {
  // Copy top-level metadata from the first chunk that has it
  if (!acc.id && chunk.id) acc.id = chunk.id;
  if (!acc.created && chunk.created) acc.created = chunk.created;
  if (!acc.model && chunk.model) acc.model = chunk.model;
  if (chunk.usage) acc.usage = chunk.usage;

  const chunkChoice = chunk.choices?.[0];
  if (!chunkChoice) return;

  const accChoice = acc.choices[0];
  const delta = chunkChoice.delta || {};

  // Role (first chunk)
  if (delta.role) accChoice.message.role = delta.role;

  // Content — concatenate
  if (delta.content) accChoice.message.content += delta.content;

  // Tool calls — accumulate by index, concatenating function.arguments
  if (Array.isArray(delta.tool_calls)) {
    for (const dtc of delta.tool_calls) {
      const idx = dtc.index ?? 0;
      const existing = accChoice.message.tool_calls[idx];
      if (!existing) {
        // First chunk for this tool call — initialise the slot
        accChoice.message.tool_calls[idx] = {
          id: dtc.id ?? null,
          type: dtc.type ?? "function",
          function: {
            name: dtc.function?.name ?? "",
            arguments: dtc.function?.arguments ?? "",
          },
        };
      } else {
        // Subsequent chunks — merge id/type/name if not yet set, concat arguments
        if (dtc.id && !existing.id) existing.id = dtc.id;
        if (dtc.type && !existing.type) existing.type = dtc.type;
        if (dtc.function?.name && !existing.function.name) existing.function.name = dtc.function.name;
        if (dtc.function?.arguments) existing.function.arguments += dtc.function.arguments;
      }
    }
  }

  // Finish reason
  if (chunkChoice.finish_reason) accChoice.finish_reason = chunkChoice.finish_reason;
}

/**
 * Create an empty Anthropic-format response skeleton for accumulation.
 * @private
 */
function _emptyAnthropicResponse() {
  return {
    id: null,
    type: "message",
    role: "assistant",
    model: null,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

/**
 * Merge an Anthropic streaming event into the accumulated response object.
 *
 * Handles: message_start, content_block_start, content_block_delta,
 *          content_block_stop, message_delta, message_stop.
 *
 * @private
 * @param {object} acc - Accumulated response object (mutated in place).
 * @param {object} event - Parsed SSE event object.
 */
function _accumAnthropicChunk(acc, event) {
  switch (event.type) {
    case "message_start": {
      const msg = event.message || {};
      if (msg.id) acc.id = msg.id;
      if (msg.model) acc.model = msg.model;
      if (msg.role) acc.role = msg.role;
      if (msg.usage) {
        acc.usage.input_tokens = msg.usage.input_tokens ?? 0;
        acc.usage.output_tokens = msg.usage.output_tokens ?? 0;
      }
      break;
    }
    case "content_block_start": {
      const idx = event.index ?? acc.content.length;
      const block = event.content_block || {};
      // Initialise slot (may arrive out of order in theory, though rare)
      while (acc.content.length <= idx) acc.content.push(null);
      acc.content[idx] = {
        type: block.type ?? "text",
        // text blocks accumulate text, tool_use blocks accumulate input
        ...(block.type === "tool_use"
          ? { id: block.id, name: block.name, input: {} }
          : { text: "" }),
      };
      break;
    }
    case "content_block_delta": {
      const idx = event.index ?? 0;
      const delta = event.delta || {};
      const block = acc.content[idx];
      if (!block) break;
      if (delta.type === "text_delta" && block.type === "text") {
        block.text += delta.text ?? "";
      } else if (delta.type === "input_json_delta" && block.type === "tool_use") {
        // Accumulate raw JSON fragments then parse at the end
        block._rawInput = (block._rawInput ?? "") + (delta.partial_json ?? "");
      }
      break;
    }
    case "content_block_stop": {
      // Parse accumulated tool_use input JSON
      const idx = event.index ?? 0;
      const block = acc.content[idx];
      if (block?.type === "tool_use" && block._rawInput) {
        try {
          block.input = JSON.parse(block._rawInput);
        } catch {
          block.input = { _raw: block._rawInput };
        }
        delete block._rawInput;
      }
      break;
    }
    case "message_delta": {
      const delta = event.delta || {};
      if (delta.stop_reason) acc.stop_reason = delta.stop_reason;
      if (delta.stop_sequence !== undefined) acc.stop_sequence = delta.stop_sequence;
      if (event.usage?.output_tokens !== undefined) acc.usage.output_tokens = event.usage.output_tokens;
      break;
    }
    case "message_stop":
      // Nothing additional to accumulate
      break;
    default:
      // Unknown event types (ping, etc.) — ignore
      break;
  }
}

// ---------------------------------------------------------------------------
// passthroughStream — Forward upstream SSE to client with optional inspection
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PassthroughOptions
 * @property {function(object): void} [onChunk] - Called with each parsed SSE chunk.
 * @property {function(object): void} [onDone] - Called with the accumulated response on [DONE].
 * @property {function(string): string|null} [transformChunk]
 *   Optional transform applied to each raw `data:` line value before forwarding.
 *   Return the replacement string, or null to suppress the frame.
 * @property {string} [format="openai"] - SSE format for the SSEParser ("openai"|"anthropic").
 * @property {boolean} [keepAlive=true] - Whether to emit keep-alive comment frames.
 * @property {number} [keepAliveMs=5000] - Keep-alive interval in ms.
 */

/**
 * Stream an upstream SSE response through to the client response, optionally
 * inspecting or transforming each frame along the way.
 *
 * The function:
 *   1. Writes SSE headers to `clientRes` (merging `upstreamHeaders`).
 *   2. Starts a keep-alive comment timer.
 *   3. Forwards each `data:` line verbatim (or transformed if `opts.transformChunk` is set).
 *   4. Calls `opts.onChunk` for each parsed frame.
 *   5. Calls `opts.onDone` with the fully accumulated response when `[DONE]` arrives.
 *   6. Ends `clientRes` when the upstream stream ends.
 *
 * Returns a Promise that resolves with the accumulated response object once
 * the upstream stream fully ends.
 *
 * @param {import("node:http").IncomingMessage} upstreamRes - Upstream HTTP response stream.
 * @param {import("node:http").ServerResponse} clientRes - Client HTTP response to write into.
 * @param {object} [upstreamHeaders={}] - Upstream response headers (for merging).
 * @param {PassthroughOptions} [opts={}]
 * @returns {Promise<object>} Resolves with accumulated response object.
 */
export function passthroughStream(upstreamRes, clientRes, upstreamHeaders = {}, opts = {}) {
  const {
    onChunk,
    onDone,
    transformChunk,
    format = "openai",
    keepAlive = true,
    keepAliveMs = KEEPALIVE_INTERVAL_MS,
  } = opts;

  // Start SSE response to client
  const writer = new SSEWriter(clientRes, { keepAliveMs: keepAlive ? keepAliveMs : 0 });
  writer.start(upstreamHeaders);

  // Set up SSE parser to accumulate and emit events
  const parser = new SSEParser({ format });

  if (onChunk) parser.on("chunk", onChunk);
  if (onDone) parser.on("done", onDone);

  return new Promise((resolve, reject) => {
    let lineBuf = "";

    upstreamRes.setEncoding("utf-8");

    upstreamRes.on("data", (raw) => {
      // Parse line-by-line to support per-frame transformation, then forward
      lineBuf += raw;
      let idx;
      while ((idx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, idx).replace(/\r$/, "");
        lineBuf = lineBuf.slice(idx + 1);

        if (line.startsWith("data:")) {
          const value = line.slice(5).trimStart();

          if (value === "[DONE]") {
            writer.stop(); // Stop keep-alive before [DONE]
            writer.write("[DONE]");
            writer.writeDone();
            continue;
          }

          // Optional per-frame transform
          if (transformChunk) {
            const replacement = transformChunk(value);
            if (replacement === null) continue; // suppress this frame
            writer.write(replacement);
          } else {
            writer.write(value);
          }
        } else if (line.startsWith(":")) {
          // Comment frame — forward as-is (upstream keep-alives pass through)
          writer.writeComment(line.slice(1).trimStart());
        } else if (line !== "") {
          // Other SSE fields (event:, id:, retry:) — forward verbatim
          try {
            clientRes.write(line + "\n");
          } catch {
            // Client disconnected
          }
        } else {
          // Blank line — forward as separator
          try {
            clientRes.write("\n");
          } catch {
            // Client disconnected
          }
        }
      }

      // Feed raw data into parser for accumulation
      parser.write(Buffer.from(raw));
    });

    upstreamRes.on("end", () => {
      // Flush remaining buffer
      if (lineBuf.trim()) {
        parser.write(Buffer.from(lineBuf));
      }
      parser.end();

      if (!writer.ended) {
        writer.writeDone();
      }
      resolve(parser.accumulated);
    });

    upstreamRes.on("error", (err) => {
      writer.stop();
      if (!writer.ended) {
        try { clientRes.end(); } catch {}
      }
      reject(err);
    });

    clientRes.on("close", () => {
      // Client disconnected early — clean up
      writer.stop();
      upstreamRes.destroy();
    });
  });
}

// ---------------------------------------------------------------------------
// Utility: build SSE headers for manual use
// ---------------------------------------------------------------------------

/**
 * Return a ready-to-use set of SSE response headers, merged with any upstream
 * headers and with conflicting headers removed.
 *
 * @param {object} [upstreamHeaders={}] - Upstream response headers to merge from.
 * @param {object} [extras={}] - Additional headers to apply last.
 * @returns {object} Merged header object suitable for res.writeHead().
 */
export function sseHeaders(upstreamHeaders = {}, extras = {}) {
  const merged = { ...upstreamHeaders };
  delete merged["content-length"];
  delete merged["transfer-encoding"];
  return { ...merged, ...SSE_HEADERS, ...extras };
}

// ---------------------------------------------------------------------------
// Utility: collect a full SSE upstream response into a JSON object (no-stream)
// ---------------------------------------------------------------------------

/**
 * Collect an upstream SSE response stream into a single complete JSON object.
 * Useful when the proxy needs to buffer the full response before forwarding.
 *
 * @param {import("node:http").IncomingMessage} upstreamRes - Upstream response stream.
 * @param {object} [opts]
 * @param {string} [opts.format="openai"] - SSE format ("openai" | "anthropic").
 * @returns {Promise<object>} Resolves with the accumulated response object.
 */
export function collectSSEResponse(upstreamRes, opts = {}) {
  const format = opts.format ?? "openai";
  const parser = new SSEParser({ format });

  return new Promise((resolve, reject) => {
    parser.on("done", resolve);
    parser.on("error", reject);

    upstreamRes.on("error", reject);
    upstreamRes.on("data", (chunk) => parser.write(chunk));
    upstreamRes.on("end", () => {
      parser.end();
      // If upstream ended without [DONE], resolve with whatever we have
      if (!parser.done) resolve(parser.accumulated);
    });
  });
}
