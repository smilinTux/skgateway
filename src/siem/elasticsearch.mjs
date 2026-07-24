/**
 * elasticsearch.mjs - Elasticsearch / OpenSearch Bulk Output for SKGateway SIEM
 *
 * Responsibilities
 * ────────────────
 * 1. Bulk Indexing  - buffer {@link module:siem/events.GatewayEvent} objects and
 *                     ship them to an Elasticsearch or OpenSearch cluster via the
 *                     `_bulk` API. Both engines speak the identical NDJSON bulk
 *                     protocol, so a single adapter serves both.
 * 2. Batching       - flush whenever the buffer reaches `batch_size` events
 *                     (default 100) OR every `flush_ms` milliseconds
 *                     (default 5000), whichever comes first.
 * 3. Fail-Safe      - a network error, a non-2xx response, or a per-item reject
 *                     never throws into the caller and never blocks the request
 *                     hot path. Failures are logged to stderr and the batch is
 *                     dropped (bounded buffer already protects memory). Writes are
 *                     fire-and-forget; a bounded buffer drops the oldest events
 *                     once `max_buffer` is exceeded.
 * 4. Config-Driven  - endpoint URL + index name + optional auth are all supplied
 *                     by config. Auth material is referenced by ENV-VAR NAME, never
 *                     by literal value, so no secret is ever committed or logged.
 * 5. Disabled by default - an adapter with `enabled: false`, or missing an
 *                     endpoint URL, is a safe no-op. The gateway ships ES OFF.
 *
 * Index / document shape
 * ──────────────────────
 * Each event becomes one document. The action line targets `index` (a static
 * name, or a date-templated name when `index` contains a `%DATE%` token, e.g.
 * `skgateway-siem-%DATE%` → `skgateway-siem-2026.07.24`). The document is the
 * raw GatewayEvent plus an `@timestamp` field (copied from `event.timestamp`) so
 * Kibana / OpenSearch Dashboards time-based index patterns work out of the box.
 *
 * Usage
 * ─────
 *   import { createElasticsearchOutput } from './siem/elasticsearch.mjs';
 *
 *   const out = createElasticsearchOutput({
 *     enabled:      true,
 *     endpoint:     'https://es.internal:9200',
 *     index:        'skgateway-siem-%DATE%',
 *     api_key_env:  'SKGATEWAY_ES_API_KEY',   // ENV-VAR NAME, not the key itself
 *     batch_size:   100,
 *     flush_ms:     5000,
 *   });
 *   bus.addOutput(out);        // or call out.write(event) directly
 *
 * @module siem/elasticsearch
 */

// ─── constants ────────────────────────────────────────────────────────────────

/** Flush once this many events are buffered. */
const DEFAULT_BATCH_SIZE = 100;

/** Flush at least this often (ms) even if the batch is not full. */
const DEFAULT_FLUSH_MS = 5_000;

/** Hard cap on buffered events; oldest are dropped past this to bound memory. */
const DEFAULT_MAX_BUFFER = 10_000;

/** Per-request network timeout for a `_bulk` POST (ms). */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Default index name when none is configured. */
const DEFAULT_INDEX = 'skgateway-siem-%DATE%';

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Resolve the concrete index name for an event, expanding a `%DATE%` token to
 * the event's UTC date (`YYYY.MM.DD`, the Elastic/OpenSearch daily convention).
 *
 * @param {string} template   Index name, optionally containing `%DATE%`.
 * @param {object} event      The gateway event (uses event.timestamp).
 * @returns {string}
 */
export function resolveIndexName(template, event) {
  if (!template.includes('%DATE%')) return template;
  const ts = event && event.timestamp ? new Date(event.timestamp) : new Date();
  const d = Number.isNaN(ts.getTime()) ? new Date() : ts;
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
  return template.replace(/%DATE%/g, date);
}

/**
 * Build the NDJSON `_bulk` request body for a batch of events. Every event
 * produces two lines: an action line (`{ "index": { "_index": "…" } }`) and the
 * source document line. The body ends with a trailing newline as the bulk API
 * requires.
 *
 * @param {object[]} events    Events to serialise.
 * @param {string}   indexTpl  Index name template (may contain `%DATE%`).
 * @returns {string}  NDJSON payload.
 */
