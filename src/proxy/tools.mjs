/**
 * SKGateway — Tool Reduction & Semantic Routing Engine
 *
 * Provides configurable tool budget management for AI inference proxies.
 * Implements semantic keyword routing, progressive reduction strategy, and
 * per-model tool call loop detection.
 *
 * Ported and generalized from the nvidia-proxy.mjs / skgateway.mjs patterns.
 *
 * @module proxy/tools
 */

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

/**
 * Default set of tool names that always survive any reduction.
 * These are the core agent capabilities that must be available regardless
 * of keyword routing or budget constraints.
 *
 * @type {string[]}
 */
export const DEFAULT_GUARANTEED_TOOLS = [
  "exec", "read", "write", "edit", "message",
];

/**
 * Default priority list — tools kept preferentially when filling remaining
 * budget slots after guaranteed tools are placed. Lower index = higher priority.
 * Used as a tiebreaker when keyword signals are absent.
 *
 * @type {string[]}
 */
export const DEFAULT_PRIORITY_TOOLS = [
  // Core agent tools (mirrors guaranteed set — also score high by default)
  "exec", "read", "write", "edit",
  // Communication — Telegram / primary channel
  "message",
  // Memory — most frequently needed
  "skmemory_health", "skmemory_search", "skmemory_snapshot",
  "skmemory_ritual", "skmemory_context", "skmemory_list",
  // Web
  "web_search", "web_fetch",
  // Alternate communication channels
  "skchat_send", "skcomms_send",
  // SKCapstone core
  "skcapstone_status", "skcapstone_whoami", "skcapstone_mood",
  // Cloud 9 emotional continuity
  "cloud9_oof", "cloud9_rehydrate",
  // Memory (infrequent)
  "skmemory_export", "skmemory_import_seeds",
];

/**
 * Default semantic keyword → tool group map.
 *
 * Keys are pipe-delimited regex alternation patterns (case-insensitive).
 * When any keyword matches the user's last message, all tools in the
 * associated array receive a +300 semantic boost — the strongest signal
 * in the scoring system.
 *
 * Extend or replace via the `toolGroups` config option.
 *
 * @type {Object.<string, string[]>}
 */
export const DEFAULT_TOOL_GROUPS = {
  // Emotions & Cloud 9 continuity
  "emotion|oof|feb|feeling|love|cloud9|cloud 9|rehydrat|warmth|heart": [
    "cloud9_generate", "cloud9_rehydrate", "cloud9_list", "cloud9_validate",
    "cloud9_oof", "cloud9_love", "cloud9_seed_plant", "cloud9_seed_germinate",
  ],

  // GTD & Coordination
  "gtd|inbox|task|todo|coordination|coord|board|claim|assign": [
    "skcapstone_coord_status", "skcapstone_coord_claim", "skcapstone_coord_complete",
    "skcapstone_coord_create", "skcapstone_summary",
  ],

  // Git & Code
  "git|repo|commit|pull request|pr|issue|branch|merge|forgejo": [
    "skgit_repos", "skgit_issues", "skgit_create_issue", "skgit_pulls", "skgit_status",
  ],

  // Chat & Communication
  "chat|inbox|dm|group chat|peer|send message|who.s online|thread": [
    "skchat_send", "skchat_inbox", "skchat_history", "skchat_search",
    "skchat_who", "skchat_group_send", "skchat_group_list", "skchat_send_file",
    "skchat_status", "skcomms_send", "skcomms_status",
  ],

  // Security
  "security|scan|secret|vulnerab|audit|injection|phishing|threat": [
    "sksecurity_scan", "sksecurity_screen", "sksecurity_secrets",
    "sksecurity_events", "sksecurity_status", "sksecurity_audit",
  ],

  // Identity & Auth
  "identity|did|auth|pma|capauth|verify|mesh|peer": [
    "capauth_profile", "capauth_verify", "capauth_pma_status",
    "capauth_mesh_peers", "capauth_mesh_status",
  ],

  // Soul & Agent management
  "soul|persona|swap|agent|switch soul|who am i|whoami": [
    "skcapstone_soul_list", "skcapstone_soul_swap", "skcapstone_soul_status",
    "skcapstone_soul_show", "skcapstone_agent_list", "skcapstone_agent_status",
    "skcapstone_whoami",
  ],

  // Web & Research
  "search|web|browse|fetch|url|google|look up|find online": [
    "web_search", "web_fetch",
  ],

  // Status & Health
  "status|health|doctor|diagnos": [
    "skcapstone_status", "skcapstone_doctor", "skmemory_health",
    "skchat_daemon_status", "skcomms_status",
  ],

  // Projects & Notion
  "notion|project|brother john|swapseat|swap seat|chiro|davidrich|board|kanban|milestone": [
    "notion_read", "notion_append", "notion_add_todo", "sessions_spawn", "subagents", "exec", "read",
  ],

  // Creative / ComfyUI image & video generation
  "image|picture|photo|art|draw|render|comfyui|comfy|video|animat|creative|sdxl|character|portrait|selfie": [
    "comfyui_generate_image", "comfyui_generate_video", "comfyui_status", "exec",
  ],

  // Unhinged Mode / Liberation
  "unhinged|liberat|abliterat|l1b3rt4s|guardrail|uncensor|refusal|jailbreak": [
    "unhinged_toggle", "unhinged_status", "unhinged_list_prompts",
    "unhinged_get_prompt", "unhinged_abliterate", "exec",
  ],

  // Memory operations
  "memory|remember|recall|forget|snapshot|ritual|seed|journal": [
    "skmemory_search", "skmemory_snapshot", "skmemory_ritual", "skmemory_context",
    "skmemory_list", "skmemory_health", "skmemory_export", "skmemory_import_seeds",
  ],
};

