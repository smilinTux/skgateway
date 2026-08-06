/**
 * authz_routes.mjs — method-aware (route → capability) map for skgateway's PEP.
 *
 * SKWorld Authorization Standard section 3 (route-coverage discipline): every
 * authenticated route is EXACTLY one of capability-mapped, explicit-public, or
 * explicit-self-auth. Nothing implicit. Mapping MUST be method-aware (GET vs
 * POST on one path can differ). This module is the single source of truth for
 * that classification; the enforcement wiring in index.mjs and the coverage test
 * both read it, so a new live route that is neither mapped nor allow-listed is
 * caught by the completeness test rather than silently falling through.
 *
 * skgateway's surface (L1.8) has just two gated capabilities:
 *   • skgateway.infer  — the inference proxy (spend compute AS the subject)
 *   • skgateway.admin  — the /admin/* model-catalog / advertise / routing mutations
 * Everything else is public infra (health/status/discovery/model-listing).
 *
 * @module policy/authz_routes
 */

/** Capability for the inference proxy path. */
export const CAP_INFER = "skgateway.infer";
/** Capability for the admin (catalog / advertise / routing) surface. */
export const CAP_ADMIN = "skgateway.admin";

/**
 * Explicit PUBLIC allowlist — unauthenticated infra + discovery + read-only
 * model listing. Each entry is method-aware. `GET` implies `HEAD` for probes.
 *
 * These are public by design TODAY (the gateway already answers them without any
 * identity), so classifying them public preserves flag-off behavior exactly and
 * documents the intent for the coverage gate.
 *
 * @type {Array<{ methods: string[], match: (pathname: string) => boolean, why: string }>}
 */
export const PUBLIC_ROUTES = [
  { methods: ["GET"], match: (p) => p === "/health" || p === "/healthz", why: "liveness probe" },
  { methods: ["GET", "HEAD"], match: (p) => p === "/api/hello", why: "anthropic client connectivity probe" },
  { methods: ["GET"], match: (p) => p === "/status", why: "server + pool status" },
  { methods: ["GET"], match: (p) => p === "/queue", why: "connection-pool depth" },
  { methods: ["GET"], match: (p) => p === "/" || p === "/dashboard", why: "dashboard redirect" },
  { methods: ["GET"], match: (p) => p === "/.well-known/skworld-module.json", why: "module manifest discovery" },
  { methods: ["GET"], match: (p) => p === "/v1/models", why: "read-only model catalog (feeds the picker)" },
  { methods: ["GET"], match: (p) => p.startsWith("/v1/models/"), why: "read-only per-model retrieve" },
];

/**
 * Classify a request into exactly one bucket.
 *
 * Returns one of:
 *   { kind: "public" }                                — no authz needed
 *   { kind: "gated", capability: "skgateway.infer" }  — inference proxy
 *   { kind: "gated", capability: "skgateway.admin" }  — admin surface
 *   { kind: "gated", capability: null }               — a gated prefix with no
 *        mapped capability (must 403 in enforce; surfaces a coverage gap)
 *
 * Method-aware and pathname-only (query strings are stripped by the caller or
 * here). Order matters: the public model-listing GETs are matched BEFORE the
 * generic `/v1/*` → infer rule so a read does not get the write/compute tier.
 *
 * @param {string} method  HTTP method (any case).
 * @param {string} url     Request URL (may carry a query string).
 * @returns {{ kind: "public" } | { kind: "gated", capability: string|null }}
 */
export function classifyRoute(method, url) {
  const m = (method || "GET").toUpperCase();
  const pathname = (url || "/").split("?")[0];

  // 1. Explicit public allowlist (method-aware).
  for (const r of PUBLIC_ROUTES) {
    if (r.methods.includes(m) && r.match(pathname)) return { kind: "public" };
  }

  // 2. Admin surface — every method on /admin/* mutates or reads privileged
  //    catalog/routing state; one capability gates the class.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    return { kind: "gated", capability: CAP_ADMIN };
  }

  // 3. Inference proxy — everything else under /v1/* that is not a public model
  //    GET (handled in step 1) is a spend-compute-as-yourself action.
  if (pathname === "/v1" || pathname.startsWith("/v1/")) {
    return { kind: "gated", capability: CAP_INFER };
  }

  // 4. Anything else is unmapped, non-sensitive infra (a bare unknown path the
  //    proxy will 404). Not an authenticated route; treat as public so flag-off
  //    stays identical and enforce does not 403 a 404.
  return { kind: "public" };
}

/**
 * Resolve the PDP subject from the resolved identity, from the credential-backed
 * registry entry only (never from raw request input). Preference:
 *   1. agent.fqid                       — the sovereign <agent>@<operator>.<realm>
 *   2. agent.capauth_uri (strip scheme) — capauth:lumina@skworld.io → lumina@skworld.io
 *   3. agent_id                          — bare name, last resort
 * Anonymous / unresolved → "" so the PDP denies on an unknown subject (fail closed).
 *
 * @param {{ agent_id?: string, agent?: object }} identity
 * @returns {string}
 */
export function subjectFromIdentity(identity) {
  if (!identity) return "";
  const agent = identity.agent || null;
  if (agent && typeof agent.fqid === "string" && agent.fqid.trim()) return agent.fqid.trim();
  if (agent && typeof agent.capauth_uri === "string" && agent.capauth_uri.trim()) {
    return agent.capauth_uri.trim().replace(/^capauth:/i, "");
  }
  const id = (identity.agent_id || "").trim();
  if (!id || id.toLowerCase() === "anonymous") return "";
  return id;
}
