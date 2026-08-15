/**
 * capability-assessment.test.mjs: card 2ba73bf9 / C9, the MEASUREMENT half
 * ("MEMBERSHIP IS MEASURED, NOT DECLARED"). No network: every `chatComplete`
 * is an injected fake.
 *
 * Run with:  node --test tests/capability-assessment.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessToolCalling,
  assessStructuredOutput,
  assessInstructionFollowing,
  assessMinOutputTokens,
  runCapabilityAssessment,
  livenessFromProbeOutcome,
  applyCapabilityMeasurement,
  defaultCapabilityRecord,
  selectCapabilityCandidates,
  classifyTransport,
  MIN_OUTPUT_TOKEN_LADDER,
  DEFAULT_CAPABILITY_BUDGET,
  TOOL_ASSESSMENT_SCHEMA,
} from '../src/discovery/capability-assessment.mjs';

const NOW = 1_000_000;

describe('classifyTransport', () => {
  test('2xx classifies ok', () => {
    assert.deepEqual(classifyTransport({ ok: true, status: 200 }), { outcome: 'ok' });
  });
  test('429 classifies unmeasured, never fail', () => {
    const r = classifyTransport({ ok: false, status: 429 });
    assert.equal(r.outcome, 'unmeasured');
    assert.equal(r.reason, 'rate_limited');
  });
  test('no status (timeout/network) classifies unmeasured', () => {
    const r = classifyTransport({ ok: false, status: undefined });
    assert.equal(r.outcome, 'unmeasured');
  });
  test('5xx classifies unmeasured', () => {
    const r = classifyTransport({ ok: false, status: 503 });
    assert.equal(r.outcome, 'unmeasured');
  });
  test('a determinate rejection (400) classifies fail', () => {
    const r = classifyTransport({ ok: false, status: 400 });
    assert.equal(r.outcome, 'fail');
  });
});

describe('assessToolCalling', () => {
  test('a well-formed tool_call with parseable required args passes', async () => {
    const chatComplete = async () => ({
      ok: true,
      status: 200,
      message: { tool_calls: [{ function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Paris' }) } }] },
    });
    const r = await assessToolCalling(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'pass');
    assert.equal(r.capability, 'measured');
    assert.equal(r.assertion, 'capability.tool_call.v1');
    assert.equal(r.measured_at, NOW);
  });

  test('no tool_calls at all fails (metadata overclaim, card 2ba73bf9 concrete evidence)', async () => {
    const chatComplete = async () => ({ ok: true, status: 200, message: { content: 'sure, Paris is nice' } });
    const r = await assessToolCalling(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.reason, 'no_matching_tool_call');
  });

  test('unparseable arguments fails', async () => {
    const chatComplete = async () => ({
      ok: true,
      status: 200,
      message: { tool_calls: [{ function: { name: 'get_weather', arguments: '{not json' } }] },
    });
    const r = await assessToolCalling(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.reason, 'unparseable_arguments');
  });

  test('arguments missing the required field fails', async () => {
    const chatComplete = async () => ({
      ok: true,
      status: 200,
      message: { tool_calls: [{ function: { name: 'get_weather', arguments: JSON.stringify({ unit: 'celsius' }) } }] },
    });
    const r = await assessToolCalling(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.reason, 'missing_required_field');
  });

  test('a 429 is unmeasured, never fail (this is the concrete card scenario: 5 of 7 verified, 2 unmeasured)', async () => {
    const chatComplete = async () => ({ ok: false, status: 429 });
    const r = await assessToolCalling(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'unmeasured');
  });

  test('a timeout (thrown) is unmeasured, never fail', async () => {
    const chatComplete = async () => {
      throw new Error('timeout');
    };
    const r = await assessToolCalling(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'unmeasured');
  });

  test('a 5xx is unmeasured, never fail', async () => {
    const chatComplete = async () => ({ ok: false, status: 500 });
    const r = await assessToolCalling(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'unmeasured');
  });

  test('request carries the real tool schema (design: "given a real tool schema")', () => {
    assert.equal(TOOL_ASSESSMENT_SCHEMA.function.name, 'get_weather');
    assert.deepEqual(TOOL_ASSESSMENT_SCHEMA.function.parameters.required, ['city']);
  });
});

describe('assessStructuredOutput', () => {
  test('valid JSON matching the schema passes', async () => {
    const chatComplete = async () => ({ ok: true, status: 200, message: { content: '{"name":"widget","count":3}' } });
    const r = await assessStructuredOutput(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'pass');
  });

  test('JSON wrapped in a code fence is still parsed (formatting noise, not incapability)', async () => {
    const chatComplete = async () => ({ ok: true, status: 200, message: { content: '```json\n{"name":"widget","count":3}\n```' } });
    const r = await assessStructuredOutput(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'pass');
  });

  test('unparseable content fails', async () => {
    const chatComplete = async () => ({ ok: true, status: 200, message: { content: 'not json at all' } });
    const r = await assessStructuredOutput(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.reason, 'unparseable_json');
  });

  test('missing a required key fails', async () => {
    const chatComplete = async () => ({ ok: true, status: 200, message: { content: '{"name":"widget"}' } });
    const r = await assessStructuredOutput(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.reason, 'schema_mismatch');
  });

  test('wrong type for a key fails', async () => {
    const chatComplete = async () => ({ ok: true, status: 200, message: { content: '{"name":"widget","count":"3"}' } });
    const r = await assessStructuredOutput(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'fail');
  });

  test('429 is unmeasured', async () => {
    const chatComplete = async () => ({ ok: false, status: 429 });
    const r = await assessStructuredOutput(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'unmeasured');
  });
});

describe('assessInstructionFollowing', () => {
  test('an exact match passes', async () => {
    const chatComplete = async () => ({ ok: true, status: 200, message: { content: 'PONG' } });
    const r = await assessInstructionFollowing(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'pass');
  });

  test('case-insensitive, whitespace/punctuation-tolerant match still passes', async () => {
    const chatComplete = async () => ({ ok: true, status: 200, message: { content: '  pong.\n' } });
    const r = await assessInstructionFollowing(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'pass');
  });

  test('extra content fails (a trivially checkable exact-output assertion)', async () => {
    const chatComplete = async () => ({ ok: true, status: 200, message: { content: 'Sure! PONG is my reply.' } });
    const r = await assessInstructionFollowing(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'fail');
  });

  test('empty content fails', async () => {
    const chatComplete = async () => ({ ok: true, status: 200, message: { content: '' } });
    const r = await assessInstructionFollowing(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'fail');
  });

  test('a 400 (well-formed request rejected) is a determinate fail, not unmeasured', async () => {
    const chatComplete = async () => ({ ok: false, status: 400 });
    const r = await assessInstructionFollowing(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'fail');
  });
});

describe('assessMinOutputTokens (design: "THE ONE MOST LIKELY TO BE GOT WRONG")', () => {
  test('a reasoning model with empty content at low max_tokens is not scored broken: the ladder climbs to where content appears', async () => {
    const chatComplete = async (id, req) => {
      if (req.max_tokens < 2048) {
        return { ok: true, status: 200, message: { reasoning_content: 'thinking...', content: '' } };
      }
      return { ok: true, status: 200, message: { reasoning_content: 'thinking...', content: '19' } };
    };
    const r = await assessMinOutputTokens(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'measured');
    assert.equal(r.value, 2048);
    assert.equal(r.checked_levels.length, MIN_OUTPUT_TOKEN_LADDER.length);
    assert.equal(r.checked_levels.at(-1).outcome, 'content');
  });

  test('a model that answers at the first (smallest) rung records that minimum', async () => {
    const chatComplete = async () => ({ ok: true, status: 200, message: { content: '19' } });
    const r = await assessMinOutputTokens(chatComplete, 'm', { now: NOW });
    assert.equal(r.value, MIN_OUTPUT_TOKEN_LADDER[0]);
    assert.equal(r.checked_levels.length, 1);
  });

  test('empty content at every rung is a determinate measured fact (value null), never unmeasured', async () => {
    const chatComplete = async () => ({ ok: true, status: 200, message: { content: '' } });
    const r = await assessMinOutputTokens(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'measured');
    assert.equal(r.value, null);
    assert.equal(r.checked_levels.length, MIN_OUTPUT_TOKEN_LADDER.length);
  });

  test('a 429 anywhere in the ladder aborts the rest and reports unmeasured overall, not incapable', async () => {
    let calls = 0;
    const chatComplete = async () => {
      calls++;
      return { ok: false, status: 429 };
    };
    const r = await assessMinOutputTokens(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'unmeasured');
    assert.equal(r.value, null);
    assert.equal(calls, 1, 'must not keep hammering a throttled model up the ladder');
  });

  test('a determinate rejection at one rung does not abort the ladder (only rate limiting does)', async () => {
    const chatComplete = async (id, req) => {
      if (req.max_tokens === MIN_OUTPUT_TOKEN_LADDER[0]) return { ok: false, status: 400 };
      return { ok: true, status: 200, message: { content: 'ok' } };
    };
    const r = await assessMinOutputTokens(chatComplete, 'm', { now: NOW });
    assert.equal(r.status, 'measured');
    assert.equal(r.value, MIN_OUTPUT_TOKEN_LADDER[1]);
    assert.equal(r.checked_levels[0].outcome, 'transport_fail');
  });
});

describe('livenessFromProbeOutcome', () => {
  test('ok true passes', () => {
    const r = livenessFromProbeOutcome({ ok: true, status: 200 }, NOW);
    assert.equal(r.status, 'pass');
  });
  test('429 is unmeasured', () => {
    const r = livenessFromProbeOutcome({ ok: false, status: 429 }, NOW);
    assert.equal(r.status, 'unmeasured');
  });
  test('no status (timeout) is unmeasured', () => {
    const r = livenessFromProbeOutcome({ ok: false }, NOW);
    assert.equal(r.status, 'unmeasured');
  });
  test('a determinate 410 is fail', () => {
    const r = livenessFromProbeOutcome({ ok: false, status: 410 }, NOW);
    assert.equal(r.status, 'fail');
  });
});

describe('runCapabilityAssessment (tier-2 battery orchestration)', () => {
  test('all four dimensions run when nothing rate-limits', async () => {
    const chatComplete = async (id, req) => {
      if (req.tools) return { ok: true, status: 200, message: { tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] } };
      if (req.max_tokens === 64) return { ok: true, status: 200, message: { content: 'PONG' } };
      if (req.messages[0].content.includes('JSON object')) return { ok: true, status: 200, message: { content: '{"name":"widget","count":3}' } };
      return { ok: true, status: 200, message: { content: '19' } };
    };
    const r = await runCapabilityAssessment('m', { chatComplete, now: NOW });
    assert.equal(r.tool_call.status, 'pass');
    assert.equal(r.structured_output.status, 'pass');
    assert.equal(r.instruction_following.status, 'pass');
    assert.equal(r.min_output_tokens.status, 'measured');
  });

  test('a 429 on the first dimension short-circuits the rest of the battery without calling them', async () => {
    let calls = 0;
    const chatComplete = async () => {
      calls++;
      return { ok: false, status: 429 };
    };
    const r = await runCapabilityAssessment('m', { chatComplete, now: NOW });
    assert.equal(r.tool_call.status, 'unmeasured');
    assert.equal(r.structured_output.status, 'unmeasured');
    assert.equal(r.instruction_following.status, 'unmeasured');
    assert.equal(r.min_output_tokens.status, 'unmeasured');
    assert.equal(calls, 1, 'must stop after the first 429, not burn budget confirming the throttle on every dimension');
  });

  test('a 429 mid-battery still lets earlier determinate dimensions stand', async () => {
    const chatComplete = async (id, req) => {
      if (req.tools) return { ok: true, status: 200, message: { tool_calls: [{ function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] } };
      return { ok: false, status: 429 };
    };
    const r = await runCapabilityAssessment('m', { chatComplete, now: NOW });
    assert.equal(r.tool_call.status, 'pass');
    assert.equal(r.structured_output.status, 'unmeasured');
    assert.equal(r.min_output_tokens.status, 'unmeasured');
  });
});

describe('applyCapabilityMeasurement: measured facts survive weaker retries', () => {
  test('a determinate pass is never overwritten by a later unmeasured (429) attempt', () => {
    const prev = applyCapabilityMeasurement(defaultCapabilityRecord(), {
      tool_call: { capability: 'measured', status: 'pass', assertion: 'x', measured_at: NOW, evidence: null },
    }, { now: NOW });
    const next = applyCapabilityMeasurement(prev, {
      tool_call: { capability: 'measured', status: 'unmeasured', assertion: 'x', measured_at: NOW + 1000, evidence: null },
    }, { now: NOW + 1000 });
    assert.equal(next.tool_call.status, 'pass', 'the pass must survive');
    assert.equal(next.tool_call.last_unmeasured_attempt_at, NOW + 1000, 'but the retry attempt is still visible');
  });

  test('a determinate fail is never silently erased by an unmeasured retry either (capability != declared)', () => {
    const prev = applyCapabilityMeasurement(defaultCapabilityRecord(), {
      tool_call: { capability: 'measured', status: 'fail', assertion: 'x', measured_at: NOW, evidence: { reason: 'no_matching_tool_call' } },
    }, { now: NOW });
    const next = applyCapabilityMeasurement(prev, {
      tool_call: { capability: 'measured', status: 'unmeasured', assertion: 'x', measured_at: NOW + 1000, evidence: null },
    }, { now: NOW + 1000 });
    assert.equal(next.tool_call.status, 'fail');
  });

  test('a fresh determinate result DOES overwrite a prior one (freshest determinate measurement wins)', () => {
    const prev = applyCapabilityMeasurement(defaultCapabilityRecord(), {
      tool_call: { capability: 'measured', status: 'fail', assertion: 'x', measured_at: NOW, evidence: null },
    }, { now: NOW });
    const next = applyCapabilityMeasurement(prev, {
      tool_call: { capability: 'measured', status: 'pass', assertion: 'x', measured_at: NOW + 1000, evidence: null },
    }, { now: NOW + 1000 });
    assert.equal(next.tool_call.status, 'pass');
  });

  test('every entry carries capability: measured (the claimed/measured distinguishing marker the routing half consumes)', () => {
    const next = applyCapabilityMeasurement(defaultCapabilityRecord(), {
      liveness: { capability: 'measured', status: 'pass', assertion: 'x', measured_at: NOW, evidence: null },
    }, { now: NOW });
    assert.equal(next.liveness.capability, 'measured');
  });

  test('full: true advances last_full_assessment_at; a liveness-only fold does not', () => {
    const withFull = applyCapabilityMeasurement(defaultCapabilityRecord(), {}, { now: NOW, full: true });
    assert.equal(withFull.last_full_assessment_at, NOW);
    const livenessOnly = applyCapabilityMeasurement(defaultCapabilityRecord(), {
      liveness: { capability: 'measured', status: 'pass', assertion: 'x', measured_at: NOW, evidence: null },
    }, { now: NOW });
    assert.equal(livenessOnly.last_full_assessment_at, null);
  });

  test('fields not present in partial are left untouched', () => {
    const prev = applyCapabilityMeasurement(defaultCapabilityRecord(), {
      tool_call: { capability: 'measured', status: 'pass', assertion: 'x', measured_at: NOW, evidence: null },
    }, { now: NOW });
    const next = applyCapabilityMeasurement(prev, {
      instruction_following: { capability: 'measured', status: 'pass', assertion: 'y', measured_at: NOW + 1, evidence: null },
    }, { now: NOW + 1 });
    assert.equal(next.tool_call.status, 'pass');
    assert.equal(next.instruction_following.status, 'pass');
  });
});

describe('selectCapabilityCandidates', () => {
  test('first sighting (no measured_capabilities at all) is always eligible', () => {
    const store = { fresh: {} };
    const ids = selectCapabilityCandidates(store, ['fresh'], { now: NOW });
    assert.deepEqual(ids, ['fresh']);
  });

  test('an already-assessed model is not re-selected before intervalMs elapses', () => {
    const store = { done: { measured_capabilities: { last_full_assessment_at: NOW - 1000 } } };
    const ids = selectCapabilityCandidates(store, ['done'], { now: NOW, intervalMs: 100_000 });
    assert.deepEqual(ids, []);
  });

  test('an already-assessed model is eligible again once intervalMs has elapsed (design: "full capability assertion rarely")', () => {
    const store = { due: { measured_capabilities: { last_full_assessment_at: NOW - 200_000 } } };
    const ids = selectCapabilityCandidates(store, ['due'], { now: NOW, intervalMs: 100_000 });
    assert.deepEqual(ids, ['due']);
  });

  test('never-assessed ids sort before due-for-reassessment ids', () => {
    const store = {
      due: { measured_capabilities: { last_full_assessment_at: NOW - 200_000 } },
      never: {},
    };
    const ids = selectCapabilityCandidates(store, ['due', 'never'], { now: NOW, intervalMs: 100_000 });
    assert.deepEqual(ids, ['never', 'due']);
  });

  test('is capped by budget', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `m${i}`);
    const store = Object.fromEntries(ids.map((id) => [id, {}]));
    const selected = selectCapabilityCandidates(store, ids, { now: NOW, budget: 2 });
    assert.equal(selected.length, 2);
  });

  test('budget <= 0 selects nothing', () => {
    const store = { a: {} };
    assert.deepEqual(selectCapabilityCandidates(store, ['a'], { now: NOW, budget: 0 }), []);
  });

  test('never selects an id outside the given candidate list (tier 2 is a subset of tier 1, never a superset)', () => {
    const store = { a: {}, b: {} };
    const ids = selectCapabilityCandidates(store, ['a'], { now: NOW });
    assert.deepEqual(ids, ['a']);
  });

  test('default budget is small (a full battery is far costlier than a liveness ping)', () => {
    assert.equal(DEFAULT_CAPABILITY_BUDGET, 3);
  });
});