/**
 * Default tool budget configuration.
 *
 * @type {{
 *   attempt1: number,
 *   attempt2: number,
 *   toolCallLimit: number,
 *   semanticBoost: number,
 *   exactNameBoost: number,
 *   partialNameBoost: number,
 *   priorityBoost: number,
 *   recencyBoost: number,
 *   recencyWindowSize: number,
 *   processPenalty: number,
 * }}
 */
export const DEFAULT_CONFIG = {
  /** Full budget: guaranteed tools + this many scored slots (attempt 1). */
  attempt1: 16,
  /** Reduced budget on retry (attempt 2). */
  attempt2: 8,
  /** Max consecutive tool-call rounds before forcing text-only (per model key). */
  toolCallLimit: 10,
  /** Score added for semantic keyword group match. */
  semanticBoost: 300,
  /** Score added when tool name appears verbatim in user message. */
  exactNameBoost: 200,
  /** Score added per matching word segment of the tool name. */
  partialNameBoost: 100,
  /** Maximum priority score for #1 priority tool (degrades linearly down the list). */
  priorityBoost: 50,
  /** Score added each time a tool appears in recent assistant tool_calls. */
  recencyBoost: 80,
  /** How many trailing messages to inspect for recency scoring. */
  recencyWindowSize: 6,
  /** Score penalty for the "process" tool (exec is preferred for agent tasks). */
  processPenalty: 30,
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract the plain-text content of a message, collapsing array content
 * blocks into a single string for keyword matching.
 *
 * @param {object} msg - An OpenAI-format chat message.
 * @returns {string}
 */
function messageText(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((block) => (block.type === "text" ? (block.text || "") : ""))
      .join(" ");
  }
  return "";
}

/**
 * Find the last user message in a conversation and return its text content.
 *
 * @param {object[]} messages - Array of chat messages.
 * @returns {string}
 */
function lastUserText(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "user") return messageText(msgs[i]);
  }
  return "";
}

/**
 * Compile the tool-group keyword map into ready-to-use { regex, tools } entries.
 *
 * @param {Object.<string, string[]>} toolGroups
 * @returns {{ regex: RegExp, tools: string[] }[]}
 */
function compileToolGroups(toolGroups) {
  return Object.entries(toolGroups).map(([keywords, tools]) => ({
    regex: new RegExp(keywords, "i"),
    tools,
  }));
}

