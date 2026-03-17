/**
 * dashboard/server.mjs — SOC Dashboard HTTP + WebSocket server for SKGateway
 *
 * Serves the static SOC dashboard UI on a separate port (default: 18781)
 * and provides REST API endpoints + WebSocket real-time push for live metrics.
 *
 * Architecture
 * ────────────
 * - Plain Node.js `http` server (no Express dependency)
 * - WebSocket implementation using raw HTTP upgrade + RFC 6455 framing
 * - All REST responses are JSON with CORS headers for local dev convenience
 * - WebSocket pushes a full `stats` payload every 5 seconds to all connected clients
 * - Static files are served from `src/dashboard/static/` with basic MIME types
 *
 * REST Endpoints
 * ──────────────
 *   GET /api/stats                         — live in-memory metrics snapshot
 *   GET /api/tokens?agent=X&period=1h      — token usage from SQLite
 *   GET /api/costs?period=24h             — cost breakdown from SQLite
 *   GET /api/events?type=X&limit=50       — recent SIEM events (in-memory ring)
 *   GET /api/health                        — backend health snapshots
 *   GET /api/agents                        — active agents + session counts
 *   GET /                                  — serves index.html
 *
 * WebSocket
 * ─────────
 *   ws://<host>:18781/ws
 *   Server pushes JSON frames every 5 s:
 *     { type: 'stats',  data: <stats>    }
 *     { type: 'event',  data: <siemEvent> }   — pushed immediately on new SIEM event
 *     { type: 'health', data: <health>   }
 *
 * @module dashboard/server
 */

import http from 'node:http';
import fs   from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ─── paths ────────────────────────────────────────────────────────────────────

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(__dirname, 'static');

// ─── constants ────────────────────────────────────────────────────────────────

const PUSH_INTERVAL_MS   = 5_000;   // how often to push stats to WebSocket clients
const MAX_SIEM_RING      = 200;     // max in-memory SIEM events
const CORS_HEADERS = {
  'access-control-allow-origin':  '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

// ─── MIME types ───────────────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
};

// ─── WebSocket RFC 6455 helpers ───────────────────────────────────────────────

/** Build a WebSocket accept token per RFC 6455 §4.2.2. */
function wsAccept(key) {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

/**
 * Encode a string or Buffer as a WebSocket data frame (text or binary).
 * Supports payloads up to 64 KiB using the 16-bit extended length field.
 *
 * @param {string|Buffer} payload
 * @param {0x1|0x2} [opcode=0x1]  0x1=text, 0x2=binary
 * @returns {Buffer}
 */
function wsFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  const len  = data.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    // For very large payloads use 8-byte extended length
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}

/**
 * Parse a masked client frame. Returns decoded payload string or null if incomplete.
 * Handles single-frame text messages only (sufficient for ping/pong and commands).
 *
 * @param {Buffer} buf
 * @returns {{ opcode: number, payload: string }|null}
 */
function wsParseFrame(buf) {
  if (buf.length < 2) return null;
  const fin    = (buf[0] & 0x80) !== 0;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len      = buf[1] & 0x7f;
  let offset   = 2;

  if (len === 126) {
    if (buf.length < 4) return null;
    len    = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len    = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }

  if (masked) {
    if (buf.length < offset + 4 + len) return null;
    const mask    = buf.slice(offset, offset + 4);
    offset       += 4;
    const decoded = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) decoded[i] = buf[offset + i] ^ mask[i % 4];
    return { opcode, payload: decoded.toString('utf8') };
  }
  if (buf.length < offset + len) return null;
  return { opcode, payload: buf.slice(offset, offset + len).toString('utf8') };
}

// ─── factory ──────────────────────────────────────────────────────────────────

/**
 * Create and start the dashboard HTTP server.
 *
 * @param {object} options
 * @param {number}  [options.port=18781]          Port to listen on
 * @param {string}  [options.bind='0.0.0.0']      Bind address
 * @param {object}  [options.metrics]             MetricsCollector instance (optional)
 * @param {object}  [options.router]              Router instance for health data (optional)
 * @param {object}  [options.config]              Full gateway config (optional)
 * @returns {{ server: http.Server, pushEvent: Function, close: Function }}
 */
