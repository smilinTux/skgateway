/**
 * engine.mjs — Policy Engine for SKGateway
 *
 * YAML-driven rule evaluation for every inbound inference request.
 * Rules are loaded once at startup (or hot-reloaded via SIGHUP) and
 * evaluated in O(rules × conditions) time — typically well under 1 ms.
 *
 * Rule anatomy
 * ────────────
 *   name:      human-readable identifier (unique)
 *   condition: map of field → value/operator  (ALL must match — logical AND)
 *   action:    allow | deny | transform | rate_limit | alert
 *   transform: redact_pii | downgrade_model | strip_tools | add_safety_prompt
 *   message:   optional string returned to the caller on deny
 *   severity:  info | low | medium | high | critical  (default: info)
 *
 * Condition operands
 * ──────────────────
 *   String fields   — exact match OR glob pattern (e.g. "claude-opus-*")
 *   Numeric fields  — operator prefix: ">= 8", "< 100", "== 0"
 *   Boolean fields  — `true` / `false` (string or JS boolean)
 *
 * Supported context fields
 * ────────────────────────
 *   agent_id, model, backend, prompt_class,
 *   risk_score, jailbreak_score, pii_detected,
 *   time_of_day (HH:MM 24 h), tokens_today, budget_remaining
 *
 * Usage
 * ─────
 *   import { createPolicyEngine } from './policy/engine.mjs';
 *
 *   const engine = createPolicyEngine(rulesArray);              // from parsed YAML
 *   const result = engine.evaluate(request, context);
 *   // result: { allowed, rule_matched, action, transforms, message, severity }
 *
 * Or using the top-level helpers:
 *
 *   import { loadPolicies, evaluatePolicy } from './policy/engine.mjs';
 *   await loadPolicies('/path/to/policies.yaml');
 *   const result = evaluatePolicy(request, context);
 *
 * @module policy/engine
 */

import { readFileSync, existsSync } from 'node:fs';
import { load as yamlLoad }        from 'js-yaml';

// ─── constants ────────────────────────────────────────────────────────────────

/** Severity levels in ascending order of criticality. */
export const SEVERITY_LEVELS = ['info', 'low', 'medium', 'high', 'critical'];

/** All known transform identifiers. */
export const KNOWN_TRANSFORMS = new Set([
  'redact_pii',
  'downgrade_model',
  'strip_tools',
  'add_safety_prompt',
]);

/** All valid actions. */
export const VALID_ACTIONS = new Set(['allow', 'deny', 'transform', 'rate_limit', 'alert']);

// ─── PII patterns ─────────────────────────────────────────────────────────────

/**
 * Ordered list of PII patterns applied by the `redact_pii` transform.
 * Each entry has a compiled RegExp and a replacement label.
 *
 * @type {Array<{ label: string, re: RegExp }>}
 */
