import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ClientAuthenticator, normalizeClientAgentId, stripCallerCredentials, stripCredentialQuery } from '../src/identity/client-auth.mjs';

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
    expected_owner_uid: process.getuid(),
    expected_group_gid: null,
    max_authorization_bytes: 4096,
    max_agent_id_bytes: 128,
    max_token_bytes: 2048,
    max_credential_file_bytes: 65536,
    max_credentials: 100,
    denial_window_ms: 60000,
    denial_max: 2,
    ...overrides,
  };
  return { dir, file, cfg, registry };
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
  const result = auth.authenticate({ 'x-agent-id': 'JARVIS', authorization: `Bearer ${syntheticToken}` });
  assert.deepEqual(result, { ok: true, identity: {
    agent_id: 'jarvis', verified: true, method: 'client_auth', session_id: null,
    fingerprint: null, credential_revision: 'jarvis-r7', registry_revision: 'estate-r1',
  } });
  assert.equal(JSON.stringify(result).includes(syntheticToken), false);
  assert.equal(JSON.stringify(result).includes(hash), false);
});

test('fails closed with one generic result for missing, malformed, unknown, mismatched, expired and revoked credentials', () => {
  const valid = new ClientAuthenticator(fixture().cfg);
  const attempts = [
    {},
    { 'x-agent-id': 'jarvis', authorization: 'Basic abc' },
    { 'x-agent-id': 'unknown', authorization: `Bearer ${syntheticToken}` },
    { 'x-agent-id': 'jarvis', authorization: 'Bearer wrong' },
  ];
  for (const headers of attempts) assert.deepEqual(valid.authenticate(headers), { ok: false, reason: 'invalid_credentials' });
  const expired = new ClientAuthenticator(fixture({}, { expires_at: '2000-01-01T00:00:00.000Z' }).cfg);
  const revoked = new ClientAuthenticator(fixture({}, { revoked: true }).cfg);
  const headers = { 'x-agent-id': 'jarvis', authorization: `Bearer ${syntheticToken}` };
  assert.deepEqual(expired.authenticate(headers), { ok: false, reason: 'invalid_credentials' });
  assert.deepEqual(revoked.authenticate(headers), { ok: false, reason: 'invalid_credentials' });
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
  assert.equal(auth.authenticate({ 'x-agent-id': 'jarvis', authorization: `Bearer ${syntheticToken}` }).ok, false);
  assert.equal(auth.authenticate({ 'x-agent-id': 'jarvis', authorization: `Bearer ${newToken}` }).ok, true);
  writeFileSync(f.file, '{bad json', { mode: 0o600 });
  assert.throws(() => auth.reload());
  assert.deepEqual(auth.authenticate({ 'x-agent-id': 'jarvis', authorization: `Bearer ${newToken}` }), { ok: false, reason: 'registry_unavailable' });
});

test('bounds authorization and denial rate without trusting source IP', () => {
  const { cfg } = fixture({ max_authorization_bytes: 20, denial_max: 2 });
  const auth = new ClientAuthenticator(cfg);
  assert.deepEqual(auth.authenticate({ 'x-agent-id': 'jarvis', authorization: `Bearer ${'x'.repeat(30)}` }), { ok: false, reason: 'invalid_credentials' });
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
  assert.equal(stripCredentialQuery('/v1/models?role=worker&token=secret&credential=secret'), '/v1/models?role=worker');
});

test('concurrent checks and restart remain deterministic', async () => {
  const { cfg } = fixture();
  const headers = { 'x-agent-id': 'jarvis', authorization: `Bearer ${syntheticToken}` };
  const auth = new ClientAuthenticator(cfg);
  const results = await Promise.all(Array.from({ length: 64 }, async () => auth.authenticate(headers)));
  assert.equal(results.every((result) => result.ok), true);
  assert.equal(new ClientAuthenticator(cfg).authenticate(headers).ok, true);
});
