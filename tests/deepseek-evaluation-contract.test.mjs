import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CASE_TYPES,
  evaluateDeepSeekQualification,
  loadQualificationCases,
  qualificationResultHash,
  serializeQualificationResult,
} from '../qualification/deepseek/evaluate.mjs';

const attribution = {
  logical_route: 'sk-deepseek-l',
  provider_family: 'deepseek',
  served_model: 'deepseek-v4-pro',
  policy_revision: 'a'.repeat(64),
};

function passingFixtures(cases) {
  return Object.fromEntries(cases.map((item) => {
    const expected = item.expected;
    const message = expected.tool_names
      ? { tool_calls: expected.tool_names.map((name, index) => ({ id: `call-${index}`, function: { name } })) }
      : { content: expected.json ? JSON.stringify(expected.json) : expected.text };
    return [item.id, {
      status: 200,
      latency_ms: 25,
      attribution: { ...attribution },
      body: { model: attribution.served_model, choices: [{ message }], usage: {
        prompt_tokens: 20, completion_tokens: 5, total_tokens: 25,
      } },
    }];
  }));
}

describe('G5 DeepSeek public synthetic qualification contract', () => {
  test('the immutable case set covers every required case type', () => {
    const cases = loadQualificationCases();
    assert.equal(Object.isFrozen(cases), true);
    assert.deepEqual(new Set(cases.map((item) => item.type)), new Set(CASE_TYPES));
  });

  test('deterministic fixtures produce one bounded credential-free result', async () => {
    const cases = loadQualificationCases();
    const result = await evaluateDeepSeekQualification({
      gatewayUrl: 'http://127.0.0.1:18780/v1',
      route: 'sk-deepseek-l',
      fixtureResponses: passingFixtures(cases),
      now: () => 1_800_000_000_000,
    });
    assert.equal(result.status, 'pass');
    assert.equal(result.qualified_class, 'L');
    assert.equal(result.cases.length, CASE_TYPES.length);
    for (const key of ['case_set_hash', 'response_schema_hash']) {
      assert.match(result[key], /^[a-f0-9]{64}$/);
    }
    assert.equal(result.logical_route, 'sk-deepseek-l');
    assert.equal(result.provider_family, 'deepseek');
    assert.equal(result.served_model, 'deepseek-v4-pro');
    assert.equal(result.policy_revision, 'a'.repeat(64));
    const encoded = JSON.stringify(result);
    for (const forbidden of ['Call the add tool', 'do-not-retain', 'authorization', 'api_key', 'reasoning_content']) {
      assert.equal(encoded.includes(forbidden), false);
    }
  });

  test('only exact case ids are accepted in deterministic fixture mode', async () => {
    const cases = loadQualificationCases();
    const fixtures = passingFixtures(cases);
    fixtures.extra = fixtures[cases[0].id];
    await assert.rejects(() => evaluateDeepSeekQualification({
      gatewayUrl: 'http://127.0.0.1:18780/v1', route: 'sk-deepseek-l', fixtureResponses: fixtures,
    }), /exactly match/);
  });

  test('route, attribution, protected inputs, secrets, and arbitrary fixture paths fail closed', async () => {
    const cases = loadQualificationCases();
    const fixtures = passingFixtures(cases);
    await assert.rejects(() => evaluateDeepSeekQualification({
      gatewayUrl: 'http://127.0.0.1:18780/v1', route: 'sk-l', fixtureResponses: fixtures,
    }), /focused DeepSeek route/);
    fixtures[cases[0].id].attribution.provider_family = 'codex';
    await assert.rejects(() => evaluateDeepSeekQualification({
      gatewayUrl: 'http://127.0.0.1:18780/v1', route: 'sk-deepseek-l', fixtureResponses: fixtures,
    }), /attribution mismatch/);
    for (const options of [
      { gatewayUrl: 'http://user:secret@127.0.0.1:18780/v1' },
      { gatewayUrl: 'file:///home/operator/matter.json' },
      { gatewayUrl: 'http://127.0.0.1:18780/v1', fixturePath: '/home/operator/fixture.json' },
      { gatewayUrl: 'http://127.0.0.1:18780/v1', providerApiKey: 'secret' },
    ]) {
      await assert.rejects(() => evaluateDeepSeekQualification({
        route: 'sk-deepseek-l', fixtureResponses: passingFixtures(cases), ...options,
      }), /reject|allowed|credential|http/i);
    }
  });

  test('malformed fixture response fails closed without retaining its body', async () => {
    const cases = loadQualificationCases();
    const fixtures = passingFixtures(cases);
    fixtures[cases[0].id] = { status: 200, body: { secret: 'do-not-retain' } };
    await assert.rejects(() => evaluateDeepSeekQualification({
      gatewayUrl: 'http://127.0.0.1:18780/v1', route: 'sk-deepseek-l', fixtureResponses: fixtures,
    }), /malformed/);
  });

  test('multi-megabyte and syntactically invalid attribution values fail closed', async () => {
    const cases = loadQualificationCases();
    for (const servedModel of [
      'x'.repeat(2_000_000),
      'deepseek-v4-pro\ncredential=value',
      '../deepseek-v4-pro',
    ]) {
      const fixtures = passingFixtures(cases);
      for (const response of Object.values(fixtures)) {
        response.attribution = { ...response.attribution, served_model: servedModel };
        response.body = { ...response.body, model: servedModel };
      }
      await assert.rejects(() => evaluateDeepSeekQualification({
        gatewayUrl: 'http://127.0.0.1:18780/v1',
        route: 'sk-deepseek-l',
        fixtureResponses: fixtures,
      }), /attribution mismatch/);
    }
  });

  test('reviewed result digests reproduce exactly from bounded deterministic fixtures', async () => {
    const cases = loadQualificationCases();
    const expected = {
      'deepseek-ai/deepseek-v4-flash': '4da76f516db4ef54613f54907dc7238fce22487123a2c388ffcb89937c0cf091',
      'deepseek-ai/deepseek-v4-pro': '387fc51742819e5185a87a3b2514925ba82d70070b2fe8a9ba816c26c7e2e199',
    };
    for (const [servedModel, digest] of Object.entries(expected)) {
      const fixtures = passingFixtures(cases);
      for (const response of Object.values(fixtures)) {
        response.attribution = {
          ...response.attribution,
          served_model: servedModel,
          policy_revision: '6c0f392f1757d850da42da17fe17587e0b291d2e54df3b49b20cfc5caa504170',
        };
        response.body = { ...response.body, model: servedModel };
      }
      const result = await evaluateDeepSeekQualification({
        gatewayUrl: 'http://127.0.0.1:18780/v1',
        route: 'sk-deepseek-l',
        fixtureResponses: fixtures,
        now: () => Date.UTC(2026, 8, 25),
      });
      assert.ok(serializeQualificationResult(result).length < 16_384);
      assert.equal(qualificationResultHash(result), digest);
    }
  });
});