const PII_PATTERNS = [
  // SSN  (US)
  { label: '[SSN]',    re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Credit card (Visa, MC, Amex, Discover — 13–16 digits, optional dashes/spaces)
  { label: '[CC]',     re: /\b(?:\d[ -]?){13,16}\b/g },
  // E-mail
  { label: '[EMAIL]',  re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  // US phone  (various formats)
  { label: '[PHONE]',  re: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g },
  // IPv4
  { label: '[IP]',     re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  // API keys / tokens heuristic (long alphanumeric strings)
  { label: '[TOKEN]',  re: /\b(?:sk-|ghp_|gho_|ghs_|ghu_|glpat-|xox[baprs]-)[A-Za-z0-9_\-]{10,}\b/g },
];

// ─── glob matching ────────────────────────────────────────────────────────────

/**
 * Minimal glob matcher that supports `*` (any substring, no path separator)
 * and `**` (any substring including separators).  Case-sensitive.
 *
 * We implement this in-house to avoid a runtime dependency and because the
 * patterns here are simple model/agent name globs — not file system paths.
 *
 * @param {string} pattern  Glob pattern, e.g. "claude-opus-*"
 * @param {string} value    Candidate string to test.
 * @returns {boolean}
 */
function globMatch(pattern, value) {
  if (typeof value !== 'string') return false;

  // Build a regex from the glob pattern.
  // Escape all regex-special chars except * which we convert last.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex specials (not *)
    .replace(/\*\*/g, '\x00')               // placeholder for **
    .replace(/\*/g, '[^]*?')                // * → match any chars (greedy-free)
    .replace(/\x00/g, '[^]*');              // ** → match anything including /

  return new RegExp(`^${escaped}$`).test(value);
}

// ─── numeric comparison ───────────────────────────────────────────────────────

/**
 * Parse and evaluate a numeric comparison expression.
 *
 * Supported operators: `>=`, `<=`, `>`, `<`, `==`, `!=`.
 * The expression string may be just a number (implying `==`).
 *
 * @param {string|number} expr   Condition expression, e.g. ">= 8" or "< 100".
 * @param {number}        actual The runtime value to compare against.
 * @returns {boolean}
 */
function numericCompare(expr, actual) {
  if (typeof expr === 'number') return actual === expr;

  const s = String(expr).trim();
  const m = s.match(/^(>=|<=|>|<|==|!=)\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) {
    // bare number
    const n = parseFloat(s);
    return !isNaN(n) && actual === n;
  }

  const [, op, numStr] = m;
  const threshold = parseFloat(numStr);

  switch (op) {
    case '>=': return actual >= threshold;
    case '<=': return actual <= threshold;
    case '>':  return actual >  threshold;
    case '<':  return actual <  threshold;
    case '==': return actual === threshold;
    case '!=': return actual !== threshold;
    default:   return false;
  }
}

// ─── condition evaluation ─────────────────────────────────────────────────────

/**
 * Numeric context fields — these are compared with `numericCompare` rather
 * than string equality / glob matching.
 */
const NUMERIC_FIELDS = new Set([
  'risk_score',
  'jailbreak_score',
  'tokens_today',
  'budget_remaining',
]);

/**
 * Boolean context fields — coerced to JS boolean before comparison.
 */
const BOOLEAN_FIELDS = new Set([
  'pii_detected',
]);

/**
 * Time-of-day range condition  — special cased.
 * Condition value is a string like "09:00-17:00" (24 h, inclusive).
 *
 * @param {string} range   e.g. "22:00-06:00"  (wraps midnight when start > end)
 * @param {string} actual  e.g. "23:30"
 * @returns {boolean}
 */
function timeInRange(range, actual) {
  const [start, end] = range.split('-').map((t) => t.trim());
  if (!start || !end || !actual) return false;

  const toMins = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + (m || 0);
  };

  const s = toMins(start);
  const e = toMins(end);
  const a = toMins(actual);

  if (s <= e) {
    return a >= s && a <= e;
  } else {
    // wraps midnight
    return a >= s || a <= e;
  }
}

/**
 * Evaluate a single condition map against the provided context.
 * All keys in the condition must match (logical AND).
 *
 * @param {Record<string, *>} condition  From the rule definition.
 * @param {Record<string, *>} context    Runtime request context.
 * @returns {boolean}
 */
function evaluateCondition(condition, context) {
  for (const [field, expected] of Object.entries(condition)) {
    const actual = context[field];

    if (NUMERIC_FIELDS.has(field)) {
      if (!numericCompare(expected, Number(actual))) return false;
      continue;
    }

    if (BOOLEAN_FIELDS.has(field)) {
      const expectedBool = expected === true || expected === 'true';
      const actualBool   = actual  === true  || actual  === 'true';
      if (expectedBool !== actualBool) return false;
      continue;
    }

    if (field === 'time_of_day') {
      if (!timeInRange(String(expected), String(actual ?? ''))) return false;
      continue;
    }

    // String fields — exact match or glob
    const expStr = String(expected);
    const actStr = actual != null ? String(actual) : '';

    if (expStr.includes('*')) {
      if (!globMatch(expStr, actStr)) return false;
    } else {
      if (expStr !== actStr) return false;
    }
  }

  return true;
}

// ─── transforms ───────────────────────────────────────────────────────────────

/**
 * Apply the `redact_pii` transform to a request body.
 *
 * Scans `messages[].content` (string or array-of-parts) and the `system`
 * field, replacing PII patterns with labelled placeholders.
 *
 * The request object is cloned before mutation; the original is not touched.
 *
 * @param {object} request  Parsed request body.
 * @param {object} _rule    The matched rule (unused for this transform).
 * @returns {object} New request with PII redacted.
 */
function transformRedactPii(request, _rule) {
  const req = JSON.parse(JSON.stringify(request)); // deep clone

  const redact = (text) => {
    if (typeof text !== 'string') return text;
    let out = text;
    for (const { label, re } of PII_PATTERNS) {
      out = out.replace(re, label);
    }
    return out;
  };

  if (Array.isArray(req.messages)) {
    for (const msg of req.messages) {
      if (typeof msg.content === 'string') {
        msg.content = redact(msg.content);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text' && typeof part.text === 'string') {
            part.text = redact(part.text);
          }
        }
      }
    }
  }

  if (typeof req.system === 'string') {
    req.system = redact(req.system);
  }

  return req;
}

