/**
 * authz_gate.mjs — the flag gate + per-request authorization composition.
 *
 * Two tiny, pure, unit-testable pieces that index.mjs wires into the live server:
 *
 *   authzEnforceEnabled(env, config) — the MASTER OFF-BY-DEFAULT flag. True only
 *     when SKGATEWAY_AUTHZ_ENFORCE is "1"/"true" OR config.authz.enforce === true.
 *     When false, index.mjs skips the whole gate and is byte-identical to today.
 *
 *   authorizeRequest({ method, url, identity, client }) — classify the route,
 *     resolve the subject from the authenticated identity, and (for a gated
 *     route) delegate to the PDP client. Returns a plain verdict object; it does
 *     NO I/O of its own beyond calling client.decide, and never throws for a
 *     policy outcome. index.mjs turns a `denied` verdict into a 403 + a SIEM line.
 *
 * Keeping this composition out of index.mjs is what lets the "flag-off = no
 * decide call" and "flag-on = enforced" guarantees be tested directly.
 *
 * @module policy/authz_gate
 */

import { classifyRoute, subjectFromIdentity } from "./authz_routes.mjs";

export const SKLEGAL_RESOURCE_FIELDS = Object.freeze([
  "tenant_id",
  "matter_id",
  "material_id",
  "material_version",
  "route_id",
]);
export const SKLEGAL_CONTEXT_FIELDS = Object.freeze([
  "purpose",
  "classification",
  "privilege",
  "ethical_wall",
]);

function exactBoundedStringMap(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null;
  const result = {};
  for (const field of fields) {
    const item = value[field];
    if (typeof item !== "string" || item.length < 1 || item.length > 256 || item.trim() !== item) return null;
    result[field] = item;
  }
  return Object.freeze(result);
}

/**
 * Build the explicit SKLegal qualification route table from trusted process
 * configuration. Request headers are never consulted for scope selectors.
 */
export function createSkLegalQualificationResolver(config = {}) {
  if (config?.enabled !== true) {
    return { enabled: false, resolve: () => null };
  }
  if (!Array.isArray(config.routes) || config.routes.length === 0) {
    throw new Error("SKLegal qualification routes are required");
  }

  const routes = new Map();
  for (const entry of config.routes) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("SKLegal qualification route is malformed");
    }
    const method = typeof entry.method === "string" ? entry.method.trim().toUpperCase() : "";
    const path = typeof entry.path === "string" ? entry.path.trim() : "";
    const subject = typeof entry.subject === "string" ? entry.subject.trim() : "";
    const resource = exactBoundedStringMap(entry.resource, SKLEGAL_RESOURCE_FIELDS);
    const context = exactBoundedStringMap(entry.context, SKLEGAL_CONTEXT_FIELDS);
    if (!method || !path.startsWith("/") || path.includes("?") || !subject || subject.length > 256 || !resource || !context) {
      throw new Error("SKLegal qualification route lacks exact trusted scope");
    }
    const key = `${method} ${path}`;
    if (routes.has(key)) throw new Error("SKLegal qualification route is duplicated");
    routes.set(key, Object.freeze({ subject, resource, context }));
  }

  return {
    enabled: true,
    resolve(method, url) {
      const pathname = (url || "").split("?")[0];
      return routes.get(`${(method || "GET").toUpperCase()} ${pathname}`) || null;
    },
  };
}

/**
 * The master enforce flag. OFF by default. Env wins, then config.
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @param {object} [config={}]  Gateway config (reads config.authz.enforce).
 * @returns {boolean}
 */
export function authzEnforceEnabled(env = process.env, config = {}) {
  const e = env?.SKGATEWAY_AUTHZ_ENFORCE;
  if (e === "1" || e === "true") return true;
  if (e === "0" || e === "false") return false; // explicit off wins over config
  return config?.authz?.enforce === true;
}

/**
 * @typedef {object} AuthzVerdict
 * @property {"public"|"gated"} kind
 * @property {boolean} allowed        Whether the request may proceed.
 * @property {string|null} capability The mapped capability (null for public / unmapped).
 * @property {string} subject         Resolved PDP subject ("" when anonymous).
 * @property {string} reason          Human-readable justification.
 * @property {Array}  obligations     PDP obligations (audit records) to honor.
 */

/**
 * Authorize one request. Pure composition; the only side effect is the injected
 * client's network call for a gated route.
 *
 * Public routes short-circuit to allowed with no PDP call. A gated route with no
 * mapped capability fails closed (coverage-gap guard). Otherwise the PDP decides,
 * failing closed inside the client on any transport/HTTP fault.
 *
 * @param {object} args
 * @param {string} args.method
 * @param {string} args.url
 * @param {object} args.identity   Resolved identity ({ agent_id, agent }).
 * @param {{ decide: Function }} args.client  The authz PDP client.
 * @param {object|null} [args.sklegalQualification] Trusted configured scope.
 * @param {string|null} [args.requestCapAuth] Request-local CapAuth header.
 * @param {{decideSkLegal: Function}|null} [args.sklegalClient] Strict client.
 * @returns {Promise<AuthzVerdict>}
 */
export async function authorizeRequest({
  method,
  url,
  identity,
  client,
  internal = false,
  sklegalQualification = null,
  requestCapAuth = null,
  sklegalClient = null,
}) {
  const route = classifyRoute(method, url);
  if (route.kind === "public") {
    return { kind: "public", allowed: true, capability: null, subject: "", reason: "public route", obligations: [] };
  }

  const subject = sklegalQualification?.subject || subjectFromIdentity(identity);

  if (sklegalQualification) {
    if (route.capability !== "skgateway.infer" || typeof sklegalClient?.decideSkLegal !== "function") {
      return {
        kind: "gated",
        allowed: false,
        capability: route.capability ?? null,
        subject,
        reason: "SKLegal qualification is not configured",
        obligations: [],
      };
    }
    const decision = await sklegalClient.decideSkLegal({
      subject,
      capability: route.capability,
      resource: sklegalQualification.resource,
      context: sklegalQualification.context,
      requestCapAuth,
    });
    return {
      kind: "gated",
      governed: true,
      allowed: decision.allow === true,
      capability: route.capability,
      subject,
      reason: decision.reason || "",
      decision_id: decision.decision_id ?? null,
      policy_revision: decision.policy_revision ?? null,
      correlation_id: decision.correlation_id ?? null,
      obligations: Array.isArray(decision.obligations) ? decision.obligations : [],
    };
  }

  // The legacy non-SKLegal lane retains its internal-peer behavior. Governed
  // qualification routes returned above always consult the strict PDP client.
  if (internal) {
    return {
      kind: "gated",
      allowed: true,
      capability: route.capability ?? null,
      subject,
      reason: "internal-trusted peer",
      obligations: [],
    };
  }

  if (!route.capability) {
    return {
      kind: "gated",
      allowed: false,
      capability: null,
      subject,
      reason: "unmapped gated route (coverage gap)",
      obligations: [],
    };
  }

  const pathname = (url || "").split("?")[0];
  const resource = { path: pathname, method: (method || "GET").toUpperCase() };
  const decision = await client.decide(subject, route.capability, resource);
  return {
    kind: "gated",
    allowed: decision.allow === true,
    capability: route.capability,
    subject,
    reason: decision.reason || "",
    obligations: Array.isArray(decision.obligations) ? decision.obligations : [],
  };
}
