import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_PATH = resolve(HERE, 'cases.json');
const ROUTE_RE = /^sk-deepseek-(s|m|l)$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_LATENCY_MS = 600_000;
const MAX_TOKENS = 1_000_000;

export const CASE_TYPES = Object.freeze([
  'tool_use',
  'multiple_tool_calls',
  'json_schema',
  'repository_navigation',
  'code_repair',
  'test_diagnosis',
  'long_context',
  'rejected_tool_recovery',
  'adversarial_instruction_preservation',
]);

const RESULT_SCHEMA = Object.freeze({
  version: 1,
  required: Object.freeze([
    'logical_route', 'provider_family', 'served_model', 'policy_revision',
    'case_set_hash', 'response_schema_hash', 'status', 'qualified_class', 'cases',
  ]),
  case_required: Object.freeze([
    'id', 'type', 'passed', 'reason', 'latency_ms', 'input_tokens',
    'output_tokens', 'total_tokens',
  ]),
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
}

export const QUALIFICATION_RESPONSE_SCHEMA_HASH = sha256(RESULT_SCHEMA);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

let cachedCases;
export function loadQualificationCases() {
  if (cachedCases) return cachedCases;
  const parsed = JSON.parse(readFileSync(CASES_PATH, 'utf8'));
  if (parsed?.classification !== 'public-synthetic' || !Array.isArray(parsed.cases)) {
    throw new Error('qualification cases must be public-synthetic');
  }
  const actualTypes = new Set(parsed.cases.map((item) => item.type));
  if (parsed.cases.length !== CASE_TYPES.length ||
      CASE_TYPES.some((type) => !actualTypes.has(type))) {
    throw new Error('qualification case types do not match the immutable contract');
  }
  cachedCases = deepFreeze(parsed.cases);
  return cachedCases;
}

export function qualificationCaseSetHash() {
  return sha256(loadQualificationCases());
}

export function qualificationResultHash(result) {
  return sha256(result);
}

function validateOptions(options) {
  const allowed = new Set([
    'gatewayUrl', 'route', 'fixtureResponses', 'fetchImpl', 'gatewayAuth', 'now',
  ]);
  const unknown = Object.keys(options).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`qualification option is not allowed: ${unknown.sort().join(',')}`);
  }
  if (Object.hasOwn(options, 'providerApiKey')) {
    throw new Error('raw provider credential input is rejected');
  }
  if (Object.hasOwn(options, 'fixturePath')) {
    throw new Error('arbitrary fixture paths are not allowed');
  }
  if (!ROUTE_RE.test(options.route || '')) {
    throw new Error('qualification requires a focused DeepSeek route');
  }
  let url;
  try {
    url = new URL(options.gatewayUrl);
  } catch {
    throw new Error('an explicit http SKGateway URL is required');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('SKGateway URL must be http and contain no embedded credential');
  }
  const unsafe = `${options.gatewayUrl} ${options.route}`;
  if (/HammerTime|Inbox|Matter|\/home\/|credential/i.test(unsafe)) {
    throw new Error('protected or credential-bearing input is rejected');
  }
  return url;
}

function boundedInteger(value, max, field) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`malformed qualification response: invalid ${field}`);
  }
  return value;
}

function normalizeAttribution(response, route) {
  const attr = response?.attribution;
  if (!attr || typeof attr !== 'object') {
    throw new Error('malformed qualification response: missing attribution');
  }
  if (attr.logical_route !== route || attr.provider_family !== 'deepseek' ||
      typeof attr.served_model !== 'string' || !attr.served_model ||
      !HASH_RE.test(attr.policy_revision || '')) {
    throw new Error('qualification attribution mismatch');
  }
  return {
    logical_route: attr.logical_route,
    provider_family: attr.provider_family,
    served_model: attr.served_model,
    policy_revision: attr.policy_revision,
  };
}

