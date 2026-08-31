/**
 * attribution.mjs: response headers that let a caller join its own request to
 * the `request_log` row describing it (card 3351d25b / A6.2).
 *
 * The gateway has always written `(id, agent_id, model, backend, session_id,
 * ...)` into request_log and returned NONE of it, so a caller holding a
 * response had no key to look its own request up by. It could see that the
 * gateway answered and could not see which row that answer was. These headers
 * close that gap.
 *
 * Core attribution headers (card 3351d25b):
 *   x-sk-req-id          the request_log primary key for THIS call
 *   x-sk-backend         the backend id that served it
 *   x-sk-model-served    the model that backend actually served
 *
 * Provider-neutral rail attribution headers (card e19f88db / SKGW-ATTRIBUTION-01):
 *   x-sk-provider        inferred provider (nvidia, anthropic, local, etc.)
 *   x-sk-rail            infrastructure rail (local, cloud, hybrid)
 *   x-sk-logical-route   registry routing context (context/service/role)
 *
 * Two rules, both inherited on purpose from energyHeaders() in energy.mjs
 * rather than reinvented here, because the fleet must not carry two different
 * answers to the same question:
 *
 * 1. OMISSION, NOT EMPTINESS. A field we do not know is ABSENT. "unknown" and
 *    "empty string" are different facts, and a header that is always present
 *    proves nothing about the one call you are looking at. A request that
 *    never reached a backend (an EOL-gated 404, an all-candidates-throttled
 *    429) genuinely has no serving backend, and says so by not claiming one.
 *
 * 2. THE SERVING ATTEMPT ONLY. On a failover these headers describe the
 *    attempt that produced the bytes the client is holding, never a blend
 *    across attempts. This is the same ruling src/index.mjs records for the
 *    energy headers: one value has to mean one backend and one model, so it
 *    means the one that answered. Per-attempt detail lives in the logs
 *    (energy_log rows are written per attempt), not in a header that can only
 *    hold one answer.
 *
 * Exposing the internal backend id is settled policy: x-sk-energy-node already
 * returns an internal node name. What is NOT exposed is anything upstream
 * credential shaped; backendId is a local config key, never a provider secret.
 */

/**
 * Build the attribution headers for one request.
 *
 * @param {string|null|undefined} reqId
 *   The id recordRequest() returned, i.e. request_log.id. Null when metrics
 *   are disabled or recordRequest failed, in which case there is no row to
 *   join to and the header is correctly absent.
 * @param {{backendId?:string|null, servedModel?:string|null, requestedModel?:string|null, bucket?:string|null, bucketMember?:string|null, provider?:string|null, rail?:string|null, logicalRoute?:string|null}|null|undefined} result
 *   routeAndSend()'s result for the SERVING attempt.
 * @returns {Record<string,string>}
 */
export function attributionHeaders(reqId, result) {
  const out = {};
  if (typeof reqId === "string" && reqId) out["x-sk-req-id"] = reqId;
  if (typeof result?.backendId === "string" && result.backendId) {
    out["x-sk-backend"] = result.backendId;
  }
  if (typeof result?.servedModel === "string" && result.servedModel) {
    out["x-sk-model-served"] = result.servedModel;
  }
  if (typeof result?.requestedModel === "string" && result.requestedModel) {
    out["x-sk-model-requested"] = result.requestedModel;
  }
  if (typeof result?.bucket === "string" && result.bucket) {
    out["x-sk-bucket"] = result.bucket;
  }
  if (typeof result?.bucketMember === "string" && result.bucketMember) {
    out["x-sk-bucket-member"] = result.bucketMember;
  }
  // Provider-neutral rail attribution (card e19f88db / SKGW-ATTRIBUTION-01)
  if (typeof result?.provider === "string" && result.provider) {
    out["x-sk-provider"] = result.provider;
  }
  if (typeof result?.rail === "string" && result.rail) {
    out["x-sk-rail"] = result.rail;
  }
  if (typeof result?.logicalRoute === "string" && result.logicalRoute) {
    out["x-sk-logical-route"] = result.logicalRoute;
  }
  return out;
}
