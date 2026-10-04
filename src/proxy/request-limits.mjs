/**
 * request-limits.mjs: explicit transport byte bounds for proxied requests.
 *
 * Unlike the trim-based model limits applied earlier in the request path
 * (src/index.mjs, "model limits"), these bounds never edit the client's
 * conversation to fit a budget. An oversized request body, or an oversized
 * system/developer message slice of it, is rejected outright (413) with the
 * history untouched, so the caller can retry with a smaller payload instead
 * of silently losing context to truncation.
 *
 * Defaults match the transport ceilings already in use: 120000 bytes for the
 * full request body, 40000 bytes for the system/developer message slice.
 * Both are overridable from config (global `sanitizer.*`, or per-model via
 * `model_limits.<model>.*`).
 */

const DEFAULT_BODY_BYTES = 120000;
const DEFAULT_SYSTEM_BYTES = 40000;

function positive(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError('Request byte limit must be a positive safe integer');
  }
  return result;
}

/**
 * Resolve the effective body/system byte limits for a concrete model,
 * narrowing (never widening) when the caller addressed the request through
 * an alias that carries its own, tighter restriction.
 *
 * @param {object} config          Gateway config (sanitizer + model_limits).
 * @param {string} model           Resolved concrete model id.
 * @param {string} [requestedModel] The alias/model the client actually asked
 *   for, if different from `model`. Only ever tightens the resolved limit.
 * @returns {{maxBodyBytes:number, maxSystemBytes:number}}
 */
export function modelRequestLimits(config = {}, model, requestedModel = model) {
  const defaults = config.sanitizer || {};
  const concrete = config.model_limits?.[model] || {};
  const requested = requestedModel !== model ? config.model_limits?.[requestedModel] : null;
  const maxBodyBytes = positive(concrete.max_body_bytes,
    positive(defaults.max_body_bytes, DEFAULT_BODY_BYTES));
  const maxSystemBytes = positive(concrete.max_system_bytes,
    positive(defaults.max_system_bytes, DEFAULT_SYSTEM_BYTES));
  return {
    maxBodyBytes: Math.min(maxBodyBytes, positive(requested?.max_body_bytes, maxBodyBytes)),
    maxSystemBytes: Math.min(maxSystemBytes, positive(requested?.max_system_bytes, maxSystemBytes)),
  };
}

/**
 * The single ceiling to bound buffering of an incoming request BEFORE the
 * model is known (routing happens after the body is fully read). This must
 * admit the largest body any configured model is allowed to send, so a
 * generously-limited model is never truncated mid-buffer; a per-model cap is
 * enforced afterward, once the model is resolved, by `requestLimitError`.
 *
 * @param {object} config  Gateway config.
 * @returns {number} Maximum ingress bytes to buffer before rejecting.
 */
export function ingressRequestLimit(config = {}) {
  const values = [positive(config.sanitizer?.max_body_bytes, DEFAULT_BODY_BYTES)];
  for (const value of Object.values(config.model_limits || {})) {
    if (value.max_body_bytes != null) values.push(positive(value.max_body_bytes));
  }
  const maximum = Math.max(...values);
  return !config.client_auth?.enabled || config.client_auth.max_request_body_bytes == null ? maximum
    : Math.min(maximum, positive(config.client_auth.max_request_body_bytes));
}

/**
 * Check a fully-buffered request body against resolved limits.
 *
 * @param {Buffer|object} body  Raw request body, or an already-parsed object.
 * @param {{maxBodyBytes:number, maxSystemBytes:number}} limits
 * @returns {null|{message:string,code:string,type:string,param:string,actual_bytes:number,limit_bytes:number,retryable:boolean}}
 *   `null` when the request is within bounds.
 */
export function requestLimitError(body, limits) {
  const maxBodyBytes = positive(limits.maxBodyBytes, DEFAULT_BODY_BYTES);
  const maxSystemBytes = positive(limits.maxSystemBytes, DEFAULT_SYSTEM_BYTES);
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  const error = (param, actual, maximum) => ({
    message: `Request ${param} exceeds the configured transport limit; history was not modified`,
    code: 'request_too_large', type: 'invalid_request_error', param,
    actual_bytes: actual, limit_bytes: maximum, retryable: false,
  });
  if (bytes.length > maxBodyBytes) return error('body', bytes.length, maxBodyBytes);
  let parsed;
  try { parsed = Buffer.isBuffer(body) ? JSON.parse(body.toString('utf8')) : body; }
  catch { return null; }
  const systemBytes = (Array.isArray(parsed?.messages) ? parsed.messages : [])
    .filter(message => message?.role === 'system' || message?.role === 'developer')
    .reduce((sum, message) => sum + Buffer.byteLength(typeof message.content === 'string'
      ? message.content : JSON.stringify(message.content ?? null)), 0);
  return systemBytes > maxSystemBytes ? error('system', systemBytes, maxSystemBytes) : null;
}

/** Render a requestLimitError() result as the response the proxy should send. */
export function requestLimitResponse(error) {
  return { status: 413, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: Buffer.from(JSON.stringify({ error })), backendId: null, failover: false };
}