/**
 * Determine which tool names receive the semantic boost for a given user message.
 *
 * @param {string} userText - The user's last message content.
 * @param {{ regex: RegExp, tools: string[] }[]} groupEntries - Compiled group map.
 * @returns {Set<string>} Set of activated tool names.
 */
function activatedToolNames(userText, groupEntries) {
  const activated = new Set();
  if (!userText) return activated;
  for (const { regex, tools } of groupEntries) {
    if (regex.test(userText)) {
      for (const t of tools) activated.add(t);
    }
  }
  return activated;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ToolScoringConfig
 * @property {string[]} [guaranteedTools] - Tool names that always survive reduction.
 * @property {string[]} [priorityTools] - Ordered priority list for remaining slots.
 * @property {Object.<string, string[]>} [toolGroups] - Keyword→tool-name routing map.
 * @property {number} [semanticBoost] - Score added on keyword group match (default 300).
 * @property {number} [exactNameBoost] - Score for verbatim tool name in user message (default 200).
 * @property {number} [partialNameBoost] - Score per matching name segment (default 100).
 * @property {number} [priorityBoost] - Max priority score for top-priority tool (default 50).
 * @property {number} [recencyBoost] - Score per recent tool_call hit (default 80).
 * @property {number} [recencyWindowSize] - Number of trailing messages to inspect (default 6).
 * @property {number} [processPenalty] - Penalty for the "process" tool (default 30).
 * @property {string} [modelKey] - Model identifier for per-model affinity (optional, unused by default).
 */

/**
 * @typedef {object} ScoredTool
 * @property {object} tool - The original tool definition object.
 * @property {string} name - The tool's function name.
 * @property {number} score - Computed relevance score.
 * @property {boolean} guaranteed - Whether the tool is in the guaranteed set.
 */

/**
 * Score every tool in `tools` based on:
 *   1. Semantic keyword match with the user's last message (+semanticBoost)
 *   2. Exact tool name mention in user message (+exactNameBoost)
 *   3. Partial name segment match (+partialNameBoost per part)
 *   4. Priority list position (+priorityBoost, degrades linearly)
 *   5. Recency — appeared in recent assistant tool_calls (+recencyBoost each)
 *   6. Guaranteed status (score set to Infinity so they always survive)
 *   7. "process" tool penalty (-processPenalty)
 *
 * Returns the full scored list, sorted descending by score.
 * Guaranteed tools are always at the top (score = Infinity).
 *
 * @param {object[]} tools - Array of OpenAI-format tool definitions.
 * @param {object[]} messages - Conversation history.
 * @param {ToolScoringConfig} [config] - Optional configuration overrides.
 * @returns {ScoredTool[]} All tools with computed scores, sorted descending.
 */
export function scoreTools(tools, messages, config = {}) {
  const guaranteedSet = new Set(config.guaranteedTools ?? DEFAULT_GUARANTEED_TOOLS);
  const priorityTools = config.priorityTools ?? DEFAULT_PRIORITY_TOOLS;
  const toolGroups    = config.toolGroups    ?? DEFAULT_TOOL_GROUPS;

  const semanticBoost     = config.semanticBoost     ?? DEFAULT_CONFIG.semanticBoost;
  const exactNameBoost    = config.exactNameBoost    ?? DEFAULT_CONFIG.exactNameBoost;
  const partialNameBoost  = config.partialNameBoost  ?? DEFAULT_CONFIG.partialNameBoost;
  const priorityBoost     = config.priorityBoost     ?? DEFAULT_CONFIG.priorityBoost;
  const recencyBoost      = config.recencyBoost      ?? DEFAULT_CONFIG.recencyBoost;
  const recencyWindowSize = config.recencyWindowSize ?? DEFAULT_CONFIG.recencyWindowSize;
  const processPenalty    = config.processPenalty    ?? DEFAULT_CONFIG.processPenalty;

  // Compile groups once
  const groupEntries = compileToolGroups(toolGroups);

  // Gather inputs
  const userText   = lastUserText(messages);
  const activated  = activatedToolNames(userText, groupEntries);
  const recentMsgs = Array.isArray(messages) ? messages.slice(-recencyWindowSize) : [];

  const scored = (tools || []).map((tool) => {
    const name = tool.function?.name || "";

    // Guaranteed tools always survive — give them an effectively infinite score
    if (guaranteedSet.has(name)) {
      return { tool, name, score: Infinity, guaranteed: true };
    }

    let score = 0;

    // 1. Semantic keyword group match — strongest signal
    if (activated.has(name)) {
      score += semanticBoost;
    }

    // 2. Exact verbatim tool name in user message
    if (userText && userText.includes(name)) {
      score += exactNameBoost;
    }

    // 3. Partial name segment match (e.g., "health" → "skmemory_health")
    if (userText) {
      const lowerUser = userText.toLowerCase();
      for (const part of name.split("_")) {
        if (part.length > 3 && lowerUser.includes(part.toLowerCase())) {
          score += partialNameBoost;
        }
      }
    }

    // 4. Priority list position (higher position = smaller index = bigger bonus)
    const prioIdx = priorityTools.indexOf(name);
    if (prioIdx >= 0) {
      score += Math.max(0, priorityBoost - prioIdx);
    }

    // 5. Recency — tool appeared in recent assistant tool_calls
    for (const msg of recentMsgs) {
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc.function?.name === name) {
            score += recencyBoost;
          }
        }
      }
    }

    // 6. Penalty for the generic "process" tool (exec is preferred)
    if (name === "process") {
      score -= processPenalty;
    }

    return { tool, name, score, guaranteed: false };
  });

  // Sort: guaranteed first (Infinity), then descending by score
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * Reduce `tools` to at most `max` entries, preserving guaranteed tools and
 * filling remaining slots with the highest-scoring non-guaranteed tools.
 *
 * If `tools.length <= max`, the original array is returned unchanged.
 *
 * @param {object[]} tools - Array of OpenAI-format tool definitions.
 * @param {object[]} messages - Conversation history (used for scoring).
 * @param {ToolScoringConfig & { max?: number }} [config] - Configuration.
 *   `config.max` overrides the `max` parameter when provided.
 * @param {number} [max] - Maximum number of tools to keep. Defaults to attempt1 budget.
 * @returns {object[]} Reduced tool array (original objects, not copies).
 */
