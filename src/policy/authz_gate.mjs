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
 * configuration. Opt-in request selectors are untrusted until the strict PDP
 * verifies the unchanged credential against canonical current state.
 */
export function createSkLegalQualificationResolver(config = {}) {
  if (config?.enabled !== true) {
    return { enabled: false, resolve: () => null };
  }
  if (!Array.isArray(config.routes) || config.routes.length === 0 || config.routes.length > 64) {
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
    if (entry.request_capability !== undefined && typeof entry.request_capability !== 'boolean') {
      throw new Error('SKLegal request capability mode must be boolean');
    }
    const dynamic = entry.request_capability === true;
    const modelRoute = dynamic && exactBoundedStringMap({ model_route: entry.model_route }, ['model_route']);
    if (dynamic && !modelRoute) throw new Error('SKLegal request capability requires an explicit model route');
    const resource = exactBoundedStringMap(entry.resource, dynamic
      ? ['tenant_id', 'matter_id', 'route_id'] : SKLEGAL_RESOURCE_FIELDS);
    const context = exactBoundedStringMap(entry.context, SKLEGAL_CONTEXT_FIELDS);
    if (!method || !path.startsWith("/") || path.includes("?") || !subject || subject.length > 256 || !resource || !context) {
      throw new Error("SKLegal qualification route lacks exact trusted scope");
    }
    const key = `${method} ${path}`;
    const entries = routes.get(key) || [];
    if (entries.some(previous => !dynamic || !previous.dynamic || (
      previous.subject === subject && previous.resource.tenant_id === resource.tenant_id
      && previous.resource.matter_id === resource.matter_id
      && previous.modelRoute === modelRoute.model_route && previous.context.purpose === context.purpose
    ))) throw new Error("SKLegal qualification route is duplicated");
    entries.push(Object.freeze({ subject, resource, context, dynamic, modelRoute: modelRoute?.model_route }));
    routes.set(key, entries);
  }

  return {
    enabled: true,
    resolve(method, url, authorization = null) {
      const pathname = (url || "").split("?")[0];
      const entries = routes.get(`${(method || "GET").toUpperCase()} ${pathname}`);
      if (!entries) return null;
      if (!entries[0].dynamic) {
        const { subject, resource, context } = entries[0];
        return { subject, resource, context };
      }
      const selectors = unverifiedCapabilitySelectors(authorization);
      const match = selectors && entries.find(entry => entry.subject === selectors.subject
        && entry.resource.tenant_id === selectors.resource.tenant_id
        && entry.resource.matter_id === selectors.resource.matter_id
        && entry.modelRoute === selectors.resource.route_id
        && entry.context.purpose === selectors.purpose);
      // A configured path remains governed even when its selectors are invalid.
      if (!match) return { invalid: true };
      return { subject: match.subject,
        resource: Object.freeze({ ...selectors.resource, route_id: match.resource.route_id }), context: match.context };
    },
  };
}

function unverifiedCapabilitySelectors(authorization) {
  // No signature or policy decision is made here. The PDP receives the exact
  // original credential and rejects malformed, forged, expired or stale claims.
  if (typeof authorization !== 'string' || authorization.length > 8192
    || !/^Bearer [\x20-\x7e]+$/i.test(authorization)) return null;
  try {
    const envelope = JSON.parse(authorization.replace(/^Bearer\s+/i, ''));
    const token = envelope?.sklegal_presented_capability === '1.0'
      ? JSON.parse(envelope.chain.leaf) : envelope;
    const claims = token?.payload?.metadata?.sklegal_capability;
    const grant = claims?.grant;
    if (grant?.audience !== 'model' || !Number.isSafeInteger(grant.resource_version)
      || grant.resource_version < 1) return null;
    const identity = exactBoundedStringMap({ subject: claims.principal?.subject, purpose: grant.purpose }, ['subject', 'purpose']);
    const resource = exactBoundedStringMap({
      tenant_id: grant.tenant_id, matter_id: grant.matter_id,
      material_id: grant.resource_id, material_version: String(grant.resource_version),
      route_id: grant.model_route,
    }, SKLEGAL_RESOURCE_FIELDS);
    return identity && resource ? { ...identity, resource } : null;
  } catch {
    return null;
  }
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
    if (sklegalQualification.invalid || route.capability !== "skgateway.infer" || typeof sklegalClient?.decideSkLegal !== "function") {
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
