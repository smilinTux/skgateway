/**
 * skgateway's SKWorld module manifest (operator-facet), served from the gateway
 * HTTP surface.
 *
 * skgateway is a first-class SKWorld subapp like skchat / skcode / skcomms, but
 * it is a backend SERVICE with no UI module: it declares ONE skworld.module.json
 * whose single facet is the operator adapter (there is no Flutter package, no nav
 * pane, no shell entry). The gateway serves it unauthenticated at
 * /.well-known/skworld-module.json (public discovery metadata, no secrets) so the
 * fleet control plane can discover skgateway and Atlas can watch/steer it the same
 * way it manages the UI subapps.
 *
 * The manifest is built from the serving origin so its URLs are origin-relative
 * (health resolves against wherever the gateway actually answers, avoiding
 * host/port drift). The operator block mirrors this repo's operator facet
 * (src/operator/operator.mjs), which is itself the Node mirror of Atlas's
 * skgateway adapter (skcapstone/src/skcapstone/operator_seat/skgateway_adapter.py).
 * CONDITIONS and the standard/reversible action names are imported from
 * operator.mjs so the manifest can never drift from the contract it advertises.
 *
 * @module operator/manifest
 */

import { CONDITIONS, ACTIONS } from "./operator.mjs";

/** sk-standards manifest schema version (v1.1, with the operator block). */
export const SCHEMA_VERSION = "1.1";

/**
 * The standard, reversible action names the operator may actuate, derived from
 * the operator facet's ACTIONS exactly like the Python adapter's proposed set
 * (standard && reversible). raise_pool_limit is standard:false and so excluded.
 */
export const PROPOSED_STANDARD_ACTIONS = ACTIONS.filter(
  (a) => a.standard && a.reversible,
).map((a) => a.name);

/**
 * Build skgateway's skworld.module.json for a given serving origin.
 *
 * skgateway is a backend service, so the manifest carries NO UI facet: no
 * `entry` (no url, no flutter_package), no `nav`. `grade` is the literal
 * "service" to mark it a UI-less service rather than a Grade A/B UI module, and
 * `service: true` states the same explicitly for consumers that key off a flag.
 * The only facet is `operator`.
 *
 * @param {string} baseUrl The origin the gateway answers on (e.g. the request
 *   base URL, "http://100.x.x.x:18780/"). The health URL is built relative to it
 *   so it never hardcodes a host or port.
 * @returns {object} The manifest dict (operator facet only).
 */
export function skgatewayModuleManifest(baseUrl) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  return {
    schemaVersion: SCHEMA_VERSION,
    id: "skgateway",
    name: "Gateway",
    // Backend service: no UI module. No `entry`, no `nav`, no Flutter package.
    // A grade promotion is not applicable; this stays a service.
    grade: "service",
    service: true,
    memory: { opt_in: false },
    // Origin-relative: the gateway serves GET /health (see src/index.mjs).
    health: `${base}/health`,
    // Operator facet: what Atlas's skgateway adapter observes and may act on.
    // Mirrors src/operator/operator.mjs (CONDITIONS + standard/reversible
    // ACTIONS), which mirrors operator_seat/skgateway_adapter.py.
    operator: {
      contractVersion: 1,
      cli: "skgateway operator",
      repos: ["skgateway"],
      conditions: [...CONDITIONS],
      proposedStandardActions: [...PROPOSED_STANDARD_ACTIONS],
    },
  };
}

/**
 * Derive the serving origin ("scheme://host[:port]") from an incoming request.
 *
 * Honors X-Forwarded-Proto / X-Forwarded-Host (the gateway can sit behind a
 * Cloudflare tunnel or reverse proxy) and falls back to the Host header and the
 * connection's encryption state. The result is used as the manifest base so all
 * served URLs resolve against wherever the caller actually reached the gateway.
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {string} e.g. "http://localhost:18780"
 */
export function requestOrigin(req) {
  const xfProto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = xfProto || (req.socket?.encrypted ? "https" : "http");
  const xfHost = (req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const host = xfHost || req.headers.host || "localhost";
  return `${proto}://${host}`;
}

/**
 * HTTP handler for GET /.well-known/skworld-module.json.
 *
 * Unauthenticated public discovery: writes 200 with the manifest built from the
 * request's origin. Shared by the live gateway (src/index.mjs) and the tests so
 * both exercise the same code path.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 */
export function handleModuleManifest(req, res) {
  const manifest = skgatewayModuleManifest(requestOrigin(req));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(manifest));
}

export default {
  SCHEMA_VERSION,
  PROPOSED_STANDARD_ACTIONS,
  skgatewayModuleManifest,
  requestOrigin,
  handleModuleManifest,
};