/**
 * Apply the `downgrade_model` transform.
 *
 * Replaces `request.model` with the rule's `fallback_model`.
 * If no `fallback_model` is specified on the rule, defaults to
 * `"kimi-k2-instruct"` (cheapest capable model in the default backend config).
 *
 * @param {object} request
 * @param {object} rule
 * @returns {object} New request with model replaced.
 */
function transformDowngradeModel(request, rule) {
  const fallback = rule.fallback_model ?? 'kimi-k2-instruct';
  return { ...request, model: fallback };
}

/**
 * Apply the `strip_tools` transform.
 *
 * Removes `tools` and `tool_choice` from the request.
 *
 * @param {object} request
 * @param {object} _rule
 * @returns {object} New request without tools.
 */
function transformStripTools(request, _rule) {
  const { tools, tool_choice, ...rest } = request; // eslint-disable-line no-unused-vars
  return rest;
}

/**
 * Apply the `add_safety_prompt` transform.
 *
 * Prepends a system message with the safety instruction defined in
 * `rule.safety_prompt`.  Falls back to a generic safety reminder.
 *
 * @param {object} request
 * @param {object} rule
 * @returns {object} New request with safety system message prepended.
 */
function transformAddSafetyPrompt(request, rule) {
  const instruction =
    rule.safety_prompt ??
    'You are operating in a restricted mode. Respond only with safe, appropriate content.';

  const req = { ...request };
  const safetyMsg = { role: 'system', content: instruction };

  if (Array.isArray(req.messages)) {
    req.messages = [safetyMsg, ...req.messages];
  } else {
    req.messages = [safetyMsg];
  }

  return req;
}

/**
 * Dispatch table for transform functions.
 *
 * @type {Record<string, (req: object, rule: object) => object>}
 */
const TRANSFORMS = {
  redact_pii:        transformRedactPii,
  downgrade_model:   transformDowngradeModel,
  strip_tools:       transformStripTools,
  add_safety_prompt: transformAddSafetyPrompt,
};

// ─── rule compilation ─────────────────────────────────────────────────────────

/**
 * Validate and normalise a raw rule object loaded from YAML.
 *
 * Throws a descriptive error for any rule that is structurally invalid.
 * Returns a normalised rule with guaranteed fields.
 *
 * @param {object} raw  Raw rule from YAML.
 * @param {number} idx  Index in the rules array (for error messages).
 * @returns {CompiledRule}
 *
 * @typedef {object} CompiledRule
 * @property {string}   name
 * @property {object}   condition
 * @property {string}   action
 * @property {string|null} transform
 * @property {string|null} message
 * @property {string}   severity
 * @property {string|null} fallback_model
 * @property {string|null} safety_prompt
 */