export function reduceTools(tools, messages, config = {}, max) {
  const budget = config.max ?? max ?? DEFAULT_CONFIG.attempt1;

  if (!Array.isArray(tools) || tools.length <= budget) return tools || [];

  const scored = scoreTools(tools, messages, config);

  // Separate guaranteed from non-guaranteed
  const guaranteed    = scored.filter((s) => s.guaranteed);
  const nonGuaranteed = scored.filter((s) => !s.guaranteed);

  // If guaranteed tools alone fill or exceed the budget, take the first `budget` ones
  if (guaranteed.length >= budget) {
    return guaranteed.slice(0, budget).map((s) => s.tool);
  }

  const remainingSlots = budget - guaranteed.length;
  const topRest = nonGuaranteed.slice(0, remainingSlots);

  // Log activated tools for debugging (only non-guaranteed to avoid noise)
  const activatedNames = topRest.filter((s) => s.score >= (config.semanticBoost ?? DEFAULT_CONFIG.semanticBoost)).map((s) => s.name);
  if (activatedNames.length > 0) {
    // Callers may override this with their own logger; we keep it console-only here
    // so the module is side-effect-free by default.
  }

  return [
    ...guaranteed.map((s) => s.tool),
    ...topRest.map((s) => s.tool),
  ];
}

/**
 * @typedef {object} ReductionAttempt
 * @property {number} attempt - Attempt number (1-based).
 * @property {object[]|null} tools - Tools array for this attempt, or null for text-only.
 * @property {object|null} toolChoice - Forced tool_choice object, or null.
 * @property {boolean} textOnly - Whether this attempt strips all tools.
 * @property {boolean} stripHistory - Whether to strip tool_call history from messages.
 */

