/**
 * request_log.error_msg builder (card 9fbca169 / SKRSI P0.2).
 *
 * Kept out of collector.mjs on purpose: index.mjs imports it statically, and
 * collector.mjs pulls in better-sqlite3, which must stay lazy when metrics is
 * disabled.
 */

// ─── Failure reason for request_log.error_msg (card 9fbca169) ────────────────
//
// One short metadata line for a non-2xx terminal row: an error CLASS and the
// UPSTREAM STATUS, never a response body. Bodies can carry prompt echoes,
// provider detail and hostnames, so the only body field ever read is a
// gateway-authored code/type token, and only on a result the gateway made
// itself (no upstreamStatus). Pure and synchronous: it reads fields already on
// the result in hand and adds no call to the request path.

const REASON_TOKEN = /^[a-z][a-z0-9_]{2,47}$/;
const GENERIC_TYPES = new Set(["invalid_request_error", "server_error", "api_error", "error"]);

function token(value) {
  return typeof value === "string" && REASON_TOKEN.test(value) ? value : null;
}

/** Class name a gateway-made error body declares, or null. */
function gatewayBodyClass(body) {
  if (!body) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body));
  } catch {
    return null;
  }
  const err = parsed?.error;
  if (!err || typeof err !== "object") return null;
  const type = token(err.type);
  return token(err.code) ?? (type && !GENERIC_TYPES.has(type) ? type : null);
}

/** Class of the attempt the result came from. */
function attemptClass(result) {
  if (result?.cancelled) return "client_closed";
  return token(result?.transportError) ?? "upstream_error";
}

/**
 * Build request_log.error_msg for a terminal row.
 *
 * @param {object|null} result     routeAndSend's result (null when none)
 * @param {number}      statusCode status recorded on the row
 * @returns {string|undefined} undefined on a 2xx/3xx row, else
 *   "class=<token> upstream_status=<NNN|none>[ last=<token>]"
 */
export function describeFailure(result, statusCode) {
  if (!Number.isInteger(statusCode) || statusCode < 400) return undefined;
  if (!result) return "class=no_backend_result upstream_status=none";
  const upstream = Number.isInteger(result.upstreamStatus) ? String(result.upstreamStatus) : "none";
  const relayed = "upstreamStatus" in result || result.transportError || result.cancelled;
  if (!relayed) {
    // Gateway-made (unknown model, EOL gate, all throttled, context, ...).
    const cls = gatewayBodyClass(result.body) ?? `gateway_${statusCode}`;
    return `class=${cls} upstream_status=none`;
  }
  if (result.allFailed && result.failover) {
    return `class=failover_exhausted upstream_status=${upstream} last=${attemptClass(result)}`;
  }
  return `class=${attemptClass(result)} upstream_status=${upstream}`;
}

/** error_msg for a request that threw: the error's name/code only, never its message. */
export function describeException(err, cls = "dispatch_exception") {
  const detail = token(typeof err?.code === "string" ? err.code.toLowerCase() : null)
    ?? token(typeof err?.name === "string" ? err.name.toLowerCase() : null);
  return `class=${cls} upstream_status=none${detail ? ` err=${detail}` : ""}`;
}
