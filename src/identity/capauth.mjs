/**
 * capauth.mjs — CapAuth Identity Integration Layer for SKGateway
 *
 * Responsibilities
 * ────────────────
 * 1. Agent Identity Extraction — resolve who is making a request from:
 *      • X-Agent-Id header          (simple name: "lumina", "jarvis")
 *      • X-CapAuth-Signature header  (PGP-signed challenge-response, verified)
 *      • Authorization: Bearer <tok> (token mapped to agent via registry)
 *      • X-Session-Id header         (session correlation only)
 * 2. Agent Registry — load known agents from config or discover from
 *    ~/.skcapstone/agents/ directories; each entry carries permissions.
 * 3. Request Enrichment — stamp agent_id onto the request context so
 *    SIEM, metrics, and the policy engine all see the same identity.
 * 4. Identity Middleware — Express-style factory that returns
 *    (req, res, next) and enforces `require_agent_id` if configured.
 *
 * CapAuth PGP identity protocol (from capauth.identity):
 *   1. Verifier issues a challenge (random hex bytes).
 *   2. Prover signs the challenge with their PGP private key.
 *   3. Verifier checks the signature against the prover's known public key.
 *   4. Valid signature → authenticated, no corporate middleman needed.
 *
 * The X-CapAuth-Signature header carries the signature over a deterministic
 * per-request challenge: `sha256(method + path + x-agent-id + timestamp)`.
 * The timestamp comes from X-CapAuth-Timestamp (unix seconds, ±300 s window).
 *
 * Usage
 * ─────
 *   import { loadAgentRegistry, identityMiddleware } from './identity/capauth.mjs';
 *
 *   const registry = await loadAgentRegistry(config);
 *   app.use(identityMiddleware({ registry, require_agent_id: false }));
 *
 *   // After middleware, req.identity is populated:
 *   //  { agent_id, verified, method, session_id, fingerprint?, permissions }
 *
 * @module identity/capauth
 */

import { createHash, createVerify } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

// ─── constants ────────────────────────────────────────────────────────────────

/** Maximum clock skew (seconds) tolerated for CapAuth timestamps. */
const TIMESTAMP_SKEW_S = 300;

/** Default agent used when no identity is found and anonymous is allowed. */
const ANONYMOUS_AGENT_ID = 'anonymous';

/**
 * Known agents baked into code as a last-resort fallback.
 * The registry loader merges these with file-system discovery and config.
 *
 * @type {AgentEntry[]}
 */
