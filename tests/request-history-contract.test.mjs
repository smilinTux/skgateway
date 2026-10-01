import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRouter, routeAndSend } from '../src/proxy/router.mjs';
import { loadConfig } from '../src/config.mjs';
import { buildConfig, handleRequest } from '../src/proxy/core.mjs';
import { ingressRequestLimit, modelRequestLimits, requestLimitError } from '../src/proxy/request-limits.mjs';

let upstream, child, directory, endpoint;
const received = [];
let remainingToolRejections = 0;
async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function history() {
  const messages = [{ role: 'system', content: 'Preserve the exact task.' },
    { role: 'user', content: 'Implement the task without rereading completed steps.' }];
  for (let i = 0; i < 140; i++) {
    messages.push({ role: 'assistant', content: `Step ${i} already completed.`, tool_calls: [
      { id: `call_${i}`, type: 'function', function: { name: 'read', arguments: '{}' } },
    ] });
    messages.push({ role: 'tool', tool_call_id: `call_${i}`,
      content: `BEGIN_${i}:` + 'x'.repeat(4000) + `:END_${i}` });
  }
  return messages;
}
async function post(value) {
  const response = await fetch(endpoint, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'skgw-history-'));
  upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const value = JSON.parse(Buffer.concat(chunks));
    received.push(value);
    if (remainingToolRejections > 0) {
      remainingToolRejections--;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'single tool-calls required' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ model: value.model,
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = await freePort(), dashboardPort = await freePort();
  const config = {
    server: { bind: '127.0.0.1', port, dashboard_port: dashboardPort },
    dashboard: { port: dashboardPort }, discovery: { enabled: false },
    identity: { enabled: false }, metrics: { enabled: false },
    model_aliases: { 'worker-alias': 'history-model', 'restricted-alias': 'history-model' },
    sanitizer: { max_body_bytes: 120000, max_system_bytes: 40000 },
    model_limits: { 'history-model': { max_body_bytes: 2000000, max_system_bytes: 800000 },
      'restricted-alias': { max_body_bytes: 250000, max_system_bytes: 40000 } },
    backends: { fixture: { url: `http://127.0.0.1:${upstream.address().port}/v1`,
      auth_type: 'none', priority: 1, models: ['history-model'] } },
  };
  const path = join(directory, 'gateway.yaml');
  writeFileSync(path, JSON.stringify(config));
  child = spawn(process.execPath, [resolve('src/index.mjs'), '--config', path],
    { env: { ...process.env, SKGATEWAY_MODEL_CATALOG_STORE_PATH: join(directory, 'lifecycle.json'),
      SKGATEWAY_MODEL_CATALOG_CACHE_PATH: join(directory, 'catalog.json'),
      SKGATEWAY_CAPACITY_STORE_PATH: join(directory, 'capacity.json'),
      SKMODELS_REGISTRY: join(directory, 'absent-registry.yaml') }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('isolated gateway startup timeout')), 15000);
    const data = chunk => { output += chunk; if (output.includes('[skgateway] listening')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', data); child.stderr.on('data', data);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`isolated gateway exited ${code}: ${output.slice(-2000)}`)); });
  });
  endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;
});
after(async () => {
  if (child && child.exitCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  if (upstream) await new Promise(resolve => upstream.close(resolve));
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test('canonical and alias preserve complete multi-turn tool history through real HTTP', async () => {
  const messages = history();
  assert.ok(Buffer.byteLength(JSON.stringify(messages)) > 560000);
  for (const model of ['history-model', 'worker-alias']) {
    const result = await post({ model, messages });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.headers.get('x-sk-model-served'), 'history-model');
    assert.equal(result.headers.get('x-sk-backend'), 'fixture');
    assert.equal(JSON.stringify(received.at(-1).messages), JSON.stringify(messages),
      `${model} must preserve every message and tool-result byte`);
  }
});
test('explicit alias body restriction rejects without calling any upstream', async () => {
  const before = received.length;
  const result = await post({ model: 'restricted-alias', messages: history() });
  assert.equal(result.status, 413);
  assert.equal(result.body.error.code, 'request_too_large');
  assert.equal(result.body.error.retryable, false);
  assert.equal(received.length, before);
});
test('system overflow is explicit and does not silently cut instructions', async () => {
  const before = received.length;
  const result = await post({ model: 'history-model', messages: [
    { role: 'system', content: 's'.repeat(800001) }, { role: 'user', content: 'ok' },
  ] });
  assert.equal(result.status, 413);
  assert.equal(result.body.error.param, 'system');
  assert.equal(received.length, before);
});
test('bounded ingress rejects oversized one-message requests without upstream calls', async () => {
  const before = received.length;
  const result = await post({ model: 'history-model', messages: [{ role: 'user', content: 'x'.repeat(2100000) }] });
  assert.equal(result.status, 413);
  assert.equal(result.body.error.code, 'request_too_large');
  assert.equal(received.length, before);
});

test('bucket resolves canonical allowance, skips smaller transport candidate without health penalty', async () => {
  const configPath = join(directory, 'router.yaml');
  const models = ['too-small', 'history-model'];
  writeFileSync(process.env.SKGATEWAY_MODEL_CATALOG_CACHE_PATH, JSON.stringify({ models: models.map(id =>
    ({ id, provider: 'local', free: true, card: { tier: 'local', size_class: 'L' } })) }));
  const config = { routing: { buckets_enabled: true, sensitivity_enforced: true },
    sanitizer: { max_body_bytes: 120000, max_system_bytes: 40000 },
    model_limits: { 'history-model': { max_body_bytes: 2000000, max_system_bytes: 800000 } } };
  writeFileSync(configPath, JSON.stringify(config));
  await loadConfig({ configPath, silent: true });
  const router = createRouter({ backends: { fixture: {
    url: `http://127.0.0.1:${upstream.address().port}/v1`, auth_type: 'none', priority: 1, models,
  } } });
  const messages = history(), before = received.length;
  const send = model => routeAndSend(router, { model, messages },
    '/chat/completions', 'POST', { 'content-type': 'application/json' },
    Buffer.from(JSON.stringify({ model, messages })), false);
  const result = await send('sk-l-secret');
  assert.equal(result.status, 200, result.body.toString());
  assert.equal(result.bucketMember, 'history-model');
  assert.equal(received.length, before + 1);
  assert.equal(JSON.stringify(received.at(-1).messages), JSON.stringify(messages));
  assert.equal(router.getBackend('fixture').isAvailable(), true);
  const rejected = await send('too-small');
  assert.equal(rejected.status, 413);
  assert.equal(received.length, before + 1, 'exact model request must not broaden to a larger model');
  config.model_limits['sk-l-secret'] = { max_body_bytes: 250000 };
  writeFileSync(configPath, JSON.stringify(config));
  await loadConfig({ configPath, silent: true });
  assert.equal((await send('sk-l-secret')).status, 413);
  assert.equal(received.length, before + 1, 'explicit bucket restriction must survive canonical resolution');
  assert.equal(router.getBackend('fixture').isAvailable(), true, 'local rejection must not penalize provider');
});

test('compatibility HTTP handler preserves large accepted history and rejects overflow before upstream', async () => {
  const cfg = buildConfig({ targetUrl: `http://127.0.0.1:${upstream.address().port}/v1`,
    modelLimits: { 'history-model': { maxBodyBytes: 2000000, maxSystemBytes: 800000 } } });
  const server = http.createServer((req, res) => handleRequest(req, res, cfg));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/chat/completions`;
    const messages = history();
    const send = value => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(value) });
    assert.equal((await send({ model: 'history-model', messages })).status, 200);
    assert.equal(JSON.stringify(received.at(-1).messages), JSON.stringify(messages));
    assert.equal((await send({ model: 'history-model', messages,
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    })).status, 200);
    const toolMessages = received.at(-1).messages;
    assert.ok(toolMessages[0].content.endsWith(messages[0].content),
      'existing single-tool instruction may prefix but must preserve the original system content');
    assert.deepEqual(toolMessages.slice(1), messages.slice(1),
      'compatibility tool processing must preserve every original conversation and tool result');
    const retryStart = received.length;
    remainingToolRejections = 3;
    assert.equal((await send({ model: 'history-model', messages,
      tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }],
    })).status, 200);
    const retries = received.slice(retryStart);
    assert.equal(retries.length, 4, 'exercise every established tool retry stage');
    for (const request of retries) {
      assert.deepEqual(request.messages, toolMessages,
        'upstream400 retries must retain complete tool calls/results and every original message');
    }
    const before = received.length;
    const response = await send({ model: 'history-model', messages: [{ role: 'system', content: 's'.repeat(800001) }] });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.param, 'system');
    const overflow = await send({ model: 'history-model', messages: [{ role: 'user', content: 'x'.repeat(2100000) }] });
    assert.equal(overflow.status, 413);
    assert.equal(received.length, before);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('explicit client ceiling, UTF-8 system totals, and invalid limits fail closed', () => {
  const config = { sanitizer: { max_body_bytes: 120000 },
    model_limits: { big: { max_body_bytes: 2000000 } },
    client_auth: { enabled: true, max_request_body_bytes: 900000 } };
  assert.equal(ingressRequestLimit(config), 900000);
  config.client_auth.enabled = false;
  assert.equal(ingressRequestLimit(config), 2000000);
  assert.throws(() => modelRequestLimits({ model_limits: { bad: { max_body_bytes: -1 } } }, 'bad'));
  const value = { messages: [{ role: 'system', content: 'éé' }, { role: 'developer', content: 'éé' }] };
  assert.equal(requestLimitError(value, { maxBodyBytes: 1000, maxSystemBytes: 7 }).actual_bytes, 8);
  assert.equal(requestLimitError(value, { maxBodyBytes: 1000, maxSystemBytes: 8 }), null);
});
