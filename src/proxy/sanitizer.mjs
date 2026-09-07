/**
 * sanitizer.mjs — Content sanitization, PII detection, and DLP scanning for SKGateway
 *
 * Provides four exported functions:
 *
 *   sanitizeResponse(body, config)  — Clean model output (Kimi markup, think blocks, empty content)
 *   sanitizeRequest(body, config)   — Trim oversized system prompts and conversation history
 *   detectPII(text)                 — Detect PII patterns in outbound text (no blocking — flags only)
 *   scanDLP(text, patterns)         — Check text against configurable DLP block-pattern list
 *
 * All functions are pure: they do not mutate their inputs except where the
 * caller passes in a parsed object and explicitly expects in-place mutation
 * (sanitizeRequest follows the existing nvidia-proxy.mjs convention of
 * mutating `body.messages` directly so the caller's reference stays valid).
 *
 * Design notes:
 *  - "Don't block, just flag" — detectPII and scanDLP return findings;
 *    policy enforcement is the caller's responsibility.
 *  - Luhn validation is included for credit-card numbers to cut false positives.
 *  - All regex patterns are pre-compiled at module load time.
 */

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default max bytes for all system messages combined. */
const DEFAULT_MAX_SYSTEM_BYTES = 40_000;

/** Default max bytes for the entire request body (messages array). */
const DEFAULT_MAX_BODY_BYTES = 120_000;

/** Default number of non-system messages to keep from the start of history. */
const DEFAULT_KEEP_START = 2;

/** Default number of non-system messages to keep from the end of history. */
const DEFAULT_KEEP_END = 12;

// ---------------------------------------------------------------------------
// Kimi / leaked-markup patterns (pre-compiled)
// ---------------------------------------------------------------------------

/** Matches a complete Kimi tool-calls section wrapper. */
const RE_TOOL_CALLS_SECTION = /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/g;

/** Matches an individual Kimi tool-call block. */
const RE_TOOL_CALL_BLOCK = /<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/g;

/** Matches a Kimi tool-call argument fragment (may be unterminated). */
const RE_TOOL_CALL_ARGUMENT = /<\|tool_call_argument_begin\|>[\s\S]*?(<\|tool_call_end\|>|$)/g;

/**
 * Matches a single complete Kimi tool-call expressed as leaked markup, with
 * named capture groups for the function id and JSON arguments.
 *
 * Ported from hermes-agent's `kimi_k2_parser.py` (VLLM-derived). The id format
 * is `functions.tool_name:idx` or `tool_name:idx`.
 *
 * The lazy `[\s\S]*?` for arguments is bounded by `<|tool_call_end|>`; we don't
 * use the python parser's negative-lookahead variant because the lazy match
 * naturally terminates at the first end marker.
 */
const RE_KIMI_TOOL_CALL_RECOVER =
  /<\|tool_call_begin\|>\s*([^<]+:\d+)\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/g;

/** Detects ANY kimi tool-call markup token in a string. */
const RE_KIMI_HAS_MARKUP =
  /<\|tool_calls?_section_begin\|>|<\|tool_call_begin\|>/;

/**
 * Matches leaked chain-of-thought / planning monologue at the start of a
 * response.  Kimi K2.5 occasionally leaks its reasoning as visible text.
 * The pattern deliberately covers multi-line planning sequences.
 */
