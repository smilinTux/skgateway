/**
 * difficulty.mjs — Per-request DIFFICULTY scorer for SKGateway "sk-auto" routing.
 *
 * Given the OpenAI-style `messages` array of a chat request, decide which
 * logical role should serve it. This lets the registry role `sk-auto` pick the
 * cheapest capable model per request:
 *
 *   image present        -> sk-vision  (a vision:true backend, e.g. qwen-vl)
 *   hard / heavy prompt   -> sk-heavy   (the strong model, e.g. opus)
 *   everything else       -> sk-default (local/free, e.g. ornith)
 *
 * DESIGN
 *  - Pure, synchronous, dependency-free HEURISTIC. No extra LLM call, no I/O.
 *    classifyDifficulty(messages[, opts]) is a pure function of its inputs and
 *    is therefore trivially unit-testable.
 *  - "Fast path first": vision is checked before the (slightly) more expensive
 *    text scan, and the text scan is a handful of pre-compiled regexes.
 *  - Thresholds/keyword lists are overridable via an optional `opts` object
 *    (the gateway passes the registry `auto:` block here) but every knob has a
 *    sane built-in default, so calling with no opts Just Works.
 *
 * PRECEDENCE (first match wins):  vision  >  hard  >  default
 *
 * @module classifiers/difficulty
 */

// ---------------------------------------------------------------------------
// Built-in defaults (overridable via the registry `auto:` block)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AutoThresholds
 * @property {number}   [max_easy_chars]  Total user-text length (chars) at/above
 *                                         which a prompt is considered HARD on
 *                                         size alone. Default 2000.
 * @property {string[]} [hard_verbs]      Complex/expensive verbs that (combined
 *                                         with a code fence) mark a prompt HARD.
 * @property {string[]} [reasoning_cues]  Multi-step reasoning phrases -> HARD.
 * @property {string}   [heavy_role]      Role name for HARD prompts. Default "sk-heavy".
 * @property {string}   [vision_role]     Role name for image prompts. Default "sk-vision".
 * @property {string}   [default_role]    Role name otherwise. Default "sk-default".
 */

/** Default heavy/complex verbs (as a regex alternation body). */
const DEFAULT_HARD_VERBS = [
  "refactor", "debug", "architect", "design", "optimi[sz]e",
  "migrate", "implement", "prove", "derive",
];

/** Default multi-step reasoning cues (as a regex alternation body). */
const DEFAULT_REASONING_CUES = [
  "step[ -]?by[ -]?step", "reason through", "trade-?off", "compare and",
  "evaluate", "analy[sz]e", "why does",
];

const DEFAULT_MAX_EASY_CHARS = 2000;
const DEFAULT_HEAVY_ROLE = "sk-heavy";

/**
 * Infra / ops / system-status intent. These need FAITHFUL parsing of real command
 * output — the small default model confabulates hardware specs (invents CPU/GPU
 * names, driver versions, inverts which GPU runs what), so route them to the heavy
 * model. Matches ops command names, hardware terms, and "check the server" intent.
 */
const INFRA_RE = new RegExp(
  "\\b(" +
  // command / tooling names
  "nvidia-smi|intel_gpu_top|systemctl|journalctl|dmesg|lspci|lsblk|docker|kubectl|" +
  "df\\s*-h|free\\s*-h|htop|nproc|uptime|ssh\\b|ss\\s*-|iostat|vmstat|sensors|" +
  // hardware / resource terms
  "vram|gpu|igpu|cpu\\s*(load|usage|temp)|ram\\s*(usage|free)|disk\\s*(usage|space|full)|" +
  "swap|driver\\s*version|nvidia|5060|arc\\s*igpu|beelama|beellama|ornith.*(gpu|running|card)|" +
  // status / which-runs-where intent
  "server\\s*(status|load)|system\\s*status|hardware|what'?s\\s*running|which\\s*gpu|" +
  "is\\s+\\w+\\s+running|running\\s+on\\s+the|the\\s+(box|machine|server|fleet|card)|" +
  // fleet host references
  "\\.(100|158|41)\\b|chiap0" +
  ")\\b",
  "i",
);
const DEFAULT_VISION_ROLE = "sk-vision";
const DEFAULT_DEFAULT_ROLE = "sk-default";

