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
 * @returns {Promise<AuthzVerdict>}
 */
export async function authorizeRequest({ method, url, identity, client }) {
  const route = classifyRoute(method, url);
  if (route.kind === "public") {
    return { kind: "public", allowed: true, capability: null, subject: "", reason: "public route", obligations: [] };
  }

  const subject = subjectFromIdentity(identity);
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
