/**
 * engine.mjs — Prompt classification ENGINE for SKGateway (P3.5)
 *
 * A thin, PLUGGABLE facade over the heuristic {@link module:classifiers/classifier}
 * that produces ONE unified label bundle per request, ready for routing / metrics /
 * SIEM consumption.
 *
 * What this adds on top of the existing classifier + the live sk-auto DIFFICULTY
 * router (src/classifiers/difficulty.mjs):
 *
 *   - A single entry point, {@link classifyRequest}, that fuses the four signal
 *     functions (intent category, risk score, jailbreak, injection) into one
 *     bundle with the card's canonical intent set — including `jailbreak_attempt`
 *     as a top-level intent label (the base classifier keeps jailbreak as a
 *     separate detector; the engine promotes it to a category when confident).
 *   - A pluggable classifier REGISTRY so a model-backed classifier can slot in
 *     later WITHOUT touching the hot path. The built-in "heuristic" classifier is
 *     pure keyword/regex, deterministic, and sub-10ms; it is always the baseline.
 *   - {@link toSiemEvent} to shape the bundle into a flat SIEM record.
 *
 * Design invariants (match the card + the "flag, don't block" gateway posture):
 *   - PASSIVE: the engine never changes routing. It only labels. Callers decide
 *     whether to act on labels; index.mjs only emits them to SIEM.
 *   - NON-BLOCKING: {@link classifyRequest} is synchronous and does no network I/O.
 *     Registered classifiers used on the hot path MUST also be synchronous; a
 *     model-backed (async) classifier is an out-of-band enrichment step (deferred).
 *   - FAIL-OPEN: any error in a plugin degrades to the heuristic baseline; the
 *     engine never throws on the hot path.
 *
 * @module classifiers/engine
 */

import {
  classifyPrompt,
  scoreRisk,
  detectJailbreak,
  detectInjection,
} from "./classifier.mjs";

/**
 * The card's canonical intent set, plus the base classifier's extra buckets that
 * the engine still surfaces (tool_use / conversation / system). Ordered card-first.
 * @type {readonly string[]}
 */
export const PROMPT_CLASSES = Object.freeze([
  "code_generation",
  "data_query",
  "creative",
  "administrative",
  "security_sensitive",
  "jailbreak_attempt",
  // extra buckets from the base classifier (still valid outputs)
  "tool_use",
  "conversation",
  "system",
]);

/**
 * When detectJailbreak's confidence meets this bar, the engine promotes the
 * top-level `category` to `jailbreak_attempt` (the card lists it as an intent).
 * Kept in sync with the classifier's own `detected` threshold (0.5).
 */
export const JAILBREAK_CATEGORY_THRESHOLD = 0.5;

/**
 * @typedef {Object} ClassificationResult
 * @property {string}   engine       - Name of the classifier that produced the base result.
 * @property {string}   category     - Top-level intent (one of {@link PROMPT_CLASSES}).
 * @property {number}   confidence   - Confidence 0-1 for `category`.
 * @property {Object}   intent       - Raw classifyPrompt() result { category, confidence, top3 }.
 * @property {Object}   risk         - scoreRisk() result { score, level, signals }.
 * @property {Object}   jailbreak    - detectJailbreak() result { detected, patterns, confidence }.
 * @property {Object}   injection    - detectInjection() result { detected, type, confidence }.
 * @property {string[]} labels       - Flat short tags for SIEM/metrics (e.g. "intent:code_generation").
 * @property {number}   ms           - Wall-clock classification time in ms.
 */

// ---------------------------------------------------------------------------
// Built-in heuristic classifier — the deterministic, sub-10ms baseline
// ---------------------------------------------------------------------------

/**
 * The default classifier: fuse the four base signal functions.
 *
 * @param {Array<{role: string, content: any}>} messages
 * @param {{ systemPrompt?: string, history?: Array }} [opts]
 * @returns {{ category: string, confidence: number, intent: object, risk: object, jailbreak: object, injection: object }}
 */
// ponytail: hard input bound for the classifier. 8K head + 2K tail per
// message preserves every real classification signal and caps the regex
// work; upgrade path is per-pattern complexity analysis if that ever fails.
const CLASSIFY_HEAD = 8_000;
const CLASSIFY_TAIL = 2_000;

function boundMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    if (typeof m.content === "string" && m.content.length > CLASSIFY_HEAD + CLASSIFY_TAIL) {
      return { ...m, content: m.content.slice(0, CLASSIFY_HEAD) + "\n...[classification bound]\n" + m.content.slice(-CLASSIFY_TAIL) };
    }
    return m;
  });
}

export function heuristicClassifier(messages, opts = {}) {
  const systemPrompt = opts.systemPrompt || "";
  const history = opts.history || [];

  messages = boundMessages(messages);

  const intent = classifyPrompt(messages, systemPrompt);
  const risk = scoreRisk(messages);
  const jailbreak = detectJailbreak(messages, history);
  const injection = detectInjection(messages);

  // Promote to the card's `jailbreak_attempt` intent when the detector is
  // confident. A confident injection attempt also counts as jailbreak_attempt
  // (both are adversarial prompt-shaping the SOC wants surfaced as one class).
  let category = intent.category;
  let confidence = intent.confidence;
  const jbConfident = jailbreak.detected && jailbreak.confidence >= JAILBREAK_CATEGORY_THRESHOLD;
  const injConfident = injection.detected && injection.confidence >= JAILBREAK_CATEGORY_THRESHOLD;
  if (jbConfident || injConfident) {
    category = "jailbreak_attempt";
    confidence = Math.max(
      jbConfident ? jailbreak.confidence : 0,
      injConfident ? injection.confidence : 0,
    );
  }

  return { category, confidence, intent, risk, jailbreak, injection };
}

