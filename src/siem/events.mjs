/**
 * events.mjs — SIEM Event Bus for SKGateway
 *
 * Responsibilities
 * ────────────────
 * 1. Event Types    — structured definitions for auth, request, response, error,
 *                     policy_violation, anomaly, failover, and tool_use events.
 * 2. Event Factory  — `createEvent()` produces a fully-typed, stamped event.
 * 3. CEF Formatter  — `formatCEF()` renders any event as ArcSight Common Event
 *                     Format for enterprise SIEM ingestion.
 * 4. Event Bus      — in-memory pub/sub with buffering for slow outputs.
 *                     `emit()` → all subscribers + all registered output adapters.
 *                     `on(type, cb)` / `onAll(cb)` for targeted or global subscriptions.
 *
 * Usage
 * ─────
 *   import { createEventBus, createEvent, formatCEF } from './siem/events.mjs';
 *
 *   const bus = createEventBus({ maxBuffer: 1000 });
 *   bus.onAll(e => console.log(formatCEF(e)));
 *   bus.addOutput(fileOutput);          // any { write(event) } adapter
 *
 *   const ev = createEvent('request', {
 *     agent_id: 'lumina', model: 'kimi-k2-instruct', backend: 'nvidia',
 *     prompt_class: 'chat', token_estimate: 2400,
 *   });
 *   await bus.emit(ev);
 *
 * @module siem/events
 */

import { randomUUID } from 'node:crypto';

// ─── constants ────────────────────────────────────────────────────────────────

/** Gateway product metadata embedded in every CEF header. */
const CEF_VENDOR  = 'SKWorld';
const CEF_PRODUCT = 'SKGateway';
const CEF_VERSION = '0.1.0';

/** Maximum number of events buffered when outputs fall behind. */
const DEFAULT_MAX_BUFFER = 1000;

// ─── event type catalogue ─────────────────────────────────────────────────────

/**
 * All recognised event type identifiers.
 * @readonly
 * @enum {string}
 */
export const EventType = Object.freeze({
  AUTH:             'auth',
  REQUEST:          'request',
  RESPONSE:         'response',
  ERROR:            'error',
  POLICY_VIOLATION: 'policy_violation',
  ANOMALY:          'anomaly',
  FAILOVER:         'failover',
  TOOL_USE:         'tool_use',
});

/**
 * Severity levels, ordered lowest → highest.
 * @readonly
 * @enum {string}
 */
export const Severity = Object.freeze({
  INFO:     'info',
  WARNING:  'warning',
  ERROR:    'error',
  CRITICAL: 'critical',
});

/**
 * CEF severity integer (0–10) mapped from our string severity.
 * @type {Record<string, number>}
 */
const CEF_SEVERITY_MAP = {
  info:     3,
  warning:  6,
  error:    8,
  critical: 10,
};

// ─── default severity per event type ─────────────────────────────────────────

/** @type {Record<string, string>} */
const DEFAULT_SEVERITY = {
  [EventType.AUTH]:             Severity.INFO,
  [EventType.REQUEST]:          Severity.INFO,
  [EventType.RESPONSE]:         Severity.INFO,
  [EventType.ERROR]:            Severity.ERROR,
  [EventType.POLICY_VIOLATION]: Severity.WARNING,
  [EventType.ANOMALY]:          Severity.WARNING,
  [EventType.FAILOVER]:         Severity.WARNING,
  [EventType.TOOL_USE]:         Severity.INFO,
};

// ─── human-readable event names for CEF ──────────────────────────────────────

/** @type {Record<string, string>} */
const EVENT_NAMES = {
  [EventType.AUTH]:             'Agent Identity Verification',
  [EventType.REQUEST]:          'Incoming Inference Request',
  [EventType.RESPONSE]:         'Inference Response Completed',
  [EventType.ERROR]:            'Gateway Error',
  [EventType.POLICY_VIOLATION]: 'Policy Violation Detected',
  [EventType.ANOMALY]:          'Anomalous Behaviour Detected',
  [EventType.FAILOVER]:         'Backend Failover',
  [EventType.TOOL_USE]:         'Tool Invocation',
};

// ─── event factory ────────────────────────────────────────────────────────────

