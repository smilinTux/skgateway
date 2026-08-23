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

function writeRegistry(path, token, registryRevision, credentialRevision) {
  writeFileSync(path, JSON.stringify({
    schema_version: 1,
    revision: registryRevision,
    credentials: [{
      agent_id: 'jarvis', token_sha256: digest(token), credential_revision: credentialRevision,
      expires_at: '2099-01-01T00:00:00.000Z', revoked: false,
    }],
  }), { mode: 0o600 });
  chmodSync(path, 0o600);
}

test('live gateway authenticates before routing, reloads rotation, audits revisions and leaks no caller credential', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'skgw-client-auth-live-'));
  const credentialPath = join(dir, 'credentials.json');
  const auditPath = join(dir, 'audit.jsonl');
  writeRegistry(credentialPath, syntheticOld, 'estate-r1', 'jarvis-r1');

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
    '  agent_header: x-agent-id', '  denial_max: 2', '  denial_window_ms: 60000',
    'backends:', '  auth_fixture:', `    url: http://127.0.0.1:${upstreamPort}/v1`, '    auth_type: none',
    '    models: [fixture-model]', '    priority: 1', '',
  ].join('\n'));

  const child = spawn(process.execPath, [join(root, 'src/index.mjs'), '--config', configPath], {
    cwd: root,
    env: { ...process.env, HOME: dir, SKCAPSTONE_HOME: join(dir, '.skcapstone') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  t.after(async () => {
    child.kill('SIGKILL');
    await new Promise((resolveClose) => upstream.close(resolveClose));
    rmSync(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10000;
  while (!output.includes('[skgateway] listening') && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  assert.match(output, /\[skgateway\] listening/);

  const invoke = (agent, token) => fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions?credential=must-not-audit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-id': agent, authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'public synthetic' }] }),
  });
  assert.equal((await invoke('jarvis', 'wrong')).status, 401);
  assert.equal(upstreamRequests.length, 0);
  assert.equal((await invoke('JARVIS', syntheticOld)).status, 200);
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].headers.authorization, undefined);
  assert.equal(upstreamRequests[0].headers['x-agent-id'], undefined);

  writeRegistry(credentialPath, syntheticNew, 'estate-r2', 'jarvis-r2');
  child.kill('SIGHUP');
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  assert.equal((await invoke('jarvis', syntheticOld)).status, 401);
  assert.equal((await invoke('jarvis', 'second-denial')).status, 401);
  assert.equal((await invoke('jarvis', 'third-denial')).status, 429);
  assert.equal((await invoke('jarvis', syntheticNew)).status, 200);

  await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  const audit = readFileSync(auditPath, 'utf8');
  assert.match(audit, /client_auth\.denied/);
  assert.match(audit, /"status":429/);
  assert.match(audit, /"agent_id":"jarvis"/);
  assert.match(audit, /"credential_revision":"jarvis-r2"/);
  assert.doesNotMatch(audit, /synthetic-live-gate|must-not-audit|[a-f0-9]{64}/);
});
