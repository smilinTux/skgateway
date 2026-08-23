import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClientAuthenticator, classifyAuthenticationRoute, normalizeClientAgentId, readBoundedRegistryFile, stripCallerCredentials, stripCredentialQuery } from '../src/identity/client-auth.mjs';

const syntheticToken = 'synthetic-estate-agent-secret';
const hash = createHash('sha256').update(syntheticToken).digest('hex');

function fixture(overrides = {}, credentialOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'skgw-client-auth-'));
  const file = join(dir, 'credentials.json');
  const registry = {
    schema_version: 1,
    revision: 'estate-r1',
    credentials: [{
      agent_id: 'jarvis',
      client_id: 'chiap08-pi',
      token_sha256: hash,
      credential_revision: 'jarvis-r7',
      expires_at: '2099-01-01T00:00:00.000Z',
      revoked: false,
      ...credentialOverrides,
    }],
  };
  writeFileSync(file, JSON.stringify(registry), { mode: 0o600 });
  chmodSync(file, 0o600);
  const cfg = {
    credentials_file: file,
    agent_header: 'x-agent-id',
    client_header: 'x-sk-client-id',
    revision_header: 'x-sk-credential-revision',
    expected_owner_uid: process.getuid(),
    expected_group_gid: null,
    max_authorization_bytes: 4096,
    max_agent_id_bytes: 128,
    max_client_id_bytes: 128,
    max_revision_bytes: 128,
    max_token_bytes: 2048,
    max_credential_file_bytes: 65536,
    max_credentials: 100,
    denial_window_ms: 60000,
    denial_max: 2,
    ...overrides,
  };
  return { dir, file, cfg, registry };
}

function headers(token = syntheticToken, overrides = {}) {
  return {
    'x-agent-id': 'jarvis',
    'x-sk-client-id': 'chiap08-pi',
    'x-sk-credential-revision': 'jarvis-r7',
    authorization: `Bearer ${token}`,
    ...overrides,
  };
}

test('normalizes only bounded canonical agent identities', () => {
  assert.equal(normalizeClientAgentId(' Jarvis '), 'jarvis');
  assert.equal(normalizeClientAgentId('anonymous'), null);
  assert.equal(normalizeClientAgentId('bad agent'), null);
  assert.equal(normalizeClientAgentId('x'.repeat(129)), null);
});

test('authenticates exact agent and token with sanitized revision attribution', () => {
  const { cfg } = fixture();
  const auth = new ClientAuthenticator(cfg);
  const result = auth.authenticate(headers(syntheticToken, { 'x-agent-id': 'JARVIS' }));
  assert.deepEqual(result, { ok: true, identity: {
    agent_id: 'jarvis', client_id: 'chiap08-pi', verified: true, method: 'client_auth', session_id: null,
    fingerprint: null, credential_revision: 'jarvis-r7', registry_revision: 'estate-r1',
  } });
  assert.equal(JSON.stringify(result).includes(syntheticToken), false);
  assert.equal(JSON.stringify(result).includes(hash), false);
});

test('fails closed with one generic result for missing, malformed, unknown, mismatched, expired and revoked credentials', () => {
  const valid = new ClientAuthenticator(fixture().cfg);
  const attempts = [
    {},
    headers(syntheticToken, { authorization: 'Basic abc' }),
    headers(syntheticToken, { 'x-agent-id': 'unknown' }),
    headers('wrong'),
    headers(syntheticToken, { 'x-sk-client-id': 'wrong-client' }),
    headers(syntheticToken, { 'x-sk-credential-revision': 'wrong-revision' }),
  ];
  for (const headers of attempts) assert.deepEqual(valid.authenticate(headers), { ok: false, reason: 'invalid_credentials' });
  const expired = new ClientAuthenticator(fixture({}, { expires_at: '2000-01-01T00:00:00.000Z' }).cfg);
  const revoked = new ClientAuthenticator(fixture({}, { revoked: true }).cfg);
  assert.deepEqual(expired.authenticate(headers()), { ok: false, reason: 'invalid_credentials' });
  assert.deepEqual(revoked.authenticate(headers()), { ok: false, reason: 'invalid_credentials' });
});

test('checks owner, exact mode, regular file, symlink and registry schema', () => {
  const loose = fixture();
  chmodSync(loose.file, 0o644);
  assert.throws(() => new ClientAuthenticator(loose.cfg), /mode must be 0600/);
  const linked = fixture();
  const link = join(linked.dir, 'link.json');
  symlinkSync(linked.file, link);
  assert.throws(() => new ClientAuthenticator({ ...linked.cfg, credentials_file: link }));
  const badOwner = fixture({ expected_owner_uid: process.getuid() + 1 });
  assert.throws(() => new ClientAuthenticator(badOwner.cfg), /owner mismatch/);
  const oversized = fixture({ max_credential_file_bytes: 32 });
  truncateSync(oversized.file, 1024 * 1024);
  assert.throws(() => new ClientAuthenticator(oversized.cfg), /exceeds size limit/);
});