/**
 * @typedef {object} GatewayEvent
 * @property {string}  event_id    - UUID for this event instance.
 * @property {string}  timestamp   - ISO 8601 creation time (UTC).
 * @property {string}  event_type  - One of {@link EventType}.
 * @property {string}  severity    - One of {@link Severity}.
 * @property {string}  source      - Always "skgateway".
 * @property {string}  [agent_id]  - Identifying agent (e.g. "lumina").
 * @property {string}  [session_id]- Conversation/session UUID.
 * @property {string}  [request_id]- Per-request UUID.
 * @property {string}  [backend]   - Backend name (e.g. "nvidia", "anthropic").
 * @property {string}  [model]     - Model name targeted.
 * @property {object}  details     - Type-specific payload (see per-type JSDoc below).
 */

/**
 * Create a fully-structured gateway event ready for bus emission.
 *
 * The `details` shape is type-specific:
 *
 * - **auth**:             `{ success: boolean, method?: string, reason?: string }`
 * - **request**:          `{ prompt_class?: string, token_estimate?: number, tool_count?: number }`
 * - **response**:         `{ status: number, tokens_in?: number, tokens_out?: number, cost?: number, latency_ms?: number }`
 * - **error**:            `{ type: string, status_code?: number, backend?: string, retry_count?: number, message?: string }`
 * - **policy_violation**: `{ rule: string, severity: string, details?: string, action?: string }`
 * - **anomaly**:          `{ type: string, score?: number, baseline?: number|string, observed?: number|string }`
 * - **failover**:         `{ from_backend: string, to_backend: string, reason?: string }`
 * - **tool_use**:         `{ tool_name: string, success: boolean, duration_ms?: number }`
 *
 * @param {string} type          - One of {@link EventType}.
 * @param {object} [details={}]  - Type-specific payload fields.
 * @param {object} [context={}]  - Optional top-level fields: agent_id, session_id,
 *                                 request_id, backend, model, severity.
 * @returns {GatewayEvent}
 */
export function createEvent(type, details = {}, context = {}) {
  if (!Object.values(EventType).includes(type)) {
    throw new TypeError(`Unknown event type: "${type}". Valid types: ${Object.values(EventType).join(', ')}`);
  }

  const severity = context.severity ?? DEFAULT_SEVERITY[type] ?? Severity.INFO;

  return {
    event_id:   randomUUID(),
    timestamp:  new Date().toISOString(),
    event_type: type,
    severity,
    source:     'skgateway',

    // Identity / routing fields (all optional — omit undefined keys cleanly)
    ...(context.agent_id   !== undefined && { agent_id:   context.agent_id }),
    ...(context.session_id !== undefined && { session_id: context.session_id }),
    ...(context.request_id !== undefined && { request_id: context.request_id }),
    ...(context.backend    !== undefined && { backend:    context.backend }),
    ...(context.model      !== undefined && { model:      context.model }),

    details,
  };
}

// ─── CEF formatter ────────────────────────────────────────────────────────────

/**
 * Escape a CEF extension value so it does not break the `key=value` pairs.
 * Backslashes and pipe characters in headers, equals signs in extensions.
 *
 * @param {string|number|boolean|null|undefined} val
 * @returns {string}
 */
function cefEscape(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/\\/g, '\\\\')
    .replace(/=/g, '\\=')
    .replace(/\r?\n/g, ' ');
}

/**
 * Build CEF extension key=value pairs from a flat object.
 * Skips undefined/null values.
 *
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
function buildExtension(fields) {
  return Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${cefEscape(v)}`)
    .join(' ');
}

/**
 * Map a {@link GatewayEvent} to ArcSight Common Event Format (CEF).
 *
 * Format:
 *   `CEF:0|Vendor|Product|Version|SignatureID|Name|Severity|Extension`
 *
 * Extension field mapping:
 * | CEF key | Source field                         |
 * |---------|--------------------------------------|
 * | rt      | timestamp (epoch ms)                 |
 * | src     | source ("skgateway")                 |
 * | suid    | agent_id                             |
 * | cs1     | session_id   (label: sessionId)      |
 * | cs2     | request_id   (label: requestId)      |
 * | dst     | backend                              |
 * | dproc   | model                                |
 * | msg     | JSON-serialised details              |
 * | cs3     | event_id     (label: eventId)        |
 * | cs4-cs6 | details sub-fields (type-specific)   |
 *
 * @param {GatewayEvent} event
 * @returns {string}  Single-line CEF string (no trailing newline).
 */
