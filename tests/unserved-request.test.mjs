/**
 * unserved-request.test.mjs: the gateway answers what no backend can serve.
 *
 * Before: Hermes' local-server fingerprint probes (GET /api/tags, /props,
 * /v1/props, /version, /api/v1/models, POST /api/show) and any model-less
 * request reached the estate's primary backend (codex on chi) and came back
 * as `upstream_error backend=codex {"detail":"Not Found"}`, ~2,500 a week.
 * Now they get a local 404/400 and never reach an upstream, while requests
 * that name a model, or carry a registry routing header, route as before.
 * Also pins that router.mjs's backend dispatch chain has one codex branch
 * (a duplicate, unreachable copy sat below the live one until v1.1.12).
 *
 * Run with: node --test tests/unserved-request.test.mjs
 */

import { readFileSync } from 'node:fs';
import { unservedRequest } from '../src/proxy/unserved-request.mjs';
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
  const dir = mkdtempSync(join(tmpdir(), 'skgw-unserved-live-'));
  const upstreamRequests = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() });
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


async function call(port, path, { method = 'POST', headers = { 'content-type': 'application/json' }, body } = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
}

test('unservedRequest: model-less requests outside /v1 are 404 not_found', () => {
  for (const [method, url] of [['GET', '/api/tags'], ['GET', '/props'], ['GET', '/version'],
    ['GET', '/api/v1/models'], ['POST', '/api/show'], ['POST', '/chat/completions']]) {
    const r = unservedRequest({ method, url });
    assert.equal(r?.status, 404, `${method} ${url}`);
    assert.equal(JSON.parse(r.body).error.code, 'not_found');
  }
  // A model-named request on a base URL without /v1 still routes, as before.
  assert.equal(unservedRequest({ method: 'POST', url: '/chat/completions', model: 'x' }), null);
});

test('unservedRequest: model-less /v1 is 404 for GET, 400 model_required otherwise', () => {
  assert.equal(unservedRequest({ method: 'GET', url: '/v1/props' }).status, 404);
  const r = unservedRequest({ method: 'POST', url: '/v1/chat/completions' });
  assert.equal(r.status, 400);
  assert.equal(JSON.parse(r.body).error.code, 'model_required');
});

test('unservedRequest: a model or a registry routing header passes through', () => {
  assert.equal(unservedRequest({ method: 'POST', url: '/v1/chat/completions', model: 'gpt-6.1-sol' }), null);
  assert.equal(unservedRequest({ method: 'POST', url: '/v1/chat/completions?x=1', model: 'sk-default' }), null);
  for (const h of ['x-sk-context', 'x-sk-service', 'x-sk-role']) {
    assert.equal(unservedRequest({ method: 'POST', url: '/v1/chat/completions', headers: { [h]: 'coding' } }), null, h);
  }
  // A non-JSON body is the backend's to reject, as before.
  assert.equal(unservedRequest({ method: 'POST', url: '/v1/chat/completions', opaqueBody: true }), null);
});

test('live gateway: Hermes fingerprint probes and model-less requests never reach the upstream', async (t) => {
  const gw = await startGatewayFixture();
  t.after(() => gw.close());

  for (const [method, path] of [['GET', '/api/v1/models'], ['GET', '/api/tags'], ['GET', '/v1/props'],
    ['GET', '/props'], ['GET', '/version']]) {
    const res = await call(gw.gatewayPort, path, { method, headers: {} });
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal((await res.json()).error.code, 'not_found');
  }
  const show = await call(gw.gatewayPort, '/api/show', { body: JSON.stringify({ name: 'fixture-model' }) });
  assert.equal(show.status, 404);
  const noModel = await call(gw.gatewayPort, '/v1/chat/completions', {
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(noModel.status, 400);
  assert.equal((await noModel.json()).error.code, 'model_required');
  assert.equal(gw.upstreamRequests.length, 0, 'no unserved request may cost an upstream call');
});

test('live gateway: requests that name a model still route, JSON content type or not', async (t) => {
  const gw = await startGatewayFixture();
  t.after(() => gw.close());

  const body = JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal((await call(gw.gatewayPort, '/v1/chat/completions', { body })).status, 200);
  // curl -d sends application/x-www-form-urlencoded; the body still names a model.
  assert.equal((await call(gw.gatewayPort, '/v1/chat/completions', {
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  })).status, 200);
  assert.equal((await call(gw.gatewayPort, '/v1/chat/completions', {
    headers: { 'content-type': 'application/json', 'x-model': 'fixture-model' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  })).status, 200);
  assert.equal(gw.upstreamRequests.length, 3);
  // Locally served routes are unaffected.
  assert.equal((await call(gw.gatewayPort, '/v1/models', { method: 'GET', headers: {} })).status, 200);
  assert.equal((await call(gw.gatewayPort, '/health', { method: 'GET', headers: {} })).status, 200);
});

test('router.mjs: the backend dispatch chain has exactly one codex branch', () => {
  const src = readFileSync(join(root, 'src/proxy/router.mjs'), 'utf8');
  assert.equal(src.match(/\} else if \(isCodexBackend\(backend\)\) \{/g)?.length, 1);
});
