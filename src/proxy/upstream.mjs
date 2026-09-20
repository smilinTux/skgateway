/**
 * upstream.mjs - Upstream relay for SKGateway
 *
 * Provides `sendUpstream`, a thin HTTP/HTTPS relay that forwards a
 * buffered request body to an upstream API endpoint and returns the
 * full response as `{ status, headers, body }`. The caller is
 * responsible for all retry logic; this module is intentionally stateless.
 *
 * Design notes:
 *  - Always buffers the full response body before resolving.  The proxy
 *    layer forces `stream: false` on tool requests so this is safe.
 *  - Network errors resolve (not reject) with a synthetic 502 payload so
 *    the calling retry loop can handle them uniformly.
 *  - A wedged upstream that accepts the TCP connection but never replies
 *    would otherwise hang the request forever. An optional idle timeout
 *    (`timeoutMs`) converts that into a fast 504 so the router can fail
 *    over instead of blocking. Disabled (0) by default: current behavior.
 *  - `timeoutMs` is an IDLE timer and cannot bound total duration. Node resets
 *    `ClientRequest#setTimeout` on any socket activity, so an upstream that
 *    dribbles bytes, or a stalled SSE body emitting framing at any interval
 *    under the timeout, never trips it and hangs indefinitely. Measured
 *    2026-09-19: `kimi-for-coding` carried `timeout_ms: 30000` and hung past
 *    45s without ever resolving. Because the router records backend health
 *    only from a COMPLETED attempt, a request that never resolves never calls
 *    `recordOutcome()`, so that backend reported healthy at a 0% error rate
 *    for hours while every request to it wedged, and the fleet lane depending
 *    on it stalled behind a health surface insisting it was fine.
 *    `hardTimeoutMs` is therefore a true wall-clock ceiling: armed once at
 *    send time, never reset by activity. It is what makes a wedge OBSERVABLE,
 *    because the resulting 504 reaches `recordOutcome(false)`.
 *  - Hop-by-hop headers (`connection`, `keep-alive`) are stripped from
 *    proxied request headers to avoid confusing the upstream server.
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

// Pooled keep-alive agents so backend connections are REUSED across requests
// instead of a fresh TCP(+TLS) handshake per call (cuts ~tens of ms proxy tax).
const _agentOpts = { keepAlive: true, keepAliveMsecs: 30000, maxSockets: 64, maxFreeSockets: 16 };
const httpAgent = new http.Agent(_agentOpts);

// A backend that sets an idle timeout is asserting that a healthy reply
// arrives within this window. The wall-clock ceiling is that assertion times
// this multiplier, so a normal slow completion is never cut off while an
// upstream that has plainly wedged still terminates and becomes visible to
// health. Derived rather than passed per call site on purpose: the router
// reaches sendUpstream() from five places, and a ceiling that some call sites
// forget to pass is exactly the silent gap this exists to close. A backend
// with no idle timeout keeps the current unbounded behaviour, because giving
// it a ceiling is a config decision and not one to make on its behalf here.
const HARD_DEADLINE_MULTIPLIER = 3;
const httpsAgent = new https.Agent(_agentOpts);

// Matches a leading /v<digits> path segment, e.g. /v1/chat/completions -> /v1
const LEADING_VERSION_SEGMENT = /^\/v\d+(?=\/|$)/;

/**
 * Build the upstream request URL from an incoming request path and the
 * backend's configured base URL, preserving the base URL's full path.
 *
 * `new URL(reqPath, base)` cannot be used directly here: reqPath is an
 * ABSOLUTE path (e.g. `/v1/chat/completions`), and per the WHATWG URL spec
 * an absolute path resolved against a base discards any base path beyond
 * the origin. That happens to be harmless for a backend base URL whose
 * path is just `/v1` (NVIDIA), but silently drops any extra prefix on a
 * base like OpenRouter's `https://openrouter.ai/api/v1` (the `/api` is
 * lost, producing a 404).
 *
 * Instead, treat the base URL as the API root: append reqPath's pathname
 * to the base's pathname, first stripping reqPath's leading `/vN` segment
 * if the base's pathname already ends with that exact `/vN` segment (so
 * the version is not duplicated). The query string from reqUrl is always
 * preserved.
 *
 * @param {string} reqUrl - path+query as received by the proxy, e.g. `/v1/chat/completions`.
 * @param {URL} targetUrl - parsed base URL of the upstream backend, e.g. `https://openrouter.ai/api/v1`.
 * @returns {URL} the resolved upstream URL.
 */
