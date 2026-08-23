import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isCodexNamed,
  isOpenAiGptModel,
  isPureCodexCandidate,
  codexPurityProblems,
  assertCodexRegistryPurity,
} from '../src/policy/codex-purity.mjs';
import { routeAndSend } from '../src/proxy/router.mjs';

const official = (overrides = {}) => ({
  backendId: 'codex',
  backendUrl: 'https://chatgpt.com/backend-api/codex',
  model: 'gpt-5.3-codex',
  backend: { kind: 'codex', auth_type: 'codex_oauth', model: 'gpt-5.3-codex' },
  ...overrides,
});

test('normalizes Codex-labelled aliases and direct targets', () => {
  for (const value of ['codex', 'sk-codex-mid', 'GPT-5.3-CODEX', 'role_codex_fast']) {
    assert.equal(isCodexNamed(value), true, value);
  }
  assert.equal(isCodexNamed('qwen3.5-coder'), false);
});

test('accepts only GPT model syntax for official Codex candidates', () => {
  for (const model of ['gpt-5.3-codex', 'gpt-4.1', 'openai/gpt-5']) assert.equal(isOpenAiGptModel(model), true);
  for (const model of ['qwen3.5', 'claude-sonnet', 'glm-5', 'openrouter/auto']) assert.equal(isOpenAiGptModel(model), false);
  assert.equal(isPureCodexCandidate(official()), true);
});

test('rejects Qwen, Anthropic, z.ai, OpenRouter and unknown candidates', () => {
  const bad = [
    official({ backendId: 'qwen-local', backendUrl: 'http://127.0.0.1:8000', model: 'qwen3.5', backend: { kind: 'ollama', model: 'qwen3.5' } }),
    official({ backendId: 'anthropic', backendUrl: 'https://api.anthropic.com', model: 'claude-sonnet', backend: { kind: 'anthropic' } }),
    official({ backendId: 'zai', backendUrl: 'https://api.z.ai', model: 'glm-5', backend: { kind: 'zai' } }),
    official({ backendId: 'openrouter', backendUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5', backend: { provider: 'openrouter' } }),
    official({ backendId: 'mystery', backendUrl: 'https://example.invalid', model: 'gpt-5', backend: {} }),
  ];
  for (const candidate of bad) assert.equal(isPureCodexCandidate(candidate), false, candidate.backendId);
  assert.equal(codexPurityProblems(['sk-codex-mid'], [official(), bad[0]]).length, 1);
});

test('fails closed on absent candidates but leaves Qwen routes separate', () => {
  assert.deepEqual(codexPurityProblems(['sk-codex-mid'], []), ['Codex route has no eligible OpenAI or Codex candidate']);
  assert.deepEqual(codexPurityProblems(['sk-default'], [official({ model: 'qwen3.5' })]), []);
});

test('startup and reload registry assertion rejects impure roles, contexts and fallback', () => {
  const pure = {
    backends: { codex: { kind: 'codex', url: 'https://chatgpt.com/backend-api/codex', model: 'gpt-5.3-codex' } },
    roles: { 'sk-codex-mid': 'codex' }, contexts: { 'agent:jarvis': 'sk-codex-mid' }, failover: {},
  };
  assert.deepEqual(assertCodexRegistryPurity(pure), []);
  const impure = {
    backends: { qwen: { kind: 'ollama', url: 'http://127.0.0.1:8000', model: 'qwen3.5' } },
    roles: { 'sk-codex-mid': 'qwen' }, contexts: { 'agent:jarvis': 'sk-codex-mid' },
    failover: { local_fallback: 'sk-codex-mid' },
  };
  const problems = assertCodexRegistryPurity(impure);
  assert.equal(problems.length, 3);
  assert.ok(problems.every((problem) => problem.includes('official OpenAI GPT backend')));
});

test('runtime rejects a foreign primary or fallback before upstream dispatch and audits it', async () => {
  let routeCalls = 0;
  const events = [];
  const qwen = official({
    backendId: 'qwen-local', backendUrl: 'http://127.0.0.1:1', model: 'qwen3.5',
    backend: { kind: 'ollama', auth_type: 'none', model: 'qwen3.5' },
  });
  for (const candidates of [[qwen], [official(), qwen]]) {
    const router = { route: async () => { routeCalls += 1; return candidates; } };
    const result = await routeAndSend(
      router,
      { model: 'sk-codex-mid' },
      '/v1/chat/completions',
      'POST',
      {},
      Buffer.from('{"model":"sk-codex-mid","messages":[]}'),
      false,
      (event) => events.push(event),
    );
    assert.equal(result.status, 503);
    assert.equal(JSON.parse(result.body).error.code, 'codex_provider_unavailable');
  }
  assert.equal(routeCalls, 2);
  assert.equal(events.filter((event) => event.details?.code === 'codex_provider_unavailable').length, 2);
});