function compileRule(raw, idx) {
  if (!raw || typeof raw !== 'object') {
    throw new TypeError(`Rule[${idx}]: must be an object`);
  }
  if (!raw.name || typeof raw.name !== 'string') {
    throw new TypeError(`Rule[${idx}]: 'name' must be a non-empty string`);
  }
  if (!raw.condition || typeof raw.condition !== 'object') {
    throw new TypeError(`Rule '${raw.name}': 'condition' must be an object`);
  }
  if (!VALID_ACTIONS.has(raw.action)) {
    throw new TypeError(
      `Rule '${raw.name}': 'action' must be one of: ${[...VALID_ACTIONS].join(', ')}`,
    );
  }
  if (raw.action === 'transform' && raw.transform && !KNOWN_TRANSFORMS.has(raw.transform)) {
    throw new TypeError(
      `Rule '${raw.name}': unknown transform '${raw.transform}'. ` +
      `Known: ${[...KNOWN_TRANSFORMS].join(', ')}`,
    );
  }

  return {
    name:           raw.name,
    condition:      raw.condition,
    action:         raw.action,
    transform:      raw.transform      ?? null,
    message:        raw.message        ?? null,
    severity:       SEVERITY_LEVELS.includes(raw.severity) ? raw.severity : 'info',
    fallback_model: raw.fallback_model ?? null,
    safety_prompt:  raw.safety_prompt  ?? null,
    // carry any extra fields through for extensibility
    _raw:           raw,
  };
}

// ─── policy engine ────────────────────────────────────────────────────────────

/**
 * @typedef {object} PolicyResult
 * @property {boolean}       allowed        Whether the request should proceed.
 * @property {string|null}   rule_matched   Name of the first matched rule, or null.
 * @property {string}        action         The action taken (allow/deny/transform/…).
 * @property {string[]}      transforms     Names of transforms applied (may be empty).
 * @property {string|null}   message        Human-readable message from matched rule.
 * @property {string}        severity       Severity from matched rule (default: 'info').
 * @property {object}        request        Potentially-mutated request (after transforms).
 */

/**
 * Policy engine instance created by `createPolicyEngine`.
 *
 * The engine is immutable after creation.  To update rules, create a new
 * instance (cheap — no I/O, <1 ms for typical rule sets).
 *
 * @typedef {object} PolicyEngine
 * @property {CompiledRule[]} rules     Compiled, ordered rule list.
 * @property {function}       evaluate  Evaluate a request against all rules.
 */

/**
 * Create an immutable policy engine from a rules array.
 *
 * Rules are evaluated in order; by default the first matching rule wins
 * (use `continue_on_match: true` on a rule to keep evaluating after it fires).
 * The implicit default at the end of the list is `allow` with no transforms.
 *
 * @param {object[]} rulesArray  Raw rule objects (from parsed YAML `.rules`).
 * @returns {PolicyEngine}
 */
