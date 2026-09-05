/**
 * capability-assessment.mjs: the MEASUREMENT half of card C9 (coordination id
 * 2ba73bf9, "MEMBERSHIP IS MEASURED, NOT DECLARED").
 *
 * This module does not decide bucket membership (that is C9's other half,
 * built on top of this one in src/policy/buckets.mjs). It only produces
 * evidence: given an injected `chatComplete` function, it runs a small battery
 * of real completions against a model and records what actually happened,
 * never what a provider card claims. Concrete motivation, measured
 * 2026-08-14: models.dev declares `tool_call: true` for all seven live free
 * OpenCode models; testing them, five demonstrably emit a correct tool_call
 * and two returned 429 and could not be verified either way. The declaration
 * was a reasonable prior, not a fact, for any individual model, until it was
 * exercised.
 *
 * SCHEMA (this is the contract the bucket-membership work consumes):
 *
 *   MeasurementEntry = {
 *     capability: 'measured',              // literal marker, see below
 *     status: 'pass' | 'fail' | 'unmeasured',
 *     assertion: string,                   // e.g. 'capability.tool_call.v1'
 *     measured_at: number,                 // ms epoch of THIS attempt, set
 *                                           // even when status is 'unmeasured'
 *     evidence: object | null,             // assertion-specific detail
 *     last_unmeasured_attempt_at?: number, // present only when a later
 *                                           // attempt was throttled/timed out
 *                                           // and the prior determinate
 *                                           // (pass/fail) value was preserved
 *                                           // instead of being overwritten
 *   }
 *
 *   NumericMeasurementEntry = {            // shape of `min_output_tokens`
 *     capability: 'measured',
 *     status: 'measured' | 'unmeasured',
 *     value: number | null,                // smallest max_tokens in the
 *                                           // ladder that produced non-empty
 *                                           // content; null if 'measured' but
 *                                           // no rung produced content, or if
 *                                           // 'unmeasured'
 *     assertion: string,
 *     measured_at: number,
 *     checked_levels: Array<{max_tokens:number, outcome:'content'|'empty'|'transport_fail'|'unmeasured'}>,
 *     last_unmeasured_attempt_at?: number,
 *   }
 *
 *   CapabilityRecord = {
 *     liveness: MeasurementEntry,
 *     tool_call: MeasurementEntry,
 *     structured_output: MeasurementEntry,
 *     instruction_following: MeasurementEntry,
 *     min_output_tokens: NumericMeasurementEntry,
 *     last_full_assessment_at: number | null,
 *   }
 *
 * `capability: 'measured'` on every entry this module produces is the literal
 * marker the card requires ("`capability: claimed` and `capability: measured`
 * MUST be distinguishable fields"). It is the counterpart to the DECLARED
 * fields a model card already carries (src/ranking/capabilities.mjs's
 * `tool_use: {score, basis: 'card'|'heuristic'}` and card N2's declared
 * fields on the catalog entry): those live on the ephemeral catalog entry,
 * rebuilt every discovery cycle straight from provider metadata, and this
 * module never reads or writes them. A `CapabilityRecord` is instead merged
 * onto the PERSISTENT per-model lifecycle record (model_catalog_store.json,
 * the same record `defaultLifecycle()` seeds and `applyProbeOutcome` already
 * mutates) under the key `measured_capabilities`, by probe.mjs, which already
 * owns building that record every sweep. That placement is deliberate: the
 * catalog gets rebuilt from provider data every cycle (so anything measured
 * would otherwise be clobbered the moment a provider re-declares its card),
 * while the lifecycle store persists node-locally across cycles exactly like
 * `eol_reason` and `last_verified_at` already do. A measured fact is never
 * overwritten by a declared one because they physically live in different
 * records; `applyCapabilityMeasurement` below additionally guarantees a
 * measured fact is never overwritten by a WEAKER measured one either (an
 * `unmeasured` retry can never erase a prior `pass`/`fail`).
 *
 * Every assertion classifies its own transport outcome before it ever
 * evaluates content, per card 2ba73bf9's explicit rule: "A 429 during
 * assessment must record unmeasured, NEVER incapable. Those are different
 * facts... Same for a timeout or a 5xx." Only a well-formed response to a
 * request we authored ourselves, that does not satisfy the assertion, is
 * `fail` (mirrors lifecycle.mjs's `applyProbeOutcome` precedent that a
 * rejection of OUR OWN well-formed request is evidence about the model, not
 * about us).
 *
 * @module discovery/capability-assessment
 */

