import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const token = 'synthetic-14436d93';
const tokenHash = createHash('sha256').update(token).digest('hex');
const BEARER = 'Bearer ';

function writeRegistry(path, entries, revision) {
  const creds = entries.map(function (e) {
    const inner = JSON.stringify({
      agent_id: e.agent_id, client_id: e.client_id,
      token_sha256: e.hash, credential_revision: e.revision,
      expires_at: (e.expires_at !== undefined ? e.expires_at : '2099-01-01T00:00:00.000Z'),
      revoked: (e.revoked !== undefined ? e.revoked : false),
    });
    return inner;
  }).join(',');
  const raw = '{"schema_version":1,"revision":"' + revision + '","credentials":[' + creds + ']}';
  writeFileSync(path, raw, { mode: 0o600 });
  chmodSync(path, 0o600);
}

test('client_auth enabled is fail-closed before routing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'skgw-14436d93-'));
  const credPath = join(dir, 'credentials.json');
  const auditPath = join(dir, 'audit.jsonl');
  writeRegistry(credPath, [
    { agent_id: 'jarvis', client_id: 'chiap02-pi', hash: tokenHash, revision: 'r1' },
  ], 'estate-r1');

  const configPath = join(dir, 'gateway.yaml');
  const codexAuthPath = join(dir, 'codex-auth.json');
  writeFileSync(codexAuthPath,
    '{"auth_mode":"chatgpt","tokens":{"access_token":"synthetic-access","refresh_token":"synthetic-refresh"}',
    { mode: 0o600 });
  const cfgLines = [
    'server:', '  bind: 127.0.0.1', '  port: 18990', '  dashboard_port: 18991',
    'dashboard:', '  enabled: false',
    'metrics:', '  enabled: false',
    'discovery:', '  enabled: false',
    'siem:', '  enabled: true', '  outputs:', '    - { type: file, path: ' + auditPath + ' }',
    'client_auth:', '  enabled: true', '  credentials_file: ' + credPath,
    '  expected_owner_uid: ' + process.getuid(), '  expected_group_gid: null',
    '  agent_header: x-agent-id', '  client_header: x-sk-client-id',
    '  revision_header: x-sk-credential-revision', '  denial_max: 100', '  denial_window_ms: 60000',
    'backends:', '  auth_fixture:', '    url: http://127.0.0.1:18999/v1', '    auth_type: none',
    '    models: [fixture-model]', '    priority: 1',
    '  codex:', '    url: https://chatgpt.com/backend-api/codex', '    auth_type: codex_oauth',
    '    credentials_path: ' + codexAuthPath, '    models: [gpt-5.6-sol]', '    priority: 2', '',
  ];
  writeFileSync(configPath, cfgLines.join('\n'));

  const upstreamPayload = '{"id":"fixture","object":"chat.completion","model":"fixture-model","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}';
  const upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(upstreamPayload);
  });
  await new Promise((r) => upstream.listen(18999, '127.0.0.1', r));

  const child = spawn(process.execPath, [join(root, 'src/index.mjs'), '--config', configPath, '--port', '18990'], {
    cwd: root,
    env: { ...process.env, HOME: dir, SKCAPSTONE_HOME: join(dir, '.skcapstone') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  t.after(async () => {
    child.kill('SIGKILL');
    await new Promise((r) => upstream.close(r));
  });

  const deadline = Date.now() + 10000;
  while (!out.includes('[skgateway] listening') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(out, /\[skgateway\] listening/, 'gateway must come up before routing');

  const base = 'http://127.0.0.1:18990';
  const chatBody = '{"model":"fixture-model","messages":[{"role":"user","content":"hi"}]';
  const headersFor = (tok, rev) => {
    const h = {
      'content-type': 'application/json',
      'x-agent-id': 'jarvis',
      'x-sk-client-id': 'chiap02-pi',
      'x-sk-credential-revision': rev,
    };
    if (tok) h.authorization = BEARER + tok;
    return h;
  };
  const post = (headers) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST', headers, body: chatBody,
  });

  assert.equal((await fetch(`${base}/health`)).status, 200, 'health must be public');
  assert.equal((await post({ 'content-type': 'application/json' })).status, 401, 'anonymous must be denied');
  assert.equal((await post({
    'content-type': 'application/json', 'x-agent-id': 'jarvis', 'x-sk-client-id': 'chiap02-pi',
    authorization: BEARER + token,
  })).status, 401, 'missing revision must be denied');
  assert.equal((await post({ ...headersFor(token, 'r1'), 'x-agent-id': 'other-agent' })).status, 401, 'wrong agent must be denied');
  assert.equal((await post({ ...headersFor(token, 'r1'), authorization: token })).status, 401, 'malformed authorization must be denied');
  assert.equal((await post(headersFor(token, 'r1'))).status, 200, 'valid credentials must pass');

  writeRegistry(credPath, [
    { agent_id: 'jarvis', client_id: 'chiap02-pi', hash: tokenHash, revision: 'r2', revoked: true },
  ], 'estate-r2');
  child.kill('SIGHUP');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await post(headersFor(token, 'r2'))).status, 401, 'revoked credential must be denied');

  writeRegistry(credPath, [
    { agent_id: 'jarvis', client_id: 'chiap02-pi', hash: tokenHash, revision: 'r2', expires_at: '2020-01-01T00:00:00.000Z' },
  ], 'estate-r3');
  child.kill('SIGHUP');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((await post(headersFor(token, 'r2'))).status, 401, 'expired credential must be denied');

  const den = await post({ 'content-type': 'application/json' });
  const denBody = await den.text();
  assert.equal(den.status, 401);
  assert.equal(denBody.includes(token), false, 'denial body must not leak the raw token');
  assert.equal(denBody.includes(tokenHash), false, 'denial body must not leak the token hash');

  const dash = await fetch(`${base}/dashboard`);
  assert.ok(dash.status === 404 || dash.status === 403 || dash.status === 401, 'dashboard must be closed when disabled');

  assert.ok(existsSync(auditPath), 'audit log file must exist');
  const auditLines = readFileSync(auditPath, 'utf8').split('\n').filter(Boolean);
  assert.ok(auditLines.some((l) => l.includes('client_auth.denied')), 'audit must record denials');
  assert.ok(auditLines.some((l) => l.includes('client_auth.accepted')), 'audit must record acceptances');
});