export function createDashboardServer({ port = 18781, bind = '0.0.0.0', metrics, router, config } = {}) {

  // ── SIEM event ring buffer ───────────────────────────────────────────────
  /** @type {Array<{id:string, ts:number, type:string, severity:string, message:string, detail:object}>} */
  const siemRing = [];
  let   siemSeq  = 0;

  function addSiemEvent(evt) {
    siemSeq++;
    const entry = { id: `siem-${siemSeq}`, ts: Date.now(), ...evt };
    siemRing.push(entry);
    if (siemRing.length > MAX_SIEM_RING) siemRing.shift();
    // Push immediately to all WebSocket clients
    broadcastWs({ type: 'event', data: entry });
  }

  // ── Activity feed ring buffer ────────────────────────────────────────────
  /** @type {Array<object>} */
  const activityRing = [];
  let   activitySeq  = 0;

  function addActivity(entry) {
    activitySeq++;
    const rec = { id: `act-${activitySeq}`, ts: Date.now(), ...entry };
    activityRing.push(rec);
    if (activityRing.length > 50) activityRing.shift();
    broadcastWs({ type: 'activity', data: rec });
  }

  // ── WebSocket client set ─────────────────────────────────────────────────
  /** @type {Set<import('node:net').Socket>} */
  const wsClients = new Set();

  /** Send a JSON message to all connected WS clients. */
  function broadcastWs(obj) {
    const frame = wsFrame(JSON.stringify(obj));
    for (const sock of wsClients) {
      try { sock.write(frame); }
      catch { wsClients.delete(sock); }
    }
  }

  // ── periodic push ────────────────────────────────────────────────────────
  const pushTimer = setInterval(() => {
    if (wsClients.size === 0) return;
    try {
      const stats  = buildStats();
      const health = buildHealth();
      broadcastWs({ type: 'stats',  data: stats  });
      broadcastWs({ type: 'health', data: health });
    } catch { /* non-fatal */ }
  }, PUSH_INTERVAL_MS);
  pushTimer.unref();

  // ── helpers ───────────────────────────────────────────────────────────────

  /** Parse `?period=1h` → Unix ms lower bound */
  function periodToSince(period = '24h') {
    const m = String(period).match(/^(\d+)([hmds])$/);
    if (!m) return Date.now() - 86_400_000;
    const n = parseInt(m[1], 10);
    const mult = { h: 3_600_000, m: 60_000, d: 86_400_000, s: 1_000 }[m[2]] || 3_600_000;
    return Date.now() - n * mult;
  }

  /** Build a stats summary from MetricsCollector + static zeroes fallback. */
  function buildStats() {
    const base = metrics?.getStats?.() ?? {
      totalRequests:    0,
      activeRequests:   0,
      errorCount:       0,
      recentRequests5m: 0,
      recentErrors5m:   0,
      recentTokens5m:   0,
      totalInputTokens:  0,
      totalOutputTokens: 0,
      totalCostUsd:     0,
      activeSessions:   {},
      latency:          {},
    };
    return {
      ...base,
      uptime:       Math.round(process.uptime()),
      timestamp:    Date.now(),
    };
  }

  /** Build health snapshot from router + static fallback. */
  function buildHealth() {
    if (router?.getHealth) {
      const h = router.getHealth();
      // Attach model lists from config if available
      const backends = config?.backends || {};
      const out = {};
      for (const [id, snap] of Object.entries(h)) {
        out[id] = {
          ...snap,
          models: backends[id]?.models ?? [],
          url:    backends[id]?.url    ?? '',
        };
      }
      return out;
    }
    // Fallback — build from config
    const backends = config?.backends || {};
    const out = {};
    for (const [id, cfg] of Object.entries(backends)) {
      out[id] = {
        status:        'unknown',
        errorRate:     0,
        latencyP50:    0,
        totalRequests: 0,
        totalErrors:   0,
        models:        cfg.models ?? [],
        url:           cfg.url    ?? '',
      };
    }
    return out;
  }

  /** Parse query string into key→value map. */
  function parseQuery(urlStr) {
    try {
      const u = new URL(urlStr, 'http://x');
      const out = {};
      for (const [k, v] of u.searchParams) out[k] = v;
      return out;
    } catch { return {}; }
  }

  // ── JSON response helper ──────────────────────────────────────────────────
  function jsonOk(res, data) {
    const body = JSON.stringify(data);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...CORS_HEADERS });
    res.end(body);
  }

  function jsonErr(res, code, msg) {
    const body = JSON.stringify({ error: msg });
    res.writeHead(code, { 'content-type': 'application/json', ...CORS_HEADERS });
    res.end(body);
  }

  // ── static file serving ───────────────────────────────────────────────────
  function serveStatic(req, res) {
    let filePath = req.url.split('?')[0];
    if (filePath === '/' || filePath === '') filePath = '/index.html';
    const absPath = path.join(STATIC_DIR, filePath);

    // Security: ensure we stay within STATIC_DIR
    if (!absPath.startsWith(STATIC_DIR)) {
      jsonErr(res, 403, 'Forbidden');
      return;
    }

    fs.readFile(absPath, (err, data) => {
      if (err) {
        // Fallback to index.html for SPA routing
        fs.readFile(path.join(STATIC_DIR, 'index.html'), (err2, html) => {
          if (err2) { jsonErr(res, 404, 'Not found'); return; }
          res.writeHead(200, { 'content-type': MIME['.html'] });
          res.end(html);
        });
        return;
      }
      const ext  = path.extname(absPath).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-cache' });
      res.end(data);
    });
  }

  // ── HTTP request handler ──────────────────────────────────────────────────
  const server = http.createServer((req, res) => {
    const { method, url } = req;

    if (method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const pathname = url.split('?')[0];

    // ── REST API routes ────────────────────────────────────────────────────
    if (pathname === '/api/stats') {
      jsonOk(res, buildStats());
      return;
    }

    if (pathname === '/api/health') {
      jsonOk(res, buildHealth());
      return;
    }

    if (pathname === '/api/agents') {
      const stats    = buildStats();
      const sessions = stats.activeSessions ?? {};
      const agents   = Object.entries(sessions).map(([id, count]) => ({ id, activeSessions: count }));
      jsonOk(res, { agents, timestamp: Date.now() });
      return;
    }

    if (pathname === '/api/tokens') {
      if (!metrics) { jsonOk(res, { rows: [], message: 'metrics not enabled' }); return; }
      const q      = parseQuery(url);
      const since  = periodToSince(q.period || '1h');
      const rows   = metrics.getTokenUsage({ agentId: q.agent || undefined, since });
      jsonOk(res, { rows, since, period: q.period || '1h' });
      return;
    }

    if (pathname === '/api/costs') {
      if (!metrics) { jsonOk(res, { rows: [], message: 'metrics not enabled' }); return; }
      const q      = parseQuery(url);
      const since  = periodToSince(q.period || '24h');
      const rows   = metrics.getCosts({ since });
      jsonOk(res, { rows, since, period: q.period || '24h' });
      return;
    }

    if (pathname === '/api/events') {
      const q     = parseQuery(url);
      const limit = Math.min(parseInt(q.limit || '50', 10), 200);
      const type  = q.type;
      let   events = [...siemRing].reverse();
      if (type) events = events.filter(e => e.type === type);
      events = events.slice(0, limit);
      jsonOk(res, { events, total: siemRing.length });
      return;
    }

    if (pathname === '/api/activity') {
      const q     = parseQuery(url);
      const limit = Math.min(parseInt(q.limit || '50', 10), 50);
      jsonOk(res, { activity: [...activityRing].reverse().slice(0, limit) });
      return;
    }

    // ── Static files ───────────────────────────────────────────────────────
    serveStatic(req, res);
  });

  // ── WebSocket upgrade handler ─────────────────────────────────────────────
  server.on('upgrade', (req, sock, head) => {
    if (req.url !== '/ws') {
      sock.end('HTTP/1.1 404 Not Found\r\n\r\n');
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
      sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }

    sock.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n` +
      '\r\n'
    );

    wsClients.add(sock);

    // Send initial payload immediately
    try {
      sock.write(wsFrame(JSON.stringify({ type: 'init', data: {
        stats:  buildStats(),
        health: buildHealth(),
        events: [...siemRing].slice(-20).reverse(),
        activity: [...activityRing].slice(-20).reverse(),
      }})));
    } catch { /* non-fatal */ }

    let buf = Buffer.alloc(0);

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const frame = wsParseFrame(buf);
      if (!frame) return;
      buf = Buffer.alloc(0);

      if (frame.opcode === 0x8) { // close
        wsClients.delete(sock);
        sock.end();
        return;
      }
      if (frame.opcode === 0x9) { // ping → pong
        sock.write(wsFrame(frame.payload, 0xa));
        return;
      }
      // Ignore other opcodes for now
    });

    sock.on('close', () => wsClients.delete(sock));
    sock.on('error', () => wsClients.delete(sock));
  });

  // ── start ─────────────────────────────────────────────────────────────────
  server.listen(port, bind, () => {
    console.log(`[dashboard] SOC dashboard listening on http://${bind}:${port}`);
  });

  function close() {
    clearInterval(pushTimer);
    for (const sock of wsClients) { try { sock.destroy(); } catch {} }
    wsClients.clear();
    server.close();
  }

  return {
    server,
    /** Push a SIEM event to the ring buffer and all WS clients. */
    pushEvent: addSiemEvent,
    /** Push an activity feed entry to all WS clients. */
    pushActivity: addActivity,
    /** Send arbitrary JSON to all WS clients. */
    broadcast: broadcastWs,
    close,
  };
}