const RE_THINKING_PREAMBLE =
  /^(The user wants me to|I need to|I should|Let me first|First,? I'?ll|I'?ll start by|My plan is to|Actually,? I|Looking at|Now I need|Good,? the|The instructions? (?:mention|say)|Read required|\d+\.\s+(?:Read|Check|Search|Call|Use|Get|Then|First|Next))[^\n]*\n?(\n?(I should|I need to|Let me|I'?ll|Then I|First|Next|Actually|However|Now|Good|\d+\.)[^\n]*\n?)*/i;

/**
 * Matches `<think>...</think>` blocks emitted by some reasoning models
 * (e.g. DeepSeek R1, QwQ).
 */
const RE_THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;

/** Three or more consecutive newlines — collapsed to two after strip. */
const RE_EXCESS_NEWLINES = /\n{3,}/g;

// ---------------------------------------------------------------------------
// PII detection patterns (pre-compiled)
// ---------------------------------------------------------------------------

/** US/international email address. */
const RE_EMAIL = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;

/**
 * US phone numbers in common formats:
 *   (555) 867-5309, 555-867-5309, +1 555 867 5309, 5558675309
 */
const RE_PHONE_US =
  /(?:\+?1[\s\-.]?)?\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4}\b/g;

/**
 * International phone numbers starting with + and 7-15 digits.
 * Avoids matching short numeric strings by requiring at least 9 digits.
 */
const RE_PHONE_INTL = /\+[1-9]\d{1,3}[\s\-.]?(?:\d[\s\-.]?){6,12}\d/g;

/**
 * US Social Security Numbers: NNN-NN-NNNN or NNNNNNNNN.
 * The pattern avoids matching pure date strings.
 */
const RE_SSN = /\b(?!000|666|9\d{2})\d{3}[- ]?(?!00)\d{2}[- ]?(?!0{4})\d{4}\b/g;

/**
 * Credit card numbers: 13-19 consecutive digits, optionally separated by
 * spaces or dashes in groups of 4.  Luhn validation is applied after match.
 */
const RE_CC = /\b(?:\d[ \-]?){13,19}\b/g;

/** IPv4 addresses. */
const RE_IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/**
 * Private IPv4 ranges:
 *   10.x.x.x, 172.16-31.x.x, 192.168.x.x, 127.x.x.x, 169.254.x.x
 */
const RE_PRIVATE_IPV4 =
  /^(?:10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+)$/;

/** API keys / tokens in common formats. */
const RE_API_KEY_PATTERNS = [
  { type: "openai_key",    re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { type: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9\-]{20,}\b/g },
  { type: "github_pat",    re: /\bghp_[A-Za-z0-9]{30,}\b/g },
  { type: "github_oauth",  re: /\bgho_[A-Za-z0-9]{30,}\b/g },
  { type: "github_actions",re: /\bghs_[A-Za-z0-9]{30,}\b/g },
  { type: "aws_access_key",re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "aws_secret_key",re: /\b[0-9a-zA-Z/+]{40}\b/g },
  { type: "stripe_key",    re: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { type: "jwt",           re: /\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\b/g },
  { type: "bearer_token",  re: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi },
];

// ---------------------------------------------------------------------------
// PII risk levels
// ---------------------------------------------------------------------------

/**
 * Maps PII type → risk level string used in detection results.
 * @type {Record<string, "critical"|"high"|"medium"|"low">}
 */
const PII_RISK = {
  email:         "medium",
  phone_us:      "medium",
  phone_intl:    "medium",
  ssn:           "critical",
  credit_card:   "critical",
  ipv4_public:   "low",
  ipv4_private:  "medium",
  openai_key:    "critical",
  anthropic_key: "critical",
  github_pat:    "critical",
  github_oauth:  "critical",
  github_actions:"critical",
  aws_access_key:"critical",
  aws_secret_key:"critical",
  stripe_key:    "critical",
  jwt:           "high",
  bearer_token:  "high",
};

// ---------------------------------------------------------------------------
// Luhn algorithm for credit-card validation
// ---------------------------------------------------------------------------

/**
 * Returns true if the digit-only string passes the Luhn check.
 *
 * @param {string} digits - String of digit characters only.
 * @returns {boolean}
 */
function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Recover leaked Kimi K2 tool-call markup from a text string into a proper
 * `tool_calls` array.
 *
 * kimi-k2 (notably k2.6 on NVIDIA NIM) sometimes emits tool calls as raw
 * markup tokens inside `message.content` instead of populating the proper
 * `message.tool_calls` field. The previous behavior was to strip the markup
 * — losing the model's intent and forcing it to retry. This helper parses
 * the markup into structured tool calls so the gateway can dispatch them.
 *
 * Format (per Moonshot tokenizer / VLLM `KimiK2ToolParser`):
 *   <|tool_calls_section_begin|>
 *   <|tool_call_begin|>{function_id}<|tool_call_argument_begin|>{json}<|tool_call_end|>
 *   <|tool_calls_section_end|>
 *
 * Where `function_id` is `functions.tool_name:idx` or `tool_name:idx`.
 *
 * Returns `{ content, toolCalls }`. `content` is the text BEFORE the first
 * tool-call marker (trimmed). `toolCalls` is an array of OpenAI-style
 * `{id, type, function: {name, arguments}}` objects, or `[]` if no recovery
 * was possible.
 *
 * Pure: does not mutate input.
 *
 * @param {string} text
 * @returns {{ content: string, toolCalls: object[] }}
 */
export function recoverKimiToolCalls(text) {
  if (!text || typeof text !== "string") return { content: text ?? "", toolCalls: [] };
  if (!RE_KIMI_HAS_MARKUP.test(text)) return { content: text, toolCalls: [] };

  RE_KIMI_TOOL_CALL_RECOVER.lastIndex = 0;
  const matches = [...text.matchAll(RE_KIMI_TOOL_CALL_RECOVER)];
  if (matches.length === 0) return { content: text, toolCalls: [] };

  const toolCalls = matches.map((m) => {
    const functionId = m[1].trim();
    const args = m[2].trim();
    // "functions.get_weather:0" -> "get_weather"; "get_weather:0" -> "get_weather"
    const name = functionId.split(":")[0].split(".").pop();
    return {
      id: functionId,
      type: "function",
      function: { name, arguments: args },
    };
  });

  // Content = text before the first markup token (section begin OR call begin)
  RE_KIMI_HAS_MARKUP.lastIndex = 0;
  const markerMatch = text.match(RE_KIMI_HAS_MARKUP);
  const sectionStart = markerMatch ? markerMatch.index : text.length;
  const content = text.slice(0, sectionStart).trim();

  return { content, toolCalls };
}

/**
 * Strip all Kimi K2.5 leaked tool-call markup from a text string.
 * Also removes leaked chain-of-thought planning preambles.
 *
 * Ported from nvidia-proxy.mjs `sanitizeContent()` with the following
 * enhancements:
 *  - Uses reset-index approach to avoid stale lastIndex on global regexes.
 *  - Handles the thinking preamble pattern from both proxy scripts.
 *
 * @param {string} text - Raw model output text.
 * @param {object} [opts]
 * @param {string} [opts.label="sanitizer"] - Log prefix used in console output.
 * @returns {string} Cleaned text.
 */
function stripKimiMarkup(text, { label = "sanitizer" } = {}) {
  if (!text) return text;

  let cleaned = text;

  // Reset lastIndex before each global replace to avoid stateful regex bugs
  RE_TOOL_CALLS_SECTION.lastIndex = 0;
  RE_TOOL_CALL_BLOCK.lastIndex = 0;
  RE_TOOL_CALL_ARGUMENT.lastIndex = 0;

  cleaned = cleaned.replace(RE_TOOL_CALLS_SECTION, "");
  cleaned = cleaned.replace(RE_TOOL_CALL_BLOCK, "");
  cleaned = cleaned.replace(RE_TOOL_CALL_ARGUMENT, "");

  // Strip leaked planning preamble
  const thinkingMatch = cleaned.match(RE_THINKING_PREAMBLE);
  if (thinkingMatch) {
    const preamble = thinkingMatch[0];
    const remainder = cleaned.slice(preamble.length).trim();
    if (!remainder) {
      console.log(`[${label}] SANITIZED: stripped entire planning preamble (${preamble.length} chars)`);
      cleaned = "";
    } else if (remainder.length > 50) {
      console.log(`[${label}] SANITIZED: stripped planning preamble (${preamble.length} chars), kept ${remainder.length} chars`);
      cleaned = remainder;
    }
  }

  if (cleaned === text) return text;

  // Collapse excess whitespace
  cleaned = cleaned.replace(RE_EXCESS_NEWLINES, "\n\n").trim();

  if (cleaned !== text) {
    console.log(`[${label}] SANITIZED: stripped Kimi markup (${text.length} → ${cleaned.length} chars)`);
  }
  return cleaned;
}

/**
 * Handle `<think>...</think>` blocks according to config.
 *
 * @param {string} text
 * @returns {{ text: string, hadThinking: boolean }}
 */
function handleThinkBlocks(text) {
  if (!text || !RE_THINK_BLOCK.test(text)) return { text, hadThinking: false };

  RE_THINK_BLOCK.lastIndex = 0;
  const matches = [...text.matchAll(RE_THINK_BLOCK)];
  if (matches.length === 0) return { text, hadThinking: false };

  RE_THINK_BLOCK.lastIndex = 0;
  let result = text.replace(RE_THINK_BLOCK, "");

  result = result.replace(RE_EXCESS_NEWLINES, "\n\n").trim();
  return { text: result, hadThinking: true };
}

// ---------------------------------------------------------------------------
// Public API: sanitizeResponse
// ---------------------------------------------------------------------------

/**
 * Sanitize an OpenAI-compatible chat completion response body.
 *
 * Mutations are applied to a shallow clone of the body object so the caller's
 * reference is not modified (choices array entries are mutated in-place on the
 * clone).
 *
 * Operations performed (in order):
 *  1a. Recover leaked Kimi K2 tool-call markup in `message.content` into
 *      proper `message.tool_calls` (only if `tool_calls` is empty); when
 *      recovery succeeds, preserve the upstream terminal reason.
 *  1b. Strip any remaining Kimi K2.5 leaked tool-call markup from
 *      `message.content`.
 *  2. Strip `<think>...</think>` blocks.
 *  3. Remove private reasoning fields without creating public content.
 *  4. Preserve tool-call arguments exactly as received.
 *  5. Preserve public content bytes exactly when no private marker is removed.
 *
 * @param {object} body - Parsed JSON response body from the upstream model.
 * @param {object} [config={}]
 * @param {string} [config.label="sanitizer"]
 *   Log prefix for console output.
 * @returns {object} Sanitized body (shallow clone of input).
 */
export function sanitizeResponse(body, config = {}) {
  if (!body || typeof body !== "object") return body;

  const label = config.label ?? "sanitizer";

  // Shallow clone to avoid mutating caller's object
  const out = { ...body };
  if (!Array.isArray(out.choices)) return out;

  out.choices = out.choices.map((choice) => {
    const c = { ...choice };
    if (!c.message) return c;

    c.message = { ...c.message };

    // --- Step 1a: Recover leaked tool-call markup into structured tool_calls ---
    // Only attempt recovery when the message has no proper tool_calls already;
    // if NVIDIA NIM correctly parsed the tokens we don't want to double-dispatch.
    if (
      typeof c.message.content === "string" &&
      !(Array.isArray(c.message.tool_calls) && c.message.tool_calls.length > 0) &&
      RE_KIMI_HAS_MARKUP.test(c.message.content)
    ) {
      const { content: recoveredContent, toolCalls: recovered } =
        recoverKimiToolCalls(c.message.content);
      if (recovered.length > 0) {
        c.message.tool_calls = recovered;
        c.message.content = recoveredContent;
        const names = recovered.map((tc) => tc.function?.name).join(",");
        console.log(
          `[${label}] SANITIZED: recovered ${recovered.length} tool_call(s) from leaked markup [${names}]`
        );
      }
    }

    // --- Step 1b: Strip remaining Kimi leaked markup from text content ---
    if (typeof c.message.content === "string") {
      c.message.content = stripKimiMarkup(c.message.content, { label });
    }

    // --- Step 2: Handle <think> blocks ---
    if (typeof c.message.content === "string") {
      const { text, hadThinking } = handleThinkBlocks(c.message.content);
      if (hadThinking) {
        console.log(`[${label}] SANITIZED: stripped <think> block`);
        c.message.content = text;
      }
    }

    // --- Step 3: Remove private reasoning without modifying public evidence ---
    delete c.message.reasoning;
    delete c.message.reasoning_content;
    delete c.message.analysis;

    return c;
  });

  return out;
}

// ---------------------------------------------------------------------------
// Tool-pairing repair (internal helper)
// ---------------------------------------------------------------------------

/**
 * Repair OpenAI-style assistant(tool_calls)↔tool pairing after a tail slice.
 *
 * Trimming the conversation tail can leave two kinds of broken state that
 * cause hallucinations (notably kimi-k2.6 returning CJK + emoji noise):
 *
 *   1. Leading orphan `tool` messages whose parent assistant(tool_calls) was
 *      dropped from the slice.
 *   2. An assistant(tool_calls) whose set of `tool_call_id` responses is
 *      incomplete inside the slice (some tool replies live in the dropped
 *      middle, or the slice ends before all tool replies arrive).
 *
 * Repairs (in order):
 *   a. Drop any leading `tool`/`toolResult` messages.
 *   b. Walk forward; for each assistant with non-empty `tool_calls`, verify
 *      every `tc.id` has a matching `tool_call_id` in the immediately
 *      following tool block. If any id is missing, drop the assistant and
 *      its partial tool replies as a unit.
 *
 * Pure: does not mutate input, returns a new array.
 *
 * @param {object[]} slice
 * @returns {object[]}
 */
export function repairToolPairing(slice) {
  if (!Array.isArray(slice) || slice.length === 0) return slice;

  // Step 1: drop leading orphan tool messages.
  let start = 0;
  while (
    start < slice.length &&
    (slice[start].role === "tool" || slice[start].role === "toolResult")
  ) {
    start++;
  }
  const trimmed = start === 0 ? slice : slice.slice(start);

  // Step 2: walk forward, validating each assistant(tool_calls) block.
  const out = [];
  for (let i = 0; i < trimmed.length; i++) {
    const m = trimmed[i];
    if (
      m.role === "assistant" &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0
    ) {
      const expectedIds = m.tool_calls
        .map((tc) => tc && tc.id)
        .filter((id) => typeof id === "string" && id.length > 0);
      const seenIds = new Set();
      let j = i + 1;
      while (
        j < trimmed.length &&
        (trimmed[j].role === "tool" || trimmed[j].role === "toolResult")
      ) {
        if (typeof trimmed[j].tool_call_id === "string") {
          seenIds.add(trimmed[j].tool_call_id);
        }
        j++;
      }
      const allPresent =
        expectedIds.length === 0 || expectedIds.every((id) => seenIds.has(id));
      if (!allPresent) {
        // Drop this assistant and its partial tool replies as a unit.
        i = j - 1;
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API: trimHistoryToBudget
// ---------------------------------------------------------------------------

/**
 * Trim a request body's conversation history so the serialized body stays
 * under `maxBodyBytes`. Single source of truth for the history-trim algorithm
 * — both `sanitizeRequest` here and `trimConversationHistory` in core.mjs
 * delegate to this function.
 *
 * Assumes the caller has already:
 *   - Truncated oversized tool-result messages.
 *   - Trimmed oversized system messages.
 *
 * Strategy (in order):
 *   1. If body is already under budget, no-op.
 *   2. Drop middle messages: keep first `keepStart` non-system + last `keepEnd`
 *      non-system, with a "[N earlier messages trimmed]" system notice between.
 *      Progressively shrink `keepEnd` from its max down to 2 until under budget.
 *   3. Aggressive fallback: system + first user + last 4, then last 2.
 *   4. Absolute last resort: system + first user + last 2 (returned even if
 *      still over budget — caller decides what to do).
 *
 * Every tail slice is passed through `repairToolPairing` to drop orphan
 * `tool` messages and incomplete `assistant(tool_calls)` blocks. Without this
 * repair, kimi-k2.6 hallucinates CJK + emoji noise when the slice begins with
 * an orphan tool result (2026-05-16 ocp-coherence-watch incident).
 *
 * Mutates `body.messages` in place (following nvidia-proxy.mjs convention).
 *
 * @param {object} body                 Parsed request body.
 * @param {object} [options]
 * @param {number} [options.maxBodyBytes=120000]
 * @param {number} [options.keepStart=2]
 * @param {number} [options.keepEnd=12]
 * @param {string} [options.label="sanitizer"]   Log prefix.
 * @param {(msg: string) => void} [options.log] Custom logger; defaults to
 *   `console.log` with the label prefix.
 * @param {string} [options.aggressiveNotice]    Body of the system "fall-back"
 *   notice inserted when only first-user + tail survive. Defaults to a generic
 *   phrasing; callers may override (e.g. core.mjs uses a slightly different
 *   wording for back-compat).
 * @returns {object} The same `body` object.
 */
export function trimHistoryToBudget(body, options = {}) {
  if (!body || !Array.isArray(body.messages)) return body;

  const maxBodyBytes      = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const keepStart         = options.keepStart    ?? DEFAULT_KEEP_START;
  const keepEndMax        = options.keepEnd      ?? DEFAULT_KEEP_END;
  const label             = options.label        ?? "sanitizer";
  const log               = options.log          ?? ((m) => console.log(`[${label}] ${m}`));
  const aggressiveNotice  = options.aggressiveNotice
    ?? "[earlier messages trimmed — answer using tool results below]";

  if (body.messages.length < 6) return body;

  let bodySize = Buffer.byteLength(JSON.stringify(body), "utf-8");
  const roleSummary = body.messages.map((m) => m.role).join(",");
  log(`conversation roles (${body.messages.length} msgs): ${roleSummary}`);
  if (bodySize <= maxBodyBytes) return body;

  const system    = body.messages.filter((m) => m.role === "system");
  const nonSystem = body.messages.filter((m) => m.role !== "system");

  if (nonSystem.length <= 4) return body;

  let keepEnd = Math.min(keepEndMax, nonSystem.length - keepStart);

  // Pass A: progressively shrink tail until under budget
  while (keepEnd >= 2) {
    const dropped = nonSystem.length - keepStart - keepEnd;
    const rawTail = nonSystem.slice(-keepEnd);
    const tail = repairToolPairing(rawTail);
    const tailRepaired = tail.length !== rawTail.length;
    const candidate = [
      ...system,
      ...nonSystem.slice(0, keepStart),
      ...(dropped > 0
        ? [{ role: "system", content: `[${dropped} earlier messages trimmed to save context]` }]
        : []),
      ...tail,
    ];
    const candidateSize = Buffer.byteLength(
      JSON.stringify({ ...body, messages: candidate }), "utf-8",
    );
    if (candidateSize <= maxBodyBytes) {
      const assembled = repairToolPairing(candidate);
      body.messages = assembled;
      log(
        `trimmed history: dropped ${dropped} middle messages, keepEnd=${keepEnd}, bodyLen ~${candidateSize}` +
        (tailRepaired ? ` (repaired tool pairing: ${rawTail.length}→${tail.length})` : "") +
        (assembled.length !== candidate.length ? ` (repaired head/tail boundary: ${candidate.length}→${assembled.length})` : ""),
      );
      return body;
    }
    keepEnd--;
  }

  // Pass B: aggressive — system + first user + last N
  const firstUser = nonSystem.find((m) => m.role === "user");
  for (const tailSize of [4, 2]) {
    const rawLastN = nonSystem.slice(-tailSize);
    const lastN = repairToolPairing(rawLastN);
    const tailRepaired = lastN.length !== rawLastN.length;
    const minimal = [
      ...system,
      ...(firstUser && !lastN.includes(firstUser)
        ? [firstUser, { role: "system", content: aggressiveNotice }]
        : []),
      ...lastN,
    ];
    const candidateSize = Buffer.byteLength(
      JSON.stringify({ ...body, messages: minimal }), "utf-8",
    );
    if (candidateSize <= maxBodyBytes) {
      const assembled = repairToolPairing(minimal);
      body.messages = assembled;
      log(
        `trimmed history: AGGRESSIVE — kept system + first user + last ${tailSize}, bodyLen ~${candidateSize}` +
        (tailRepaired ? ` (repaired tool pairing: ${rawLastN.length}→${lastN.length})` : "") +
        (assembled.length !== minimal.length ? ` (repaired head/tail boundary: ${minimal.length}→${assembled.length})` : ""),
      );
      return body;
    }
  }

  // Pass C: absolute last resort
  const rawLastTwo = nonSystem.slice(-2);
  const lastTwo = repairToolPairing(rawLastTwo);
  const tailRepaired = lastTwo.length !== rawLastTwo.length;
  body.messages = repairToolPairing([
    ...system,
    ...(firstUser && !lastTwo.includes(firstUser)
      ? [firstUser, { role: "system", content: aggressiveNotice }]
      : []),
    ...lastTwo,
  ]);
  bodySize = Buffer.byteLength(JSON.stringify(body), "utf-8");
  log(
    `trimmed history: ABSOLUTE LAST RESORT — kept system + first user + last 2, bodyLen ~${bodySize}` +
    (tailRepaired ? ` (repaired tool pairing: ${rawLastTwo.length}→${lastTwo.length})` : ""),
  );
  return body;
}

// ---------------------------------------------------------------------------
// Public API: sanitizeRequest
// ---------------------------------------------------------------------------

/**
 * Sanitize an outbound chat completion request body.
 *
 * Mutates `body.messages` in-place (following the existing nvidia-proxy.mjs
 * convention so callers that hold a reference to the messages array see the
 * trimmed result automatically).
 *
 * Operations performed (in order):
 *  1. Truncate large tool-result messages (kept to `config.toolResultMaxChars`).
 *  2. Trim system messages if total system bytes exceed `config.maxSystemBytes`.
 *  3. Trim conversation history if total body bytes exceed `config.maxBodyBytes`.
 *     Strategy:
 *       a. Keep `keepStart` non-system messages from the front (identity/rehydration).
 *       b. Keep up to `keepEnd` non-system messages from the tail.
 *       c. Drop middle messages, inserting a trim notice.
 *       d. If still over budget, progressively shrink tail down to 2.
 *       e. Last resort: system + first user message + last 2.
 *     Every tail slice is passed through `repairToolPairing` to drop orphan
 *     `tool` messages and incomplete assistant(tool_calls) blocks — kimi-k2.6
 *     specifically hallucinates CJK + emoji noise on malformed pairing.
 *
 * @param {object} body - Parsed JSON request body (mutated in-place for messages).
 * @param {object} [config={}]
 * @param {number} [config.maxSystemBytes=40000]
 *   Hard cap on total system-message bytes.
 * @param {number} [config.maxBodyBytes=120000]
 *   Hard cap on total serialized request body bytes.
 * @param {number} [config.keepStart=2]
 *   Number of non-system messages to keep from the start of history.
 * @param {number} [config.keepEnd=12]
 *   Maximum number of non-system messages to keep from the tail.
 * @param {number} [config.toolResultMaxChars=1500]
 *   Characters to keep in each tool-result content string before truncating.
 * @param {string} [config.label="sanitizer"]
 *   Log prefix for console output.
 * @returns {object} The same `body` object (mutations already applied).
 */
export function sanitizeRequest(body, config = {}) {
  if (!body || !Array.isArray(body.messages)) return body;

  const label              = config.label              ?? "sanitizer";
  const maxSystemBytes     = config.maxSystemBytes     ?? DEFAULT_MAX_SYSTEM_BYTES;
  const maxBodyBytes       = config.maxBodyBytes       ?? DEFAULT_MAX_BODY_BYTES;
  const keepStart          = config.keepStart          ?? DEFAULT_KEEP_START;
  const keepEndMax         = config.keepEnd            ?? DEFAULT_KEEP_END;
  const toolResultMaxChars = config.toolResultMaxChars ?? 1500;

  // --- Step 1: Truncate oversized tool-result messages ---
  for (const m of body.messages) {
    if (m.role !== "tool" && m.role !== "toolResult") continue;
    if (typeof m.content === "string" && m.content.length > toolResultMaxChars) {
      m.content = m.content.slice(0, toolResultMaxChars) + "\n...[truncated]";
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > toolResultMaxChars) {
          block.text = block.text.slice(0, toolResultMaxChars) + "\n...[truncated]";
        }
      }
    }
  }

  // --- Step 2: Trim system messages ---
  const sysMsgs = body.messages.filter(
    (m) => m.role === "system" && typeof m.content === "string",
  );
  if (sysMsgs.length > 0) {
    const beforeBytes = sysMsgs.reduce(
      (sum, m) => sum + Buffer.byteLength(m.content, "utf-8"), 0,
    );
    if (beforeBytes > maxSystemBytes) {
      // Sort largest first, trim until under budget
      const sorted = [...sysMsgs].sort((a, b) => b.content.length - a.content.length);
      let trimmedCount = 0;
      for (const msg of sorted) {
        const currentBytes = body.messages
          .filter((m) => m.role === "system" && typeof m.content === "string")
          .reduce((sum, m) => sum + Buffer.byteLength(m.content, "utf-8"), 0);
        if (currentBytes <= maxSystemBytes) break;
        if (msg.content.length <= 4000) break;
        const head = msg.content.slice(0, 3000);
        const tail = msg.content.slice(-1000);
        msg.content =
          head +
          "\n\n[...content trimmed to save context — use memory tool for full identity...]\n\n" +
          tail;
        trimmedCount++;
      }
      if (trimmedCount > 0) {
        const afterBytes = body.messages
          .filter((m) => m.role === "system" && typeof m.content === "string")
          .reduce((sum, m) => sum + Buffer.byteLength(m.content, "utf-8"), 0);
        console.log(
          `[${label}] trimmed system prompt: ${beforeBytes} → ${afterBytes} bytes (${trimmedCount} msgs)`,
        );
      }
    }
  }

  // --- Step 3: Trim conversation history (delegate to shared helper) ---
  trimHistoryToBudget(body, {
    maxBodyBytes,
    keepStart,
    keepEnd: keepEndMax,
    label,
  });
  return body;
}

// ---------------------------------------------------------------------------
// Public API: detectPII
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PIIFinding
 * @property {string} type     - PII category (e.g. "email", "ssn", "credit_card").
 * @property {string} match    - The matched substring (may be partially redacted for logs).
 * @property {number} position - Index of the match start in the input string.
 * @property {"critical"|"high"|"medium"|"low"} risk - Risk level.
 */

/**
 * Scan `text` for common PII patterns.
 *
 * Does NOT block or redact — returns an array of findings so the policy
 * engine can decide the appropriate action (log, redact, block, alert).
 *
 * Patterns detected:
 *  - Email addresses
 *  - US phone numbers
 *  - International phone numbers
 *  - US Social Security Numbers
 *  - Credit card numbers (Luhn-validated)
 *  - IPv4 addresses (classified as private or public)
 *  - API keys / tokens (OpenAI, Anthropic, GitHub PAT/OAuth/Actions, AWS, Stripe, JWT, Bearer)
 *
 * @param {string} text - Text to scan.
 * @returns {PIIFinding[]} Array of findings (empty if none detected).
 */
export function detectPII(text) {
  if (!text || typeof text !== "string") return [];

  /** @type {PIIFinding[]} */
  const findings = [];

  // Helper: add finding with partial match redaction for safe logging
  function addFinding(type, match, position) {
    const risk = PII_RISK[type] ?? "medium";
    // Redact all but first 4 and last 2 chars for critical/high risk
    let safeMatch = match;
    if ((risk === "critical" || risk === "high") && match.length > 8) {
      safeMatch = match.slice(0, 4) + "*".repeat(match.length - 6) + match.slice(-2);
    }
    findings.push({ type, match: safeMatch, position, risk });
  }

  // Reset and run each pattern
  RE_EMAIL.lastIndex = 0;
  for (const m of text.matchAll(RE_EMAIL)) {
    addFinding("email", m[0], m.index);
  }

  RE_PHONE_US.lastIndex = 0;
  for (const m of text.matchAll(RE_PHONE_US)) {
    // Avoid matching things that look like model version numbers (e.g. 3.5-turbo)
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 10) addFinding("phone_us", m[0], m.index);
  }

  RE_PHONE_INTL.lastIndex = 0;
  for (const m of text.matchAll(RE_PHONE_INTL)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 9) addFinding("phone_intl", m[0], m.index);
  }

  RE_SSN.lastIndex = 0;
  for (const m of text.matchAll(RE_SSN)) {
    addFinding("ssn", m[0], m.index);
  }

  RE_CC.lastIndex = 0;
  for (const m of text.matchAll(RE_CC)) {
    const digits = m[0].replace(/[ \-]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      addFinding("credit_card", m[0], m.index);
    }
  }

  RE_IPV4.lastIndex = 0;
  for (const m of text.matchAll(RE_IPV4)) {
    // Validate each octet is 0-255
    const octets = m[0].split(".").map(Number);
    if (octets.every((o) => o >= 0 && o <= 255)) {
      const isPrivate = RE_PRIVATE_IPV4.test(m[0]);
      addFinding(isPrivate ? "ipv4_private" : "ipv4_public", m[0], m.index);
    }
  }

  for (const { type, re } of RE_API_KEY_PATTERNS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      addFinding(type, m[0], m.index);
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Public API: scanDLP
// ---------------------------------------------------------------------------

/**
 * @typedef {object} DLPMatch
 * @property {string|RegExp} pattern - The pattern that matched.
 * @property {string}        match   - The matched substring.
 * @property {number}        index   - Index of the match start in the text.
 * @property {string}        [label] - Optional human-readable label from config.
 */

/**
 * @typedef {object} DLPResult
 * @property {boolean}    blocked  - True if any pattern matched (policy signal).
 * @property {DLPMatch[]} matches  - All matches found (empty if none).
 */

/**
 * Scan `text` against a configurable list of DLP block patterns.
 *
 * Each entry in `patterns` may be:
 *  - A `RegExp` — used directly.
 *  - A string   — compiled to a case-insensitive RegExp with the `g` flag.
 *  - An object  `{ pattern: string|RegExp, label?: string }`.
 *
 * Returns a `DLPResult` describing whether any pattern matched and what was
 * found.  Does NOT block the request — the caller decides the action.
 *
 * @param {string} text - Text to scan (typically a request prompt or response).
 * @param {Array<string|RegExp|{pattern: string|RegExp, label?: string}>} [patterns=[]]
 *   DLP patterns to check.
 * @returns {DLPResult}
 */
// ---------------------------------------------------------------------------
// Compatibility shim: sanitizeContent(text) → string
// ---------------------------------------------------------------------------

/**
 * Simple text-only sanitizer shim compatible with the `cfg.sanitizer` slot
 * in core.mjs `ProxyConfig`.
 *
 * Applies Kimi K2.5 leaked markup stripping and planning-preamble removal
 * to a plain text string and returns the cleaned string.  This wraps the
 * internal `stripKimiMarkup` helper so callers don't need to deal with the
 * full `sanitizeResponse()` pipeline when they only have a raw string.
 *
 * Used as the default `cfg.sanitizer` function in `buildConfig()`.
 *
 * @param {string} text - Raw model output text.
 * @param {string} [label="skgateway"] - Log tag used in console output.
 * @returns {string} Cleaned text.
 */
export function sanitizeContent(text, label = "skgateway") {
  return stripKimiMarkup(text, { label });
}

export function scanDLP(text, patterns = []) {
  if (!text || typeof text !== "string" || !Array.isArray(patterns) || patterns.length === 0) {
    return { blocked: false, matches: [] };
  }

  /** @type {DLPMatch[]} */
  const matches = [];

  for (const entry of patterns) {
    let re;
    let label;

    if (entry instanceof RegExp) {
      // Clone with global flag to safely use matchAll
      re = new RegExp(entry.source, entry.flags.includes("g") ? entry.flags : entry.flags + "g");
    } else if (typeof entry === "string") {
      re = new RegExp(entry, "gi");
    } else if (entry && typeof entry === "object") {
      const src = entry.pattern instanceof RegExp ? entry.pattern.source : entry.pattern;
      const flags = entry.pattern instanceof RegExp
        ? (entry.pattern.flags.includes("g") ? entry.pattern.flags : entry.pattern.flags + "g")
        : "gi";
      re = new RegExp(src, flags);
      label = entry.label;
    } else {
      continue; // skip malformed entry
    }

    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      /** @type {DLPMatch} */
      const hit = { pattern: entry, match: m[0], index: m.index };
      if (label) hit.label = label;
      matches.push(hit);
    }
  }

  return { blocked: matches.length > 0, matches };
}