/** A code fence: ``` optionally followed by a language tag. */
const CODE_FENCE_RE = /```/;

/**
 * "Agentic / multi-file" shape:
 *   - two or more numbered task markers ("1. ...", "2) ...") anywhere, OR
 *   - a "then ... then" chain (multi-step imperative).
 * Detected with two cheap regexes in {@link looksAgentic}.
 */
const NUMBERED_TASK_RE = /(^|\n)\s*\d+[.)]\s+\S/g;
const THEN_CHAIN_RE = /\bthen\b[\s\S]*\bthen\b/i;

// ---------------------------------------------------------------------------
// Helpers — extracting text + detecting images from a messages array
// ---------------------------------------------------------------------------

/**
 * Is this a single content-part an image?
 * Handles the OpenAI vision shape ({type:"image_url", ...}), a bare
 * {type:"image", ...} part, and inline data URLs.
 *
 * @param {*} part
 * @returns {boolean}
 */
function partIsImage(part) {
  if (!part) return false;
  if (typeof part === "string") return /data:image\//i.test(part);
  if (typeof part !== "object") return false;
  const type = String(part.type || "").toLowerCase();
  if (type === "image_url" || type === "image" || type === "input_image") return true;
  // Some clients omit `type` but carry an image_url object or a data URL.
  if (part.image_url) return true;
  if (typeof part.image === "string" && /data:image\//i.test(part.image)) return true;
  if (typeof part.url === "string" && /data:image\//i.test(part.url)) return true;
  return false;
}

/**
 * Does ANY message in the array carry an image content part?
 * @param {Array} messages
 * @returns {boolean}
 */
function hasImage(messages) {
  for (const m of messages) {
    if (!m) continue;
    const c = m.content;
    if (typeof c === "string") {
      if (/data:image\//i.test(c)) return true;
      continue;
    }
    if (Array.isArray(c)) {
      for (const part of c) if (partIsImage(part)) return true;
    }
  }
  return false;
}

/**
 * Concatenate the plain text of all USER messages (system/assistant excluded
 * so length/keyword scoring reflects what the human actually asked). Content
 * may be a string or an array of {type:"text", text} parts.
 *
 * @param {Array} messages
 * @returns {string}
 */
function userText(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || m.role !== "user") continue;
    const c = m.content;
    if (typeof c === "string") {
      out.push(c);
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if (typeof part === "string") out.push(part);
        else if (part && typeof part.text === "string") out.push(part.text);
      }
    }
  }
  return out.join("\n");
}

/**
 * Compile an alternation regex from a list of pattern fragments (already
 * regex-safe alternatives such as "optimi[sz]e"). Case-insensitive.
 * @param {string[]} fragments
 * @returns {RegExp}
 */
function alternation(fragments) {
  return new RegExp("\\b(?:" + fragments.join("|") + ")", "i");
}

/**
 * Agentic/multi-file shape detector: 2+ numbered tasks or a then…then chain.
 * @param {string} text
 * @returns {boolean}
 */
function looksAgentic(text) {
  const numbered = text.match(NUMBERED_TASK_RE);
  if (numbered && numbered.length >= 2) return true;
  return THEN_CHAIN_RE.test(text);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify the DIFFICULTY of a chat request and return the logical role that
 * should serve it. Pure function — safe to unit test with hand-built arrays.
 *
 * @param {Array<{role?:string, content?:*}>} messages  OpenAI chat messages
 * @param {AutoThresholds} [opts]  Overrides (typically the registry `auto:` block)
 * @returns {{ role:string, reason:string, signals:string[] }}
 *   role    — resolved logical role ("sk-vision" | "sk-heavy" | "sk-default")
 *   reason  — short human-readable justification (for logs)
 *   signals — the individual heuristic hits that fired
 */
/** Local-context guard threshold: chars across ALL messages (~100k tokens, under ornith 128k). */
const DEFAULT_MAX_LOCAL_CONTEXT_CHARS = 400000;

/**
 * Concatenate the plain text of ALL messages (every role). Used to guard the
 * LOCAL model's context window: a short user ask inside a huge conversation
 * still overflows the small model, so route by total size, not just the ask.
 * @param {Array} messages
 * @returns {string}
 */
function totalText(messages) {
  const out = [];
  for (const m of messages) {
    if (!m) continue;
    const c = m.content;
    if (typeof c === "string") out.push(c);
    else if (Array.isArray(c)) {
      for (const part of c) {
        if (typeof part === "string") out.push(part);
        else if (part && typeof part.text === "string") out.push(part.text);
      }
    }
  }
  return out.join("\n");
}

export function classifyDifficulty(messages, opts = {}) {
  const msgs = Array.isArray(messages) ? messages : [];

  const heavyRole = opts.heavy_role || DEFAULT_HEAVY_ROLE;
  const visionRole = opts.vision_role || DEFAULT_VISION_ROLE;
  const defaultRole = opts.default_role || DEFAULT_DEFAULT_ROLE;
  const maxEasyChars =
    typeof opts.max_easy_chars === "number" ? opts.max_easy_chars : DEFAULT_MAX_EASY_CHARS;
  const hardVerbsRe = alternation(
    Array.isArray(opts.hard_verbs) && opts.hard_verbs.length ? opts.hard_verbs : DEFAULT_HARD_VERBS,
  );
  const cuesRe = alternation(
    Array.isArray(opts.reasoning_cues) && opts.reasoning_cues.length
      ? opts.reasoning_cues
      : DEFAULT_REASONING_CUES,
  );

  const signals = [];

  // ── 1. VISION (highest precedence) ──
  if (hasImage(msgs)) {
    signals.push("image");
    return { role: visionRole, reason: "image content part present", signals };
  }

  // ── 1b. CONTEXT-SIZE GUARD → heavy model (local window protection) ──
  // Route by TOTAL prompt size (all messages), not just the user ask, so a huge
  // conversation never overflows the small local model's window.
  const maxLocalCtxChars =
    typeof opts.max_local_context_chars === "number"
      ? opts.max_local_context_chars
      : DEFAULT_MAX_LOCAL_CONTEXT_CHARS;
  const totalChars = totalText(msgs).length;
  if (totalChars > maxLocalCtxChars) {
    signals.push(`ctx(${totalChars}>${maxLocalCtxChars})`);
    return {
      role: heavyRole,
      reason: `total context ${totalChars} chars > ${maxLocalCtxChars} — exceeds local window`,
      signals,
    };
  }

  // ── 2. HARD → heavy model ──
  const text = userText(msgs);
  const len = text.length;

  const long = len > maxEasyChars;
  const hasFence = CODE_FENCE_RE.test(text);
  const hasHardVerb = hardVerbsRe.test(text);
  const hasCue = cuesRe.test(text);
  const agentic = looksAgentic(text);
  const infra = INFRA_RE.test(text);

  if (long) signals.push(`long(${len}>${maxEasyChars})`);
  if (hasFence) signals.push("code-fence");
  if (hasHardVerb) signals.push("hard-verb");
  if (hasCue) signals.push("reasoning-cue");
  if (agentic) signals.push("agentic");
  if (infra) signals.push("infra");

  // Precedence within HARD, per spec:
  //   long-text OR (code-fence AND hard-verb) OR reasoning-cue OR agentic OR infra
  // infra/ops queries go to the heavy model — the small model confabulates specs.
  const isHard = long || (hasFence && hasHardVerb) || hasCue || agentic || infra;

  if (isHard) {
    let reason;
    if (infra) reason = "infra/ops query — needs faithful command-output parsing";
    else if (long) reason = `user text ${len} chars > ${maxEasyChars}`;
    else if (hasFence && hasHardVerb) reason = "code fence + complex verb";
    else if (hasCue) reason = "multi-step reasoning cue";
    else reason = "agentic / multi-step shape";
    return { role: heavyRole, reason, signals };
  }

  // ── 3. DEFAULT (local/free) ──
  return { role: defaultRole, reason: "no hard/vision signals", signals };
}

export default classifyDifficulty;
