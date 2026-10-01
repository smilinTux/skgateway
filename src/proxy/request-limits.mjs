/** Explicit transport bounds. Never edit the client's conversation to fit. */
const DEFAULT_BODY_BYTES = 120000;
const DEFAULT_SYSTEM_BYTES = 40000;

function positive(value, fallback) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError('Request byte limit must be a positive safe integer');
  }
  return result;
}

/** Resolve against the actual candidate, preserving explicit alias restrictions. */
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

/** Bound buffering before routing without applying an unresolved alias default. */
export function ingressRequestLimit(config = {}) {
  const values = [positive(config.sanitizer?.max_body_bytes, DEFAULT_BODY_BYTES)];
  for (const value of Object.values(config.model_limits || {})) {
    if (value.max_body_bytes != null) values.push(positive(value.max_body_bytes));
  }
  const maximum = Math.max(...values);
  return !config.client_auth?.enabled || config.client_auth.max_request_body_bytes == null ? maximum
    : Math.min(maximum, positive(config.client_auth.max_request_body_bytes));
}

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

export function requestLimitResponse(error) {
  return { status: 413, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: Buffer.from(JSON.stringify({ error })), backendId: null, failover: false };
}