test('bounded reader rejects a file that changes after its pre-read stat', () => {
  const f = fixture();
  assert.throws(() => readBoundedRegistryFile(f.file, f.cfg, {
    afterStat: () => writeFileSync(f.file, `${JSON.stringify(f.registry)} `, { mode: 0o600 }),
  }), /changed during bounded read/);
});

test('reload rotates credentials and fails closed on invalid replacement', () => {
  const f = fixture();
  const auth = new ClientAuthenticator(f.cfg);
  const newToken = 'synthetic-rotated-secret';
  f.registry.revision = 'estate-r2';
  f.registry.credentials[0].credential_revision = 'jarvis-r8';
  f.registry.credentials[0].token_sha256 = createHash('sha256').update(newToken).digest('hex');
  writeFileSync(f.file, JSON.stringify(f.registry), { mode: 0o600 });
  chmodSync(f.file, 0o600);
  assert.equal(auth.reload(), 'estate-r2');
  assert.equal(auth.authenticate(headers()).ok, false);
  assert.equal(auth.authenticate(headers(newToken, { 'x-sk-credential-revision': 'jarvis-r8' })).ok, true);
  writeFileSync(f.file, '{bad json', { mode: 0o600 });
  assert.throws(() => auth.reload());
  assert.deepEqual(auth.authenticate(headers(newToken, { 'x-sk-credential-revision': 'jarvis-r8' })), { ok: false, reason: 'registry_unavailable' });
});

test('supports overlapping revisions and rejects tuple or token ambiguity', () => {
  const f = fixture();
  const nextToken = 'synthetic-overlap-next';
  f.registry.credentials.push({
    ...f.registry.credentials[0],
    token_sha256: createHash('sha256').update(nextToken).digest('hex'),
    credential_revision: 'jarvis-r8',
  });
  writeFileSync(f.file, JSON.stringify(f.registry), { mode: 0o600 });
  chmodSync(f.file, 0o600);
  const auth = new ClientAuthenticator(f.cfg);
  assert.equal(auth.authenticate(headers()).ok, true);
  assert.equal(auth.authenticate(headers(nextToken, { 'x-sk-credential-revision': 'jarvis-r8' })).ok, true);

  f.registry.credentials[1].credential_revision = 'jarvis-r7';
  writeFileSync(f.file, JSON.stringify(f.registry), { mode: 0o600 });
  assert.throws(() => new ClientAuthenticator(f.cfg), /tuple is duplicated/);
  f.registry.credentials[1].credential_revision = 'jarvis-r8';
  f.registry.credentials[1].token_sha256 = f.registry.credentials[0].token_sha256;
  writeFileSync(f.file, JSON.stringify(f.registry), { mode: 0o600 });
  assert.throws(() => new ClientAuthenticator(f.cfg), /token hash is ambiguous/);
});

test('bounds authorization and denial rate without trusting source IP', () => {
  const { cfg } = fixture({ max_authorization_bytes: 20, denial_max: 2 });
  const auth = new ClientAuthenticator(cfg);
  assert.deepEqual(auth.authenticate(headers('x'.repeat(30))), { ok: false, reason: 'invalid_credentials' });
  assert.equal(auth.denialAllowed(), true);
  assert.equal(auth.denialAllowed(), true);
  assert.equal(auth.denialAllowed(), false);
});

test('strips caller credentials while preserving normalized attribution', () => {
  const headers = {
    authorization: 'Bearer secret', cookie: 'session=secret', 'x-api-key': 'secret',
    'proxy-authorization': 'secret', 'x-sk-capability': 'secret', 'x-agent-id': 'jarvis',
  };
  stripCallerCredentials(headers);
  assert.deepEqual(headers, { 'x-agent-id': 'jarvis' });
  assert.equal(stripCredentialQuery('/v1/models?role=worker&token=secret&CREDENTIAL=secret&Authorization=secret'), '/v1/models?role=worker');
});

test('concurrent checks and restart remain deterministic', async () => {
  const { cfg } = fixture();
  const auth = new ClientAuthenticator(cfg);
  const results = await Promise.all(Array.from({ length: 64 }, async () => auth.authenticate(headers())));
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(new ClientAuthenticator(cfg).authenticate(headers()).ok, true);
});

test('classifies only exact public routes as unauthenticated', () => {
  for (const path of ['/health', '/healthz', '/.well-known/skworld-module.json', '/api/hello']) {
    assert.equal(classifyAuthenticationRoute('GET', path).kind, 'public');
  }
  for (const path of ['/v1', '/v1/models', '/responses', '/not-v1', '/admin', '/admin/models', '//v1/models']) {
    assert.notEqual(classifyAuthenticationRoute('POST', path).kind, 'public');
  }
  assert.equal(classifyAuthenticationRoute('GET', '/admin/models').kind, 'admin');
  assert.equal(classifyAuthenticationRoute('POST', '/health').kind, 'client');
  assert.equal(classifyAuthenticationRoute('GET', '/health?unexpected=1').kind, 'client');
});