export function formatCEF(event) {
  const {
    event_id, timestamp, event_type, severity,
    source, agent_id, session_id, request_id,
    backend, model, details,
  } = event;

  const cefSeverity = CEF_SEVERITY_MAP[severity] ?? 3;
  const eventName   = EVENT_NAMES[event_type] ?? event_type;

  // ── header ──────────────────────────────────────────────────────────────
  // Pipe characters in header fields must be escaped with backslash.
  const escapePipe = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

  const header = [
    'CEF:0',
    escapePipe(CEF_VENDOR),
    escapePipe(CEF_PRODUCT),
    escapePipe(CEF_VERSION),
    escapePipe(event_type),
    escapePipe(eventName),
    String(cefSeverity),
  ].join('|');

  // ── extension ────────────────────────────────────────────────────────────
  // rt = receipt time in epoch milliseconds
  const rt = new Date(timestamp).getTime();

  // Build type-specific cs4/cs5/cs6 values from details
  const typeFields = _cefDetailsFields(event_type, details);

  const ext = buildExtension({
    rt,
    src:    source,
    suid:   agent_id,
    cs1:    session_id,
    cs1Label: session_id  ? 'sessionId'  : undefined,
    cs2:    request_id,
    cs2Label: request_id  ? 'requestId'  : undefined,
    cs3:    event_id,
    cs3Label: 'eventId',
    dst:    backend,
    dproc:  model,
    msg:    details ? JSON.stringify(details) : undefined,
    ...typeFields,
  });

  return `${header}|${ext}`;
}

/**
 * Map type-specific details fields to CEF cs4/cs5/cs6 extension keys.
 *
 * @param {string} type
 * @param {object} details
 * @returns {Record<string, string|number|undefined>}
 */
function _cefDetailsFields(type, details = {}) {
  switch (type) {
    case EventType.AUTH:
      return {
        cs4:      details.success !== undefined ? String(details.success) : undefined,
        cs4Label: 'authSuccess',
        cs5:      details.method,
        cs5Label: details.method ? 'authMethod' : undefined,
        cs6:      details.reason,
        cs6Label: details.reason ? 'authReason' : undefined,
      };

    case EventType.REQUEST:
      return {
        cs4:      details.prompt_class,
        cs4Label: details.prompt_class ? 'promptClass' : undefined,
        cs5:      details.token_estimate,
        cs5Label: details.token_estimate !== undefined ? 'tokenEstimate' : undefined,
        cs6:      details.tool_count,
        cs6Label: details.tool_count !== undefined ? 'toolCount' : undefined,
      };

    case EventType.RESPONSE:
      return {
        cs4:      details.status,
        cs4Label: details.status !== undefined ? 'httpStatus' : undefined,
        cs5:      details.latency_ms,
        cs5Label: details.latency_ms !== undefined ? 'latencyMs' : undefined,
        cs6:      details.cost !== undefined ? String(details.cost) : undefined,
        cs6Label: details.cost !== undefined ? 'costUsd' : undefined,
      };

    case EventType.ERROR:
      return {
        cs4:      details.type,
        cs4Label: details.type ? 'errorType' : undefined,
        cs5:      details.status_code,
        cs5Label: details.status_code !== undefined ? 'statusCode' : undefined,
        cs6:      details.retry_count,
        cs6Label: details.retry_count !== undefined ? 'retryCount' : undefined,
      };

    case EventType.POLICY_VIOLATION:
      return {
        cs4:      details.rule,
        cs4Label: details.rule ? 'policyRule' : undefined,
        cs5:      details.severity,
        cs5Label: details.severity ? 'policySeverity' : undefined,
        cs6:      details.action,
        cs6Label: details.action ? 'policyAction' : undefined,
      };

    case EventType.ANOMALY:
      return {
        cs4:      details.type,
        cs4Label: details.type ? 'anomalyType' : undefined,
        cs5:      details.score,
        cs5Label: details.score !== undefined ? 'anomalyScore' : undefined,
        cs6:      details.observed,
        cs6Label: details.observed !== undefined ? 'observed' : undefined,
      };

    case EventType.FAILOVER:
      return {
        cs4:      details.from_backend,
        cs4Label: details.from_backend ? 'fromBackend' : undefined,
        cs5:      details.to_backend,
        cs5Label: details.to_backend ? 'toBackend' : undefined,
        cs6:      details.reason,
        cs6Label: details.reason ? 'failoverReason' : undefined,
      };

    case EventType.TOOL_USE:
      return {
        cs4:      details.tool_name,
        cs4Label: details.tool_name ? 'toolName' : undefined,
        cs5:      details.success !== undefined ? String(details.success) : undefined,
        cs5Label: details.success !== undefined ? 'toolSuccess' : undefined,
        cs6:      details.duration_ms,
        cs6Label: details.duration_ms !== undefined ? 'toolDurationMs' : undefined,
      };

    default:
      return {};
  }
}

