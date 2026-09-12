/**
 * connection-pool.mjs — Connection pooler with request queue for SKGateway
 *
 * NVIDIA NIM has a 20 concurrent request limit. This module enforces that
 * limit per capacity domain (or per backend when ungrouped), queues excess
 * requests, and exposes admission outcomes for monitoring.
 *
 * Architecture:
 *   ┌─────────────┐     ┌──────────────────┐     ┌─────────────┐
 *   │  Incoming   │────▶│   Connection     │────▶│  NVIDIA NIM │
 *   │  Request    │     │   Pool (max 20)  │     │  Backend    │
 *   └─────────────┘     └──────────────────┘     └─────────────┘
 *                              │
 *                              ▼
 *                       ┌───────────────┐
 *                       │ Request Queue │
 *                       │ (FIFO)        │
 *                       └───────────────┘
 *
 * Public API:
 *   pool.acquire(backendId)      → Promise<ticket> - wait for slot
 *   pool.release(ticket)         → return slot
 *   pool.getStats(backendId?)    → { active, queued, max }
 *   pool.getAllStats()           → Record<backendId, Stats>
 *
 * Usage:
 *   const slot = await pool.acquire("nvidia");
 *   try {
 *     const res = await sendUpstream(...);
 *     return res;
 *   } finally {
 *     pool.release(slot);
 *   }
 */

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENT = 20;
const DEFAULT_MAX_QUEUE = 1000;
const DEFAULT_QUEUE_TIMEOUT_MS = 300_000; // 5 minutes max wait
let nextPoolInstanceId = 1;

/** Typed admission failure consumed by the router's structured retry path. */
export class PoolAdmissionError extends Error {
  constructor(code, capacityDomain, message, retryAfterSeconds, telemetry = {}) {
    super(message);
    this.name = "PoolAdmissionError";
    this.code = code;
    this.capacityDomain = capacityDomain;
    this.retryAfterSeconds = retryAfterSeconds;
    // Bounded, non-identifying admission facts for request telemetry. Keep
    // these on the typed error so callers never have to parse messages.
    this.queueWaitMs = telemetry.queueWaitMs ?? 0;
    this.inflightConcurrency = telemetry.inflightConcurrency ?? 0;
    this.admissionOutcome = telemetry.admissionOutcome ?? "denied";
  }
}

// ---------------------------------------------------------------------------
// Per-backend pool state
// ---------------------------------------------------------------------------

class PoolState {
  constructor(id, {
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    maxQueue = DEFAULT_MAX_QUEUE,
    queueTimeoutMs = DEFAULT_QUEUE_TIMEOUT_MS,
    members = [id],
  } = {}) {
    this.id = id;
    this.max = Math.max(1, maxConcurrent);
    this.maxQueue = Math.max(0, maxQueue);
    this.queueTimeoutMs = Math.max(1, queueTimeoutMs);
    this.members = [...members];

    /** Active in-flight requests */
    this.active = 0;

    /** Queued requests waiting for a slot */
    /** @type {Array<{promote: Function, enqueuedAt: number}>} */
    this.queue = [];

    /** Total requests ever processed (metrics) */
    this.totalProcessed = 0;

    /** Total dropped due to full queue (metrics) */
    this.totalDropped = 0;
    this.totalDeferred = 0;

    /** Total waiters rejected when their domain queue SLA expired */
    this.totalTimedOut = 0;

    /** Total queued waiters removed on downstream cancellation */
    this.totalCancelled = 0;

    /** Peak active connections ever reached */
    this.peakActive = 0;

    /** Peak queue depth ever reached */
    this.peakQueue = 0;
  }
}

// ---------------------------------------------------------------------------
// Pool manager
// ---------------------------------------------------------------------------