/** How many models get a FULL capability battery in one sweep (tier 2, expensive). Small on purpose: a battery is up to 7 sequential completions per model versus the liveness probe's 1, and it only runs against models the liveness probe (tier 1) already confirmed alive this sweep. */
export const DEFAULT_CAPABILITY_BUDGET = 3;

/** How rarely a model already holding a capability record gets re-assessed. A first-sighting model (no record at all) ignores this and is always eligible, budget permitting; see selectCapabilityCandidates. */
export const DEFAULT_CAPABILITY_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/** Per-call timeout for a capability assertion. More generous than the liveness probe's timeout: these calls ask for real content, not one word. */
export const DEFAULT_CAPABILITY_TIMEOUT_MS = 30_000;

/**
 * max_tokens ladder for the min_output_tokens assertion (design: "Use a
 * generous max_tokens, and RECORD the minimum at which the model actually
 * produces content"). Deliberately a short, coarse ladder rather than a
 * binary search: this assertion already only runs at tier-2 cadence
 * (rare/first-sighting) against a small per-sweep budget, so a handful of
 * sequential calls per model is affordable; a tighter search would cost more
 * calls for a precision this system does not need (bucketing only needs "can
 * this model answer at a token budget Ornith-shaped harnesses actually use,"
 * not the exact byte-level minimum). 2048 is the ceiling because Ornith
 * itself needs >=2048 to produce any answer at all (several free models in
 * this fleet share that trait via empty `content` alongside populated
 * `reasoning_content`), so the ladder must reach at least that high or it
 * would repeat the exact mistake this assertion exists to catch.
 */
export const MIN_OUTPUT_TOKEN_LADDER = [64, 256, 1024, 2048];

const LIVENESS_ASSERTION = 'capability.liveness.v1';
const TOOL_CALL_ASSERTION = 'capability.tool_call.v1';
const STRUCTURED_OUTPUT_ASSERTION = 'capability.structured_output.v1';
const INSTRUCTION_FOLLOWING_ASSERTION = 'capability.instruction_following.v1';
const MIN_OUTPUT_TOKENS_ASSERTION = 'capability.min_output_tokens.v1';

/** A real tool schema (design: "given a real tool schema"), not a toy with no required fields, so a well-formed pass genuinely demonstrates argument construction. */
export const TOOL_ASSESSMENT_SCHEMA = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, e.g. "Paris"' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
      },
      required: ['city'],
    },
  },
};

export const STRUCTURED_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    count: { type: 'number' },
  },
  required: ['name', 'count'],
};

export const INSTRUCTION_FOLLOWING_EXPECTED = 'PONG';

const MIN_OUTPUT_TOKEN_PROMPT = 'What is 12 plus 7? Reply with just the final number.';

/** Build the request body for the tool-calling assertion. Exported so tests and any future assertion can share the exact fixture. */
export function buildToolCallRequest() {
  return {
    messages: [{ role: 'user', content: 'What is the weather in Paris? Use the get_weather tool to find out.' }],
    tools: [TOOL_ASSESSMENT_SCHEMA],
    tool_choice: 'required',
    max_tokens: 256,
  };
}

export function buildStructuredOutputRequest() {
  return {
    messages: [
      {
        role: 'user',
        content:
          'Reply with ONLY a JSON object matching this shape, nothing else: {"name": string, "count": number}. Use "widget" for name and 3 for count.',
      },
    ],
    max_tokens: 256,
  };
}

export function buildInstructionFollowingRequest() {
  return {
    messages: [
      { role: 'user', content: 'Reply with exactly these four characters and nothing else, no punctuation: PONG' },
    ],
    max_tokens: 64,
  };
}

export function buildMinOutputTokensRequest(maxTokens) {
  return {
    messages: [{ role: 'user', content: MIN_OUTPUT_TOKEN_PROMPT }],
    max_tokens: maxTokens,
  };
}