export function buildBulkBody(events, indexTpl) {
  const lines = [];
  for (const ev of events) {
    const index = resolveIndexName(indexTpl, ev);
    // Set _id to event_id so retries are idempotent (no duplicate documents).
    const action = ev && ev.event_id
      ? { index: { _index: index, _id: ev.event_id } }
      : { index: { _index: index } };
    lines.push(JSON.stringify(action));
    // Copy in an @timestamp for time-based index patterns without mutating the
    // caller's object.
    const doc = ev && ev.timestamp && ev['@timestamp'] === undefined
      ? { '@timestamp': ev.timestamp, ...ev }
      : ev;
    lines.push(JSON.stringify(doc));
  }
  return lines.join('\n') + '\n';
}

/**
 * Resolve the Authorization / api-key header from config. Auth is referenced by
 * ENV-VAR NAME only - the literal secret is read from `process.env` at runtime
 * and never stored in config or logs.
 *
 *   - `api_key_env`      → `Authorization: ApiKey <value>`   (Elasticsearch API key)
 *   - `bearer_token_env` → `Authorization: Bearer <value>`   (OpenSearch/JWT)
 *   - `auth_header_env`  → `Authorization: <value>`          (raw, e.g. "Basic …")
 *   - `username` + `password_env` → HTTP Basic (password read from the named env
 *                                   var; the username is not a secret)
 *
 * @param {object} config
 * @param {Record<string,string|undefined>} [env=process.env]
 * @returns {Record<string,string>}  Headers to merge (may be empty).
 */
