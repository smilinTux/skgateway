/**
 * syslog.mjs — RFC 5424 Syslog Output Adapter for SKGateway SIEM
 *
 * Responsibilities
 * ────────────────
 * 1. RFC 5424 Formatting — `formatRFC5424(event, opts)` renders any
 *    {@link module:siem/events.GatewayEvent} as a syntactically-correct
 *    RFC 5424 syslog message:
 *
 *      <PRI>VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP
 *           MSGID SP STRUCTURED-DATA SP MSG
 *
 *    - PRI            = facility*8 + severity  (RFC 5424 §6.2.1)
 *    - VERSION        = 1
 *    - TIMESTAMP      = event.timestamp (RFC 3339, already ISO-8601 UTC)
 *    - HOSTNAME       = os.hostname()  (or configured override)
 *    - APP-NAME       = "skgateway"
 *    - PROCID         = process pid
 *    - MSGID          = event_type (e.g. "request", "policy_violation")
 *    - STRUCTURED-DATA= [skgateway@<PEN> event_id="…" agent_id="…" …] (or "-")
 *    - MSG            = CEF or JSON rendering of the event (optional UTF-8 BOM)
 *
 * 2. Transports — `createSyslogOutput(config)` returns an EventBus-compatible
 *    `OutputAdapter` ({ write, flush, close }) that ships each formatted message
 *    over one of:
 *      - udp   : one datagram per event (RFC 5426)
 *      - tcp   : octet-counting or LF framing (RFC 6587)
 *      - tls   : TLS-wrapped TCP (RFC 5425)
 *      - unix  : stream unix socket (e.g. a syslog daemon listening on a path)
 *
 * 3. Disabled by default — an adapter with `enabled: false` (or missing host for
 *    a network transport) is a safe no-op. The gateway ships syslog OFF.
 *
 * Usage
 * ─────
 *   import { createSyslogOutput, formatRFC5424 } from './siem/syslog.mjs';
 *
 *   const out = createSyslogOutput({
 *     enabled:  true,
 *     host:     'syslog.internal',
 *     port:     514,
 *     protocol: 'udp',     // udp | tcp | tls | unix
 *     format:   'cef',     // cef | json
 *     facility: 16,        // 16 = local0
 *   });
 *   bus.addOutput(out);
 *
 * @module siem/syslog
 */

import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

import { formatCEF, Severity } from './events.mjs';

// ─── constants ──────────────────────────────────────────────────────────────

/** SYSLOG-VERSION per RFC 5424. */
const SYSLOG_VERSION = 1;

/** APP-NAME embedded in every message (RFC 5424 limits to 48 printable chars). */
const APP_NAME = 'skgateway';

/**
 * Private Enterprise Number for the STRUCTURED-DATA SD-ID.
 * 32473 is IANA-reserved for documentation/experimental use (RFC 5612), so it
 * is a safe default until SKWorld registers its own PEN. Override via
 * `opts.enterpriseId`.
 */
const DEFAULT_PEN = 32473;

/** Default facility: 16 = local0 (RFC 5424 §6.2.1). */
const DEFAULT_FACILITY = 16;

/** Default UDP/TCP syslog port. */
const DEFAULT_PORT = 514;

/**
 * Map SKGateway string severity → RFC 5424 numeric severity (0 = most severe).
 *   0 Emergency  1 Alert   2 Critical  3 Error
 *   4 Warning    5 Notice  6 Info      7 Debug
 * @type {Record<string, number>}
 */
const SEVERITY_MAP = {
  [Severity.CRITICAL]: 2,
  [Severity.ERROR]:    3,
  [Severity.WARNING]:  4,
  [Severity.INFO]:     6,
};

/** Fallback when a severity string is unrecognised → Informational. */
const DEFAULT_SEVERITY_LEVEL = 6;

/** UTF-8 byte-order mark — RFC 5424 §6.4 flags a UTF-8 MSG with a leading BOM. */
const UTF8_BOM = '﻿';

/** RFC 5424 NILVALUE. */
const NIL = '-';

// ─── formatter ────────────────────────────────────────────────────────────────

