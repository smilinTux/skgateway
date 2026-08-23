import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

const AGENT_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const REVISION_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function safeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  const size = Math.max(left.length, right.length, 1);
  const lp = Buffer.alloc(size);
  const rp = Buffer.alloc(size);
  left.copy(lp);
  right.copy(rp);
  return left.length === right.length && timingSafeEqual(lp, rp);
}

export function normalizeClientAgentId(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized !== 'anonymous' && AGENT_RE.test(normalized) ? normalized : null;
}

function validateFile(stat, cfg) {
  if (!stat.isFile()) throw new Error('client auth credential path is not a regular file');
  if (stat.uid !== cfg.expected_owner_uid) throw new Error('client auth credential owner mismatch');
  const expectedGid = cfg.expected_group_gid;
  if (expectedGid == null) {
    if ((stat.mode & 0o777) !== 0o600) throw new Error('client auth credential mode must be 0600');
  } else {
    if (stat.gid !== expectedGid) throw new Error('client auth credential group mismatch');
    if ((stat.mode & 0o777) !== 0o640) throw new Error('client auth credential mode must be 0640');
  }
}

function parseRegistry(path, cfg) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw;
  try {
    validateFile(fstatSync(fd), cfg);
    raw = readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
  if (Buffer.byteLength(raw) > cfg.max_credential_file_bytes) {
    throw new Error('client auth credential file exceeds size limit');
  }
  const parsed = JSON.parse(raw);
  if (parsed?.schema_version !== 1 || !REVISION_RE.test(parsed?.revision ?? '')) {
    throw new Error('client auth credential file schema is invalid');
  }
  if (!Array.isArray(parsed.credentials) || parsed.credentials.length < 1 || parsed.credentials.length > cfg.max_credentials) {
    throw new Error('client auth credential list is invalid');
  }
  const seen = new Set();
  const credentials = parsed.credentials.map((item) => {
    const agentId = normalizeClientAgentId(item?.agent_id);
    if (!agentId || agentId !== item.agent_id || seen.has(agentId)) throw new Error('client auth agent id is invalid or duplicated');
    seen.add(agentId);
    if (!HASH_RE.test(item.token_sha256 ?? '')) throw new Error('client auth token hash is invalid');
    if (!REVISION_RE.test(item.credential_revision ?? '')) throw new Error('client auth credential revision is invalid');
    if (typeof item.revoked !== 'boolean') throw new Error('client auth revoked flag is invalid');
    const expiresAt = Date.parse(item.expires_at);
    if (!Number.isFinite(expiresAt)) throw new Error('client auth expiry is invalid');
    return { agentId, tokenHash: item.token_sha256, revision: item.credential_revision, revoked: item.revoked, expiresAt };
  });
  return { registryRevision: parsed.revision, credentials };
}

export class ClientAuthenticator {
  constructor(cfg, { now = () => Date.now() } = {}) {
    this.cfg = cfg;
    this.now = now;
    this.denials = [];
    this.available = false;
    this.registry = null;
    this.reload();
  }

  reload() {
    try {
      this.registry = parseRegistry(this.cfg.credentials_file, this.cfg);
      this.available = true;
      return this.registry.registryRevision;
    } catch (error) {
      this.registry = null;
      this.available = false;
      throw error;
    }
  }

  denialAllowed() {
    const now = this.now();
    const floor = now - this.cfg.denial_window_ms;
    this.denials = this.denials.filter((at) => at > floor);
    if (this.denials.length >= this.cfg.denial_max) return false;
    this.denials.push(now);
    return true;
  }

  authenticate(headers = {}) {
    if (!this.available || !this.registry) return { ok: false, reason: 'registry_unavailable' };
    const rawAgent = headers[this.cfg.agent_header];
    const rawAuth = headers.authorization;
    if (typeof rawAgent !== 'string' || Buffer.byteLength(rawAgent) > this.cfg.max_agent_id_bytes) return { ok: false, reason: 'invalid_credentials' };
    if (typeof rawAuth !== 'string' || Buffer.byteLength(rawAuth) > this.cfg.max_authorization_bytes) return { ok: false, reason: 'invalid_credentials' };
    const match = /^Bearer ([^\s]+)$/.exec(rawAuth);
    const agentId = normalizeClientAgentId(rawAgent);
    if (!match || !agentId || match[1].length > this.cfg.max_token_bytes) return { ok: false, reason: 'invalid_credentials' };
    const suppliedHash = createHash('sha256').update(match[1]).digest('hex');
    let matched = null;
    for (const credential of this.registry.credentials) {
      const sameAgent = safeEqualText(agentId, credential.agentId);
      const sameToken = safeEqualText(suppliedHash, credential.tokenHash);
      if (sameAgent && sameToken) matched = credential;
    }
    if (!matched) return { ok: false, reason: 'invalid_credentials' };
    if (matched.revoked) return { ok: false, reason: 'invalid_credentials' };
    if (matched.expiresAt <= this.now()) return { ok: false, reason: 'invalid_credentials' };
    return {
      ok: true,
      identity: {
        agent_id: matched.agentId,
        verified: true,
        method: 'client_auth',
        session_id: null,
        fingerprint: null,
        credential_revision: matched.revision,
        registry_revision: this.registry.registryRevision,
      },
    };
  }
}

export function stripCallerCredentials(headers) {
  for (const key of ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'api-key', 'x-goog-api-key', 'x-sk-capability']) {
    delete headers[key];
  }
}

export function stripCredentialQuery(url) {
  const parsed = new URL(url, 'http://client.invalid');
  for (const key of ['token', 'access_token', 'api_key', 'authorization', 'credential']) parsed.searchParams.delete(key);
  return `${parsed.pathname}${parsed.search}`;
}