export class ConnectionPool {
  /**
   * @param {object} [config]
   * @param {number} [config.defaultMaxConcurrent=20]    Default max concurrent per backend
   * @param {number} [config.defaultMaxQueue=1000]         Default max queue depth per backend
   * @param {number} [config.queueTimeoutMs=300000]        Max time a request waits in queue
   * @param {object} [config.perBackend]                   Per-backend overrides: { [id]: { max, maxQueue, queueTimeoutMs } }
   * @param {object} [config.capacityDomains]              Shared domains: { [id]: { members, max, maxQueue, queueTimeoutMs } }
   */
  constructor(config = {}) {
    this._defaultMax = config.defaultMaxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this._defaultMaxQueue = config.defaultMaxQueue ?? DEFAULT_MAX_QUEUE;
    this._queueTimeoutMs = config.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;

    /** @type {Map<string, PoolState>} */
    this._pools = new Map();

    /**
     * Issued slot tickets. Weak object-identity ownership makes tickets
     * unforgeable across pool instances and lets released tickets be collected.
     * @type {WeakMap<object, PoolState>}
     */
    this._issuedTickets = new WeakMap();
    this._poolInstanceId = nextPoolInstanceId++;
    this._nextTicketId = 1;

    /** Per-backend overrides from config */
    this._overrides = config.perBackend || {};

    /** Explicit aliases which consume one physical service's shared capacity. */
    this._capacityDomains = config.capacityDomains || {};
    this._memberDomains = new Map();
    for (const [domainId, domain] of Object.entries(this._capacityDomains)) {
      const members = [...new Set([domainId, ...(domain.members || [])])];
      for (const member of members) {
        const existing = this._memberDomains.get(member);
        if (existing && existing !== domainId) {
          throw new Error(
            `[connection-pool] member=${member} belongs to both ${existing} and ${domainId}`
          );
        }
        this._memberDomains.set(member, domainId);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  _domainId(id) {
    return this._memberDomains.get(id) || id;
  }

  _settings(id) {
    const domainId = this._domainId(id);
    const domain = this._capacityDomains[domainId];
    const override = domain || this._overrides[id] || {};
    const members = domain
      ? [...new Set([domainId, ...(domain.members || [])])]
      : [id];
    return {
      domainId,
      maxConcurrent: override.max ?? this._defaultMax,
      maxQueue: override.maxQueue ?? this._defaultMaxQueue,
      queueTimeoutMs: override.queueTimeoutMs ?? this._queueTimeoutMs,
      members,
    };
  }

  _getOrCreate(id) {
    const settings = this._settings(id);
    if (!this._pools.has(settings.domainId)) {
      this._pools.set(settings.domainId, new PoolState(settings.domainId, settings));
    }
    return this._pools.get(settings.domainId);
  }

  _issueTicket(state, backendId, enqueuedAt = null, inflightConcurrency = state.active) {
    const acquiredAt = Date.now();
    const ticket = Object.freeze({
      id: state.id,
      backendId,
      acquiredAt,
      ticketId: `${this._poolInstanceId}:${state.id}:${this._nextTicketId++}`,
      queueWaitMs: enqueuedAt === null
        ? 0
        : Math.min(state.queueTimeoutMs, Math.max(0, acquiredAt - enqueuedAt)),
      inflightConcurrency: Math.min(state.max, Math.max(1, inflightConcurrency)),
      admissionOutcome: "admitted",
    });
    this._issuedTickets.set(ticket, state);
    return ticket;
  }

  // -----------------------------------------------------------------------
  // Core API
  // -----------------------------------------------------------------------

  /**
   * Acquire a connection slot for the given backend.
   * If the pool is at capacity, this resolves when a slot becomes available.
   *
   * @param {string} backendId
   * @param {{signal?:AbortSignal|null}} [options]
   * @returns {Promise<{id: string, backendId: string, acquiredAt: number, ticketId: string}>}
   *   Resolves with a ticket that MUST be passed to release().
   *   Rejects if the queue is full or the wait times out.
   */
  acquire(backendId, { signal = null, nonBlocking = false } = {}) {
    const state = this._getOrCreate(backendId);
    const retryAfterSeconds = Math.max(1, Math.ceil(state.queueTimeoutMs / 1000));

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        state.totalCancelled++;
        reject(new PoolAdmissionError(
          "client_closed",
          state.id,
          `[connection-pool] backend=${backendId} client disconnected before admission`,
          retryAfterSeconds,
          {
            queueWaitMs: 0,
            inflightConcurrency: Math.min(state.max, Math.max(0, state.active)),
            admissionOutcome: "cancelled",
          },
        ));
        return;
      }

      // Fast path: slot available right now
      if (state.active < state.max) {
        state.active++;
        state.totalProcessed++;
        if (state.active > state.peakActive) state.peakActive = state.active;
        resolve(this._issueTicket(state, backendId));
        return;
      }

      // Slow path: the door is full.
      //
      // Non-blocking admission (card f5c7022b). The caller still has another
      // candidate to try, so a full door must fail IMMEDIATELY rather than
      // queue. Queueing here is precisely what made the PR94 failover
      // unreachable: with the production maxQueue of 24 the primary enqueued
      // the request and it waited out queueTimeoutMs, so the code that picks
      // the next candidate never ran. The original PR94 tests passed only
      // because they used maxQueue: 0, the single configuration in which the
      // defect cannot appear.
      //
      // This is deliberately NOT counted as a drop. A deferral that fails over
      // successfully is a served request, and folding it into totalDropped
      // would make the drop metric report healthy failovers as losses.
      if (nonBlocking) {
        state.totalDeferred++;
        reject(new PoolAdmissionError(
          "capacity_exceeded",
          state.id,
          `[connection-pool] domain=${state.id} at capacity ` +
            `(${state.active}/${state.max}); deferred to the next candidate ` +
            `without queueing.`,
          retryAfterSeconds,
          {
            queueWaitMs: 0,
            inflightConcurrency: Math.min(state.max, Math.max(0, state.active)),
            admissionOutcome: "denied",
          },
        ));
        return;
      }

      // maxQueue=0 means fail fast. It must never mean "disable the cap".
      if (state.queue.length >= state.maxQueue) {
        state.totalDropped++;
        reject(new PoolAdmissionError(
          "capacity_exceeded",
          state.id,
          `[connection-pool] domain=${state.id} queue full ` +
            `(${state.queue.length}/${state.maxQueue}). Request dropped.`,
          retryAfterSeconds,
          {
            queueWaitMs: 0,
            inflightConcurrency: Math.min(state.max, Math.max(0, state.active)),
            admissionOutcome: "denied",
          },
        ));
        return;
      }

      // Enqueue the waiter
      let settled = false;
      let timer = null;
      let onAbort = null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        timer = null;
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      };
      const remove = (waiter) => {
        const idx = state.queue.indexOf(waiter);
        if (idx < 0) return false;
        state.queue.splice(idx, 1);
        return true;
      };
      const waiter = {
        promote: () => {
          if (settled) return false;
          settled = true;
          cleanup();
          state.totalProcessed++;
          resolve(this._issueTicket(state, backendId, waiter.enqueuedAt, state.active + 1));
          return true;
        },
        enqueuedAt: Date.now(),
      };
      state.queue.push(waiter);
      if (state.queue.length > state.peakQueue) state.peakQueue = state.queue.length;

      // Timeout guard
      timer = setTimeout(() => {
        if (!settled && remove(waiter)) {
          settled = true;
          cleanup();
          state.totalTimedOut++;
          reject(new PoolAdmissionError(
            "queue_timeout",
            state.id,
            `[connection-pool] domain=${state.id} queue timeout after ` +
              `${state.queueTimeoutMs}ms`,
            retryAfterSeconds,
            {
              queueWaitMs: state.queueTimeoutMs,
              inflightConcurrency: Math.min(state.max, Math.max(0, state.active)),
              admissionOutcome: "timeout",
            },
          ));
        }
      }, state.queueTimeoutMs);

      onAbort = () => {
        if (!settled && remove(waiter)) {
          settled = true;
          cleanup();
          state.totalCancelled++;
          reject(new PoolAdmissionError(
            "client_closed",
            state.id,
            `[connection-pool] backend=${backendId} client disconnected while queued`,
            retryAfterSeconds,
            {
              queueWaitMs: Math.min(
                state.queueTimeoutMs,
                Math.max(0, Date.now() - waiter.enqueuedAt),
              ),
              inflightConcurrency: Math.min(state.max, Math.max(0, state.active)),
              admissionOutcome: "cancelled",
            },
          ));
        }
      };
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        // Close the race between the initial check and listener registration.
        if (signal.aborted) onAbort();
      }

      // This is intentionally NOT logged per-request to avoid log spam.
      // Use getStats() to inspect the queue.
    });
  }

  /**
   * Release a previously-acquired slot.
   * If the queue has waiters, the oldest one is promoted immediately.
   *
   * A ticket is owned by this pool and may be released exactly once. Legacy
   * string ids, copied/forged objects, foreign tickets, and duplicates are
   * rejected without changing counters or promoting a waiter.
   *
   * @param {object} ticket
   * @returns {boolean} true only when this call released an owned active slot
   */
  release(ticket) {
    if (!ticket || typeof ticket !== "object") return false;
    const state = this._issuedTickets.get(ticket);
    if (!state) return false;

    // Consume ownership before mutating counters so a re-entrant/duplicate
    // release can never free the same slot twice.
    this._issuedTickets.delete(ticket);
    if (state.active <= 0) return false;
    state.active--;

    // Promote the next waiter from the queue
    while (state.queue.length > 0) {
      const waiter = state.queue.shift();
      if (state.active < state.max) {
        if (waiter.promote()) {
          state.active++;
          if (state.active > state.peakActive) state.peakActive = state.active;
          break; // Only one slot released
        }
      }
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // Stats / Monitoring
  // -----------------------------------------------------------------------

  /**
   * Get current stats for a specific backend pool.
   * @param {string} backendId
   * @returns {{ capacityDomain: string, members: string[], active: number, queued: number, max: number, maxQueue: number, queueTimeoutMs: number, totalProcessed: number, totalDropped: number, totalDeferred: number, totalTimedOut: number, totalCancelled: number, peakActive: number, peakQueue: number }}
   */
  getStats(backendId) {
    const settings = this._settings(backendId);
    const state = this._pools.get(settings.domainId);
    if (!state) {
      return {
        capacityDomain: settings.domainId,
        members: settings.members,
        active: 0,
        queued: 0,
        max: settings.maxConcurrent,
        maxQueue: settings.maxQueue,
        queueTimeoutMs: settings.queueTimeoutMs,
        totalProcessed: 0,
        totalDropped: 0,
        totalDeferred: 0,
        totalTimedOut: 0,
        totalCancelled: 0,
        peakActive: 0,
        peakQueue: 0,
      };
    }
    return {
      capacityDomain: state.id,
      members: [...state.members],
      active: state.active,
      queued: state.queue.length,
      max: state.max,
      maxQueue: state.maxQueue,
      queueTimeoutMs: state.queueTimeoutMs,
      totalProcessed: state.totalProcessed,
      totalDropped: state.totalDropped,
      totalDeferred: state.totalDeferred,
      totalTimedOut: state.totalTimedOut,
      totalCancelled: state.totalCancelled,
      peakActive: state.peakActive,
      peakQueue: state.peakQueue,
    };
  }

  /**
   * Get stats for all configured domains and runtime-created backend pools.
   * @returns {Record<string, ReturnType<ConnectionPool['getStats']>>}
   */
  getAllStats() {
    const out = {};
    // Configured domains are a bounded operator-owned set and should be
    // observable before first traffic. Runtime-only ungrouped pools join the
    // set only after a real acquire; arbitrary getStats() lookups never do.
    const domainIds = new Set([
      ...Object.keys(this._overrides).map((id) => this._domainId(id)),
      ...Object.keys(this._capacityDomains),
      ...this._pools.keys(),
    ]);
    for (const id of domainIds) {
      out[id] = this.getStats(id);
    }
    return out;
  }

  /**
   * Get total active + queued across all pools.
   * Useful for a single load metric.
   * @returns {{ totalActive: number, totalQueued: number, totalCapacity: number }}
   */
  getTotalStats() {
    let totalActive = 0;
    let totalQueued = 0;
    let totalCapacity = 0;
    for (const stats of Object.values(this.getAllStats())) {
      totalActive += stats.active;
      totalQueued += stats.queued;
      totalCapacity += stats.max;
    }
    return { totalActive, totalQueued, totalCapacity };
  }
}

// ---------------------------------------------------------------------------
// Singleton (for use in the gateway)
// ---------------------------------------------------------------------------

let _globalPool = null;

export function getPool(config) {
  if (!_globalPool) {
    _globalPool = new ConnectionPool(config);
  }
  return _globalPool;
}

export function resetPool() {
  _globalPool = null;
}