export function buildUpstreamUrl(reqUrl, targetUrl) {
  // Parse reqUrl against the origin alone so we can pull apart its
  // pathname/search without the base's path interfering.
  const req = new URL(reqUrl, targetUrl.origin);

  const basePath = targetUrl.pathname.replace(/\/$/, ""); // strip trailing slash
  const versionMatch = req.pathname.match(LEADING_VERSION_SEGMENT);
  // Treat the client's /v1 as a logical API version. Providers may expose
  // the same OpenAI-compatible surface under another version, such as z.ai's
  // /api/coding/paas/v4. When the configured base already ends in /vN,
  // replace the client's leading version rather than producing /v4/v1/....
  const baseEndsWithVersion = versionMatch && /\/v\d+$/i.test(basePath);

  const reqPathToAppend = baseEndsWithVersion
    ? req.pathname.slice(versionMatch[0].length)
    : req.pathname;

  const upstream = new URL(targetUrl.origin);
  upstream.pathname = basePath + reqPathToAppend;
  upstream.search = req.search;
  return upstream;
}

/**
 * Forward one HTTP request to the upstream origin and collect the full
 * response body before resolving.
 *
 * @param {string} reqUrl
 *   The path+query portion of the request as received by the proxy
 *   (e.g. `/v1/chat/completions`).
 * @param {string} method
 *   HTTP method (`GET`, `POST`, …).
 * @param {Record<string, string>} headers
 *   Incoming client request headers.  `host` and `content-length` are
 *   overwritten; `connection` and `keep-alive` are removed.
 * @param {Buffer} body
 *   Fully-buffered request body.
 * @param {URL} targetUrl
 *   Parsed base URL of the upstream origin (e.g. `https://integrate.api.nvidia.com`).
 *   The `reqUrl` path is resolved against this origin.
 * @param {number} [timeoutMs=0]
 *   Socket idle timeout in milliseconds. When > 0, if the upstream sends no
 *   data for this long (connect that never replies, or a wedged wrapper), the
 *   request is aborted and resolves with `status: 504`. 0 disables the timeout.
 * @param {AbortSignal|null} [signal=null]
 *   Downstream-client lifetime. Aborting it destroys the active upstream
 *   request and resolves with `status: 499` / `client_closed`.
 * @param {number} [hardTimeoutMs=0]
 *   Total wall-clock ceiling in milliseconds, armed once when the request is
 *   sent and never reset by upstream activity. Unlike `timeoutMs` this bounds
 *   the whole attempt, so it catches a slow-drip wedge that keeps the socket
 *   nominally busy. Resolves `status: 504` / `upstream_deadline`. 0 disables.
 * @param {number} [maxResponseBytes=0]
 *   Local buffered-response ceiling. Zero disables it. This bounds providers
 *   whose native wire rejects token-limit parameters.
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer }>}
 *   Always resolves.  Network failures resolve with `status: 502`; an idle
 *   timeout resolves with `status: 504`; both carry a JSON `{ error }` body.
 */