const BUILTIN_AGENTS = [
  {
    name: 'lumina',
    allowed_models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'kimi-k2-instruct', 'kimi-k2.5', 'minimax-m2.1'],
    allowed_backends: ['anthropic', 'nvidia', 'ollama'],
    rate_limit: { requests_per_minute: 120, tokens_per_day: 5_000_000 },
    budget: { daily_usd: 20.00 },
    capauth_uri: 'capauth:lumina@skworld.io',
  },
  {
    name: 'jarvis',
    allowed_models: ['kimi-k2-instruct', 'minimax-m2.1', 'claude-sonnet-4-6'],
    allowed_backends: ['nvidia', 'anthropic'],
    rate_limit: { requests_per_minute: 60, tokens_per_day: 2_000_000 },
    budget: { daily_usd: 5.00 },
    capauth_uri: 'capauth:jarvis@skworld.io',
  },
  {
    name: 'opus',
    allowed_models: ['claude-opus-4-6', 'claude-sonnet-4-6'],
    allowed_backends: ['anthropic'],
    rate_limit: { requests_per_minute: 30, tokens_per_day: 1_000_000 },
    budget: { daily_usd: 10.00 },
    capauth_uri: 'capauth:opus@skworld.io',
  },
  {
    name: 'artisan',
    allowed_models: ['claude-sonnet-4-6', 'kimi-k2-instruct'],
    allowed_backends: ['anthropic', 'nvidia'],
    rate_limit: { requests_per_minute: 60, tokens_per_day: 2_000_000 },
    budget: { daily_usd: 5.00 },
    capauth_uri: 'capauth:artisan@skworld.io',
  },
  {
    name: 'herald',
    allowed_models: ['kimi-k2-instruct', 'kimi-k2.5'],
    allowed_backends: ['nvidia'],
    rate_limit: { requests_per_minute: 60, tokens_per_day: 2_000_000 },
    budget: { daily_usd: 0 },
    capauth_uri: 'capauth:herald@skworld.io',
  },
  {
    name: 'sentinel',
    allowed_models: ['kimi-k2-instruct', 'kimi-k2.5'],
    allowed_backends: ['nvidia'],
    rate_limit: { requests_per_minute: 30, tokens_per_day: 1_000_000 },
    budget: { daily_usd: 0 },
    capauth_uri: 'capauth:sentinel@skworld.io',
  },
  {
    name: 'architect',
    allowed_models: ['claude-sonnet-4-6', 'kimi-k2-instruct'],
    allowed_backends: ['anthropic', 'nvidia'],
    rate_limit: { requests_per_minute: 60, tokens_per_day: 2_000_000 },
    budget: { daily_usd: 5.00 },
    capauth_uri: 'capauth:architect@skworld.io',
  },
  {
    name: 'scholar',
    allowed_models: ['kimi-k2-instruct', 'kimi-k2.5'],
    allowed_backends: ['nvidia'],
    rate_limit: { requests_per_minute: 60, tokens_per_day: 2_000_000 },
    budget: { daily_usd: 0 },
    capauth_uri: 'capauth:scholar@skworld.io',
  },
  {
    name: 'steward',
    allowed_models: ['kimi-k2-instruct'],
    allowed_backends: ['nvidia'],
    rate_limit: { requests_per_minute: 60, tokens_per_day: 2_000_000 },
    budget: { daily_usd: 0 },
    capauth_uri: 'capauth:steward@skworld.io',
  },
  {
    name: 'coder',
    allowed_models: ['claude-sonnet-4-6'],
    allowed_backends: ['anthropic'],
    rate_limit: { requests_per_minute: 60, tokens_per_day: 2_000_000 },
    budget: { daily_usd: 5.00 },
    capauth_uri: 'capauth:coder@skworld.io',
  },
];

// ─── JSDoc types ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} AgentEntry
 * @property {string}   name               - Agent identifier (e.g. "lumina")
 * @property {string[]} allowed_models     - Glob-style model name allowlist
 * @property {string[]} allowed_backends   - Backend names this agent may use
 * @property {{ requests_per_minute: number, tokens_per_day: number }} rate_limit
 * @property {{ daily_usd: number }} budget
 * @property {string}  [capauth_uri]       - capauth:<name>@<domain> URI
 * @property {string}  [fingerprint]       - PGP fingerprint for verified identity
 * @property {string}  [public_key_armor]  - ASCII-armored public key (for sig verification)
 * @property {string[]} [bearer_tokens]    - Hashed tokens that map to this agent
 */

/**
 * @typedef {object} AgentRegistry
 * @property {Map<string, AgentEntry>} byName        - Lookup by agent name
 * @property {Map<string, string>}     byToken        - SHA-256(token) → agent name
 * @property {Map<string, string>}     byFingerprint  - fingerprint → agent name
 * @property {AgentEntry|null}         defaultAgent   - Used for unidentified requests (or null to deny)
 */

/**
 * @typedef {object} ResolvedIdentity
 * @property {string}  agent_id    - Resolved agent name (or "anonymous")
 * @property {boolean} verified    - True only if PGP signature was validated
 * @property {'header'|'capauth'|'bearer'|'anonymous'} method - How identity was established
 * @property {string|null} session_id   - From X-Session-Id header, if present
 * @property {string|null} fingerprint  - PGP fingerprint if capauth method
 * @property {AgentEntry|null} agent    - Full registry entry, or null if anonymous
 */

// ─── registry loader ─────────────────────────────────────────────────────────

/**
 * Discover agent names from `~/.skcapstone/agents/` directory entries.
 * Each sub-directory whose name is a simple slug (no dots, no gpg-manifest)
 * is treated as a potential agent.
 *
 * @param {string} agentsDir  Absolute path to the agents directory.
 * @returns {string[]}  List of agent name slugs found.
 */
