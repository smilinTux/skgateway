/**
 * unserved-request.mjs: answer requests no backend can serve, locally.
 *
 * The catch-all proxy in index.mjs used to forward ANY unmatched path to the
 * routing default. A request with no model has no routing signal, so it went
 * to the estate's primary backend (codex on chi, nvidia on nor), which
 * answered `{"detail":"Not Found"}` and was logged as an upstream error.
 *
 * Measured before this change (metrics.db request_log + audit.jsonl, both
 * estates, 2026-09-05..10-26): about 14,900 model-less requests, exactly one
 * of which ever succeeded (a hand-run curl). The rest were Hermes' local
 * server fingerprint waterfall (GET /api/v1/models, /api/tags, /v1/props,
 * /props, /version and POST /api/show), which Hermes runs because an
 * unqualified gateway hostname counts as a local endpoint. Each probe cost a
 * real codex/nvidia upstream call, and some hit codex 403s or the client's
 * 2 s timeout (499).
 *
 * Mapping these to a default model would be worse, not better: a probe for
 * /props or /api/tags forwarded to a llama.cpp or Ollama backend could answer
 * 200 and make the client misidentify the gateway as that server. So:
 *   - a request with no model and no x-sk-context/service/role routing
 *     header, on a path outside /v1 or as a GET/HEAD (e.g. llama.cpp's
 *     /v1/props): 404 not_found;
 *   - any other such request under /v1: 400 model_required.
 * Requests that name a model, or that carry a registry routing header, are
 * untouched, on any path (an authenticated client may still use a base URL
 * without /v1). A body that is not JSON at all is opaque here and still
 * forwarded, as before: the backend owns that error.
 *
 * @module proxy/unserved-request
 */

/**
 * Decide whether the gateway should answer a request itself instead of
 * routing it. Pure; callers write the response.
 *
 * @param {{ method?: string, url?: string, model?: string, opaqueBody?: boolean, headers?: object }} req
 *   `model` is the model resolved from the body or the x-model header;
 *   `opaqueBody` means a non-empty body that did not parse as JSON.
 * @returns {null | { status: number, code: string, body: string }}
 */
export function unservedRequest({ method, url, model, opaqueBody = false, headers = {} }) {
  const m = (method || "GET").toUpperCase();
  const pathname = (url || "/").split("?")[0];
  const label = `${m} ${pathname}`;
  if (model || opaqueBody) return null;
  if (headers["x-sk-context"] || headers["x-sk-service"] || headers["x-sk-role"]) return null;
  if (pathname !== "/v1" && !pathname.startsWith("/v1/")) {
    return reply(404, "not_found",
      `skgateway does not serve ${label}. The OpenAI-compatible API is under /v1 (e.g. POST /v1/chat/completions, GET /v1/models).`);
  }
  if (m === "GET" || m === "HEAD") {
    return reply(404, "not_found", `skgateway does not serve ${label}.`);
  }
  return reply(400, "model_required",
    `${label} has no model. Set "model" in the JSON body (GET /v1/models lists them, e.g. sk-default) or route with an x-sk-context, x-sk-service or x-sk-role header.`);
}

function reply(status, code, message) {
  const type = status === 404 ? "not_found_error" : "invalid_request_error";
  return { status, code, body: JSON.stringify({ error: { message, type, code, status } }) };
}