export function sendUpstream(reqUrl, method, headers, body, targetUrl, timeoutMs = 0, signal = null, maxResponseBytes = 0, hardTimeoutMs = 0) {
  return new Promise((resolve) => {
    const upstream = buildUpstreamUrl(reqUrl, targetUrl);

    // Guard against double-resolution: a timeout-triggered destroy() also fires
    // the 'error' handler, and we must resolve exactly once.
    let settled = false;
    let onAbort = null;
    let deadlineTimer = null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      resolve(r);
    };
    let timedOut = false;
    let deadlineExceeded = false;
    // Explicit override wins; otherwise derive from the idle timeout this
    // backend already declares. 0 stays 0: no timeout configured, no ceiling.
    const deadlineMs = hardTimeoutMs > 0
      ? hardTimeoutMs
      : (timeoutMs > 0 ? timeoutMs * HARD_DEADLINE_MULTIPLIER : 0);
    let cancelled = false;
    const startedAt = Date.now();
    let firstByteAt = null;
    let firstByteMs = null;
    const terminalTiming = () => ({
      firstByteMs,
      generationMs: firstByteAt === null ? null : Math.max(0, Date.now() - firstByteAt),
    });
    const cancellationResult = () => ({
      status: 499,
      headers: {},
      body: Buffer.from(JSON.stringify({
        error: {
          message: "downstream client disconnected",
          code: "client_closed",
        },
      })),
      ...terminalTiming(),
      cancelled: true,
    });

    const proxyHeaders = { ...headers };
    proxyHeaders.host = upstream.host;
    proxyHeaders["content-length"] = body.length;
    // Strip hop-by-hop headers that must not be forwarded
    delete proxyHeaders.connection;
    delete proxyHeaders["keep-alive"];

    const transport = upstream.protocol === "https:" ? https : http;

    const upstreamReq = transport.request(
      {
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        path: upstream.pathname + upstream.search,
        method,
        headers: proxyHeaders,
        agent: upstream.protocol === "https:" ? httpsAgent : httpAgent,
      },
      (upstreamRes) => {
        // The response callback fires when upstream headers arrive. This is the
        // first byte boundary available to Node and remains truthful for empty
        // bodies, unlike waiting for a data event that may never fire.
        firstByteAt = Date.now();
        firstByteMs = firstByteAt - startedAt;
        const chunks = [];
        let responseBytes = 0;
        upstreamRes.on("data", (chunk) => {
          responseBytes += chunk.length;
          if (maxResponseBytes > 0 && responseBytes > maxResponseBytes) {
            done({
              status: 502,
              headers: {},
              body: Buffer.from(JSON.stringify({ error: { code: "response_too_large" } })),
              ...terminalTiming(),
            });
            upstreamRes.destroy();
            upstreamReq.destroy();
            return;
          }
          chunks.push(chunk);
        });
        upstreamRes.on("end", () => {
          done({
            status: upstreamRes.statusCode,
            headers: upstreamRes.headers,
            body: Buffer.concat(chunks),
            ...terminalTiming(),
          });
        });
      },
    );

    onAbort = () => {
      cancelled = true;
      done(cancellationResult());
      upstreamReq.destroy(new Error("downstream client disconnected"));
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }

    // Idle-timeout the upstream so a wedged backend fails fast (504) and the
    // router can fail over, instead of hanging the request indefinitely.
    if (timeoutMs > 0) {
      upstreamReq.setTimeout(timeoutMs, () => {
        timedOut = true;
        upstreamReq.destroy();
      });
    }

    // The wall-clock ceiling. Armed once here and never rearmed, which is the
    // whole point: upstream activity must not be able to postpone it.
    if (deadlineMs > 0) {
      deadlineTimer = setTimeout(() => {
        deadlineExceeded = true;
        // Resolve here rather than leaning on the request to emit an error.
        // Once response headers have arrived, destroying the ClientRequest
        // does not reliably emit `error` (the abort surfaces on the response
        // object instead), so a deadline that merely destroyed would hang the
        // very request it exists to terminate. Verified against a dribbling
        // upstream that writes one byte every 500ms and never ends.
        done({
          status: 504,
          headers: {},
          body: Buffer.from(JSON.stringify({
            error: {
              message: `upstream exceeded hard deadline after ${deadlineMs}ms`,
              code: "upstream_deadline",
            },
          })),
          ...terminalTiming(),
        });
        upstreamReq.destroy();
      }, deadlineMs);
      deadlineTimer?.unref?.();
    }

    upstreamReq.on("error", (err) => {
      done({
        status: cancelled ? 499 : ((timedOut || deadlineExceeded) ? 504 : 502),
        headers: {},
        body: Buffer.from(JSON.stringify({
          error: {
            message: cancelled
              ? "downstream client disconnected"
              : deadlineExceeded
                ? `upstream exceeded hard deadline after ${deadlineMs}ms`
                : (timedOut ? `upstream idle timeout after ${timeoutMs}ms` : err.message),
            code: cancelled
              ? "client_closed"
              : deadlineExceeded
                ? "upstream_deadline"
                : (timedOut ? "upstream_timeout" : "upstream_unreachable"),
          },
        })),
        ...terminalTiming(),
        ...(cancelled ? { cancelled: true } : {}),
      });
    });

    if (!cancelled) {
      upstreamReq.write(body);
      upstreamReq.end();
    }
  });
}