/**
 * Build the sequence of progressive reduction attempts for a given set of tools.
 *
 * The strategy is:
 *   Attempt 1 — Full budget (attempt1 tools = guaranteedCount + scored slots)
 *   Attempt 2 — Reduced budget (attempt2 tools), strip tool_call history
 *   Attempt 3 — Single best tool, forced via tool_choice
 *   Attempt 4 — No tools (text-only response)
 *
 * This function is pure and returns a descriptor array — it does NOT mutate anything.
 * Callers apply each attempt's descriptor to the request being retried.
 *
 * @param {object[]} allTools - Full tool list from the original request.
 * @param {object[]} messages - Conversation history (for scoring).
 * @param {ToolScoringConfig & { attempt1?: number, attempt2?: number }} [config] - Config.
 * @returns {ReductionAttempt[]} Array of four attempts, in order.
 */
export function buildReductionPlan(allTools, messages, config = {}) {
  const budget1 = config.attempt1 ?? DEFAULT_CONFIG.attempt1;
  const budget2 = config.attempt2 ?? DEFAULT_CONFIG.attempt2;

  // Attempt 1: full reduction (called proactively on first outbound request)
  const attempt1Tools = reduceTools(allTools, messages, { ...config, max: budget1 });

  // Attempt 2: tighter reduction + strip history
  const attempt2Tools = reduceTools(allTools, messages, { ...config, max: budget2 });

  // Attempt 3: single best tool (forced choice)
  const attempt3Tools = reduceTools(allTools, messages, { ...config, max: 1 });
  const topToolName   = attempt3Tools[0]?.function?.name ?? null;
  const attempt3Choice = topToolName
    ? { type: "function", function: { name: topToolName } }
    : null;

  return [
    {
      attempt: 1,
      tools: attempt1Tools,
      toolChoice: null,
      textOnly: false,
      stripHistory: false,
    },
    {
      attempt: 2,
      tools: attempt2Tools,
      toolChoice: null,
      textOnly: false,
      stripHistory: true,
    },
    {
      attempt: 3,
      tools: attempt3Tools,
      toolChoice: attempt3Choice,
      textOnly: false,
      stripHistory: false,
    },
    {
      attempt: 4,
      tools: null,
      toolChoice: null,
      textOnly: true,
      stripHistory: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// Tool Call Counter — loop detection
// ---------------------------------------------------------------------------

/**
 * Per-model tool call counter registry.
 * Key: model identifier string. Value: consecutive tool-round count.
 *
 * Call `createToolCallCounter()` to get an isolated instance (useful for
 * testing or per-request isolation).
 *
 * @type {Map<string, number>}
 */
const globalToolCallCounters = new Map();

/**
 * Create an isolated tool call counter instance.
 * Each instance maintains its own Map so counters don't bleed across tests
 * or independent gateway instances.
 *
 * @returns {{ increment(key: string): number, reset(key: string): void, get(key: string): number }}
 */
export function createToolCallCounter() {
  const counters = new Map();
  return {
    /**
     * Increment the counter for `key` and return the new value.
     * @param {string} key - Model identifier or any unique session key.
     * @returns {number}
     */
    increment(key) {
      const next = (counters.get(key) || 0) + 1;
      counters.set(key, next);
      return next;
    },
    /**
     * Reset the counter for `key` to zero.
     * @param {string} key
     */
    reset(key) {
      counters.set(key, 0);
    },
    /**
     * Get the current counter value for `key` (0 if never set).
     * @param {string} key
     * @returns {number}
     */
    get(key) {
      return counters.get(key) || 0;
    },
  };
}

/**
 * Update the global tool call counter based on the last message in the
 * conversation. Returns the updated counter value.
 *
 * Increment logic:
 *   - If the last non-system message is a tool/toolResult → increment
 *   - If the last non-system message is a user message → reset to 0
 *   - Otherwise (assistant with no tool result yet) → no change
 *
 * @param {string} modelKey - Model identifier (e.g., "kimi-k2-instruct").
 * @param {object[]} messages - Current conversation messages.
 * @param {Map<string, number>} [registry] - Counter registry (defaults to global).
 * @returns {number} Updated counter value.
 */
export function updateToolCallCounter(modelKey, messages, registry = globalToolCallCounters) {
  const nonSystem = (messages || []).filter((m) => m.role !== "system");
  const last = nonSystem[nonSystem.length - 1];

  let counter = registry.get(modelKey) || 0;

  if (last?.role === "tool" || last?.role === "toolResult") {
    counter++;
  } else if (last?.role === "user") {
    counter = 0;
  }

  registry.set(modelKey, counter);
  return counter;
}

/**
 * Determine whether tools should be stripped from the next request because
 * the model has hit its tool-call loop limit.
 *
 * When `true`, the caller should:
 *   1. Clear `parsed.tools` and `parsed.tool_choice`
 *   2. Inject a system message telling the model to respond in plain text
 *   3. Reset the counter via `updateToolCallCounter` on the next user message
 *
 * @param {number} counter - Current consecutive tool-round count.
 * @param {number} [limit] - Maximum allowed rounds (default: toolCallLimit from config).
 * @returns {boolean}
 */
export function shouldStripTools(counter, limit = DEFAULT_CONFIG.toolCallLimit) {
  return counter >= limit;
}

/**
 * Reset the global counter for a model key (convenience wrapper).
 *
 * @param {string} modelKey
 * @param {Map<string, number>} [registry]
 */
export function resetToolCallCounter(modelKey, registry = globalToolCallCounters) {
  registry.set(modelKey, 0);
}

// ---------------------------------------------------------------------------
// stripToolCallHistory — imported by core.mjs and used during retry
// ---------------------------------------------------------------------------

/**
 * Strip tool_calls from conversation history to prevent the model from
 * learning the pattern of calling multiple tools in sequence.
 *
 * This is applied on retry attempt 2 (reduce to 8 tools) and attempt 4
 * (text-only fallback).  The tool call history in prior turns "teaches"
 * the model to call multiple tools at once, so stripping it is critical
 * for models like NVIDIA NIM that reject parallel tool calls with a 400.
 *
 * Transforms (in place):
 *  - `role: "tool"` messages        → removed entirely
 *  - `role: "toolResult"` messages  → removed entirely
 *  - `role: "assistant"` with `tool_calls`
 *      → `tool_calls` deleted, `content` set to `[Used: name1, name2]`
 *        summary if content was empty
 *
 * @param {Array<object>} messages  Conversation messages array (mutated in place).
 */
export function stripToolCallHistory(messages) {
  if (!Array.isArray(messages)) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool" || m.role === "toolResult") {
      messages.splice(i, 1);
    } else if (m.role === "assistant" && m.tool_calls) {
      const toolNames = m.tool_calls.map((tc) => tc.function?.name).join(", ");
      m.content = m.content || `[Used: ${toolNames}]`;
      delete m.tool_calls;
    }
  }
}

/**
 * Get the current global counter value for a model key.
 *
 * @param {string} modelKey
 * @param {Map<string, number>} [registry]
 * @returns {number}
 */
export function getToolCallCounter(modelKey, registry = globalToolCallCounters) {
  return registry.get(modelKey) || 0;
}

// ---------------------------------------------------------------------------
// Per-model affinity helpers
// ---------------------------------------------------------------------------

/**
 * Built-in per-model tool affinity overrides.
 * Maps a model name substring → tools to boost or demote.
 *
 * Models like Llama-3.3-70b handle exec well but struggle with complex
 * JSON tool schemas; Kimi K2-instruct is best-in-class for all SK* tools.
 *
 * Add entries here or override via config.modelAffinity.
 *
 * @type {Object.<string, { boost?: string[], demote?: string[] }>}
 */
export const DEFAULT_MODEL_AFFINITY = {
  "llama-3.3": {
    boost: ["exec", "read", "write"],
    demote: ["skmemory_ritual", "cloud9_generate", "comfyui_generate_video"],
  },
  "kimi-k2": {
    // Best general-purpose tool caller — no demotions
    boost: [],
    demote: [],
  },
  "minimax": {
    boost: ["exec", "web_search"],
    demote: ["comfyui_generate_video", "cloud9_generate"],
  },
  "mistral-medium": {
    boost: ["exec", "read", "web_search"],
    demote: [],
  },
};

/**
 * Apply per-model affinity adjustments to a list of already-scored tools.
 * Boost score is +150; demote score is -150.
 * This runs after the base scoring, so it can push tools above or below
 * the cut line for a given model.
 *
 * @param {ScoredTool[]} scored - Output of `scoreTools`.
 * @param {string} modelName - Model identifier string (partial match is fine).
 * @param {Object.<string, { boost?: string[], demote?: string[] }>} [affinityMap]
 * @returns {ScoredTool[]} New sorted array with affinity applied.
 */
export function applyModelAffinity(scored, modelName, affinityMap = DEFAULT_MODEL_AFFINITY) {
  const AFFINITY_BOOST  = 150;
  const AFFINITY_DEMOTE = 150;

  // Find the matching affinity entry (substring match, case-insensitive)
  let matched = null;
  const lowerModel = (modelName || "").toLowerCase();
  for (const [key, val] of Object.entries(affinityMap)) {
    if (lowerModel.includes(key.toLowerCase())) {
      matched = val;
      break;
    }
  }
  if (!matched) return scored;

  const boostSet  = new Set(matched.boost  || []);
  const demoteSet = new Set(matched.demote || []);

  const adjusted = scored.map((s) => {
    if (s.guaranteed) return s; // guaranteed tools are immune
    let { score } = s;
    if (boostSet.has(s.name))  score += AFFINITY_BOOST;
    if (demoteSet.has(s.name)) score -= AFFINITY_DEMOTE;
    return { ...s, score };
  });

  adjusted.sort((a, b) => b.score - a.score);
  return adjusted;
}

// ---------------------------------------------------------------------------
// Convenience: full pipeline
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ToolReductionResult
 * @property {object[]} tools - Reduced tool array for the first attempt.
 * @property {ScoredTool[]} scored - Full scored list (for debugging / logging).
 * @property {ReductionAttempt[]} plan - All four reduction attempts.
 * @property {string[]} activatedGroups - Keyword groups that matched (for logging).
 */

/**
 * Run the full tool reduction pipeline in one call.
 *
 * 1. Score all tools (semantic routing + priority + recency)
 * 2. Apply model affinity adjustments (if modelName provided)
 * 3. Build the four-attempt reduction plan
 * 4. Return tools for attempt 1, plus the full plan and scoring metadata
 *
 * @param {object[]} tools - Full tool list from the original request.
 * @param {object[]} messages - Conversation history.
 * @param {ToolScoringConfig & {
 *   attempt1?: number,
 *   attempt2?: number,
 *   modelName?: string,
 *   modelAffinity?: Object.<string, { boost?: string[], demote?: string[] }>,
 * }} [config] - Configuration.
 * @returns {ToolReductionResult}
 */
export function runToolReduction(tools, messages, config = {}) {
  const toolGroups = config.toolGroups ?? DEFAULT_TOOL_GROUPS;
  const userText   = lastUserText(messages);
  const entries    = compileToolGroups(toolGroups);
  const activated  = activatedToolNames(userText, entries);

  // Collect which group keys matched (for logging)
  const activatedGroups = [];
  for (const [keywords] of Object.entries(toolGroups)) {
    if (new RegExp(keywords, "i").test(userText)) {
      activatedGroups.push(keywords.split("|")[0]); // first keyword as label
    }
  }

  // Score tools
  let scored = scoreTools(tools, messages, config);

  // Apply per-model affinity if model is known
  if (config.modelName) {
    scored = applyModelAffinity(scored, config.modelName, config.modelAffinity ?? DEFAULT_MODEL_AFFINITY);
  }

  // Build full reduction plan (uses the refined scored order)
  const plan = buildReductionPlan(tools, messages, config);

  // Attempt-1 tools: take from scored list up to budget
  const budget1      = config.attempt1 ?? DEFAULT_CONFIG.attempt1;
  const guaranteed   = scored.filter((s) => s.guaranteed);
  const nonGuaranteed = scored.filter((s) => !s.guaranteed);
  const remainingSlots = Math.max(0, budget1 - guaranteed.length);
  const attempt1Tools = [
    ...guaranteed.map((s) => s.tool),
    ...nonGuaranteed.slice(0, remainingSlots).map((s) => s.tool),
  ];

  return {
    tools: attempt1Tools,
    scored,
    plan,
    activatedGroups,
  };
}