/**
 * Sanitise a field to the RFC 5424 PRINTUSASCII grammar used by HEADER fields
 * (HOSTNAME, APP-NAME, PROCID, MSGID). ASCII 33-126, no spaces; truncated to
 * `max`; empty → NILVALUE.
 *
 * @param {unknown} val
 * @param {number}  max
 * @returns {string}
 */
function headerField(val, max) {
  if (val === null || val === undefined) return NIL;
  const s = String(val)
    .replace(/[^\x21-\x7e]/g, '') // strip spaces + non-printable + non-ASCII
    .slice(0, max);
  return s.length ? s : NIL;
}

/**
 * Escape an SD-PARAM value per RFC 5424 §6.3.3: `"`, `\`, and `]` are escaped
 * with a backslash.
 *
 * @param {unknown} val
 * @returns {string}
 */
function sdEscape(val) {
  return String(val ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\]/g, '\\]');
}

/**
 * Resolve the RFC 5424 numeric severity for an event.
 * @param {string} severity  One of {@link Severity}.
 * @returns {number} 0-7
 */
export function severityToLevel(severity) {
  return SEVERITY_MAP[severity] ?? DEFAULT_SEVERITY_LEVEL;
}

/**
 * Compute the RFC 5424 PRI value: `facility * 8 + severity`.
 * @param {number} facility  0-23
 * @param {number} level     0-7
 * @returns {number}
 */
export function computePri(facility, level) {
  const f = Number.isInteger(facility) && facility >= 0 && facility <= 23 ? facility : DEFAULT_FACILITY;
  const s = Number.isInteger(level) && level >= 0 && level <= 7 ? level : DEFAULT_SEVERITY_LEVEL;
  return f * 8 + s;
}

/**
 * Build the STRUCTURED-DATA element for an event, or NILVALUE when there is
 * nothing meaningful to attach.
 *
 * @param {object} event
 * @param {number} pen
 * @returns {string}
 */
function buildStructuredData(event, pen) {
  const params = [];
  const push = (k, v) => {
    if (v !== undefined && v !== null && v !== '') params.push(`${k}="${sdEscape(v)}"`);
  };
  push('event_id',  event.event_id);
  push('severity',  event.severity);
  push('agent_id',  event.agent_id);
  push('session_id', event.session_id);
  push('request_id', event.request_id);
  push('backend',   event.backend);
  push('model',     event.model);

  if (params.length === 0) return NIL;
  return `[${APP_NAME}@${pen} ${params.join(' ')}]`;
}

/**
 * Validate that a timestamp string looks like an RFC 3339 date-time; otherwise
 * synthesise one from `now`. RFC 5424 TIMESTAMP is a strict subset of RFC 3339.
 *
 * @param {unknown} ts
 * @returns {string}
 */
function normaliseTimestamp(ts) {
  if (typeof ts === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(ts)) {
    return ts;
  }
  return new Date().toISOString();
}

/**
 * @typedef {object} SyslogFormatOptions
 * @property {number}  [facility=16]        Syslog facility (0-23).
 * @property {string}  [format='cef']       MSG body format: 'cef' | 'json'.
 * @property {string}  [host]               HOSTNAME override (defaults to os.hostname()).
 * @property {number}  [enterpriseId=32473] Private Enterprise Number for SD-ID.
 * @property {boolean} [bom=true]           Prefix a UTF-8 BOM on the MSG.
 * @property {number}  [pid]                PROCID override (defaults to process.pid).
 * @property {boolean} [structuredData=true] Emit an SD element (else NILVALUE).
 */

/**
 * Render a gateway event as a single RFC 5424 syslog message (no trailing newline).
 *
 * @param {object} event               A {@link module:siem/events.GatewayEvent}.
 * @param {SyslogFormatOptions} [opts]
 * @returns {string}
 */