export function resolveAuthHeaders(config, env = process.env) {
  const headers = {};
  if (config.api_key_env && env[config.api_key_env]) {
    headers.Authorization = `ApiKey ${env[config.api_key_env]}`;
  } else if (config.bearer_token_env && env[config.bearer_token_env]) {
    headers.Authorization = `Bearer ${env[config.bearer_token_env]}`;
  } else if (config.auth_header_env && env[config.auth_header_env]) {
    headers.Authorization = env[config.auth_header_env];
  } else if (config.username && config.password_env && env[config.password_env]) {
    const basic = Buffer.from(`${config.username}:${env[config.password_env]}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  }
  return headers;
}

// ─── adapter factory ────────────────────────────────────────────────────────────

/**
 * @typedef {object} ElasticsearchOutputConfig
 * @property {boolean} [enabled=false]     Master switch. Disabled → no-op adapter.
 * @property {string}  [endpoint]          Cluster base URL, e.g. https://es:9200 (required to enable).
 * @property {string}  [url]               Alias for `endpoint`.
 * @property {string}  [index]             Index name; may contain %DATE% (default skgateway-siem-%DATE%).
 * @property {number}  [batch_size=100]    Flush when this many events are buffered.
 * @property {number}  [flush_ms=5000]     Flush at least this often (ms).
 * @property {number}  [flush_interval_ms] Alias for `flush_ms`.
 * @property {number}  [max_buffer=10000]  Drop oldest events past this many buffered.
 * @property {number}  [timeout_ms=10000]  Per-request `_bulk` POST timeout (ms).
 * @property {string}  [api_key_env]       ENV-VAR NAME holding an ES API key (→ `ApiKey …`).
 * @property {string}  [bearer_token_env]  ENV-VAR NAME holding a bearer token (→ `Bearer …`).
 * @property {string}  [auth_header_env]   ENV-VAR NAME holding a raw Authorization value.
 * @property {string}  [username]          HTTP Basic username (paired with password_env).
 * @property {string}  [password_env]      ENV-VAR NAME holding the HTTP Basic password.
 * @property {boolean} [reject_unauthorized] Reserved for future TLS pinning (unused here).
 */

/**
 * @typedef {object} ElasticsearchOutput
 * @property {(event: object) => void} write  Buffer one event (fire-and-forget).
 * @property {() => Promise<void>}     flush   Ship all buffered events now.
 * @property {() => Promise<void>}     close   Flush + stop the timer.
 * @property {boolean}                 enabled Whether this adapter is live.
 */

/**
 * Create an Elasticsearch / OpenSearch `_bulk` output adapter. When disabled or
 * missing an endpoint, a no-op adapter is returned so callers need no
 * conditional wiring.
 *
 * @param {ElasticsearchOutputConfig} [config]
 * @param {object} [deps]                Injectable dependencies (for tests).
 * @param {typeof fetch} [deps.fetch]    HTTP client (defaults to global fetch).
 * @returns {ElasticsearchOutput}
 */
export function createElasticsearchOutput(config = {}, deps = {}) {
  const enabled = config.enabled === true;
  const rawEndpoint = config.endpoint ?? config.url;
  const endpoint = typeof rawEndpoint === 'string' ? rawEndpoint.replace(/\/+$/, '') : '';

  // ── disabled / misconfigured → no-op ─────────────────────────────────────
  if (!enabled || !endpoint) {
    return {
      write: () => {},
      flush: async () => {},
      close: async () => {},
      enabled: false,
    };
  }

  const httpFetch  = deps.fetch ?? globalThis.fetch;
  const indexTpl   = config.index ?? DEFAULT_INDEX;
  const batchSize  = config.batch_size ?? DEFAULT_BATCH_SIZE;
  const flushMs    = config.flush_ms ?? config.flush_interval_ms ?? DEFAULT_FLUSH_MS;
  const maxBuffer  = config.max_buffer ?? DEFAULT_MAX_BUFFER;
  const timeoutMs  = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const bulkUrl    = `${endpoint}/_bulk`;

  /** @type {object[]} events awaiting a bulk ship */
  const buffer = [];
  let closed = false;

  /** Serialise ships so batches never overlap on one adapter. */
  let chain = Promise.resolve();

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;

  function startTimer() {
    if (timer || closed) return;
    timer = setInterval(() => {
      if (buffer.length > 0) schedule(shipOnce);
    }, flushMs);
    timer.unref?.();
  }

  /**
   * Ship one batch (up to `batchSize` events) to `_bulk`. Fail-safe: any error
   * is logged and the batch is dropped. Never throws.
   *
   * @returns {Promise<void>}
   */
  async function shipOnce() {
    if (buffer.length === 0) return;
    const batch = buffer.splice(0, batchSize);
    let body;
    try {
      body = buildBulkBody(batch, indexTpl);
    } catch (err) {
      process.stderr.write(`[skgateway:siem:es] serialise error: ${err.message}\n`);
      return;
    }

    const headers = {
      'content-type': 'application/x-ndjson',
      ...resolveAuthHeaders(config),
    };

    try {
      const res = await httpFetch(bulkUrl, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res || !res.ok) {
        const status = res ? res.status : 'no-response';
        let snippet = '';
        try { snippet = (await res.text()).slice(0, 200); } catch { /* ignore */ }
        process.stderr.write(`[skgateway:siem:es] bulk POST ${status}: ${snippet}\n`);
        return; // drop batch, do not retry-forever or block
      }
      // Surface per-item failures for observability without failing the write.
      try {
        const parsed = await res.json();
        if (parsed && parsed.errors) {
          const failed = Array.isArray(parsed.items)
            ? parsed.items.filter((it) => {
                const r = it && (it.index || it.create || it.update);
                return r && r.status >= 300;
              }).length
            : 0;
          if (failed > 0) {
            process.stderr.write(`[skgateway:siem:es] bulk had ${failed} rejected item(s)\n`);
          }
        }
      } catch { /* body already consumed or not JSON - ignore */ }
    } catch (err) {
      // Network failure, timeout, DNS, TLS - must never break the gateway.
      process.stderr.write(`[skgateway:siem:es] bulk ship failed: ${err.message}\n`);
    }
  }

  /**
   * Enqueue work on the serialised chain. Errors are swallowed so one bad ship
   * never poisons the chain.
   *
   * @param {() => Promise<void>} work
   * @returns {Promise<void>}
   */
  function schedule(work) {
    chain = chain.then(work).catch((err) => {
      process.stderr.write(`[skgateway:siem:es] ship error: ${err.message}\n`);
    });
    return chain;
  }

  return {
    enabled: true,

    write(event) {
      if (closed) return;
      if (buffer.length >= maxBuffer) {
        buffer.shift(); // drop oldest to bound memory
        process.stderr.write('[skgateway:siem:es] buffer full - dropped oldest event\n');
      }
      buffer.push(event);
      startTimer();
      if (buffer.length >= batchSize) schedule(shipOnce);
    },

    async flush() {
      // Drain everything currently buffered (may be more than one batch).
      while (buffer.length > 0 && !closed) {
        await schedule(shipOnce);
      }
      await chain;
    },

    async close() {
      if (closed) return;
      closed = true;
      if (timer) { clearInterval(timer); timer = null; }
      // Ship whatever remains, one batch at a time.
      while (buffer.length > 0) {
        // eslint-disable-next-line no-await-in-loop
        await schedule(shipOnce);
      }
      await chain;
    },
  };
}
