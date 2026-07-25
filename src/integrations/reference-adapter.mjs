/**
 * reference-adapter.mjs - REFERENCE integration output adapter for SKGateway.
 *
 * Purpose
 * ───────
 * This is the canonical, minimal example of an SKGateway integration adapter.
 * Copy it as the starting point for a new integration (a webhook forwarder, a
 * message-bus publisher, an object-store archiver, and so on). It implements
 * the same `OutputAdapter` contract every SIEM output uses, so it can be
 * registered with the SIEM event bus (`bus.addOutput(...)`) or built through the
 * adapter registry (see `./registry.mjs`) with zero special-casing.
 *
 * The Contract (matches `src/siem/events.mjs` OutputAdapter)
 * ─────────────────────────────────────────────────────────
 *   {
 *     write(event)  : void            // buffer/forward one event; MUST NOT throw
 *     flush()       : Promise<void>   // force any buffered work to complete
 *     close()       : Promise<void>   // flush, then release resources
 *     enabled       : boolean         // false when disabled/misconfigured (no-op)
 *   }
 *
 * Contract rules every adapter MUST follow:
 *   1. Config-driven and DISABLED BY DEFAULT - return a no-op unless the caller
 *      opts in with `enabled: true` AND supplies whatever the adapter needs
 *      (endpoint, path, credentials env var, ...). The no-op still satisfies the
 *      full shape so callers never branch on `enabled`.
 *   2. `write()` is fire-and-forget and MUST be fail-safe - never throw, never
 *      reject the hot path. Log to stderr and drop on error.
 *   3. `flush()` / `close()` are idempotent and safe to call on a no-op adapter.
 *   4. No live URLs, hosts, or secrets in code - read endpoints/credentials from
 *      config and secrets from ENV-VAR NAMES (never inline literals).
 *
 * This reference implementation is intentionally a no-op / echo: when enabled it
 * records events into an in-memory ring (for tests / demos) and optionally
 * echoes a one-line summary to a `deps.sink` (defaults to stderr). It performs
 * NO network or disk I/O, so it is always safe to enable.
 *
 * Usage
 * ─────
 *   import { createReferenceOutput } from './integrations/reference-adapter.mjs';
 *
 *   const out = createReferenceOutput({ enabled: true, echo: true });
 *   bus.addOutput(out);                 // register with the SIEM event bus
 *   out.write(event);
 *   await out.flush();
 *   await out.close();
 *
 * @module integrations/reference-adapter
 */

/** Adapter type key used by the registry and in `config.siem.outputs[].type`. */
export const REFERENCE_TYPE = 'reference';

/** Default cap for the in-memory event ring (keeps the demo bounded). */
const DEFAULT_MAX_KEEP = 100;

/**
 * @typedef {object} ReferenceOutputConfig
 * @property {boolean} [enabled=false]   Opt-in switch. Disabled → no-op adapter.
 * @property {boolean} [echo=false]      When true, echo a one-line summary per event.
 * @property {number}  [max_keep=100]    Max events retained in the in-memory ring.
 * @property {string}  [label='reference'] Human label used in echo lines.
 */

/**
 * @typedef {object} ReferenceOutput
 * @property {(event: object) => void} write   Buffer one event (fail-safe, never throws).
 * @property {() => Promise<void>}     flush   No-op flush (contract completeness).
 * @property {() => Promise<void>}     close   Flush + release the in-memory ring.
 * @property {boolean}                 enabled Whether this adapter is live.
 * @property {() => object[]}          events  Snapshot of retained events (reference/test aid).
 * @property {() => number}            count   Total events accepted since creation.
 */

/**
 * Create the reference integration output adapter.
 *
 * When disabled or misconfigured a fully-shaped no-op is returned, so callers
 * need no conditional wiring - exactly like the SIEM file/syslog/elasticsearch
 * adapters.
 *
 * @param {ReferenceOutputConfig} [config]
 * @param {object} [deps]                        Injectable dependencies (for tests).
 * @param {(line: string) => void} [deps.sink]   Echo sink (defaults to stderr writer).
 * @returns {ReferenceOutput}
 */
export function createReferenceOutput(config = {}, deps = {}) {
  const enabled = config.enabled === true;

  // ── disabled / misconfigured → no-op (still satisfies the full contract) ──
  if (!enabled) {
    return {
      write: () => {},
      flush: async () => {},
      close: async () => {},
      enabled: false,
      events: () => [],
      count: () => 0,
    };
  }

  const echo    = config.echo === true;
  const maxKeep = Number.isInteger(config.max_keep) && config.max_keep > 0
    ? config.max_keep
    : DEFAULT_MAX_KEEP;
  const label   = typeof config.label === 'string' ? config.label : 'reference';
  const sink    = typeof deps.sink === 'function'
    ? deps.sink
    : (line) => process.stderr.write(line + '\n');

  /** @type {object[]} bounded in-memory ring of recent events */
  const ring = [];
  let total  = 0;
  let closed = false;

  /**
   * Buffer one event. Fail-safe: any error is caught and logged, never thrown,
   * so a bad event can never disrupt the gateway hot path.
   *
   * @param {object} event  Any serialisable gateway/SIEM event.
   */
  function write(event) {
    if (closed) return;
    try {
      ring.push(event);
      if (ring.length > maxKeep) ring.shift();
      total += 1;
      if (echo) {
        const type = event?.event_type ?? event?.event ?? 'event';
        const sev  = event?.severity ?? '';
        sink(`[skgateway:integration:${label}] ${type}${sev ? ' ' + sev : ''}`);
      }
    } catch (err) {
      process.stderr.write(
        `[skgateway:integration:${label}] write error: ${err.message}\n`,
      );
    }
  }

  /**
   * Force buffered work to complete. This reference adapter buffers only in
   * memory, so flush resolves immediately; a real adapter would drain its
   * network/disk queue here.
   *
   * @returns {Promise<void>}
   */
  async function flush() {
    // Nothing to drain for an in-memory reference; real adapters await I/O here.
  }

  /**
   * Flush, then release the in-memory ring. Idempotent.
   *
   * @returns {Promise<void>}
   */
  async function close() {
    if (closed) return;
    closed = true;
    await flush();
    ring.length = 0;
  }

  /**
   * Snapshot of retained events (a reference/test convenience; production
   * adapters would not expose their buffer).
   *
   * @returns {object[]}
   */
  function events() {
    return ring.slice();
  }

  /** Total events accepted since creation. @returns {number} */
  function count() {
    return total;
  }

  return { write, flush, close, enabled: true, events, count };
}