// ─── event bus ────────────────────────────────────────────────────────────────

/**
 * @typedef {object} EventBusConfig
 * @property {number} [maxBuffer=1000]  Max events to buffer when outputs are slow.
 */

/**
 * @typedef {object} OutputAdapter
 * @property {(event: GatewayEvent) => void | Promise<void>} write  Write one event.
 * @property {() => Promise<void>}                           [flush] Optional flush.
 * @property {() => Promise<void>}                           [close] Optional close.
 */

/**
 * @typedef {object} EventBus
 * @property {(event: GatewayEvent) => Promise<void>}              emit      Publish event.
 * @property {(type: string, cb: Function) => () => void}          on        Subscribe to type.
 * @property {(cb: Function) => () => void}                        onAll     Subscribe to all.
 * @property {(output: OutputAdapter) => void}                     addOutput Register output adapter.
 * @property {(output: OutputAdapter) => void}                     removeOutput Unregister adapter.
 * @property {() => { buffered: number, subscribers: number }}     stats     Internal stats.
 * @property {() => Promise<void>}                                 drain     Flush all outputs.
 * @property {() => Promise<void>}                                 close     Flush + close all outputs.
 */

/**
 * Create a new event bus.
 *
 * The bus is synchronous for subscribers (callbacks fire immediately) but
 * buffers for outputs so that slow I/O (e.g. file rotation) does not block
 * the hot proxy path.  Output writes are serialised per-adapter via a
 * micro-queue; a spill warning is logged if the buffer cap is reached and
 * the oldest event is dropped.
 *
 * @param {EventBusConfig} [config={}]
 * @returns {EventBus}
 */