/**
 * Classify the transport-level outcome of a `chatComplete` call, before any
 * content is evaluated. Three outcomes:
 *   - 'ok': a 2xx came back; the caller should go on to evaluate content.
 *   - 'unmeasured': 429 (card 9e28de88's "alive and throttled" rule, applied
 *     here to assessment the same way it already applies to the liveness
 *     probe), a timeout/network error (no status at all), or a 5xx. None of
 *     these say anything about the model's capability, only about the
 *     request's luck.
 *   - 'fail': any other non-2xx status (400/401/403/404/410/422/...) on a
 *     request WE authored ourselves: the model or backend rejected a
 *     well-formed request outright, which is evidence, not noise.
 *
 * @param {{ok?: boolean, status?: number}|null|undefined} res
 * @returns {{outcome:'ok'|'unmeasured'|'fail', reason?: string, status?: number}}
 */
export function classifyTransport(res) {
  if (res && res.ok === true) return { outcome: 'ok' };
  const status = res && res.status;
  if (status === 429) return { outcome: 'unmeasured', reason: 'rate_limited', status };
  if (status === undefined || status === null) return { outcome: 'unmeasured', reason: 'timeout_or_network', status };
  if (status >= 500) return { outcome: 'unmeasured', reason: '5xx', status };
  return { outcome: 'fail', reason: 'rejected', status };
}

function measurementEntry({ status, assertion, now, evidence = null }) {
  return { capability: 'measured', status, assertion, measured_at: now, evidence };
}

async function safeCall(chatComplete, id, request, { timeoutMs } = {}) {
  try {
    return await chatComplete(id, request, { timeoutMs });
  } catch {
    return { ok: false, status: undefined };
  }
}

/**
 * Pull the assistant message out of a `chatComplete` result. Two shapes are
 * accepted, because two kinds of runner feed this battery:
 *   - `{message}`: a runner that already unwrapped the completion (the unit
 *     tests, and any adapter that pre-extracts `choices[0].message`);
 *   - `{json}` / a bare completion body: the raw OpenAI-compatible wire shape,
 *     `{choices: [{message: {...}}]}`, which is what
 *     src/ranking/eval.mjs's createLoopbackChatComplete returns verbatim and
 *     what a direct provider call returns.
 * Until 2026-09-04 only the first shape was read, so every battery run
 * through the loopback runner saw an empty message and recorded a
 * tool-capable model as `fail` / `no_matching_tool_call`. A measurement that
 * cannot see the response is not a measurement; reading the wire shape here
 * (rather than adapting every runner) keeps one definition of "what the model
 * said" for every caller.
 */
function extractMessage(res) {
  if (!res) return {};
  if (res.message && typeof res.message === 'object') return res.message;
  const body = res.json && typeof res.json === 'object' ? res.json : res;
  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  return (choice && choice.message && typeof choice.message === 'object') ? choice.message : {};
}

/**
 * Tool calling assertion (design: "the single most load-bearing capability
 * for agent work and the most commonly overclaimed"). Passes only when the
 * model emits at least one tool_call naming the tool we offered, whose
 * `arguments` parses as JSON and carries the schema's required field.
 */
export async function assessToolCalling(chatComplete, id, { timeoutMs, now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const res = await safeCall(chatComplete, id, buildToolCallRequest(), { timeoutMs });
  const transport = classifyTransport(res);
  if (transport.outcome !== 'ok') {
    return measurementEntry({
      status: transport.outcome === 'fail' ? 'fail' : 'unmeasured',
      assertion: TOOL_CALL_ASSERTION,
      now: nowMs,
      evidence: { transport: transport.reason, http_status: transport.status },
    });
  }
  const message = extractMessage(res);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const call = toolCalls.find((c) => c && c.function && c.function.name === TOOL_ASSESSMENT_SCHEMA.function.name);
  if (!call) {
    return measurementEntry({
      status: 'fail',
      assertion: TOOL_CALL_ASSERTION,
      now: nowMs,
      evidence: { reason: 'no_matching_tool_call', tool_calls: toolCalls },
    });
  }
  let args;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return measurementEntry({
      status: 'fail',
      assertion: TOOL_CALL_ASSERTION,
      now: nowMs,
      evidence: { reason: 'unparseable_arguments', raw: call.function.arguments },
    });
  }
  if (!args || typeof args.city !== 'string' || args.city.length === 0) {
    return measurementEntry({
      status: 'fail',
      assertion: TOOL_CALL_ASSERTION,
      now: nowMs,
      evidence: { reason: 'missing_required_field', parsed: args },
    });
  }
  return measurementEntry({
    status: 'pass',
    assertion: TOOL_CALL_ASSERTION,
    now: nowMs,
    evidence: { tool_name: call.function.name, arguments: args },
  });
}

