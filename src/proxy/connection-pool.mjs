/**
 * connection-pool.mjs — Connection pooler with request queue for SKGateway
 *
 * NVIDIA NIM has a 20 concurrent request limit. This module enforces that
 * limit per-backend, queues excess requests, and exposes queue depth for
 * monitoring.
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
 *   pool.acquire(backendId)      → Promise<void> - wait for slot
 *   pool.release(backendId)      → return slot
 *   pool.getStats(backendId?)    → { active, queued, max }
 *   pool.getAllStats()           → Record<backendId, Stats>
 *
 * Usage:
 *   const slot = await pool.acquire("nvidia");
 *   try {
 *     const res = await sendUpstream(...);
 *     return res;
 *   } finally {
 *     pool.release("nvidia");
 *   }
 */

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENT = 20;
const DEFAULT_MAX_QUEUE = 1000;
const DEFAULT_QUEUE_TIMEOUT_MS = 300_000; // 5 minutes max wait

// ---------------------------------------------------------------------------
// Per-backend pool state
// ---------------------------------------------------------------------------

class PoolState {
  constructor(id, maxConcurrent = DEFAULT_MAX_CONCURRENT, maxQueue = DEFAULT_MAX_QUEUE) {
    this.id = id;
    this.max = Math.max(1, maxConcurrent);
    this.maxQueue = Math.max(0, maxQueue);

    /** Active in-flight requests */
    this.active = 0;

    /** Queued requests waiting for a slot */
    /** @type {Array<{resolve: Function, reject: Function, enqueuedAt: number}>} */
    this.queue = [];

    /** Total requests ever processed (metrics) */
    this.totalProcessed = 0;

    /** Total dropped due to full queue (metrics) */
    this.totalDropped = 0;

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
   * @param {object} [config.perBackend]                   Per-backend overrides: { [id]: { max, maxQueue } }
   */
  constructor(config = {}) {
    this._defaultMax = config.defaultMaxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this._defaultMaxQueue = config.defaultMaxQueue ?? DEFAULT_MAX_QUEUE;
    this._queueTimeoutMs = config.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;

    /** @type {Map<string, PoolState>} */
    this._pools = new Map();

    /** Per-backend overrides from config */
    this._overrides = config.perBackend || {};
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  _getOrCreate(id) {
    if (!this._pools.has(id)) {
      const ov = this._overrides[id] || {};
      this._pools.set(id, new PoolState(
        id,
        ov.max ?? this._defaultMax,
        ov.maxQueue ?? this._defaultMaxQueue
      ));
    }
    return this._pools.get(id);
  }

  // -----------------------------------------------------------------------
  // Core API
  // -----------------------------------------------------------------------

  /**
   * Acquire a connection slot for the given backend.
   * If the pool is at capacity, this resolves when a slot becomes available.
   *
   * @param {string} backendId
   * @returns {Promise<{id: string, acquiredAt: number}>}
   *   Resolves with a ticket that MUST be passed to release().
   *   Rejects if the queue is full or the wait times out.
   */
  acquire(backendId) {
    const state = this._getOrCreate(backendId);

    return new Promise((resolve, reject) => {
      // Fast path: slot available right now
      if (state.active < state.max) {
        state.active++;
        state.totalProcessed++;
        if (state.active > state.peakActive) state.peakActive = state.active;
        resolve({ id: backendId, acquiredAt: Date.now() });
        return;
      }

      // Slow path: must queue
      if (state.maxQueue > 0 && state.queue.length >= state.maxQueue) {
        state.totalDropped++;
        reject(new Error(
          `[connection-pool] backend=${backendId} queue full (${state.queue.length}/${state.maxQueue}). Request dropped.`
        ));
        return;
      }

      // Enqueue the waiter
      const waiter = {
        resolve: (ticket) => {
          state.totalProcessed++;
          resolve(ticket);
        },
        reject,
        enqueuedAt: Date.now(),
      };
      state.queue.push(waiter);
      if (state.queue.length > state.peakQueue) state.peakQueue = state.queue.length;

      // Timeout guard
      setTimeout(() => {
        const idx = state.queue.indexOf(waiter);
        if (idx >= 0) {
          state.queue.splice(idx, 1);
          reject(new Error(
            `[connection-pool] backend=${backendId} queue timeout after ${this._queueTimeoutMs}ms`
          ));
        }
      }, this._queueTimeoutMs);

      // This is intentionally NOT logged per-request to avoid log spam.
      // Use getStats() to inspect the queue.
    });
  }

  /**
   * Release a previously-acquired slot.
   * If the queue has waiters, the oldest one is promoted immediately.
   *
   * @param {string} backendId
   */
  release(backendId) {
    const state = this._getOrCreate(backendId);

    if (state.active > 0) {
      state.active--;
    }

    // Promote the next waiter from the queue
    while (state.queue.length > 0) {
      const waiter = state.queue.shift();
      if (state.active < state.max) {
        state.active++;
        if (state.active > state.peakActive) state.peakActive = state.active;
        waiter.resolve({ id: backendId, acquiredAt: Date.now() });
        break; // Only one slot released
      }
    }
  }

  // -----------------------------------------------------------------------
  // Stats / Monitoring
  // -----------------------------------------------------------------------

  /**
   * Get current stats for a specific backend pool.
   * @param {string} backendId
   * @returns {{ active: number, queued: number, max: number, maxQueue: number, totalProcessed: number, totalDropped: number, peakActive: number, peakQueue: number }}
   */
  getStats(backendId) {
    const state = this._pools.get(backendId);
    if (!state) {
      return { active: 0, queued: 0, max: this._defaultMax, maxQueue: this._defaultMaxQueue,
        totalProcessed: 0, totalDropped: 0, peakActive: 0, peakQueue: 0 };
    }
    return {
      active: state.active,
      queued: state.queue.length,
      max: state.max,
      maxQueue: state.maxQueue,
      totalProcessed: state.totalProcessed,
      totalDropped: state.totalDropped,
      peakActive: state.peakActive,
      peakQueue: state.peakQueue,
    };
  }

  /**
   * Get stats for all registered backend pools.
   * @returns {Record<string, ReturnType<ConnectionPool['getStats']>>}
   */
  getAllStats() {
    const out = {};
    for (const [id] of this._pools) {
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
    for (const state of this._pools.values()) {
      totalActive += state.active;
      totalQueued += state.queue.length;
      totalCapacity += state.max;
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
