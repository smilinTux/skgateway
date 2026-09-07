import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldForceNonStream } from '../src/classifiers/classifier.mjs';
import { enforceResponseContract } from '../src/proxy/response-contract.mjs';

test('kimi agentic streaming shape is forced upstream non-stream', () => {
  const request = {
    model: 'kimi-for-coding',
    stream: true,
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'Inspect the repository.' },
    ],
    tools: [{ type: 'function', function: { name: 'read_file', parameters: {} } }],
  };
  const decision = shouldForceNonStream(request, {}, Buffer.byteLength(JSON.stringify(request)), {
    default: true,
    auto_nonstream: { enabled: true, aggressive_models: ['kimi-for-coding'] },
  });
  assert.equal(decision.force, true);
  assert.match(decision.reason, /^aggressive_/);
});

test('kimi aggregated tool response with reasoning satisfies response contract', () => {
  const response = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      id: 'kimi-test', object: 'chat.completion', model: 'kimi-for-coding',
      choices: [{ index: 0, message: {
        role: 'assistant', content: '', reasoning_content: 'I will inspect the repository.',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      }, finish_reason: 'tool_calls' }],
    })),
  };
  const checked = enforceResponseContract(response, 'kimi-for-coding');
  assert.equal(checked.status, 200);
});