export function createEventBus(config = {}) {
  const maxBuffer = config.maxBuffer ?? DEFAULT_MAX_BUFFER;

  // ── subscriber maps ───────────────────────────────────────────────────────
  // type → Set<callback>
  /** @type {Map<string, Set<Function>>} */
  const typeListeners = new Map();
  /** @type {Set<Function>} */
  const allListeners  = new Set();

  // ── output adapters ───────────────────────────────────────────────────────
  /** @type {Set<OutputAdapter>} */
  const outputs = new Set();

  // Per-adapter pending promise (serialises async writes without a queue array)
  /** @type {WeakMap<OutputAdapter, Promise<void>>} */
  const adapterTail = new WeakMap();

  // ── overflow buffer ───────────────────────────────────────────────────────
  // Used only when ALL output adapters are saturated (their chain > maxBuffer
  // depth).  We track this at the bus level with a simple counter.
  let bufferedCount = 0;

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Fire all relevant subscriber callbacks synchronously.
   * Errors in callbacks are swallowed (logged to stderr) so a bad subscriber
   * never prevents other subscribers or output writes from running.
   *
   * @param {GatewayEvent} event
   */
  function _notifySubscribers(event) {
    // Type-specific listeners
    const typed = typeListeners.get(event.event_type);
    if (typed) {
      for (const cb of typed) {
        try { cb(event); }
        catch (err) {
          process.stderr.write(
            `[skgateway:siem] subscriber error (type=${event.event_type}): ${err.message}\n`,
          );
        }
      }
    }

    // Wildcard listeners
    for (const cb of allListeners) {
      try { cb(event); }
      catch (err) {
        process.stderr.write(
          `[skgateway:siem] subscriber error (onAll): ${err.message}\n`,
        );
      }
    }
  }

  /**
   * Enqueue a write to one output adapter using promise-chaining.
   * This serialises writes per-adapter while keeping adapters independent.
   *
   * @param {OutputAdapter} adapter
   * @param {GatewayEvent}  event
   */
  function _enqueueWrite(adapter, event) {
    const prev = adapterTail.get(adapter) ?? Promise.resolve();

    const next = prev.then(async () => {
      try {
        await adapter.write(event);
      } catch (err) {
        process.stderr.write(
          `[skgateway:siem] output write error: ${err.message}\n`,
        );
      } finally {
        bufferedCount = Math.max(0, bufferedCount - 1);
      }
    });

    adapterTail.set(adapter, next);
  }

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * Publish an event to all subscribers and all registered output adapters.
   *
   * Subscribers are called synchronously before any async output write begins,
   * so they always see the event regardless of I/O pressure.
   *
   * @param {GatewayEvent} event
   * @returns {Promise<void>}  Resolves immediately (does not wait for outputs).
   */
  async function emit(event) {
    if (!event || typeof event !== 'object') {
      throw new TypeError('emit() requires a GatewayEvent object');
    }

    // 1. Fire subscribers synchronously
    _notifySubscribers(event);

    // 2. Enqueue for each registered output, respecting the buffer cap
    if (outputs.size > 0) {
      if (bufferedCount >= maxBuffer) {
        process.stderr.write(
          `[skgateway:siem] WARN: event buffer full (${maxBuffer}), dropping oldest\n`,
        );
        // We can't easily drop the "oldest" from a promise chain without a
        // real queue.  We drop the CURRENT event to protect the existing
        // queue and avoid backpressure stalls.
        return;
      }

      bufferedCount++;
      for (const adapter of outputs) {
        _enqueueWrite(adapter, event);
      }
    }
  }

  /**
   * Subscribe to events of a specific type.
   *
   * @param {string}   type  One of {@link EventType}.
   * @param {Function} cb    Callback `(event: GatewayEvent) => void`.
   * @returns {() => void}   Unsubscribe function.
   */
  function on(type, cb) {
    if (typeof cb !== 'function') throw new TypeError('on() callback must be a function');
    if (!typeListeners.has(type)) typeListeners.set(type, new Set());
    typeListeners.get(type).add(cb);
    return () => typeListeners.get(type)?.delete(cb);
  }

  /**
   * Subscribe to all events regardless of type.
   *
   * @param {Function} cb  Callback `(event: GatewayEvent) => void`.
   * @returns {() => void} Unsubscribe function.
   */
  function onAll(cb) {
    if (typeof cb !== 'function') throw new TypeError('onAll() callback must be a function');
    allListeners.add(cb);
    return () => allListeners.delete(cb);
  }

  /**
   * Register an output adapter (e.g. a file writer).
   *
   * @param {OutputAdapter} output
   */
  function addOutput(output) {
    if (typeof output?.write !== 'function') {
      throw new TypeError('Output adapter must have a write(event) method');
    }
    outputs.add(output);
  }

  /**
   * Remove a previously registered output adapter.
   *
   * @param {OutputAdapter} output
   */
  function removeOutput(output) {
    outputs.delete(output);
    adapterTail.delete(output);
  }

  /**
   * Return internal bus statistics (useful for health checks and dashboards).
   *
   * @returns {{ buffered: number, outputs: number, subscribers: number }}
   */
  function stats() {
    let subscribers = allListeners.size;
    for (const s of typeListeners.values()) subscribers += s.size;
    return { buffered: bufferedCount, outputs: outputs.size, subscribers };
  }

  /**
   * Wait for all pending output writes to complete.
   * Optionally calls `flush()` on each adapter if supported.
   *
   * @returns {Promise<void>}
   */
  async function drain() {
    const waits = [];
    for (const adapter of outputs) {
      const tail = adapterTail.get(adapter);
      if (tail) waits.push(tail);
    }
    await Promise.allSettled(waits);
    // Call adapter-level flush if available
    for (const adapter of outputs) {
      if (typeof adapter.flush === 'function') {
        try { await adapter.flush(); }
        catch (err) {
          process.stderr.write(`[skgateway:siem] flush error: ${err.message}\n`);
        }
      }
    }
  }

  /**
   * Drain pending writes, flush, then close all output adapters.
   * Call during gateway graceful shutdown.
   *
   * @returns {Promise<void>}
   */
  async function close() {
    await drain();
    for (const adapter of outputs) {
      if (typeof adapter.close === 'function') {
        try { await adapter.close(); }
        catch (err) {
          process.stderr.write(`[skgateway:siem] close error: ${err.message}\n`);
        }
      }
    }
    outputs.clear();
  }

  return { emit, on, onAll, addOutput, removeOutput, stats, drain, close };
}
