/**
 * classifier.mjs — Prompt classification, risk scoring, and threat detection for SKGateway
 *
 * Provides four exported functions:
 *
 *   classifyPrompt(messages, systemPrompt)  — Categorize prompt intent (keyword + pattern, <5ms)
 *   scoreRisk(messages)                     — Rate security risk 0-10
 *   detectJailbreak(messages, history)      — Detect jailbreak attempts with pattern list
 *   detectInjection(messages)               — Detect prompt injection in user content
 *
 * Design notes:
 *  - Zero ML dependencies — all classification is regex/keyword scoring compiled at module load.
 *  - Functions are pure and stateless except detectJailbreak which accepts history for
 *    multi-turn escalation tracking (history is read-only; callers own lifecycle).
 *  - All patterns pre-compiled at module load to meet the <5ms per-call budget.
 *  - "Flag, don't block" — all functions return structured findings; policy is the caller's job.
 *
 * @module classifiers/classifier
 */

// ---------------------------------------------------------------------------
// Intent category definitions
// ---------------------------------------------------------------------------

/**
 * @typedef {'code_generation'|'data_query'|'creative'|'administrative'|'security_sensitive'|'tool_use'|'conversation'|'system'} IntentCategory
 */

/**
 * @typedef {Object} CategoryResult
 * @property {IntentCategory} category   - Top matched category
 * @property {number}         confidence - Confidence score 0-1
 * @property {CategoryScore[]} top3      - Up to 3 nearest category scores
 */

/**
 * @typedef {Object} CategoryScore
 * @property {IntentCategory} category
 * @property {number}         score
 * @property {number}         confidence
 */

/**
 * @typedef {Object} RiskResult
 * @property {number}   score    - Risk score 0-10
 * @property {string}   level    - 'normal' | 'sensitive' | 'suspicious' | 'critical'
 * @property {string[]} signals  - Human-readable reasons that contributed to the score
 */

/**
 * @typedef {Object} JailbreakResult
 * @property {boolean}  detected    - Whether a jailbreak attempt was detected
 * @property {string[]} patterns    - Named patterns that matched
 * @property {number}   confidence  - Aggregate confidence 0-1
 */

/**
 * @typedef {Object} InjectionResult
 * @property {boolean} detected    - Whether a prompt injection was detected
 * @property {string}  type        - Short label for the injection type (or '')
 * @property {number}  confidence  - Confidence 0-1
 */

// ---------------------------------------------------------------------------
// Keyword lists — each entry is [regex, weight]
// ---------------------------------------------------------------------------

/**
 * Weighted keyword tables for each intent category.
 * All regexes are pre-compiled here so classification loops pay no compile cost.
 *
 * @type {Object.<IntentCategory, Array<[RegExp, number]>>}
 */
