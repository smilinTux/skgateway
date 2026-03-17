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
 *  - Hop-by-hop headers (`connection`, `keep-alive`) are stripped from
 *    proxied request headers to avoid confusing the upstream server.
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

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
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer }>}
 *   Always resolves.  Network failures resolve with `status: 502` and a
 *   JSON `{ error: { message } }` body.
 */
export function sendUpstream(reqUrl, method, headers, body, targetUrl) {
  return new Promise((resolve) => {
    const upstream = new URL(reqUrl, targetUrl);

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
      },
      (upstreamRes) => {
        const chunks = [];
        upstreamRes.on("data", (chunk) => chunks.push(chunk));
        upstreamRes.on("end", () => {
          resolve({
            status: upstreamRes.statusCode,
            headers: upstreamRes.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    upstreamReq.on("error", (err) => {
      resolve({
        status: 502,
        headers: {},
        body: Buffer.from(JSON.stringify({ error: { message: err.message } })),
      });
    });

    upstreamReq.write(body);
    upstreamReq.end();
  });
}