export function formatRFC5424(event, opts = {}) {
  const facility = opts.facility ?? DEFAULT_FACILITY;
  const format   = opts.format   ?? 'cef';
  const pen      = opts.enterpriseId ?? DEFAULT_PEN;
  const bom      = opts.bom !== false;
  const emitSD   = opts.structuredData !== false;

  const level = severityToLevel(event?.severity);
  const pri   = computePri(facility, level);

  const timestamp = normaliseTimestamp(event?.timestamp);
  const host      = headerField(opts.host ?? hostname(), 255);
  const appName   = headerField(APP_NAME, 48);
  const procId    = headerField(opts.pid ?? process.pid, 128);
  const msgId     = headerField(event?.event_type, 32);

  const sd = emitSD ? buildStructuredData(event ?? {}, pen) : NIL;

  let msg;
  if (format === 'json') {
    msg = JSON.stringify(event);
  } else {
    msg = formatCEF(event);
  }
  if (bom) msg = UTF8_BOM + msg;

  // HEADER: <PRI>VERSION SP TIMESTAMP SP HOSTNAME SP APP-NAME SP PROCID SP MSGID
  return `<${pri}>${SYSLOG_VERSION} ${timestamp} ${host} ${appName} ${procId} ${msgId} ${sd} ${msg}`;
}

// ─── transport framing ─────────────────────────────────────────────────────────

/**
 * Frame a message for a stream transport (TCP/TLS/unix).
 *   - 'octet' : RFC 6587 octet-counting  →  `<len> <msg>`
 *   - 'lf'    : RFC 6587 non-transparent →  `<msg>\n`
 *
 * @param {string} msg
 * @param {'octet'|'lf'} framing
 * @returns {Buffer}
 */
function frameStream(msg, framing) {
  if (framing === 'lf') {
    return Buffer.from(msg.replace(/\n/g, ' ') + '\n', 'utf8');
  }
  const body = Buffer.from(msg, 'utf8');
  return Buffer.concat([Buffer.from(`${body.length} `, 'utf8'), body]);
}

// ─── adapter factory ────────────────────────────────────────────────────────────

/**
 * @typedef {object} SyslogOutputConfig
 * @property {boolean} [enabled=false]      Master switch. Disabled → no-op adapter.
 * @property {string}  [host]               Syslog server host (required for udp/tcp/tls).
 * @property {number}  [port=514]           Syslog server port.
 * @property {string}  [protocol='udp']     'udp' | 'tcp' | 'tls' | 'unix'.
 * @property {string}  [path]               Unix socket path (protocol='unix').
 * @property {string}  [format='cef']       MSG body: 'cef' | 'json'.
 * @property {number}  [facility=16]        Syslog facility 0-23.
 * @property {string}  [framing='octet']    Stream framing: 'octet' | 'lf'.
 * @property {string}  [hostname]           HOSTNAME field override.
 * @property {number}  [enterprise_id]      Private Enterprise Number for SD-ID.
 * @property {boolean} [bom=true]           Prefix UTF-8 BOM on MSG.
 * @property {number}  [max_buffer=1000]    Max messages buffered while (re)connecting.
 * @property {object}  [tls]                TLS options { ca_file, cert_file, key_file, reject_unauthorized, servername }.
 */

/**
 * @typedef {object} SyslogOutput
 * @property {(event: object) => void} write  Format + ship one event (fire-and-forget).
 * @property {() => Promise<void>}     flush   Resolve once queued writes are handed to the socket.
 * @property {() => Promise<void>}     close   Flush + tear down the socket.
 * @property {boolean}                 enabled Whether this adapter is live.
 */

/**
 * Create a syslog output adapter. When disabled (or missing a target), a
 * no-op adapter is returned so callers need no conditional wiring.
 *
 * @param {SyslogOutputConfig} [config]
 * @returns {SyslogOutput}
 */