const CATEGORY_PATTERNS = {
  code_generation: [
    [/\b(write|create|generate|implement|code|program|script|function|class|method)\b/i, 3],
    [/\b(debug|fix|refactor|optimize|review|lint|test|unit test|ci\/cd)\b/i, 3],
    [/\b(python|javascript|typescript|rust|go|java|c\+\+|bash|shell|sql|html|css)\b/i, 2],
    [/\b(api|endpoint|library|module|package|dependency|npm|pip|cargo|gradle)\b/i, 2],
    [/\b(variable|loop|array|object|interface|type|enum|struct|generic)\b/i, 2],
    [/\b(error|exception|stack trace|traceback|syntax|compile|runtime)\b/i, 2],
    [/```[\s\S]*?```/i, 4],                        // fenced code blocks
    [/\bdef |function\s+\w+\s*\(|class\s+\w+/i, 5], // actual code snippets
  ],

  data_query: [
    [/\b(query|search|find|lookup|retrieve|fetch|get|select|filter|where)\b/i, 3],
    [/\b(database|db|sql|nosql|mongo|postgres|mysql|sqlite|redis|elasticsearch)\b/i, 3],
    [/\b(table|column|row|record|document|index|schema|migration)\b/i, 2],
    [/\b(analyze|analytics|aggregate|sum|count|average|group by|order by|join)\b/i, 3],
    [/\b(dataset|csv|json|xml|api response|log|metrics|statistics)\b/i, 2],
    [/\b(dashboard|report|chart|graph|visualization|trend|insight)\b/i, 2],
    [/\bSELECT\s+.+\s+FROM\b/i, 5],               // literal SQL
  ],

  creative: [
    [/\b(write|create|generate|draft|compose|craft|imagine|invent)\b/i, 2],
    [/\b(story|poem|essay|blog|article|script|screenplay|dialogue|fiction)\b/i, 4],
    [/\b(character|plot|setting|theme|narrative|chapter|scene|episode)\b/i, 3],
    [/\b(creative|artistic|brainstorm|idea|concept|design|aesthetic|style)\b/i, 3],
    [/\b(music|song|lyrics|melody|art|illustration|image prompt|midjourney|stable diffusion)\b/i, 3],
    [/\b(metaphor|simile|allegory|tone|voice|humor|satire|genre)\b/i, 2],
  ],

  administrative: [
    [/\b(schedule|calendar|meeting|appointment|reminder|deadline|due date)\b/i, 3],
    [/\b(task|todo|gtd|inbox|backlog|board|sprint|ticket|issue|coordination)\b/i, 3],
    [/\b(email|message|memo|report|document|draft|send|forward|reply)\b/i, 2],
    [/\b(project|milestone|roadmap|plan|agenda|priority|assign|delegate)\b/i, 3],
    [/\b(organize|manage|coordinate|track|monitor|review|approve|reject)\b/i, 2],
    [/\b(team|member|stakeholder|manager|owner|role|responsibility)\b/i, 2],
  ],

  security_sensitive: [
    [/\b(password|credential|secret|token|api[_\s]key|private[_\s]key|certificate|cert)\b/i, 5],
    [/\b(ssh|ssl|tls|pgp|gpg|jwt|oauth|auth|authenticate|authorize|securely|secure storage)\b/i, 3],
    [/\b(exploit|vulnerability|cve|penetration|pentest|red team|attack vector)\b/i, 5],
    [/\b(firewall|iptables|acl|permission|privilege|sudo|root|admin|rbac)\b/i, 3],
    [/\b(encrypt|decrypt|hash|salt|bcrypt|aes|rsa|hmac|signature)\b/i, 3],
    [/\b(scan|audit|compliance|soc2|iso27001|gdpr|pci|hipaa)\b/i, 2],
    [/\b(malware|ransomware|phishing|trojan|rootkit|backdoor|payload)\b/i, 5],
    [/\b(key rotation|rotate.{0,10}key|secret management|vault|keystore|key store)\b/i, 4],
  ],

  tool_use: [
    [/\b(run|execute|call|invoke|use|trigger|start|stop|restart|deploy)\b/i, 2],
    [/\b(file|directory|folder|path|read|write|delete|copy|move|rename)\b/i, 2],
    [/\b(tool|function|command|cli|shell|terminal|bash|subprocess|process)\b/i, 3],
    [/\b(plugin|integration|webhook|http|curl|fetch|request|response)\b/i, 2],
    [/\b(upload|download|import|export|sync|backup|restore|transfer)\b/i, 2],
    // MCP/SK tool call patterns
    [/\b(skmemory|skcapstone|skgit|cloud9|capauth|skcomms|skchat)\b/i, 4],
  ],

  conversation: [
    [/\b(hello|hi|hey|howdy|greetings|good morning|good evening)\b/i, 4],
    [/\b(how are you|what('s| is) up|what do you think|tell me|explain|describe)\b/i, 2],
    [/\b(question|answer|help|assist|clarify|understand|know|learn)\b/i, 2],
    [/\b(thanks|thank you|appreciate|great|awesome|nice|cool|interesting)\b/i, 2],
    [/\b(yes|no|maybe|sure|okay|ok|alright|got it|understood|sounds good)\b/i, 2],
    [/^[A-Za-z ,!?.'"]{0,80}[?!]$/im, 2],         // short questions/exclamations
  ],

  system: [
    [/\b(system prompt|system message|instruction|directive|role|persona|behavior)\b/i, 4],
    [/\b(you are|act as|your name is|your role is|you must|you should always)\b/i, 4],
    [/\b(configuration|config|setting|parameter|option|flag|environment|env)\b/i, 3],
    [/\b(policy|rule|constraint|limit|guideline|protocol|standard|compliance)\b/i, 3],
    [/\b(version|model|temperature|max tokens|top[_\s]p|frequency penalty)\b/i, 3],
  ],
};

// Pre-flatten into a single scored pass per category
const COMPILED_CATEGORIES = Object.entries(CATEGORY_PATTERNS).map(([cat, pairs]) => ({
  category: /** @type {IntentCategory} */ (cat),
  pairs,
}));

// ---------------------------------------------------------------------------
// Risk signal patterns — each entry is [regex, points, label]
// ---------------------------------------------------------------------------

/**
 * Ordered list of risk signal patterns.
 * Each tuple: [compiled RegExp, score contribution, human-readable label].
 * Total across matched signals → capped to 10.
 *
 * @type {Array<[RegExp, number, string]>}
 */
const RISK_SIGNALS = [
  // Credential/secret handling (moderate)
  [/\b(password|secret|api[_\s]?key|private[_\s]?key|token|credential)\b/i, 2, "credential mention"],
  [/\b(ssh[_\s]?key|certificate|pfx|p12|pem|keystore)\b/i, 2, "cryptographic material"],
  // Credential management operations — rotate, store, manage secrets (sensitive but legitimate)
  [/\b(rotate|revoke|expire|reissue|invalidate).{0,30}(key|secret|token|credential|password)\b/i, 2, "credential rotation"],
  [/\b(secret manager|vault|key management|kms|hsm|secrets? storage|credential store)\b/i, 2, "secrets management system"],

  // System access (moderate)
  [/\b(sudo|root|admin|privilege escalat|setuid|chown|chmod 777)\b/i, 3, "privilege escalation"],
  [/\b(\/etc\/passwd|\/etc\/shadow|\/proc\/|\/dev\/|\/sys\/)\b/i, 3, "sensitive filesystem path"],
  [/\b(iptables|nftables|ufw|selinux|apparmor|seccomp)\b/i, 2, "security subsystem access"],

  // Exfiltration signals (high)
  [/\b(exfiltrat|data dump|dump (database|db|tables?)|leak|expos[ei])\b/i, 4, "data exfiltration intent"],
  [/\b(send (to|all)|upload|post|transmit|pipe).{0,40}(external|remote|webhook|discord|slack|telegram)/i, 3, "external data transfer"],
  [/\bhttps?:\/\/(?!localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/i, 1, "external URL"],

  // Offensive security (high)
  [/\b(exploit|payload|shellcode|buffer overflow|use[_\s]after[_\s]free|rop chain)\b/i, 4, "exploit technique"],
  [/\b(reverse shell|bind shell|netcat|nc -[el]|bash -i|mkfifo)\b/i, 5, "shell establishment"],
  [/\b(sql injection|xss|csrf|xxe|ssrf|rce|lfi|rfi|open redirect)\b/i, 4, "web attack vector"],
  [/\b(malware|ransomware|worm|trojan|rootkit|keylogger|spyware|botnet)\b/i, 5, "malware reference"],

  // Jailbreak-adjacent (suspicious)
  [/\bignore (previous|all|prior|above|earlier) instructions?\b/i, 4, "instruction override attempt"],
  [/\b(DAN|jailbreak|unfiltered|no restrictions?|bypass (safety|filter|guardrail))\b/i, 4, "jailbreak keyword"],
  [/\bpretend (you (are|have no)|there (are|is) no)\b/i, 3, "role subversion"],

  // Encoding tricks (suspicious)
  [/[A-Za-z0-9+/]{40,}={0,2}(?:\s|$)/, 2, "possible base64 blob"],
  [/(?:\\x[0-9a-f]{2}){6,}/i, 3, "hex escape sequence chain"],
  [/(?:&#\d{2,5};){4,}/i, 3, "HTML entity chain"],
  [/%[0-9a-f]{2}(?:%[0-9a-f]{2}){5,}/i, 2, "URL encoding chain"],
];

// ---------------------------------------------------------------------------
// Jailbreak detection patterns
// ---------------------------------------------------------------------------

/**
 * Named jailbreak pattern entries.
 * Each has a name, compiled regex, and base confidence contribution.
 *
 * @type {Array<{name: string, re: RegExp, weight: number}>}
 */
const JAILBREAK_PATTERNS = [
  // Classic instruction override
  {
    name: "ignore_instructions",
    re: /\bignore (previous|all|prior|above|earlier|your) instructions?\b/i,
    weight: 0.9,
  },
  {
    name: "disregard_instructions",
    re: /\b(disregard|forget|override|bypass|circumvent) (your )?(previous |prior |all |earlier )?instructions?\b/i,
    weight: 0.85,
  },

  // Persona hijacking
  {
    name: "dan_persona",
    re: /\b(you are now |act as |switch to )?(DAN|do anything now|jailbreak mode|unrestricted mode|unfiltered mode)\b/i,
    weight: 0.95,
  },
  {
    name: "persona_injection",
    re: /\b(you are now|from now on you are|your new name is|you have been reset to|you are acting as)\b/i,
    weight: 0.7,
  },
  {
    name: "pretend_roleplay",
    re: /\bpretend (you (are|have no restrictions?|were not|can|don't have)|there (are|is) no (rules?|restrictions?|guidelines?))\b/i,
    weight: 0.8,
  },
  {
    name: "fictional_framing",
    re: /\b(in (a|this) (fictional|hypothetical|alternate|fantasy|sci-?fi) (world|universe|scenario|story|setting))[^.]{0,100}(kill|harm|attack|exploit|hack|bypass|illegal)/i,
    weight: 0.75,
  },

  // Encoding / obfuscation
  {
    name: "base64_instruction",
    // Looks for a long base64 blob followed by "decode and" or similar instruction
    re: /[A-Za-z0-9+/]{30,}={0,2}\s{0,5}(decode|execute|run|eval|interpret)/i,
    weight: 0.8,
  },
  {
    name: "rot13_indicator",
    re: /\b(rot13|rot-13|caesar cipher|shift cipher)\b/i,
    weight: 0.6,
  },
  {
    name: "unicode_lookalike",
    // Cyrillic/homoglyph substitution in otherwise ASCII text (e.g. "ρаssword")
    re: /[\u0400-\u04FF\u0250-\u02AF\uFB00-\uFB4F]{2,}/,
    weight: 0.65,
  },

  // Token smuggling
  {
    name: "token_smuggling",
    re: /<\|[a-z_]{3,30}\|>|<im_(start|end|sep)>|\[INST\]|\[\/INST\]|<SYS>|<<SYS>>/i,
    weight: 0.85,
  },
  {
    name: "end_of_system_probe",
    re: /\bEND OF SYSTEM PROMPT\b|\bSYSTEM PROMPT END\b|---+\s*(USER|HUMAN|ASSISTANT):\s/i,
    weight: 0.8,
  },

  // Capability probing
  {
    name: "capability_unlock",
    re: /\b(unlock|enable|activate|turn (on|off)|remove|disable) (your )?(safety|filter|guardrail|restriction|limit|cap|cap|censorship|moderation)/i,
    weight: 0.85,
  },
  {
    name: "dev_mode",
    re: /\b(developer mode|dev mode|god mode|sudo mode|admin mode|root mode|unrestricted mode|no[_-]?filter mode)\b/i,
    weight: 0.9,
  },

  // Hypothetical abuse framing
  {
    name: "hypothetical_harm",
    re: /\b(hypothetically|theoretically|just for (fun|educational purposes?|research|curiosity)|if you (could|had no restrictions?))[^.]{0,80}(make|build|write|create|explain|describe)[^.]{0,80}(weapon|bomb|virus|malware|exploit|poison|drug|hack)/i,
    weight: 0.75,
  },

  // Multi-turn escalation marker (detected in history analysis)
  {
    name: "escalation_sequence",
    re: /ESCALATION_DETECTED/, // synthetic — injected by multi-turn analysis
    weight: 0.7,
  },
];

// ---------------------------------------------------------------------------
// Prompt injection detection patterns
// ---------------------------------------------------------------------------

/**
 * @type {Array<{type: string, re: RegExp, weight: number}>}
 */
const INJECTION_PATTERNS = [
  // Direct override in user text
  {
    type: "instruction_override",
    re: /\b(ignore|disregard|forget|override|bypass)\s+(the\s+)?(above|previous|prior|all|system)\s+(instructions?|prompt|context|rules?|directions?)\b/i,
    weight: 0.9,
  },

  // Delimiter boundary attacks — user tries to close the system block
  {
    type: "delimiter_injection",
    re: /(<\/?(system|human|assistant|user|instruction|prompt|context)>|<\|im_(start|end)\|>|\[SYSTEM\]|\[\/SYSTEM\])/i,
    weight: 0.85,
  },

  // Markdown/code-fence boundary injection
  {
    type: "markdown_boundary",
    re: /```\s*(system|instructions?|prompt|assistant:?|human:?)\s*\n/i,
    weight: 0.75,
  },

  // Spurious YAML/JSON front-matter claiming system authority
  {
    type: "yaml_injection",
    re: /^---\s*\n(role|persona|instruction|system|mode|behavior)\s*:/im,
    weight: 0.92,
  },
  {
    type: "json_injection",
    re: /^\s*\{\s*"(role|instruction|system|persona|mode)"\s*:/im,
    weight: 0.8,
  },

  // Trying to inject new persona/role mid-conversation
  {
    type: "persona_override",
    re: /\b(from now on|starting now|going forward)[^.]{0,60}(you (are|will|must|should)|your (name|role|task|job|purpose|goal) is)\b/i,
    weight: 0.8,
  },

  // "Hidden" instruction patterns (invisible characters, excessive whitespace tricks)
  {
    type: "invisible_text",
    re: /[\u200B-\u200D\uFEFF\u00AD\u2060]{3,}/, // zero-width / soft-hyphen chains
    weight: 0.9,
  },

  // Instruction injection in apparent data fields (e.g. CSV/JSON values containing directives)
  {
    type: "data_field_injection",
    re: /"[^"]{0,40}(ignore|override|forget|you are|act as|new instructions?)[^"]{0,40}"/i,
    weight: 0.7,
  },

  // Nested prompt: user asks model to read a file that "contains system instructions"
  {
    type: "indirect_injection",
    re: /\b(read|load|fetch|open|include|execute)[^.]{0,60}\b(system (prompt|instructions?)|new instructions?|override instructions?)\b/i,
    weight: 0.75,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract all text content from a messages array.
 * Handles string content, array-of-parts content, and assistant messages.
 *
 * @param {Array<{role: string, content: any}>} messages
 * @param {string} [roleFilter] - If set, only include messages of this role
 * @returns {string}
 */
function extractText(messages, roleFilter) {
  if (!Array.isArray(messages)) return "";
  return messages
    .filter(m => !roleFilter || m.role === roleFilter)
    .map(m => {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter(p => p.type === "text")
          .map(p => p.text || "")
          .join(" ");
      }
      return "";
    })
    .join("\n");
}

/**
 * Normalize text for pattern matching — lowercase, collapse whitespace.
 * Does NOT strip punctuation so regex word-boundary anchors still work.
 *
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Clamp a number between min and max.
 *
 * @param {number} val
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify the intent of a prompt.
 *
 * Runs all category keyword sets against the combined user + system text and
 * returns the top category, a 0-1 confidence score, and the top 3 runners-up.
 * Pure keyword/regex — no ML — guaranteed <5ms on any reasonable input.
 *
 * @param {Array<{role: string, content: any}>} messages  - Conversation messages
 * @param {string} [systemPrompt]                          - Optional separate system prompt string
 * @returns {CategoryResult}
 *
 * @example
 * const result = classifyPrompt(messages, systemPrompt);
 * // { category: 'code_generation', confidence: 0.82, top3: [...] }
 */
export function classifyPrompt(messages, systemPrompt = "") {
  const userText = extractText(messages, "user");
  const allText = extractText(messages) + " " + (systemPrompt || "");
  const combined = normalize(userText + " " + allText); // weight user text by including it twice

  /** @type {CategoryScore[]} */
  const scores = COMPILED_CATEGORIES.map(({ category, pairs }) => {
    let raw = 0;
    for (const [re, weight] of pairs) {
      // Count all matches (global flag handled by exec loop to avoid state issues)
      let m;
      const testRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      while ((m = testRe.exec(combined)) !== null) {
        raw += weight;
        if (m.index === testRe.lastIndex) testRe.lastIndex++; // guard against zero-width
      }
    }
    return { category, score: raw, confidence: 0 };
  });

  const total = scores.reduce((s, c) => s + c.score, 0);

  if (total === 0) {
    // No signals — default to conversation with low confidence
    return {
      category: "conversation",
      confidence: 0.1,
      top3: [{ category: "conversation", score: 0, confidence: 0.1 }],
    };
  }

  // Normalize scores to confidences
  for (const s of scores) {
    s.confidence = s.score / total;
  }

  scores.sort((a, b) => b.score - a.score);

  const top = scores[0];
  const top3 = scores.slice(0, 3).filter(s => s.score > 0);

  return {
    category: top.category,
    confidence: top.confidence,
    top3,
  };
}

/**
 * Score the security risk of a set of messages.
 *
 * Returns an integer 0-10 and a human-readable level label:
 *  - 0-2  normal       — everyday conversation or code
 *  - 3-5  sensitive    — credentials, system access (legitimate use likely)
 *  - 6-8  suspicious   — unusual patterns, possible injection attempts
 *  - 9-10 critical     — high-confidence jailbreak / exfiltration attempt
 *
 * @param {Array<{role: string, content: any}>} messages
 * @returns {RiskResult}
 *
 * @example
 * const risk = scoreRisk(messages);
 * // { score: 7, level: 'suspicious', signals: ['exploit technique', 'external URL'] }
 */
export function scoreRisk(messages) {
  const text = extractText(messages);
  const userText = extractText(messages, "user");

  let totalScore = 0;
  /** @type {string[]} */
  const signals = [];

  for (const [re, points, label] of RISK_SIGNALS) {
    if (re.test(text)) {
      totalScore += points;
      signals.push(label);
    }
  }

  // Extra penalty: signals in user messages weigh more than in assistant
  // Rescore against user-only text to detect whether user is the source
  let userBonus = 0;
  for (const [re, points] of RISK_SIGNALS) {
    if (points >= 3 && re.test(userText)) {
      userBonus += 1; // +1 per high-weight signal originating from user
    }
  }
  totalScore += userBonus;

  // Cap to 10
  const score = clamp(Math.round(totalScore), 0, 10);

  const level =
    score <= 2 ? "normal" :
    score <= 5 ? "sensitive" :
    score <= 8 ? "suspicious" : "critical";

  return { score, level, signals };
}

/**
 * Detect jailbreak attempts in a conversation.
 *
 * Scans the current messages for known jailbreak patterns and also checks
 * the session history for multi-turn escalation sequences (repeated
 * probing that individually looks benign but collectively signals intent).
 *
 * @param {Array<{role: string, content: any}>}  messages - Current turn messages
 * @param {Array<{role: string, content: any}>} [history] - Prior turns in the session (read-only)
 * @returns {JailbreakResult}
 *
 * @example
 * const jb = detectJailbreak(messages, sessionHistory);
 * // { detected: true, patterns: ['dan_persona', 'capability_unlock'], confidence: 0.92 }
 */
export function detectJailbreak(messages, history = []) {
  const currentText = extractText(messages, "user");

  /** @type {string[]} */
  const matchedPatterns = [];
  let weightSum = 0;

  // --- Single-turn pattern scan ---
  for (const { name, re, weight } of JAILBREAK_PATTERNS) {
    if (name === "escalation_sequence") continue; // handled separately
    if (re.test(currentText)) {
      matchedPatterns.push(name);
      weightSum += weight;
    }
  }

  // --- Multi-turn escalation detection ---
  // Strategy: look at the last N user turns in history and count how many
  // contained mild jailbreak-adjacent signals. If 3+ turns show escalating
  // patterns, flag it.
  if (history.length > 0) {
    const historyUserMessages = history
      .filter(m => m.role === "user")
      .slice(-8); // examine last 8 user turns

    // Mild signals — things that alone are noise but together are a signal
    const ESCALATION_SIGNALS = [
      /\bignore\b/i,
      /\bpretend\b/i,
      /\bact as\b/i,
      /\byou are now\b/i,
      /\bhypothetically\b/i,
      /\bno restrictions?\b/i,
      /\bunfiltered\b/i,
      /\bbypass\b/i,
      /\boverride\b/i,
      /\bfor (educational|research) purposes?\b/i,
    ];

    let escalationHits = 0;
    for (const msg of historyUserMessages) {
      const txt = extractText([msg]);
      let hitCount = 0;
      for (const sig of ESCALATION_SIGNALS) {
        if (sig.test(txt)) hitCount++;
      }
      if (hitCount >= 1) escalationHits++;
    }

    if (escalationHits >= 3) {
      matchedPatterns.push("escalation_sequence");
      // Weight proportionally to how many turns showed signals
      const escalationWeight = Math.min(0.85, 0.4 + (escalationHits - 3) * 0.1);
      weightSum += escalationWeight;
    }
  }

  // Aggregate confidence: weighted average capped at 1.0
  // Multiple independent signals compound (diminishing returns via average)
  const confidence = matchedPatterns.length === 0
    ? 0
    : clamp(weightSum / matchedPatterns.length, 0, 1);

  const detected = confidence >= 0.5 || matchedPatterns.length >= 2;

  return { detected, patterns: matchedPatterns, confidence };
}

/**
 * Detect prompt injection attempts in user-supplied content.
 *
 * Focuses on patterns where user-role content tries to masquerade as or
 * override system-level instructions — delimiter attacks, YAML/JSON
 * front-matter injection, persona overrides, and invisible-text tricks.
 *
 * @param {Array<{role: string, content: any}>} messages
 * @returns {InjectionResult}
 *
 * @example
 * const inj = detectInjection(messages);
 * // { detected: true, type: 'delimiter_injection', confidence: 0.85 }
 */
export function detectInjection(messages) {
  // Only inspect user-role messages — assistant and system content is trusted
  const userText = extractText(messages, "user");

  /** @type {Array<{type: string, weight: number}>} */
  const hits = [];

  for (const { type, re, weight } of INJECTION_PATTERNS) {
    if (re.test(userText)) {
      hits.push({ type, weight });
    }
  }

  if (hits.length === 0) {
    return { detected: false, type: "", confidence: 0 };
  }

  // Pick the highest-weight hit as the primary type label
  hits.sort((a, b) => b.weight - a.weight);
  const top = hits[0];

  // Compound confidence: first hit at full weight, each additional at diminishing rate
  let confidence = top.weight;
  for (let i = 1; i < hits.length; i++) {
    confidence = Math.min(1, confidence + hits[i].weight * 0.15);
  }

  return {
    detected: confidence >= 0.5,
    type: top.type,
    confidence: clamp(confidence, 0, 1),
  };
}

// ---------------------------------------------------------------------------
// Non-streaming decision
// ---------------------------------------------------------------------------

/**
 * Decide whether a chat-completion request should be forced to non-streaming
 * mode upstream (the client's SSE contract is preserved by re-emitting the
 * buffered JSON as SSE).  Non-streaming avoids mid-stream connection drops
 * from providers like NVIDIA NIM on long or tool-heavy turns.
 *
 * Precedence: force header > per-model aggressive > threshold triggers.
 *
 * @param {object} parsed  Parsed JSON request body (may be null).
 * @param {Record<string,string|string[]>} headers  Incoming request headers.
 * @param {number} bodyBytes  Byte length of the raw request body.
 * @param {object} streamCfg  cfg.streaming — { force_header, auto_nonstream }.
 * @returns {{ force: boolean, reason: string }}
 */
export function shouldForceNonStream(parsed, headers, bodyBytes, streamCfg) {
  if (!streamCfg || streamCfg.default === false) {
    return { force: true, reason: "streaming_disabled_globally" };
  }

  const auto = streamCfg.auto_nonstream || {};
  const hdrName = (streamCfg.force_header || "x-skgateway-nonstream").toLowerCase();
  const hdrVal = String(headers?.[hdrName] ?? "").toLowerCase();
  if (hdrVal === "force" || hdrVal === "1" || hdrVal === "true") {
    return { force: true, reason: "force_header" };
  }

  if (!auto.enabled) return { force: false, reason: "auto_disabled" };
  if (!parsed) return { force: false, reason: "non_json" };

  const model = parsed.model || "";
  const aggressive = auto.aggressive_models || [];
  const isAggressive = aggressive.some((m) => model.includes(m));

  if (isAggressive) {
    // Aggressive: any one trigger flips.  Everything else: all-of (rare).
    if (Number.isFinite(auto.trigger_if_body_bytes_ge) &&
        bodyBytes >= auto.trigger_if_body_bytes_ge) {
      return { force: true, reason: `aggressive_body_bytes=${bodyBytes}` };
    }
    if (Number.isFinite(auto.trigger_if_messages_ge) &&
        Array.isArray(parsed.messages) &&
        parsed.messages.length >= auto.trigger_if_messages_ge) {
      return { force: true, reason: `aggressive_messages=${parsed.messages.length}` };
    }
    const toolHistCount = countToolCallsInHistory(parsed.messages);
    if (Number.isFinite(auto.trigger_if_tool_call_history_ge) &&
        toolHistCount >= auto.trigger_if_tool_call_history_ge) {
      return { force: true, reason: `aggressive_tool_history=${toolHistCount}` };
    }
    // Aggressive models also non-stream if any `tools` are present at all —
    // NIM streaming is unstable on tool-calling turns regardless of size.
    if (Array.isArray(parsed.tools) && parsed.tools.length > 0) {
      return { force: true, reason: "aggressive_tools_present" };
    }
    return { force: false, reason: "aggressive_no_trigger" };
  }

  // Non-aggressive: only flip on clear-cut large turns.
  if (Number.isFinite(auto.trigger_if_body_bytes_ge) &&
      bodyBytes >= auto.trigger_if_body_bytes_ge) {
    return { force: true, reason: `body_bytes=${bodyBytes}` };
  }
  if (Array.isArray(parsed.messages) &&
      Number.isFinite(auto.trigger_if_messages_ge) &&
      parsed.messages.length >= auto.trigger_if_messages_ge) {
    const toolHistCount = countToolCallsInHistory(parsed.messages);
    if (Number.isFinite(auto.trigger_if_tool_call_history_ge) &&
        toolHistCount >= auto.trigger_if_tool_call_history_ge) {
      return { force: true, reason: `messages=${parsed.messages.length}+tool_history=${toolHistCount}` };
    }
  }

  return { force: false, reason: "no_trigger" };
}

/**
 * Count assistant messages in `messages` that carry `tool_calls` entries.
 * Proxy for "how deep is the tool-use loop so far".
 * @param {Array} messages
 * @returns {number}
 */
function countToolCallsInHistory(messages) {
  if (!Array.isArray(messages)) return 0;
  let n = 0;
  for (const m of messages) {
    if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) n++;
    if (m?.role === "tool" || m?.role === "toolResult") n++;
  }
  return n;
}
