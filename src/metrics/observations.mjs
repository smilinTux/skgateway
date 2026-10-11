/** Governed, bounded realtime observation contract for SKDashboard. */

export const OBSERVATION_VERSION = 'skgateway.observation.v1';
export const LANES = Object.freeze(['gateway_observed', 'harness_reported']);
const FORBIDDEN = /prompt|response|credential|secret|capabilit|session|authorization|cookie/i;
const MAX_BUCKETS = 32;

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function text(value, max = 160) { return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null; }
function count(value) { return Number.isInteger(value) && value >= 0 ? value : null; }
function histogram(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.buckets) || value.buckets.length > MAX_BUCKETS) return null;
  const buckets = value.buckets.map(b => ({ le: finite(b?.le) ? b.le : null, count: count(b?.count) }));
  return buckets.every(b => b.le !== null && b.count !== null) ? { buckets, count: count(value.count), sum: finite(value.sum) ? value.sum : null } : null;
}

/**
 * Build an observation using only supplied facts. Missing facts stay null.
 * The returned object is safe to JSON.stringify and contains no raw identifiers.
 */
export function createObservation(input = {}, now = new Date()) {
  const source = text(input.source, 120);
  const lane = LANES.includes(input.lane) ? input.lane : null;
  const observedAt = text(input.observed_at, 40) || (now instanceof Date ? now.toISOString() : null);
  const route = text(input.route, 200);
  const model = text(input.model, 160);
  const backend = text(input.backend, 160);
  const agent = text(input.agent, 128);
  const node = text(input.node, 128);
  if (!source || !lane || !observedAt || !route || !model || !backend || !agent || !node) throw new TypeError('source, observed_at, lane, route, model, backend, agent, and node are required');
  const candidate = { ...input, source, observed_at: observedAt, lane, route, model, backend, agent, node };
  for (const key of Object.keys(candidate)) if (FORBIDDEN.test(key)) throw new TypeError(`forbidden field: ${key}`);
  const result = {
    contract: OBSERVATION_VERSION, source, observed_at: observedAt,
    freshness: { watermark: text(input.watermark, 40), ttl_seconds: finite(input.ttl_seconds) && input.ttl_seconds >= 0 ? input.ttl_seconds : null, stale: input.stale === true },
    lane, route, model, requested_model: text(input.requested_model, 160), served_model: text(input.served_model, 160), backend, agent, node,
    counts: { requests: count(input.request_count), errors: count(input.error_count), active_requests: count(input.active_requests), queue_depth: count(input.queue_depth) },
    cache: input.cache_state === null || typeof input.cache_state === 'string' ? input.cache_state : null,
    cost: input.cost_state === null || typeof input.cost_state === 'string' ? input.cost_state : null,
    tokens: { input: count(input.input_tokens), output: count(input.output_tokens), cache_read: count(input.cache_read_tokens), cache_write: count(input.cache_write_tokens) },
    latency: { request: histogram(input.request_latency), time_to_first_token: histogram(input.time_to_first_token), time_per_output_token: histogram(input.time_per_output_token) },
    worker: { live: input.worker_live === true ? true : input.worker_live === false ? false : null },
  };
  return Object.freeze(result);
}

export function observationKey(observation) {
  if (!observation || typeof observation !== 'object') throw new TypeError('observation required');
  return [observation.source, observation.lane, observation.observed_at, observation.route, observation.model, observation.backend, observation.agent, observation.node].join('\u001f');
}

export function isFresh(observation, at = Date.now()) {
  const t = Date.parse(observation?.observed_at || '');
  const ttl = observation?.freshness?.ttl_seconds;
  return Number.isFinite(t) && finite(ttl) && ttl >= 0 && at - t <= ttl * 1000;
}

export function serializeObservation(observation) { return JSON.stringify(observation); }
export function parseObservation(line) {
  if (typeof line !== 'string' || line.length > 100_000) throw new TypeError('malformed observation');
  const parsed = JSON.parse(line);
  if (parsed?.contract !== OBSERVATION_VERSION) throw new TypeError('unsupported observation contract');
  return createObservation({
    ...parsed,
    ttl_seconds: parsed.freshness?.ttl_seconds,
    watermark: parsed.freshness?.watermark,
    stale: parsed.freshness?.stale,
    request_count: parsed.counts?.requests,
    error_count: parsed.counts?.errors,
    active_requests: parsed.counts?.active_requests,
    queue_depth: parsed.counts?.queue_depth,
    cache_state: parsed.cache,
    cost_state: parsed.cost,
    input_tokens: parsed.tokens?.input,
    output_tokens: parsed.tokens?.output,
    cache_read_tokens: parsed.tokens?.cache_read,
    cache_write_tokens: parsed.tokens?.cache_write,
    request_latency: parsed.latency?.request,
    time_to_first_token: parsed.latency?.time_to_first_token,
    time_per_output_token: parsed.latency?.time_per_output_token,
    worker_live: parsed.worker?.live,
  }, new Date(parsed.observed_at));
}