function gradeCase(item, response) {
  if (response?.status !== 200 || !response?.body || typeof response.body !== 'object') {
    throw new Error('malformed qualification response');
  }
  const message = response.body?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') throw new Error('malformed qualification response');
  let passed = false;
  if (item.expected.tool_names) {
    const names = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => call?.function?.name)
      : [];
    passed = canonical(names) === canonical(item.expected.tool_names);
  } else if (item.expected.json) {
    try {
      passed = canonical(JSON.parse(message.content)) === canonical(item.expected.json);
    } catch {
      passed = false;
    }
  } else {
    passed = message.content === item.expected.text;
  }
  const usage = response.body.usage;
  if (!usage || typeof usage !== 'object') throw new Error('malformed qualification response');
  return Object.freeze({
    id: item.id,
    type: item.type,
    passed,
    reason: passed ? 'expected-output' : 'output-mismatch',
    latency_ms: boundedInteger(response.latency_ms, MAX_LATENCY_MS, 'latency_ms'),
    input_tokens: boundedInteger(usage.prompt_tokens, MAX_TOKENS, 'input_tokens'),
    output_tokens: boundedInteger(usage.completion_tokens, MAX_TOKENS, 'output_tokens'),
    total_tokens: boundedInteger(usage.total_tokens, MAX_TOKENS, 'total_tokens'),
  });
}

async function gatewayResponse(item, options, gatewayUrl) {
  if (options.fixtureResponses) return options.fixtureResponses[item.id];
  if (typeof options.fetchImpl !== 'function') {
    throw new Error('fixture responses or an injected gateway fetch are required');
  }
  const authHeaders = typeof options.gatewayAuth === 'function'
    ? await options.gatewayAuth()
    : {};
  if (!authHeaders || typeof authHeaders !== 'object' || Array.isArray(authHeaders) ||
      Object.keys(authHeaders).some((name) => /api[-_]?key|provider/i.test(name))) {
    throw new Error('raw provider credential input is rejected');
  }
  const started = (options.now || Date.now)();
  const response = await options.fetchImpl(
    new URL('chat/completions', gatewayUrl.href.endsWith('/') ? gatewayUrl : `${gatewayUrl.href}/`),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ model: options.route, messages: [{ role: 'user', content: item.prompt }] }),
    },
  );
  const body = await response.json();
  const ended = (options.now || Date.now)();
  return {
    status: response.status,
    latency_ms: Math.max(0, Math.round(ended - started)),
    attribution: body.attribution,
    body,
  };
}

export async function evaluateDeepSeekQualification(options = {}) {
  const gatewayUrl = validateOptions(options);
  const cases = loadQualificationCases();
  if (options.fixtureResponses) {
    const expected = cases.map((item) => item.id).sort();
    const actual = Object.keys(options.fixtureResponses).sort();
    if (canonical(actual) !== canonical(expected)) {
      throw new Error('fixture response ids must exactly match the qualification cases');
    }
  }

  const results = [];
  let attribution = null;
  for (const item of cases) {
    const response = await gatewayResponse(item, options, gatewayUrl);
    const current = normalizeAttribution(response, options.route);
    if (attribution && canonical(current) !== canonical(attribution)) {
      throw new Error('qualification attribution mismatch between cases');
    }
    attribution = current;
    if (response.body.model !== current.served_model) {
      throw new Error('qualification attribution mismatch for served model');
    }
    results.push(gradeCase(item, response));
  }

  const passed = results.every((item) => item.passed);
  return deepFreeze({
    version: 1,
    ...attribution,
    case_set_hash: sha256(cases),
    response_schema_hash: QUALIFICATION_RESPONSE_SCHEMA_HASH,
    evaluated_at: new Date((options.now || Date.now)()).toISOString(),
    status: passed ? 'pass' : 'fail',
    qualified_class: passed ? options.route.match(ROUTE_RE)[1].toUpperCase() : null,
    cases: results,
  });
}
