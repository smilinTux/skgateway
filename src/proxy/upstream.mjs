/**
 * upstream.mjs — Upstream relay for SKGateway
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
 *    over instead of blocking. Disabled (0) by default — current behavior.
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
const httpsAgent = new https.Agent(_agentOpts);

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
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer }>}
 *   Always resolves.  Network failures resolve with `status: 502`; an idle
 *   timeout resolves with `status: 504`; both carry a JSON `{ error }` body.
 */
export function sendUpstream(reqUrl, method, headers, body, targetUrl, timeoutMs = 0) {
  return new Promise((resolve) => {
    const upstream = new URL(reqUrl, targetUrl);

    // Guard against double-resolution: a timeout-triggered destroy() also fires
    // the 'error' handler, and we must resolve exactly once.
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let timedOut = false;

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
        const chunks = [];
        upstreamRes.on("data", (chunk) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          done({
            status: upstreamRes.statusCode,
            headers: upstreamRes.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    // Idle-timeout the upstream so a wedged backend fails fast (504) and the
    // router can fail over, instead of hanging the request indefinitely.
    if (timeoutMs > 0) {
      upstreamReq.setTimeout(timeoutMs, () => {
        timedOut = true;
        upstreamReq.destroy();
      });
    }

    upstreamReq.on("error", (err) => {
      done({
        status: timedOut ? 504 : 502,
        headers: {},
        body: Buffer.from(JSON.stringify({
          error: {
            message: timedOut ? `upstream idle timeout after ${timeoutMs}ms` : err.message,
            code: timedOut ? "upstream_timeout" : "upstream_unreachable",
          },
        })),
      });
    });

    upstreamReq.write(body);
    upstreamReq.end();
  });
}
