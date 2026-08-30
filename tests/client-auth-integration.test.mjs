import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const syntheticOld = 'synthetic-live-gate-old';
const syntheticNew = 'synthetic-live-gate-new';
const digest = (value) => createHash('sha256').update(value).digest('hex');

function listen(server) {
  return new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen(server.address().port)));
}

function writeRegistry(path, entries, registryRevision) {
  writeFileSync(path, JSON.stringify({
    schema_version: 1,
    revision: registryRevision,
    credentials: entries.map((entry) => ({
      agent_id: entry.agent_id ?? 'jarvis', client_id: entry.client_id ?? 'chiap08-pi',
      token_sha256: digest(entry.token), credential_revision: entry.revision,
      expires_at: '2099-01-01T00:00:00.000Z', revoked: entry.revoked ?? false,
    })),
  }), { mode: 0o600 });
  chmodSync(path, 0o600);
}

test('live gateway authenticates before routing, reloads rotation, audits revisions and leaks no caller credential', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'skgw-client-auth-live-'));
  const credentialPath = join(dir, 'credentials.json');
  const operatorPath = join(dir, 'operators.json');
  const auditPath = join(dir, 'audit.jsonl');
  writeRegistry(credentialPath, [{ token: syntheticOld, revision: 'jarvis-r1' }], 'estate-r1');
  writeRegistry(operatorPath, [{ agent_id: 'local-operator', client_id: 'review-console', token: 'synthetic-operator', revision: 'operator-r1' }], 'operator-r1');

  const upstreamRequests = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
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
    'siem:', '  enabled: true', '  outputs:', `    - { type: file, path: "${auditPath}" }`,
    'client_auth:', '  enabled: true', `  credentials_file: "${credentialPath}"`,
    `  expected_owner_uid: ${process.getuid()}`, '  expected_group_gid: null',
    '  agent_header: x-agent-id', '  denial_max: 100', '  denial_window_ms: 60000',
    'operator_auth:', '  enabled: true', `  credentials_file: "${operatorPath}"`,
    `  expected_owner_uid: ${process.getuid()}`, '  expected_group_gid: null',
    'backends:', '  auth_fixture:', `    url: http://127.0.0.1:${upstreamPort}/v1`, '    auth_type: none',
    '    models: [fixture-model]', '    priority: 1', '',
  ].join('\n'));

  let output = '';
  const startGateway = () => {
    const processHandle = spawn(process.execPath, [join(root, 'src/index.mjs'), '--config', configPath], {
      cwd: root,
      env: { ...process.env, HOME: dir, SKCAPSTONE_HOME: join(dir, '.skcapstone') },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    processHandle.stdout.on('data', (chunk) => { output += chunk; });
    processHandle.stderr.on('data', (chunk) => { output += chunk; });
    return processHandle;
  };
  let child = startGateway();
  t.after(async () => {
    child.kill('SIGKILL');
    await new Promise((resolveClose) => upstream.close(resolveClose));
    rmSync(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10000;
  while (!output.includes('[skgateway] listening') && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  assert.match(output, /\[skgateway\] listening/);

  const clientHeaders = (token, revision = 'jarvis-r1') => ({
    'content-type': 'application/json', 'x-agent-id': 'jarvis', 'x-sk-client-id': 'chiap08-pi',
    'x-sk-credential-revision': revision, authorization: `Bearer ${token}`,
  });
  const invoke = (path, token, revision = 'jarvis-r1', body = { model: 'fixture-model', messages: [{ role: 'user', content: 'public synthetic' }] }) => fetch(`http://127.0.0.1:${gatewayPort}${path}`, {
    method: 'POST',
    headers: token ? clientHeaders(token, revision) : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  assert.equal((await fetch(`http://127.0.0.1:${gatewayPort}/health`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${gatewayPort}/health?unexpected=1`)).status, 401);
  const denialCases = [
    ['/v1', { model: 'fixture-model', messages: [] }],
    ['/responses', { model: 'fixture-model', messages: [] }],
    ['/chat/completions', { model: 'fixture-model', messages: [] }],
    ['/not-v1', { model: 'fixture-model', messages: [] }],
    ['/v1/chat/completions', { model: 'fixture-model', messages: [], stream: true }],
    ['/v1/chat/completions', { model: 'fixture-model', messages: [], tools: [{ type: 'function', function: { name: 'fixture', parameters: { type: 'object' } } }] }],
    ['/v1/images/generations', { model: 'fixture-model', prompt: 'public synthetic image' }],
  ];
  for (const [path, body] of denialCases) assert.equal((await invoke(path, null, undefined, body)).status, 401, path);
  assert.equal(upstreamRequests.length, 0);

  assert.equal((await fetch(`http://127.0.0.1:${gatewayPort}/admin/models`)).status, 401);
  const forwardedAdmin = await fetch(`http://127.0.0.1:${gatewayPort}/admin/models`, {
    headers: { ...clientHeaders(syntheticOld), 'x-forwarded-for': '100.64.0.8' },
  });
  assert.equal(forwardedAdmin.status, 401);
  const operatorAdmin = await fetch(`http://127.0.0.1:${gatewayPort}/admin/models`, { headers: {
    'x-sk-operator-id': 'local-operator', 'x-sk-operator-client-id': 'review-console',
    'x-sk-operator-credential-revision': 'operator-r1', authorization: 'Bearer synthetic-operator',
  } });
  assert.equal(operatorAdmin.status, 200);
  assert.equal(upstreamRequests.length, 0);

  assert.equal((await invoke('/responses?credential=must-not-audit', syntheticOld)).status, 200);
  assert.equal((await invoke('/not-v1', syntheticOld)).status, 200);
  assert.equal(upstreamRequests.length, 2);
  assert.equal(upstreamRequests[0].headers.authorization, undefined);
  assert.equal(upstreamRequests[0].headers['x-agent-id'], undefined);
  assert.equal(upstreamRequests[0].headers['x-sk-client-id'], undefined);
  assert.equal(upstreamRequests[0].headers['x-sk-credential-revision'], undefined);

  writeRegistry(credentialPath, [
    { token: syntheticOld, revision: 'jarvis-r1' },
    { token: syntheticNew, revision: 'jarvis-r2' },
  ], 'estate-r2');
  child.kill('SIGHUP');
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  assert.equal((await invoke('/v1/chat/completions', syntheticOld)).status, 200);
  assert.equal((await invoke('/v1/chat/completions', syntheticNew, 'jarvis-r2')).status, 200);
  writeRegistry(credentialPath, [
    { token: syntheticOld, revision: 'jarvis-r1', revoked: true },
    { token: syntheticNew, revision: 'jarvis-r2' },
  ], 'estate-r3');
  const concurrent = await Promise.all(Array.from({ length: 16 }, async (_, index) => {
    if (index === 8) child.kill('SIGHUP');
    return invoke('/v1/chat/completions', syntheticNew, 'jarvis-r2');
  }));
  assert.equal(concurrent.every((response) => response.status === 200), true);
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  assert.equal((await invoke('/v1/chat/completions', syntheticOld)).status, 401);
  assert.equal((await invoke('/v1/chat/completions', syntheticNew, 'jarvis-r2')).status, 200);

  child.kill('SIGKILL');
  await new Promise((resolveExit) => child.once('exit', resolveExit));
  output = '';
  child = startGateway();
  const restartDeadline = Date.now() + 10000;
  while (!output.includes('[skgateway] listening') && Date.now() < restartDeadline) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  assert.match(output, /\[skgateway\] listening/);
  assert.equal((await invoke('/responses', syntheticNew, 'jarvis-r2')).status, 200);

  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  const audit = readFileSync(auditPath, 'utf8');
  assert.match(audit, /client_auth\.denied/);
  assert.match(audit, /"agent_id":"jarvis"/);
  assert.match(audit, /"client_id":"chiap08-pi"/);
  assert.match(audit, /"credential_revision":"jarvis-r2"/);
  assert.match(audit, /operator_auth\.accepted/);
  assert.doesNotMatch(audit, /synthetic-live-gate|synthetic-operator|must-not-audit|[a-f0-9]{64}/);
});
