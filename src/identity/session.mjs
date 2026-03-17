/**
 * session.mjs — Per-Agent Session Tracker for SKGateway
 *
 * Responsibilities
 * ────────────────
 * 1. Session Lifecycle  — create sessions on first contact, expire them on
 *    idle timeout (configurable, default 30 min).
 * 2. Session Metadata   — track start_time, request_count, token_total,
 *    last_active for each session.
 * 3. Per-Agent Indexing — fast lookup of all sessions belonging to one agent.
 * 4. Sweep Cleanup      — periodic GC removes expired sessions without
 *    accumulating unbounded memory.
 *
 * Sessions are keyed by `session_id` (from X-Session-Id header).  When no
 * session_id is provided, one is auto-generated per (agent_id, request_id)
 * pair and stored as `req.generated_session_id` by `track()`.
 *
 * Usage
 * ─────
 *   import { createSessionTracker } from './identity/session.mjs';
 *
 *   const sessions = createSessionTracker({ idle_timeout_ms: 30 * 60 * 1000 });
 *
 *   // In request handler:
 *   const session = sessions.track(req.agent_id, req.req_id, req.identity?.session_id);
 *   // … after response …
 *   sessions.recordUsage(session.session_id, { tokens: 1200 });
 *
 *   // Dashboard / metrics:
 *   const all    = sessions.getActive();
 *   const mine   = sessions.getSessions('lumina');
 *   const detail = sessions.getSession('sess_abc123');
 *
 * @module identity/session
 */

import { randomUUID } from 'node:crypto';

// ─── constants ────────────────────────────────────────────────────────────────

/** Default session idle timeout: 30 minutes. */
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** How often to sweep for expired sessions (1 minute). */
const SWEEP_INTERVAL_MS = 60_000;

// ─── JSDoc types ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} SessionRecord
 * @property {string}  session_id      - Unique session identifier (UUID or caller-supplied)
 * @property {string}  agent_id        - Owner agent name
 * @property {number}  start_time      - Unix ms when session was first seen
 * @property {number}  last_active     - Unix ms of most recent activity
 * @property {number}  request_count   - Total requests associated with this session
 * @property {number}  token_total     - Cumulative token usage for this session
 * @property {number}  input_tokens    - Cumulative input/prompt tokens
 * @property {number}  output_tokens   - Cumulative output/completion tokens
 * @property {boolean} active          - False once the session has been expired
 * @property {object}  [extra]         - Caller-supplied metadata bag
 */

/**
 * @typedef {object} UsageUpdate
 * @property {number} [tokens]          - Total tokens (used if input/output not provided)
 * @property {number} [input_tokens]    - Input/prompt tokens
 * @property {number} [output_tokens]   - Output/completion tokens
 * @property {object} [extra]           - Merge into session.extra
 */

/**
 * @typedef {object} SessionTracker
 * @property {(agentId: string, requestId?: string, sessionId?: string) => SessionRecord} track
 *   - Record activity for a session; creates the session if it doesn't exist.
 * @property {(sessionId: string, usage: UsageUpdate) => SessionRecord|null} recordUsage
 *   - Append token usage to an existing session.
 * @property {() => SessionRecord[]} getActive
 *   - Return all non-expired sessions across all agents.
 * @property {(agentId: string) => SessionRecord[]} getSessions
 *   - Return all non-expired sessions for a specific agent.
 * @property {(sessionId: string) => SessionRecord|null} getSession
 *   - Return a single session by ID (active or expired).
 * @property {() => object} getStats
 *   - Return aggregate statistics for the dashboard.
 * @property {() => void} close
 *   - Stop the sweep timer (call on shutdown).
 */

// ─── session tracker factory ──────────────────────────────────────────────────

/**
 * Create a new in-memory session tracker.
 *
 * @param {object} [config={}]
 * @param {number} [config.idle_timeout_ms=1800000]  Idle timeout in milliseconds.
 * @param {number} [config.max_sessions_per_agent=100]  Hard cap per agent (oldest evicted).
 * @param {number} [config.max_total_sessions=1000]     Global hard cap.
 * @param {boolean} [config.track_expired=true]  Keep expired sessions in memory for audit.
 * @param {number} [config.expire_prune_after_ms=3600000]  Purge expired sessions after 1h.
 * @returns {SessionTracker}
 */