export function createSyslogOutput(config = {}) {
  const protocol = (config.protocol ?? 'udp').toLowerCase();
  const enabled  = config.enabled === true;

  // A network transport needs a host; unix needs a path.
  const hasTarget =
    protocol === 'unix' ? Boolean(config.path) : Boolean(config.host);

  // ── disabled / misconfigured → no-op ─────────────────────────────────────
  if (!enabled || !hasTarget) {
    return {
      write: () => {},
      flush: async () => {},
      close: async () => {},
      enabled: false,
    };
  }

  const host      = config.host;
  const port      = config.port ?? DEFAULT_PORT;
  const path      = config.path;
  const format    = config.format ?? 'cef';
  const facility  = config.facility ?? DEFAULT_FACILITY;
  const framing   = config.framing ?? 'octet';
  const maxBuffer = config.max_buffer ?? 1000;

  const fmtOpts = {
    facility,
    format,
    host: config.hostname,
    enterpriseId: config.enterprise_id,
    bom: config.bom,
  };

  // ── UDP transport ─────────────────────────────────────────────────────────
  if (protocol === 'udp') {
    const socket = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    socket.on('error', (err) => {
      process.stderr.write(`[skgateway:siem:syslog] udp error: ${err.message}\n`);
    });
    socket.unref?.();
    let closed = false;

    return {
      enabled: true,
      write(event) {
        if (closed) return;
        let buf;
        try {
          buf = Buffer.from(formatRFC5424(event, fmtOpts), 'utf8');
        } catch (err) {
          process.stderr.write(`[skgateway:siem:syslog] format error: ${err.message}\n`);
          return;
        }
        socket.send(buf, 0, buf.length, port, host, (err) => {
          if (err) process.stderr.write(`[skgateway:siem:syslog] udp send error: ${err.message}\n`);
        });
      },
      async flush() { /* datagrams are handed straight to the OS */ },
      async close() {
        if (closed) return;
        closed = true;
        await new Promise((res) => { try { socket.close(res); } catch { res(); } });
      },
    };
  }

  // ── stream transports (tcp / tls / unix) ──────────────────────────────────
  /** @type {import('node:net').Socket | import('node:tls').TLSSocket | null} */
  let socket = null;
  let connected = false;
  let connecting = false;
  let closed = false;
  /** @type {Buffer[]} pending frames awaiting an established connection */
  const pending = [];

  function tlsOptions() {
    const t = config.tls ?? {};
    const opts = {
      host,
      port,
      servername: t.servername ?? host,
      rejectUnauthorized: t.reject_unauthorized !== false,
    };
    if (t.ca_file)   opts.ca   = readFileSync(t.ca_file);
    if (t.cert_file) opts.cert = readFileSync(t.cert_file);
    if (t.key_file)  opts.key  = readFileSync(t.key_file);
    return opts;
  }

  function connect() {
    if (connecting || connected || closed) return;
    connecting = true;

    const onConnect = () => {
      connecting = false;
      connected = true;
      // Flush anything queued while we were dialling.
      const queued = pending.splice(0, pending.length);
      for (const frame of queued) {
        try { socket.write(frame); } catch { /* re-buffer on next tick via error handler */ }
      }
    };

    try {
      if (protocol === 'tls') {
        socket = tls.connect(tlsOptions(), onConnect);
      } else if (protocol === 'unix') {
        socket = net.createConnection({ path }, onConnect);
      } else {
        socket = net.createConnection({ host, port }, onConnect);
      }
    } catch (err) {
      connecting = false;
      process.stderr.write(`[skgateway:siem:syslog] connect error: ${err.message}\n`);
      return;
    }

    socket.setKeepAlive?.(true);
    socket.unref?.();

    socket.on('error', (err) => {
      process.stderr.write(`[skgateway:siem:syslog] ${protocol} error: ${err.message}\n`);
    });
    socket.on('close', () => {
      connected = false;
      connecting = false;
      socket = null;
      // Lazy reconnect happens on the next write().
    });
  }

  function enqueue(frame) {
    if (pending.length >= maxBuffer) {
      pending.shift(); // drop oldest to bound memory
      process.stderr.write('[skgateway:siem:syslog] buffer full — dropped oldest message\n');
    }
    pending.push(frame);
  }

  return {
    enabled: true,
    write(event) {
      if (closed) return;
      let frame;
      try {
        frame = frameStream(formatRFC5424(event, fmtOpts), framing);
      } catch (err) {
        process.stderr.write(`[skgateway:siem:syslog] format error: ${err.message}\n`);
        return;
      }
      if (connected && socket) {
        try {
          socket.write(frame);
          return;
        } catch {
          enqueue(frame);
        }
      } else {
        enqueue(frame);
        connect();
      }
    },
    async flush() {
      // Give an in-progress connection a brief chance to establish and drain.
      if (!connected && (connecting || pending.length)) connect();
      for (let i = 0; i < 50 && pending.length && !closed; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await this.flush();
      await new Promise((res) => {
        if (!socket) return res();
        try { socket.end(res); } catch { res(); }
      });
      socket = null;
    },
  };
}