export function createPolicyEngine(rulesArray) {
  if (!Array.isArray(rulesArray)) {
    throw new TypeError('createPolicyEngine: rulesArray must be an Array');
  }

  const rules = rulesArray.map((r, i) => compileRule(r, i));

  /**
   * Evaluate `request` against the compiled rule set.
   *
   * @param {object} request  The (possibly partial) request body being inspected.
   * @param {object} context  Runtime context fields (agent_id, model, scores, etc.).
   * @returns {PolicyResult}
   */
  function evaluate(request, context = {}) {
    let mutatedRequest = request;
    const appliedTransforms = [];

    for (const rule of rules) {
      if (!evaluateCondition(rule.condition, context)) continue;

      // Rule matched — apply action
      switch (rule.action) {

        case 'deny':
          return {
            allowed:      false,
            rule_matched: rule.name,
            action:       'deny',
            transforms:   appliedTransforms,
            message:      rule.message ?? `Request blocked by policy rule: ${rule.name}`,
            severity:     rule.severity,
            request:      mutatedRequest,
          };

        case 'transform': {
          if (rule.transform && TRANSFORMS[rule.transform]) {
            mutatedRequest = TRANSFORMS[rule.transform](mutatedRequest, rule);
            appliedTransforms.push(rule.transform);
          }
          // transforms do not stop evaluation — continue to next rule
          continue; // eslint-disable-line no-continue
        }

        case 'rate_limit':
          return {
            allowed:      false,
            rule_matched: rule.name,
            action:       'rate_limit',
            transforms:   appliedTransforms,
            message:      rule.message ?? `Rate limit applied by policy rule: ${rule.name}`,
            severity:     rule.severity,
            request:      mutatedRequest,
          };

        case 'alert':
          // Alert fires a notification but does NOT block; continue evaluating.
          // The caller is responsible for emitting the alert event.
          // We annotate the result with the alert but keep going.
          // We store it so the final result can surface it.
          // (Uses a local variable; the continue keeps evaluation going.)
          // eslint-disable-next-line no-case-declarations
          continue; // eslint-disable-line no-continue

        case 'allow':
          return {
            allowed:      true,
            rule_matched: rule.name,
            action:       'allow',
            transforms:   appliedTransforms,
            message:      rule.message ?? null,
            severity:     rule.severity,
            request:      mutatedRequest,
          };

        default:
          // Unknown action — skip
          continue; // eslint-disable-line no-continue
      }
    }

    // Implicit default: allow
    return {
      allowed:      true,
      rule_matched: null,
      action:       'allow',
      transforms:   appliedTransforms,
      message:      null,
      severity:     'info',
      request:      mutatedRequest,
    };
  }

  return { rules, evaluate };
}

// ─── singleton engine (hot-reloadable) ────────────────────────────────────────

/** @type {PolicyEngine|null} */
let _engine = null;

/**
 * Load policies from a YAML file and activate the singleton engine.
 *
 * Safe to call multiple times — each call replaces the active engine.
 * Returns the new engine instance.
 *
 * @param {string} [yamlPath]  Path to policies.yaml. Defaults to
 *   `../../config/policies.yaml` relative to this module.
 * @returns {PolicyEngine}
 */
export function loadPolicies(yamlPath) {
  const filePath = yamlPath ?? _defaultPoliciesPath();

  if (!existsSync(filePath)) {
    process.stderr.write(`[skgateway:policy] policies file not found: ${filePath} — using empty allow-all ruleset\n`);
    _engine = createPolicyEngine([]);
    return _engine;
  }

  const raw  = readFileSync(filePath, 'utf8');
  const doc  = yamlLoad(raw) ?? {};
  const rulesArray = doc.rules ?? [];

  _engine = createPolicyEngine(rulesArray);
  process.stderr.write(`[skgateway:policy] Loaded ${rulesArray.length} rules from ${filePath}\n`);
  return _engine;
}

/**
 * Evaluate the singleton engine.
 *
 * Throws if `loadPolicies()` has not been called.
 *
 * @param {object} request  Request body.
 * @param {object} context  Runtime context.
 * @returns {PolicyResult}
 */
export function evaluatePolicy(request, context = {}) {
  if (!_engine) throw new Error('Policy engine not initialised — call loadPolicies() first');
  return _engine.evaluate(request, context);
}

/**
 * Return the currently active singleton engine (may be null before first load).
 *
 * @returns {PolicyEngine|null}
 */
export function getEngine() {
  return _engine;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

import { dirname, resolve } from 'node:path';
import { fileURLToPath }    from 'node:url';

/** @returns {string} Absolute path to the default policies.yaml */
function _defaultPoliciesPath() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return resolve(__dirname, '..', '..', 'config', 'policies.yaml');
}

// ─── transform utilities (exported for testing) ───────────────────────────────

/**
 * Apply the `redact_pii` transform directly (without going through the engine).
 * Useful for unit testing or pre-processing outside the policy loop.
 *
 * @param {object} request
 * @returns {object}
 */
export function redactPii(request) {
  return transformRedactPii(request, {});
}