export function createSessionTracker(config = {}) {
  const {
    idle_timeout_ms       = DEFAULT_IDLE_TIMEOUT_MS,
    max_sessions_per_agent = 100,
    max_total_sessions    = 1000,
    track_expired         = true,
    expire_prune_after_ms = 60 * 60 * 1000,
  } = config;

  /** @type {Map<string, SessionRecord>} session_id → record */
  const _sessions = new Map();

  /** @type {Map<string, Set<string>>} agent_id → Set of session_ids */
  const _byAgent = new Map();

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * Generate a session ID with a human-readable prefix for easier log tracing.
   * @param {string} agentId
   * @returns {string}  e.g. "sess_lumina_a3f2c1d0"
   */
  function _genId(agentId) {
    const short = randomUUID().replace(/-/g, '').slice(0, 8);
    const slug   = (agentId ?? 'unknown').replace(/[^a-z0-9]/g, '').slice(0, 12);
    return `sess_${slug}_${short}`;
  }

  /**
   * Register a session record in both indexes.
   * @param {SessionRecord} record
   */
  function _register(record) {
    _sessions.set(record.session_id, record);
    if (!_byAgent.has(record.agent_id)) _byAgent.set(record.agent_id, new Set());
    _byAgent.get(record.agent_id).add(record.session_id);
  }

  /**
   * Evict the oldest session for an agent if the per-agent cap is exceeded.
   * @param {string} agentId
   */
  function _evictOldestForAgent(agentId) {
    const ids = _byAgent.get(agentId);
    if (!ids || ids.size < max_sessions_per_agent) return;

    let oldest = null;
    let oldestTs = Infinity;
    for (const id of ids) {
      const s = _sessions.get(id);
      if (s && s.start_time < oldestTs) { oldest = id; oldestTs = s.start_time; }
    }
    if (oldest) {
      _sessions.delete(oldest);
      ids.delete(oldest);
    }
  }

  /**
   * Evict the oldest session globally if the total cap is exceeded.
   */
  function _evictOldestGlobal() {
    if (_sessions.size < max_total_sessions) return;
    let oldest = null;
    let oldestTs = Infinity;
    for (const [id, s] of _sessions) {
      if (s.start_time < oldestTs) { oldest = id; oldestTs = s.start_time; }
    }
    if (oldest) {
      const s = _sessions.get(oldest);
      if (s) _byAgent.get(s.agent_id)?.delete(oldest);
      _sessions.delete(oldest);
    }
  }

  // ── sweep ──────────────────────────────────────────────────────────────────

  /**
   * Expire sessions that have been idle longer than `idle_timeout_ms`.
   * Optionally prune expired sessions older than `expire_prune_after_ms`.
   */
  function _sweep() {
    const now = Date.now();
    for (const [id, record] of _sessions) {
      if (!record.active) {
        // Prune old expired sessions
        if (!track_expired || (now - record.last_active) > expire_prune_after_ms) {
          _byAgent.get(record.agent_id)?.delete(id);
          _sessions.delete(id);
        }
        continue;
      }
      if (now - record.last_active > idle_timeout_ms) {
        record.active = false;
      }
    }
  }

  const _sweepTimer = setInterval(_sweep, SWEEP_INTERVAL_MS);
  // Do not prevent process exit
  if (_sweepTimer.unref) _sweepTimer.unref();

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * Record activity for a session.  Creates the session if it does not exist.
   *
   * @param {string}      agentId    - Owning agent (e.g. "lumina")
   * @param {string}      [requestId] - Optional request correlation ID
   * @param {string|null} [sessionId] - Existing session ID (from X-Session-Id header).
   *                                    If null or unknown, a new session is created.
   * @returns {SessionRecord}  The updated (or newly created) session record.
   */
  function track(agentId, requestId = null, sessionId = null) {
    const now = Date.now();
    const normalizedAgent = (agentId ?? 'anonymous').toLowerCase();

    // Look up existing session
    if (sessionId && _sessions.has(sessionId)) {
      const record = _sessions.get(sessionId);
      // Revive if it was expired (session reuse after brief idle is valid)
      record.active       = true;
      record.last_active  = now;
      record.request_count++;
      return record;
    }

    // Create a new session
    _evictOldestForAgent(normalizedAgent);
    _evictOldestGlobal();

    const newId = sessionId ?? _genId(normalizedAgent);
    /** @type {SessionRecord} */
    const record = {
      session_id:    newId,
      agent_id:      normalizedAgent,
      start_time:    now,
      last_active:   now,
      request_count: 1,
      token_total:   0,
      input_tokens:  0,
      output_tokens: 0,
      active:        true,
      extra:         {},
    };

    _register(record);
    return record;
  }

  /**
   * Append token usage to an existing session.
   *
   * @param {string}      sessionId
   * @param {UsageUpdate} usage
   * @returns {SessionRecord|null}  Updated record, or null if not found.
   */
  function recordUsage(sessionId, usage = {}) {
    const record = _sessions.get(sessionId);
    if (!record) return null;

    const inputT  = usage.input_tokens  ?? 0;
    const outputT = usage.output_tokens ?? 0;
    const totalT  = usage.tokens        ?? (inputT + outputT);

    record.input_tokens  += inputT;
    record.output_tokens += outputT;
    record.token_total   += totalT || (inputT + outputT);
    record.last_active    = Date.now();

    if (usage.extra && typeof usage.extra === 'object') {
      Object.assign(record.extra, usage.extra);
    }

    return record;
  }

  /**
   * Return all active (non-expired) sessions across all agents.
   *
   * @returns {SessionRecord[]}  Snapshot array, sorted newest-active first.
   */
  function getActive() {
    return [..._sessions.values()]
      .filter(s => s.active)
      .sort((a, b) => b.last_active - a.last_active);
  }

  /**
   * Return all active sessions for a specific agent.
   *
   * @param {string} agentId
   * @returns {SessionRecord[]}
   */
  function getSessions(agentId) {
    const normalizedAgent = (agentId ?? '').toLowerCase();
    const ids = _byAgent.get(normalizedAgent);
    if (!ids) return [];
    return [...ids]
      .map(id => _sessions.get(id))
      .filter(s => s && s.active)
      .sort((a, b) => b.last_active - a.last_active);
  }

  /**
   * Return a single session by ID (active or expired — useful for auditing).
   *
   * @param {string} sessionId
   * @returns {SessionRecord|null}
   */
  function getSession(sessionId) {
    return _sessions.get(sessionId) ?? null;
  }

  /**
   * Return aggregate statistics suitable for the SKGateway dashboard.
   *
   * @returns {{
   *   active_count: number,
   *   total_count: number,
   *   agents: Record<string, { active: number, total_requests: number, total_tokens: number }>,
   *   global_tokens: number,
   *   global_requests: number,
   * }}
   */
  function getStats() {
    let globalTokens   = 0;
    let globalRequests = 0;
    let activeCount    = 0;

    /** @type {Record<string, { active: number, total_requests: number, total_tokens: number }>} */
    const agents = {};

    for (const record of _sessions.values()) {
      globalTokens   += record.token_total;
      globalRequests += record.request_count;
      if (record.active) activeCount++;

      if (!agents[record.agent_id]) {
        agents[record.agent_id] = { active: 0, total_requests: 0, total_tokens: 0 };
      }
      const a = agents[record.agent_id];
      if (record.active) a.active++;
      a.total_requests += record.request_count;
      a.total_tokens   += record.token_total;
    }

    return {
      active_count:    activeCount,
      total_count:     _sessions.size,
      agents,
      global_tokens:   globalTokens,
      global_requests: globalRequests,
    };
  }

  /**
   * Stop the background sweep timer.  Call this during graceful shutdown.
   */
  function close() {
    clearInterval(_sweepTimer);
  }

  return { track, recordUsage, getActive, getSessions, getSession, getStats, close };
}