// ---------------------------------------------------------------------------
// Pluggable classifier registry
// ---------------------------------------------------------------------------

/** @type {Map<string, (messages: Array, opts: object) => object>} */
const CLASSIFIERS = new Map([["heuristic", heuristicClassifier]]);

/**
 * Register (or replace) a named classifier so it can be selected via
 * `opts.classifier` on {@link classifyRequest}. This is the extension point for
 * a future model-backed classifier.
 *
 * Hot-path contract: a classifier used by the synchronous {@link classifyRequest}
 * MUST be synchronous and return the same shape as {@link heuristicClassifier}.
 * (An async/model-backed classifier belongs in an out-of-band enrichment step.)
 *
 * @param {string} name
 * @param {(messages: Array, opts: object) => object} fn
 */
export function registerClassifier(name, fn) {
  if (!name || typeof name !== "string") {
    throw new TypeError("registerClassifier: name must be a non-empty string");
  }
  if (typeof fn !== "function") {
    throw new TypeError("registerClassifier: fn must be a function");
  }
  if (name === "heuristic") {
    throw new Error('registerClassifier: "heuristic" is reserved for the built-in baseline');
  }
  CLASSIFIERS.set(name, fn);
}

/**
 * Remove a previously registered classifier (no-op for "heuristic").
 * @param {string} name
 * @returns {boolean} whether a classifier was removed
 */
export function unregisterClassifier(name) {
  if (name === "heuristic") return false;
  return CLASSIFIERS.delete(name);
}

/** @returns {string[]} the names of all registered classifiers. */
export function listClassifiers() {
  return [...CLASSIFIERS.keys()];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the flat SIEM/metrics label tags from a fused base result.
 * @param {{category: string, risk: object, jailbreak: object, injection: object}} base
 * @returns {string[]}
 */
function buildLabels(base) {
  const labels = [`intent:${base.category}`, `risk:${base.risk.level}`];
  if (base.jailbreak?.detected) labels.push("jailbreak");
  if (base.injection?.detected) labels.push(`injection:${base.injection.type || "unknown"}`);
  return labels;
}

/**
 * Classify a request into one unified, passive label bundle.
 *
 * Synchronous, deterministic, and non-blocking — safe to call on the hot path.
 * Fails open to the heuristic baseline if a selected plugin throws.
 *
 * @param {Array<{role: string, content: any}>} messages  - Conversation messages.
 * @param {Object} [opts]
 * @param {string}  [opts.systemPrompt]   - Optional separate system prompt string.
 * @param {Array}   [opts.history]        - Prior turns for multi-turn escalation.
 * @param {string}  [opts.classifier]     - Registered classifier name (default "heuristic").
 * @returns {ClassificationResult}
 *
 * @example
 * const r = classifyRequest(messages, { systemPrompt });
 * // { category: 'code_generation', confidence: 0.8, risk: {...}, labels: [...], ms: 0.4 }
 */
export function classifyRequest(messages, opts = {}) {
  const start = performance.now();
  const engineName = opts.classifier && CLASSIFIERS.has(opts.classifier)
    ? opts.classifier
    : "heuristic";
  const fn = CLASSIFIERS.get(engineName);

  const bounded = boundMessages(messages);
  let base;
  try {
    base = fn(bounded, opts);
    // Guard against a partial/misbehaving plugin — require the core fields.
    if (!base || typeof base.category !== "string" || !base.risk || !base.jailbreak) {
      throw new Error("classifier returned an incomplete result");
    }
  } catch {
    // Fail-open: never let classification break a request.
    base = heuristicClassifier(bounded, opts);
    return finalize("heuristic", base, start);
  }

  return finalize(engineName, base, start);
}

/**
 * @param {string} engineName
 * @param {object} base
 * @param {number} start
 * @returns {ClassificationResult}
 */
function finalize(engineName, base, start) {
  const ms = performance.now() - start;
  return {
    engine: engineName,
    category: base.category,
    confidence: base.confidence ?? 0,
    intent: base.intent,
    risk: base.risk,
    jailbreak: base.jailbreak,
    injection: base.injection,
    labels: buildLabels(base),
    ms,
  };
}

/**
 * Shape a {@link ClassificationResult} into a flat SIEM record for the audit log.
 * Keeps only scalar-friendly fields (arrays are short + JSON-safe).
 *
 * @param {ClassificationResult} result
 * @param {Object} [context] - Extra top-level fields (agent_id, session_id, model, path…).
 * @returns {Object} a plain object ready for siemHook().
 */
export function toSiemEvent(result, context = {}) {
  return {
    ts: new Date().toISOString(),
    event: "prompt.classified",
    engine: result.engine,
    category: result.category,
    confidence: Number(result.confidence?.toFixed?.(3) ?? result.confidence ?? 0),
    risk_score: result.risk?.score ?? 0,
    risk_level: result.risk?.level ?? "normal",
    risk_signals: result.risk?.signals ?? [],
    jailbreak: !!result.jailbreak?.detected,
    jailbreak_confidence: Number(result.jailbreak?.confidence?.toFixed?.(3) ?? 0),
    jailbreak_patterns: result.jailbreak?.patterns ?? [],
    injection: !!result.injection?.detected,
    injection_type: result.injection?.type || "",
    labels: result.labels,
    classify_ms: Number(result.ms?.toFixed?.(3) ?? result.ms ?? 0),
    ...context,
  };
}

export default classifyRequest;