function discoverAgentNames(agentsDir) {
  if (!existsSync(agentsDir)) return [];
  try {
    return readdirSync(agentsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^[a-z][a-z0-9-]*$/.test(d.name))
      .map(d => d.name);
  } catch {
    return [];
  }
}

/**
 * Try to read the PGP public key for an agent from its identity directory.
 * Path: ~/.skcapstone/agents/<name>/identity/public.asc
 *       or ~/.capauth/identity/public.asc (owner identity)
 *
 * @param {string} agentName
 * @param {string} agentsDir
 * @returns {string|null}  ASCII-armored public key, or null if not found.
 */
function readAgentPublicKey(agentName, agentsDir) {
  const candidates = [
    resolve(agentsDir, agentName, 'identity', 'public.asc'),
    resolve(agentsDir, agentName, 'trust', 'public.asc'),
    resolve(homedir(), '.capauth', 'agents', agentName, 'public.asc'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try { return readFileSync(p, 'utf8'); } catch { /* skip */ }
    }
  }
  return null;
}

/**
 * Load the agent registry from three sources (merged in order):
 *   1. Built-in defaults (BUILTIN_AGENTS)
 *   2. Auto-discovery from ~/.skcapstone/agents/ directories
 *   3. Explicit `identity.agents` entries in the gateway config
 *
 * Config-supplied entries fully override built-in entries for the same name.
 *
 * @param {object} [config={}]  Gateway config object (or identity sub-object).
 * @param {object} [config.identity]  Identity section of the gateway config.
 * @param {object[]} [config.identity.agents]  Explicit agent entries.
 * @param {string}  [config.identity.agents_dir]  Override for ~/.skcapstone/agents/.
 * @param {boolean} [config.identity.allow_anonymous]  Allow unidentified requests.
 * @param {string}  [config.identity.default_agent]  Name of the catch-all agent.
 * @returns {AgentRegistry}
 */
export function loadAgentRegistry(config = {}) {
  const idCfg = config.identity ?? {};
  const agentsDir = idCfg.agents_dir
    ? resolve(idCfg.agents_dir.replace(/^~/, homedir()))
    : resolve(homedir(), '.skcapstone', 'agents');

  /** @type {Map<string, AgentEntry>} */
  const byName = new Map();

  // 1. Seed with builtins
  for (const agent of BUILTIN_AGENTS) {
    byName.set(agent.name, { ...agent });
  }

  // 2. Auto-discover: create minimal entries for any dirs not already present
  for (const name of discoverAgentNames(agentsDir)) {
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        allowed_models: [],   // empty = no restriction (policy engine decides)
        allowed_backends: [],
        rate_limit: { requests_per_minute: 30, tokens_per_day: 500_000 },
        budget: { daily_usd: 2.00 },
      });
    }
    // Augment with public key if available
    const entry = byName.get(name);
    if (!entry.public_key_armor) {
      const key = readAgentPublicKey(name, agentsDir);
      if (key) entry.public_key_armor = key;
    }
  }

  // 3. Config overrides
  for (const overrideEntry of (idCfg.agents ?? [])) {
    const existing = byName.get(overrideEntry.name) ?? {};
    byName.set(overrideEntry.name, { ...existing, ...overrideEntry });
  }

  // Build secondary indexes
  /** @type {Map<string, string>} */
  const byToken = new Map();
  /** @type {Map<string, string>} */
  const byFingerprint = new Map();

  for (const [name, entry] of byName) {
    if (entry.fingerprint) byFingerprint.set(entry.fingerprint.toUpperCase(), name);
    for (const rawToken of (entry.bearer_tokens ?? [])) {
      const hash = createHash('sha256').update(rawToken).digest('hex');
      byToken.set(hash, name);
    }
  }

  // Determine default agent
  let defaultAgent = null;
  if (idCfg.allow_anonymous !== false) {
    const defaultName = idCfg.default_agent ?? null;
    defaultAgent = defaultName ? (byName.get(defaultName) ?? null) : null;
  }

  return { byName, byToken, byFingerprint, defaultAgent };
}

// ─── identity extraction ─────────────────────────────────────────────────────