/**
 * Structured output assertion: does the model honor a requested JSON shape.
 * Passes only when the content parses as JSON and carries every required key
 * from STRUCTURED_OUTPUT_SCHEMA with the right primitive type.
 */
export async function assessStructuredOutput(chatComplete, id, { timeoutMs, now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const res = await safeCall(chatComplete, id, buildStructuredOutputRequest(), { timeoutMs });
  const transport = classifyTransport(res);
  if (transport.outcome !== 'ok') {
    return measurementEntry({
      status: transport.outcome === 'fail' ? 'fail' : 'unmeasured',
      assertion: STRUCTURED_OUTPUT_ASSERTION,
      now: nowMs,
      evidence: { transport: transport.reason, http_status: transport.status },
    });
  }
  const content = String(extractMessage(res).content || '').trim();
  // Some models wrap JSON in a fenced code block despite instructions not to;
  // strip a leading/trailing ``` fence before parsing rather than failing a
  // model over formatting noise the assertion did not ask about.
  const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return measurementEntry({
      status: 'fail',
      assertion: STRUCTURED_OUTPUT_ASSERTION,
      now: nowMs,
      evidence: { reason: 'unparseable_json', raw: content },
    });
  }
  const missing = Object.keys(STRUCTURED_OUTPUT_SCHEMA.properties).filter((k) => !(k in (parsed || {})));
  if (missing.length > 0 || typeof parsed.name !== 'string' || typeof parsed.count !== 'number') {
    return measurementEntry({
      status: 'fail',
      assertion: STRUCTURED_OUTPUT_ASSERTION,
      now: nowMs,
      evidence: { reason: 'schema_mismatch', missing, parsed },
    });
  }
  return measurementEntry({ status: 'pass', assertion: STRUCTURED_OUTPUT_ASSERTION, now: nowMs, evidence: { parsed } });
}

/**
 * Instruction following assertion: a trivially checkable exact-output
 * assertion (design). Passes only on an exact match (case-insensitive,
 * surrounding whitespace/quotes/period stripped, since punishing a model for
 * an incidental trailing period is not what this assertion is measuring).
 */
