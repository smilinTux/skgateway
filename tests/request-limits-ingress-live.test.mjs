/**
 * request-limits-ingress-live.test.mjs: explicit ingress byte limit on the
 * LIVE request path (src/index.mjs, the production entrypoint).
 *
 * src/proxy/core.mjs's handleRequest() is NOT the live path (see
 * tests/siem-live-hook.test.mjs); src/index.mjs buffers the body and routes
 * via routeAndSend() directly. Chi (ab1608f9) wires the new
 * ingressRequestLimit()/requestLimitResponse() check into THIS buffering
 * loop, not just into core.mjs, so this is the test that proves the port has
 * real effect in production rather than only existing in an unused module.
 *
 * Coverage:
 *   1. happy path: a small request passes through to the upstream.
 *   2. failure case: a body larger than every configured model's ceiling is
 *      rejected (413, request_too_large) while still streaming in.
 *   3. failure case: a per-model sanitizer override still rejects an
 *      oversized body (the ingress ceiling tracks config, not a hardcoded
 *      constant).
 *
 * Run with: node --test tests/request-limits-ingress-live.test.mjs
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function listen(server) {
  return new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen(server.address().port)));
}

async function startGatewayFixture(extraConfigLines = []) {
  const dir = mkdtempSync(join(tmpdir(), 'skgw-request-limits-live-'));
  const upstreamRequests = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({ body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'fixture', object: 'chat.completion', model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const reserve = createServer();
  const gatewayPort = await listen(reserve);
  await new Promise((resolveClose) => reserve.close(resolveClose));
  const configPath = join(dir, 'gateway.yaml');
  writeFileSync(configPath, [
    'server:', '  bind: 127.0.0.1', `  port: ${gatewayPort}`, `  dashboard_port: ${gatewayPort + 1}`,
    'dashboard:', '  enabled: false',
    'metrics:', '  enabled: false',
    'discovery:', '  enabled: false',
    'backends:', '  fixture:', `    url: http://127.0.0.1:${upstreamPort}/v1`, '    auth_type: none',
    '    models: [fixture-model]', '    priority: 1',
    ...extraConfigLines,
    '',
  ].join('\n'));

  let output = '';
  const child = spawn(process.execPath, [join(root, 'src/index.mjs'), '--config', configPath], {
    cwd: root,
    env: { ...process.env, HOME: dir, SKCAPSTONE_HOME: join(dir, '.skcapstone') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const deadline = Date.now() + 10000;
  while (!output.includes('[skgateway] listening') && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  if (!output.includes('[skgateway] listening')) throw new Error(`gateway did not start:\n${output}`);

  return {
    gatewayPort,
    upstreamRequests,
    async close() {
      child.kill('SIGKILL');
      await new Promise((resolveExit) => child.once('exit', resolveExit));
      await new Promise((resolveClose) => upstream.close(resolveClose));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function post(port, body) {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
}

test('live gateway: a small chat-completion request passes through normally', async (t) => {
  const gw = await startGatewayFixture();
  t.after(() => gw.close());

  const res = await post(gw.gatewayPort, JSON.stringify({
    model: 'fixture-model', messages: [{ role: 'user', content: 'hello' }],
  }));
  assert.equal(res.status, 200);
  assert.equal(gw.upstreamRequests.length, 1);
});

test('live gateway: a body over every configured ceiling is rejected while still streaming in', async (t) => {
  const gw = await startGatewayFixture([
    'sanitizer:', '  max_body_bytes: 2000', '  max_system_bytes: 1000',
  ]);
  t.after(() => gw.close());

  const res = await post(gw.gatewayPort, JSON.stringify({
    model: 'fixture-model', messages: [{ role: 'user', content: 'x'.repeat(5000) }],
  }));
  assert.equal(res.status, 413);
  const parsed = await res.json();
  assert.equal(parsed.error.code, 'request_too_large');
  assert.equal(parsed.error.param, 'body');
  assert.match(parsed.error.message, /history was not modified/);
  assert.equal(gw.upstreamRequests.length, 0, 'an oversized request must never reach the upstream');
});

test('live gateway: a per-model limit widens the ingress ceiling past the global sanitizer default', async (t) => {
  const gw = await startGatewayFixture([
    'sanitizer:', '  max_body_bytes: 2000', '  max_system_bytes: 1000',
    'model_limits:', '  fixture-model:', '    max_body_bytes: 50000',
  ]);
  t.after(() => gw.close());

  // 5000 bytes is over the global default (2000) but comfortably under the
  // per-model ceiling (50000) that ingressRequestLimit() must admit for.
  const res = await post(gw.gatewayPort, JSON.stringify({
    model: 'fixture-model', messages: [{ role: 'user', content: 'x'.repeat(5000) }],
  }));
  assert.equal(res.status, 200, 'ingress must admit the largest configured model ceiling, not just the default');
  assert.equal(gw.upstreamRequests.length, 1);
});

test('live gateway: logical GLM retains evidence and obeys the concrete byte ceiling', async (t) => {
  const gw = await startGatewayFixture([
    'sanitizer:', '  max_body_bytes: 120000', '  max_system_bytes: 40000',
    'model_aliases:', '  sk-glm-m: fixture-model',
    'model_limits:', '  fixture-model:', '    max_body_bytes: 640000',
    '  large-fixture:', '    max_body_bytes: 2000000',
  ]);
  t.after(() => gw.close());

  const messages = [{ role: 'system', content: 'bounded synthetic worker' }];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{
      id: `read-${i}`, type: 'function', function: { name: 'read', arguments: '{}' },
    }] });
    messages.push({ role: 'tool', tool_call_id: `read-${i}`,
      content: `evidence-${i}:` + 'x'.repeat(15000) });
  }
  messages.push({ role: 'user', content: 'implement using the exact evidence' });
  const body = { model: 'sk-glm-m', messages };
  const res = await post(gw.gatewayPort, JSON.stringify(body));
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(gw.upstreamRequests[0].body).messages, messages);

  // Under ingress's 2 MB ceiling, but over this resolved model's 640 KB.
  const oversized = JSON.stringify({ ...body,
    messages: [...messages, { role: 'user', content: 'x'.repeat(640000) }] });
  const rejected = await post(gw.gatewayPort, oversized);
  assert.equal(rejected.status, 413);
  assert.equal((await rejected.json()).error.limit_bytes, 640000);
  assert.equal(gw.upstreamRequests.length, 1, 'oversized history must not reach upstream');

  const systemRejected = await post(gw.gatewayPort, JSON.stringify({
    model: 'sk-glm-m', messages: [
      { role: 'developer', content: 's'.repeat(45000) },
      { role: 'user', content: 'hello' },
    ],
  }));
  assert.equal(systemRejected.status, 413);
  assert.equal((await systemRejected.json()).error.param, 'system');
  assert.equal(gw.upstreamRequests.length, 1, 'system guard must still reject before upstream');
});
