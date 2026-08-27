import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isCodexNamed,
  isOpenAiGptModel,
  isPureCodexCandidate,
  codexPurityProblems,
  assertCodexRegistryPurity,
  assertCodexConfigPurity,
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
  for (const value of ['codex', 'sk-codex-mid', 'sk-codex-fast', 'GPT-5.3-CODEX', 'role_codex_fast']) {
    assert.equal(isCodexNamed(value), true, value);
  }
  assert.equal(isCodexNamed('qwen3.5-coder'), false);
});

test('accepts only GPT model syntax for official Codex candidates', () => {
  for (const model of ['gpt-5.3-codex', 'gpt-4.1', 'openai/gpt-5']) assert.equal(isOpenAiGptModel(model), true);
  for (const model of ['qwen3.5', 'claude-sonnet', 'glm-5', 'openrouter/auto']) assert.equal(isOpenAiGptModel(model), false);
  assert.equal(isPureCodexCandidate(official()), true);
  assert.equal(isPureCodexCandidate(official({ authHeaders: {} })), false, 'missing Codex credential fails before dispatch');
  assert.equal(isPureCodexCandidate(official({
    authHeaders: { authorization: 'Bearer fixture', 'chatgpt-account-id': 'fixture-account' },
  })), true, 'complete Codex dispatch credential is accepted');
  assert.equal(isPureCodexCandidate(official({
    backendId: 'mystery-name',
    backendUrl: 'https://chatgpt.com.evil.invalid/backend-api/codex',
    backend: {},
  })), false, 'lookalike hostname is not official');
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

test('startup and reload registry assertion rejects impure roles, aliases, buckets, contexts and fallback', () => {
  const pure = {
    backends: { codex: { kind: 'codex', url: 'https://chatgpt.com/backend-api/codex', model: 'gpt-5.3-codex' } },
    roles: { 'sk-codex': 'codex', 'sk-codex-mid': 'codex', 'sk-codex-fast': 'codex' },
    aliases: { 'codex-worker': 'sk-codex-mid' },
    buckets: { 'codex-bucket': { members: ['sk-codex', 'sk-codex-fast'] } },
    contexts: { 'agent:jarvis': 'sk-codex-mid' }, failover: {},
  };
  assert.deepEqual(assertCodexRegistryPurity(pure), []);
  const impure = {
    backends: { qwen: { kind: 'ollama', url: 'http://127.0.0.1:8000', model: 'qwen3.5' } },
    roles: { 'sk-codex-mid': 'qwen' },
    aliases: { 'codex-worker': 'qwen' },
    buckets: { 'codex-bucket': { members: ['qwen'] } },
    contexts: { 'agent:codex-worker': 'qwen' },
    failover: { local_fallback: ['ordinary-qwen', 'sk-codex-mid'] },
  };
  const problems = assertCodexRegistryPurity(impure);
  assert.equal(problems.length, 5);
  assert.ok(problems.every((problem) => /official OpenAI GPT backend|unknown Codex route/.test(problem)));
});

test('startup rejects impure Codex-named direct backends and wildcard catalogs', () => {
  const pure = { backends: { codex: {
    url: 'https://chatgpt.com/backend-api/codex', auth_type: 'codex_oauth', models: ['gpt-5.3-codex'],
  } } };
  assert.deepEqual(assertCodexConfigPurity(pure), []);
  for (const backend of [
    { url: 'http://127.0.0.1:8000', auth_type: 'none', models: ['qwen3.5'] },
    { url: 'https://openrouter.ai/api/v1', auth_type: 'api_key', models: ['openai/gpt-5'] },
    { url: 'https://chatgpt.com/backend-api/codex', auth_type: 'codex_oauth', models: ['*'] },
    { url: 'https://api.anthropic.com', auth_type: 'oauth', models: ['claude-sonnet'] },
    { url: 'https://api.z.ai', auth_type: 'zai_oauth', models: ['glm-5'] },
  ]) assert.equal(assertCodexConfigPurity({ backends: { 'sk-codex-direct': backend } }).length, 1);
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