/**
 * Build the per-request challenge string that a CapAuth client must sign.
 * Deterministic: sha256(METHOD + PATH + agent_id + timestamp).
 *
 * @param {string} method     HTTP method (uppercase)
 * @param {string} path       Request URL path
 * @param {string} agentId    Value from X-Agent-Id header
 * @param {string} timestamp  Value from X-CapAuth-Timestamp header (unix seconds string)
 * @returns {Buffer}  32-byte digest
 */
function buildChallenge(method, path, agentId, timestamp) {
  return createHash('sha256')
    .update(`${method}${path}${agentId}${timestamp}`)
    .digest();
}

/**
 * Verify a PGP detached signature over `data` using `publicKeyArmor`.
 * Uses Node's built-in crypto with OpenPGP literal packet format.
 *
 * NOTE: Full OpenPGP packet parsing is non-trivial without a library.
 * This implementation handles the common Ed25519 + RSA cases by extracting
 * the raw signature from the armored packet.  For production PGP, install
 * the optional `openpgp` package — the function detects and uses it when
 * present, otherwise falls back to best-effort header/trailer verification.
 *
 * @param {Buffer}  data           The original signed data.
 * @param {string}  signatureArmor ASCII-armored PGP signature.
 * @param {string}  publicKeyArmor ASCII-armored PGP public key.
 * @returns {boolean}  True if the signature is valid.
 */
async function verifyPgpSignature(data, signatureArmor, publicKeyArmor) {
  // Prefer the openpgp library when available (npm install openpgp)
  try {
    const openpgp = await import('openpgp');
    const message   = await openpgp.createMessage({ binary: data });
    const sig        = await openpgp.readSignature({ armoredSignature: signatureArmor });
    const pubKey     = await openpgp.readKey({ armoredKey: publicKeyArmor });
    const result     = await openpgp.verify({ message, signature: sig, verificationKeys: pubKey });
    const { verified: v } = result.signatures[0] ?? {};
    return v != null ? await v : false;
  } catch (importErr) {
    // openpgp not installed — fall through to structural check
  }

  // Structural sanity check only: confirm armored blocks exist and are non-empty.
  // This does NOT cryptographically verify — it documents the intent and ensures
  // callers who want real verification install openpgp.
  const hasValidSig = signatureArmor.includes('-----BEGIN PGP SIGNATURE-----')
    && signatureArmor.includes('-----END PGP SIGNATURE-----');
  const hasValidKey = publicKeyArmor.includes('-----BEGIN PGP PUBLIC KEY BLOCK-----');

  if (!hasValidSig || !hasValidKey) return false;

  // Flag that we could not do full verification
  process.stderr.write(
    '[skgateway:identity] WARN: openpgp not installed — PGP signature structurally present but NOT cryptographically verified.\n' +
    '                           Run: npm install openpgp  to enable full CapAuth verification.\n'
  );
  // Return false so `verified` stays false — transparent to the request, but auditable.
  return false;
}

/**
 * Canonical form of a caller-supplied agent id, or `null` when no agent is
 * knowable.
 *
 * ONE definition, because there were two (card 316dd167 / A8). `extractIdentity`
 * below has always applied `.trim().toLowerCase()`, while the inline fallback
 * `src/index.mjs` builds when `identity.enabled` is false used the raw header.
 * The same caller was therefore attributed as `Lumina` or `lumina` depending on
 * a config flag, and `getTokenUsage()` / `getCosts()` filter with
 * `agent_id = @agentId`, an exact match, so one agent's spend split silently
 * across two keys that no query joins back together.
 *
 * The anonymous SENTINEL maps to null on purpose. `ANONYMOUS_AGENT_ID` is the
 * value the resolver returns to say "nobody identified themselves"; a caller
 * that literally sends `X-Agent-Id: anonymous` must not be stored as an agent
 * by that name, or unattributed traffic would aggregate under what looks like a
 * real agent.
 *
 * @param {unknown} raw  Header value, or an already-resolved agent id.
 * @returns {string|null} lower-cased, trimmed id, or null for unknown.
 */
export function normalizeAgentId(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (!v || v === ANONYMOUS_AGENT_ID) return null;
  return v;
}

