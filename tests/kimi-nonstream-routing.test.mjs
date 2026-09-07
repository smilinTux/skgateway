import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { shouldForceNonStream } from '../src/classifiers/classifier.mjs';
import { enforceResponseContract } from '../src/proxy/response-contract.mjs';
import { loadConfig } from '../src/config.mjs';
import { createRouter, routeAndSend } from '../src/proxy/router.mjs';

await loadConfig({ configPath: '/nonexistent/skgw-kimi-nonstream-test.yaml', silent: true });

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

test('routeAndSend preserves every Kimi choice and tool index in validated SSE', async () => {
  const completion = {
    id: 'kimi-routed', object: 'chat.completion', created: 123, model: 'kimi-for-coding',
    choices: [
      { index: 2, message: { role: 'assistant', content: 'ready' }, finish_reason: 'stop' },
      { index: 7, message: { role: 'assistant', content: '', tool_calls: [
        { index: 3, id: 'call_3', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
        { index: 8, id: 'call_8', type: 'function', function: { name: 'write_file', arguments: '{"path":"b"}' } },
      ] }, finish_reason: 'tool_calls' },
    ],
    usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
  };
  const upstream = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(completion));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const router = createRouter({ backends: { kimi: {
      url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_type: 'none', models: ['kimi-for-coding'],
    } }, failover: false, siem_log: false });
    const result = await routeAndSend(
      router, { model: 'kimi-for-coding', agentId: 'repair' }, '/chat/completions', 'POST',
      { 'content-type': 'application/json', 'x-skgateway-nonstream': 'force' },
      Buffer.from(JSON.stringify({
        model: 'kimi-for-coding', stream: true, messages: [{ role: 'user', content: 'work' }],
      })), false,
    );
    assert.equal(result.status, 200);
    assert.match(result.headers['content-type'], /^text\/event-stream/);
    const frames = result.body.toString('utf8').split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)));
    assert.deepEqual([...new Set(frames.flatMap((frame) => frame.choices.map((choice) => choice.index)))], [2, 7]);
    const calls = frames.flatMap((frame) => frame.choices)
      .flatMap((choice) => choice.delta.tool_calls || []);
    assert.deepEqual(calls.map((call) => call.index), [3, 8]);
    const usageFrames = frames.filter((frame) => Object.hasOwn(frame, 'usage'));
    assert.equal(usageFrames.length, 1);
    assert.deepEqual(usageFrames[0].choices, []);
    assert.deepEqual(usageFrames[0].usage, completion.usage);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});