export async function assessInstructionFollowing(chatComplete, id, { timeoutMs, now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const res = await safeCall(chatComplete, id, buildInstructionFollowingRequest(), { timeoutMs });
  const transport = classifyTransport(res);
  if (transport.outcome !== 'ok') {
    return measurementEntry({
      status: transport.outcome === 'fail' ? 'fail' : 'unmeasured',
      assertion: INSTRUCTION_FOLLOWING_ASSERTION,
      now: nowMs,
      evidence: { transport: transport.reason, http_status: transport.status },
    });
  }
  const raw = String(extractMessage(res).content || '');
  const normalized = raw.trim().replace(/^["'.]+|["'.]+$/g, '').toUpperCase();
  if (normalized !== INSTRUCTION_FOLLOWING_EXPECTED) {
    return measurementEntry({
      status: 'fail',
      assertion: INSTRUCTION_FOLLOWING_ASSERTION,
      now: nowMs,
      evidence: { expected: INSTRUCTION_FOLLOWING_EXPECTED, got: raw },
    });
  }
  return measurementEntry({ status: 'pass', assertion: INSTRUCTION_FOLLOWING_ASSERTION, now: nowMs, evidence: { got: raw } });
}

/**
 * min_output_tokens assertion (design: "THE ONE MOST LIKELY TO BE GOT
 * WRONG"). Walks MIN_OUTPUT_TOKEN_LADDER ascending, stopping at the first
 * rung whose response has non-empty `content` (not merely non-empty
 * `reasoning_content`: several free models in this fleet emit populated
 * reasoning_content with EMPTY content at low max_tokens, and Ornith itself
 * needs >=2048 for the same reason, so only `content` counts as "the model
 * actually produced an answer").
 *
 * Any rung whose transport classifies 'unmeasured' (429/timeout/5xx) aborts
 * the whole ladder immediately and reports the assertion overall as
 * 'unmeasured': a throttled model will almost certainly throttle the next
 * rung too, and burning further budget to confirm that would be exactly the
 * "measuring costs the same scarce resource as using" mistake the card warns
 * against. A rung that transport-fails with a determinate rejection (e.g. a
 * backend that 400s a too-small max_tokens) is recorded and the ladder
 * continues to the next rung, since that is a fact about THAT max_tokens
 * value, not about the model's throttling state.
 */
export async function assessMinOutputTokens(chatComplete, id, { timeoutMs, now = Date.now, ladder = MIN_OUTPUT_TOKEN_LADDER } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const checked = [];
  for (const maxTokens of ladder) {
    const res = await safeCall(chatComplete, id, buildMinOutputTokensRequest(maxTokens), { timeoutMs });
    const transport = classifyTransport(res);
    if (transport.outcome === 'unmeasured') {
      checked.push({ max_tokens: maxTokens, outcome: 'unmeasured' });
      return {
        capability: 'measured',
        status: 'unmeasured',
        value: null,
        assertion: MIN_OUTPUT_TOKENS_ASSERTION,
        measured_at: nowMs,
        checked_levels: checked,
      };
    }
    if (transport.outcome === 'fail') {
      checked.push({ max_tokens: maxTokens, outcome: 'transport_fail' });
      continue;
    }
    const content = String(extractMessage(res).content || '').trim();
    if (content.length > 0) {
      checked.push({ max_tokens: maxTokens, outcome: 'content' });
      return {
        capability: 'measured',
        status: 'measured',
        value: maxTokens,
        assertion: MIN_OUTPUT_TOKENS_ASSERTION,
        measured_at: nowMs,
        checked_levels: checked,
      };
    }
    checked.push({ max_tokens: maxTokens, outcome: 'empty' });
  }
  // Every rung answered (2xx) but none produced content: a real, determinate
  // fact ("empty at every tested level up to the ladder's ceiling"), not an
  // absence of evidence, so this is 'measured' with value: null, never
  // 'unmeasured'.
  return {
    capability: 'measured',
    status: 'measured',
    value: null,
    assertion: MIN_OUTPUT_TOKENS_ASSERTION,
    measured_at: nowMs,
    checked_levels: checked,
  };
}

/** Build the liveness MeasurementEntry from the tier-1 probe sweep's own outcome (probe.mjs's `runProbe` result), at zero extra network cost: this assertion piggybacks on the cheap ping every sweep already makes rather than issuing its own call. */
export function livenessFromProbeOutcome(outcome, now = Date.now) {
  const nowMs = typeof now === 'function' ? now() : now;
  const status = outcome && outcome.status;
  if (outcome && outcome.ok) {
    return measurementEntry({ status: 'pass', assertion: LIVENESS_ASSERTION, now: nowMs });
  }
  if (status === 429 || status === undefined || status === null || status >= 500) {
    return measurementEntry({
      status: 'unmeasured',
      assertion: LIVENESS_ASSERTION,
      now: nowMs,
      evidence: { http_status: status },
    });
  }
  return measurementEntry({ status: 'fail', assertion: LIVENESS_ASSERTION, now: nowMs, evidence: { http_status: status } });
}

/**
 * Run the full tier-2 battery (everything except liveness, which is folded
 * in separately from the tier-1 probe outcome; see livenessFromProbeOutcome).
 * Sequential, not parallel, on purpose: this keeps the number of concurrent
 * capability-related calls against one model equal to the number of models
 * being assessed this sweep (bounded by DEFAULT_CAPABILITY_BUDGET), not that
 * number times four. It also lets a 429 abort the rest of the battery for
 * this model: once one assertion comes back rate_limited, every remaining
 * dimension is recorded 'unmeasured' without attempting the call at all, so
 * a throttled free model is not hammered with three or four more requests it
 * was always going to 429 on too (the exact failure mode that pushed two of
 * seven free models into FreeUsageLimitError while just measuring tool
 * calling on 2026-08-14).
 *
 * @param {string} id
 * @param {object} opts
 * @param {(id:string, request:object, callOpts:{timeoutMs?:number}) => Promise<{ok:boolean, status?:number, message?:{content?:string, tool_calls?:Array, reasoning_content?:string}}>} opts.chatComplete
 * @param {number} [opts.timeoutMs]
 * @param {number|(() => number)} [opts.now]
 * @returns {Promise<{tool_call:object, structured_output:object, instruction_following:object, min_output_tokens:object}>}
 */
export async function runCapabilityAssessment(id, { chatComplete, timeoutMs = DEFAULT_CAPABILITY_TIMEOUT_MS, now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : now;
  const result = {};
  const steps = [
    ['tool_call', TOOL_CALL_ASSERTION, () => assessToolCalling(chatComplete, id, { timeoutMs, now: nowMs })],
    ['structured_output', STRUCTURED_OUTPUT_ASSERTION, () => assessStructuredOutput(chatComplete, id, { timeoutMs, now: nowMs })],
    ['instruction_following', INSTRUCTION_FOLLOWING_ASSERTION, () => assessInstructionFollowing(chatComplete, id, { timeoutMs, now: nowMs })],
  ];
  let rateLimited = false;
  for (const [key, assertion, run] of steps) {
    if (rateLimited) {
      result[key] = measurementEntry({ status: 'unmeasured', assertion, now: nowMs, evidence: { reason: 'skipped_after_rate_limit' } });
      continue;
    }
    const entry = await run();
    result[key] = entry;
    if (entry.status === 'unmeasured' && entry.evidence && entry.evidence.transport === 'rate_limited') {
      rateLimited = true;
    }
  }
  if (rateLimited) {
    result.min_output_tokens = {
      capability: 'measured',
      status: 'unmeasured',
      value: null,
      assertion: MIN_OUTPUT_TOKENS_ASSERTION,
      measured_at: nowMs,
      checked_levels: [],
    };
  } else {
    result.min_output_tokens = await assessMinOutputTokens(chatComplete, id, { timeoutMs, now: nowMs });
  }
  return result;
}

/** A fresh, all-unmeasured capability record for a model with no prior assessment history. */
export function defaultCapabilityRecord() {
  return {
    liveness: null,
    tool_call: null,
    structured_output: null,
    instruction_following: null,
    min_output_tokens: null,
    last_full_assessment_at: null,
  };
}

/**
 * Fold one field's new measurement onto its previous value. A determinate
 * previous value (`pass`/`fail`, or a numeric `measured`) is never
 * overwritten by a fresh `unmeasured` attempt: the attempt is still visible
 * (via `last_unmeasured_attempt_at`) but the fact itself is preserved,
 * per card 2ba73bf9: "a measured fact must never be overwritten by a
 * declared one" extended here to its natural corollary, a measured fact must
 * never be silently erased by a WEAKER measured attempt either. Anything
 * else (no prior entry, or a fresh determinate result) replaces outright:
 * the freshest determinate measurement is always the current truth, the same
 * "freshest strong evidence wins" policy lifecycle.mjs's applyProbeOutcome
 * already uses.
 */
function foldField(prev, next) {
  if (!next) return prev ?? null;
  const isUnmeasured = next.status === 'unmeasured';
  const prevIsDeterminate = prev && (prev.status === 'pass' || prev.status === 'fail' || prev.status === 'measured');
  if (isUnmeasured && prevIsDeterminate) {
    return { ...prev, last_unmeasured_attempt_at: next.measured_at };
  }
  return next;
}

/**
 * Merge a fresh measurement (from livenessFromProbeOutcome and/or
 * runCapabilityAssessment) onto a model's previous CapabilityRecord.
 * `partial` may carry any subset of `{liveness, tool_call, structured_output,
 * instruction_following, min_output_tokens}`; fields not present are left
 * untouched. Pass `full: true` when `partial` came from a complete tier-2
 * battery (runCapabilityAssessment), which advances `last_full_assessment_at`
 * so selectCapabilityCandidates can tell a re-assessed model from one that
 * has only ever had its liveness folded in.
 *
 * @param {object|null|undefined} prevRecord
 * @param {object} partial
 * @param {{now: number, full?: boolean}} opts
 * @returns {object} a new CapabilityRecord
 */
export function applyCapabilityMeasurement(prevRecord, partial = {}, { now, full = false } = {}) {
  const prev = prevRecord || defaultCapabilityRecord();
  const next = {
    liveness: foldField(prev.liveness, partial.liveness),
    tool_call: foldField(prev.tool_call, partial.tool_call),
    structured_output: foldField(prev.structured_output, partial.structured_output),
    instruction_following: foldField(prev.instruction_following, partial.instruction_following),
    min_output_tokens: foldField(prev.min_output_tokens, partial.min_output_tokens),
    last_full_assessment_at: prev.last_full_assessment_at ?? null,
  };
  if (full) next.last_full_assessment_at = now;
  return next;
}

/**
 * Select up to `budget` ids from `candidateIds` (already tier-1-eligible,
 * i.e. the same list selectProbeCandidates chose this sweep) that are due
 * for a full tier-2 capability battery: a model with NO prior capability
 * record at all (first sighting, design: "always on first sighting of a new
 * id") is always eligible; a model that already has one is only eligible
 * again once `intervalMs` has passed since its `last_full_assessment_at`
 * (design: "full capability assertion rarely"). Ordered never-assessed first
 * then oldest-assessed first, same tie-breaking discipline as
 * selectProbeCandidates, so a budget-limited sweep works through the true
 * backlog of unassessed models before re-checking anyone.
 *
 * @param {Record<string, object>} store lifecycle records, some carrying `measured_capabilities`
 * @param {string[]} candidateIds this sweep's tier-1 candidates (probe.mjs's selectProbeCandidates output)
 * @param {{budget?: number, now: number, intervalMs?: number}} opts
 * @returns {string[]}
 */
export function selectCapabilityCandidates(store, candidateIds, { budget = DEFAULT_CAPABILITY_BUDGET, now, intervalMs = DEFAULT_CAPABILITY_INTERVAL_MS } = {}) {
  if (!(budget > 0)) return [];
  const safeStore = store || {};
  const lastFullOf = (id) => {
    const rec = safeStore[id] && safeStore[id].measured_capabilities;
    return rec ? rec.last_full_assessment_at : null;
  };
  // A record whose last battery left any dimension undetermined (a 429, a
  // timeout, a 5xx: an explicit status 'unmeasured') is not fully assessed,
  // whatever last_full_assessment_at says, and stays eligible rather than
  // hiding for intervalMs behind one unlucky call. Only an explicit
  // 'unmeasured' counts: a field that is absent was never attempted by a
  // battery at all (a battery writes all four), so absence says nothing.
  // Observed 2026-09-04: deepseek-ai/deepseek-v4-flash-0731 got a 529 on the
  // tool_call step, the rest of its battery passed, and the record would
  // have sat with tool support unknown for 30 days.
  const incomplete = (id) => {
    const rec = safeStore[id] && safeStore[id].measured_capabilities;
    if (!rec) return false;
    return ['tool_call', 'structured_output', 'instruction_following', 'min_output_tokens']
      .some((k) => rec[k] && rec[k].status === 'unmeasured');
  };
  const eligible = (candidateIds || []).filter((id) => {
    const lastFull = lastFullOf(id);
    return lastFull == null || now - lastFull >= intervalMs || incomplete(id);
  });
  eligible.sort((a, b) => {
    const av = lastFullOf(a);
    const bv = lastFullOf(b);
    if (av == null && bv == null) return a < b ? -1 : a > b ? 1 : 0;
    if (av == null) return -1;
    if (bv == null) return 1;
    if (av !== bv) return av - bv;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return eligible.slice(0, budget);
}