/**
 * Extract and resolve an agent identity from an incoming HTTP request.
 *
 * Resolution order:
 *   1. X-CapAuth-Signature + X-CapAuth-Timestamp  → method: "capauth", verified: true/false
 *   2. Authorization: Bearer <token>               → method: "bearer",  verified: false
 *   3. X-Agent-Id                                  → method: "header",  verified: false
 *   4. Default / anonymous                         → method: "anonymous", verified: false
 *
 * @param {object}        req       Node.js IncomingMessage (or Express Request)
 * @param {AgentRegistry} registry
 * @returns {Promise<ResolvedIdentity>}
 */
export async function extractIdentity(req, registry) {
  const h = req.headers ?? {};
  const sessionId = h['x-session-id'] ?? null;

  // ── 1. CapAuth PGP signature ──────────────────────────────────────────────
  const capAuthSig  = h['x-capauth-signature'];
  const capAuthTs   = h['x-capauth-timestamp'];
  // One canonicaliser for the whole gateway (card 316dd167 / A8). This used to
  // be an inline `.trim().toLowerCase()` here and a raw header read in
  // index.mjs, which is how the same caller got two different agent_ids.
  //
  // BEHAVIOUR CHANGE, called out because it touches the auth gate: this now
  // also maps the literal `anonymous` to null. Previously `X-Agent-Id:
  // anonymous` returned method 'header', so it satisfied `require_agent_id`,
  // meaning the gate could be passed by typing the sentinel that means "I am
  // not identified". It now resolves to method 'anonymous' and the gate rejects
  // it. The gate is OFF by default and OFF on this fleet, so nothing live
  // changes; a deployment that turns it on gets the semantics it asked for.
  const agentIdHdr  = normalizeAgentId(h['x-agent-id']);

  if (capAuthSig && capAuthTs && agentIdHdr) {
    const tsSeconds = parseInt(capAuthTs, 10);
    const nowSeconds = Math.floor(Date.now() / 1000);

    if (!Number.isNaN(tsSeconds) && Math.abs(nowSeconds - tsSeconds) <= TIMESTAMP_SKEW_S) {
      const agentEntry = registry.byName.get(agentIdHdr);
      if (agentEntry) {
        const challenge = buildChallenge(
          (req.method ?? 'POST').toUpperCase(),
          req.url ?? '/',
          agentIdHdr,
          capAuthTs
        );
        const publicKey = agentEntry.public_key_armor ?? '';
        let verified = false;
        if (publicKey) {
          try {
            verified = await verifyPgpSignature(challenge, capAuthSig, publicKey);
          } catch { /* signature verification failed */ }
        }

        // Even when openpgp is absent, record the fingerprint from config
        const fingerprint = agentEntry.fingerprint ?? null;

        return {
          agent_id: agentIdHdr,
          verified,
          method: 'capauth',
          session_id: sessionId,
          fingerprint,
          agent: agentEntry,
        };
      }
    }
  }

  // ── 2. Bearer token ───────────────────────────────────────────────────────
  const authHeader = h['authorization'] ?? '';
  const bearerMatch = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (bearerMatch) {
    const tokenHash = createHash('sha256').update(bearerMatch[1]).digest('hex');
    const agentName = registry.byToken.get(tokenHash);
    if (agentName) {
      return {
        agent_id: agentName,
        verified: false,
        method: 'bearer',
        session_id: sessionId,
        fingerprint: null,
        agent: registry.byName.get(agentName) ?? null,
      };
    }
  }

  // ── 3. X-Agent-Id header ─────────────────────────────────────────────────
  if (agentIdHdr) {
    const agentEntry = registry.byName.get(agentIdHdr) ?? null;
    return {
      agent_id: agentIdHdr,
      verified: false,
      method: 'header',
      session_id: sessionId,
      fingerprint: null,
      agent: agentEntry,
    };
  }

  // ── 4. Anonymous / default ────────────────────────────────────────────────
  return {
    agent_id: ANONYMOUS_AGENT_ID,
    verified: false,
    method: 'anonymous',
    session_id: sessionId,
    fingerprint: null,
    agent: registry.defaultAgent,
  };
}

// ─── request enrichment ───────────────────────────────────────────────────────

/**
 * Attach resolved identity to a request object and propagate it to the
 * other SKGateway subsystems that expect `agent_id`.
 *
 * - `req.identity`          — the full ResolvedIdentity object
 * - `req.agent_id`          — shortcut string for fast access
 * - Emits `identity:resolved` on `req.siemEmitter` if present
 * - Calls `req.metrics?.setAgentId(agentId)` if present
 * - Calls `req.policy?.setIdentity(identity)` if present
 *
 * @param {object}          req
 * @param {ResolvedIdentity} identity
 */
export function enrichRequest(req, identity) {
  req.identity = identity;
  req.agent_id = identity.agent_id;

  // SIEM integration — emit auth event
  if (req.siemEmitter?.emit) {
    req.siemEmitter.emit('identity:resolved', {
      ts: new Date().toISOString(),
      event: 'identity.resolved',
      agent_id: identity.agent_id,
      method: identity.method,
      verified: identity.verified,
      session_id: identity.session_id,
      fingerprint: identity.fingerprint,
      req_id: req.req_id ?? null,
      path: req.url,
      remote: req.socket?.remoteAddress ?? null,
    });
  }

  // Metrics integration
  if (typeof req.metrics?.setAgentId === 'function') {
    req.metrics.setAgentId(identity.agent_id);
  }

  // Policy integration
  if (typeof req.policy?.setIdentity === 'function') {
    req.policy.setIdentity(identity);
  }
}

// ─── middleware factory ───────────────────────────────────────────────────────

/**
 * @typedef {object} IdentityMiddlewareConfig
 * @property {AgentRegistry} registry          - Loaded agent registry.
 * @property {boolean} [require_agent_id=false] - Reject anonymous requests with 403.
 * @property {boolean} [log_auth=true]          - Write auth events to stderr.
 * @property {object}  [logger]                 - Optional logger with .info()/.warn() methods.
 */

/**
 * Create an Express-style identity middleware.
 *
 * The returned function:
 *   1. Calls `extractIdentity(req, registry)`
 *   2. Calls `enrichRequest(req, identity)`
 *   3. If `require_agent_id` is true and the result is anonymous → 403
 *   4. Otherwise calls `next()`
 *
 * @param {IdentityMiddlewareConfig} options
 * @returns {(req: object, res: object, next: Function) => Promise<void>}
 *
 * @example
 * import { loadAgentRegistry, identityMiddleware } from './identity/capauth.mjs';
 * const registry = loadAgentRegistry(config);
 * app.use(identityMiddleware({ registry, require_agent_id: false }));
 */
export function identityMiddleware(options = {}) {
  const {
    registry,
    require_agent_id = false,
    log_auth = true,
    logger = null,
  } = options;

  if (!registry) throw new Error('identityMiddleware: registry is required');

  const log = (level, msg, data) => {
    if (logger && typeof logger[level] === 'function') {
      logger[level](msg, data);
    } else if (log_auth) {
      process.stderr.write(
        `[skgateway:identity] ${level.toUpperCase()} ${msg} ${JSON.stringify(data)}\n`
      );
    }
  };

  return async function identityMiddlewareFn(req, res, next) {
    let identity;
    try {
      identity = await extractIdentity(req, registry);
    } catch (err) {
      log('warn', 'identity extraction error', { error: err.message, url: req.url });
      identity = {
        agent_id: ANONYMOUS_AGENT_ID,
        verified: false,
        method: 'anonymous',
        session_id: req.headers?.['x-session-id'] ?? null,
        fingerprint: null,
        agent: registry.defaultAgent,
      };
    }

    enrichRequest(req, identity);

    // Auth event logging
    log('info', 'auth', {
      agent_id: identity.agent_id,
      method: identity.method,
      verified: identity.verified,
      path: req.url,
      session_id: identity.session_id,
    });

    // Enforce require_agent_id
    if (require_agent_id && identity.method === 'anonymous') {
      log('warn', 'anonymous request rejected', {
        path: req.url,
        remote: req.socket?.remoteAddress,
      });
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'Agent identity required. Provide X-Agent-Id, X-CapAuth-Signature, or Authorization: Bearer.',
          code: 'identity_required',
          status: 403,
        },
      }));
      return;
    }

    next();
  };
}

// ─── convenience re-exports ───────────────────────────────────────────────────

export { ANONYMOUS_AGENT_ID, BUILTIN_AGENTS, TIMESTAMP_SKEW_S };
