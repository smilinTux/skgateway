/**
 * registry.mjs — skmodels registry bridge for SKGateway role/context routing.
 *
 * The skmodels registry (~/.skcapstone/models/registry.yaml) is the SINGLE
 * SOURCE OF TRUTH for logical model selection across the SK ecosystem. It maps:
 *
 *   backends: { <name>: { url, model, vision, kind, ... } }
 *   roles:    { sk-default|sk-synth|sk-code|sk-vision|sk-embed -> <backend> }
 *   contexts: { "chat:<id>"|"job:<n>"|"service:<n>"|"agent:<n>" -> role|backend }
 *   defaults: { role: sk-default }
 *
 * Resolution precedence:  context  >  service  >  role  >  default.
 *
 * SKGateway consults this registry when an incoming request opts into logical
 * routing — either the OpenAI `model` field is a role ("sk-*"), or the request
 * carries an `x-sk-context` / `x-sk-role` / `x-sk-service` header. Concrete
 * model names (claude-*, nvidia/*, qwen3.6-27b-abliterated, …) bypass the
 * registry entirely and route via the existing config backends (backward-compat).
 *
 * The file is read live: we stat() it on every resolve and only re-parse when
 * the mtime changes, so `skmodels set <key> <target>` toggles take effect
 * without a gateway restart.
 *
 * @module registry
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";
import { load as yamlLoad } from "js-yaml";

/** Absolute path to the registry file (env override honoured). */
export const REGISTRY_PATH =
  process.env.SKMODELS_REGISTRY ||
  pathResolve(homedir(), ".skcapstone", "models", "registry.yaml");

// mtime-keyed cache — re-parse only when the file actually changes.
let _cache = null;
let _cacheMtime = -1;
let _cachePath = null;

/**
 * Load and parse the registry. Returns a plain object with
 * { backends, roles, contexts, defaults }. Falls back to the last good cache
 * (or an empty registry) on read/parse error so a bad edit never takes the
 * gateway down.
 *
 * @param {string} [path]
 * @returns {{backends:object, roles:object, contexts:object, defaults:object}}
 */
export function loadRegistry(path = REGISTRY_PATH) {
  try {
    const st = statSync(path);
    if (_cache && _cacheMtime === st.mtimeMs && _cachePath === path) {
      return _cache;
    }
    const raw = readFileSync(path, "utf8");
    const parsed = yamlLoad(raw) || {};
    _cache = {
      backends: parsed.backends || {},
      roles: parsed.roles || {},
      contexts: parsed.contexts || {},
      defaults: parsed.defaults || {},
      // Optional tuning block for sk-auto difficulty routing (thresholds +
      // keyword lists). Empty {} => difficulty.mjs uses its built-in defaults.
      auto: parsed.auto || {},
      // Optional failover policy block (card P1.5): `failover.local_fallback`
      // names the LIVE model the local-backend health-aware failover should
      // use, replacing the hardcoded model id that used to live in
      // local-failover.mjs. Empty {} => resolveFailoverCandidates() returns [].
      failover: parsed.failover || {},
      // Optional per-role requirement blocks (card P4.1, design 4.3): keyed
      // by role name, each value is `{require?, prefer?, tier?}`, consumed
      // by the ranker (rank.mjs, card P3.2) for roles whose target is the
      // "@match" marker (see resolve() below). Empty {} => getRequirements()
      // returns null for every role (no @match roles configured).
      requirements: parsed.requirements || {},
    };
    _cacheMtime = st.mtimeMs;
    _cachePath = path;
  } catch (err) {
    if (!_cache) {
      _cache = {
        backends: {},
        roles: {},
        contexts: {},
        defaults: {},
        auto: {},
        failover: {},
        requirements: {},
      };
      _cachePath = path;
    }
    // else: keep the last good cache
  }
  return _cache;
}

/**
 * Return the `auto:` tuning block from the registry (thresholds + keyword
 * lists for sk-auto difficulty routing). Empty object when unset — callers
 * (difficulty.mjs) then fall back to built-in defaults.
 *
 * @param {string} [path]
 * @returns {object}
 */
export function getAutoConfig(path = REGISTRY_PATH) {
  return loadRegistry(path).auto || {};
}

/**
 * Return one role's requirement block from the registry's top-level
 * `requirements:` section (design 4.3), consumed by the ranker (`rank.mjs`,
 * card P3.2) for `@match` roles. Shares `loadRegistry()`'s mtime cache (no
 * extra file read per call).
 *
 * @param {string} role
 * @param {string} [path]  Registry path override (for tests)
 * @returns {{require?:object, prefer?:string[], tier?:string[]}|null}
 *   The role's raw requirement block as parsed from YAML, or `null` when the
 *   role has no `requirements` entry (unknown role, or a role that does not
 *   declare requirements).
 */
export function getRequirements(role, path = REGISTRY_PATH) {
  const { requirements } = loadRegistry(path);
  if (!role || !requirements) return null;
  return Object.prototype.hasOwnProperty.call(requirements, role) ? requirements[role] : null;
}

/**
 * Config epoch = registry file mtime (ms). Changes whenever registry.yaml is
 * edited, so callers can key caches on it for transparent invalidation.
 * @param {string} [path]
 * @returns {number}
 */
export function getConfigEpoch(path = REGISTRY_PATH) {
  loadRegistry(path);
  return _cacheMtime;
}

/**
 * Should this request be routed via the registry?
 * True when the model is a logical role ("sk-*"), a named role-key defined in
 * the registry `roles:` map (e.g. "ornith-tiny"), or any sk routing header is
 * present. Bare concrete model names (e.g. "ornith-1.0-9b") do NOT trigger it.
 *
 * Recognising named role-keys lets a friendly label like `ornith-tiny` inherit
 * full registry treatment: model rewrite to the backend's concrete id AND the
 * per-backend `min_output_tokens` floor (so a thinking model's <think> can't
 * starve `.content` when a caller passes a tiny max_tokens).
 *
 * @param {{model?:string, context?:string, service?:string, role?:string}} req
 * @param {string} [path]  Registry path override (for tests)
 * @returns {boolean}
 */
export function isRegistryRouted({ model, context, service, role } = {}, path = REGISTRY_PATH) {
  if (context || service || role) return true;
  if (typeof model === "string") {
    if (model.startsWith("sk-")) return true;
    const { roles } = loadRegistry(path);
    if (roles && Object.prototype.hasOwnProperty.call(roles, model)) return true;
  }
  return false;
}

/**
 * Resolve a logical request to a concrete backend descriptor, applying
 * precedence context > service > role > default.
 *
 * @param {object} req
 * @param {string} [req.model]    OpenAI model field (may be a role "sk-*")
 * @param {string} [req.context]  x-sk-context header (e.g. "chat:tg-test")
 * @param {string} [req.service]  x-sk-service header (e.g. "skingest.vision")
 * @param {string} [req.role]     x-sk-role header (e.g. "sk-vision")
 * @param {string} [path]         Registry path override (for tests)
 * @returns {null | {
 *   backend: string,
 *   url?: string,
 *   model: string,
 *   vision: boolean,
 *   kind?: string,
 *   anthropic: boolean,
 *   via: 'context'|'service'|'role'|'default',
 *   role: string|null,
 * }}
 *   Returns null when nothing resolves (caller falls back to normal routing).
 */
export function resolve({ model, context, service, role } = {}, path = REGISTRY_PATH) {
  const reg = loadRegistry(path);
  const { backends, roles, contexts, defaults } = reg;

  let target = null;
  let via = null;

  // ── precedence: context > service > role > default ──
  if (context && contexts[context] != null) {
    target = contexts[context];
    via = "context";
  }
  if (target == null && service) {
    const sv = contexts["service:" + service] ?? contexts[service];
    if (sv != null) {
      target = sv;
      via = "service";
    }
  }
  if (target == null && role) {
    target = role;
    via = "role";
  }
  if (target == null && typeof model === "string" && roles[model] != null) {
    target = model;
    via = "role";
  }
  if (target == null) {
    target = defaults.role;
    via = "default";
  }
  if (target == null) return null;

  // `target` may be a role (sk-*) or a concrete backend name.
  let roleName = null;
  let backendName = target;
  if (roles[target] != null) {
    roleName = target;
    backendName = roles[target];
  }

  // ── sk-auto marker ──
  // The registry defines `roles: { sk-auto: auto }`. "auto" is NOT a real
  // backend — it signals the gateway to run the difficulty classifier and
  // resolve the CONCRETE role per-request. Surface an auto marker; the gateway
  // (routeAndSend) classifies then calls resolve() again with a real role.
  if (roleName === "sk-auto" || backendName === "auto" || target === "sk-auto") {
    return {
      auto: true,
      backend: "auto",
      model: null,
      vision: false,
      anthropic: false,
      via,
      role: "sk-auto",
    };
  }

  // ── @match marker (card P4.1, design 4.3) ──
  // A role's target may be the literal string "@match" instead of a backend
  // name, e.g. `roles: { sk-tools: "@match" }`. Exactly parallel to the
  // sk-auto marker above: "@match" is NOT a real backend, it signals the
  // gateway to rank candidates by the role's `requirements:` block (the
  // ranker, rank.mjs card P3.2) instead of resolving a single pinned
  // backend. Surfacing `requirements` here too (in addition to the standalone
  // getRequirements() export) saves the caller (router.mjs, card P4.2) a
  // second registry lookup.
  if (backendName === "@match" || target === "@match") {
    const matchRole = roleName || target;
    return {
      match: true,
      backend: null,
      model: null,
      vision: false,
      anthropic: false,
      via,
      role: matchRole,
      requirements: getRequirements(matchRole, path),
    };
  }

  const bcfg = backends[backendName] || null;

  // Anthropic / Opus special-case: route via the gateway's own anthropic
  // backend (do NOT honour any registry url that would loop back to :18780).
  const anthropic =
    backendName === "opus" ||
    backendName === "claude" ||
    (bcfg && (bcfg.kind === "anthropic" || String(bcfg.url || "").includes("anthropic")));

  if (anthropic) {
    return {
      backend: backendName,
      model: (bcfg && bcfg.model) || "claude-opus-4-8",
      vision: false,
      anthropic: true,
      via,
      role: roleName,
    };
  }

  if (!bcfg || !bcfg.url) return null;

  return {
    backend: backendName,
    url: bcfg.url,
    model: bcfg.model,
    vision: !!bcfg.vision,
    kind: bcfg.kind,
    minOutputTokens: (bcfg && bcfg.min_output_tokens) || 0,
    // Card ba782c14: this backend must never be substituted by the cloud
    // failover. Opt-in per backend, so absent means false and failover keeps
    // its existing behaviour everywhere it is not declared.
    noFailover: !!(bcfg && bcfg.no_failover),
    anthropic: false,
    via,
    role: roleName,
  };
}

/**
 * Resolve `registry.failover.local_fallback` (card P1.5) into an ordered
 * list of candidate `{ model, backend }` pairs for the local-backend
 * health-aware failover (`proxy/local-failover.mjs`). This replaces the
 * hardcoded cloud fallback model id that used to live in that module.
 *
 * `failover.local_fallback` may be:
 *   - a single string, or
 *   - an array of strings (ordered preference; local-failover.mjs picks the
 *     first one whose lifecycle is `active`, see `model_catalog_store.mjs`).
 *
 * Each string names either:
 *   - a role declared in `roles:`, resolved to its backend's concrete
 *     `model` (and the backend name, so local-failover.mjs knows which
 *     router backend serves it), or
 *   - a concrete model id used as-is (`backend: null`; the router backend
 *     that serves it is left to `SKGATEWAY_LOCAL_FALLBACK_BACKEND` / the
 *     caller's own default).
 *
 * Never throws: an unset/empty/malformed `failover` block yields `[]`.
 *
 * @param {string} [path]  Registry path override (for tests)
 * @returns {{model: string, backend: string|null}[]}
 */
export function resolveFailoverCandidates(path = REGISTRY_PATH) {
  const { roles, backends, failover } = loadRegistry(path);
  const raw = failover && failover.local_fallback;
  if (raw == null) return [];
  const names = Array.isArray(raw) ? raw : [raw];

  const out = [];
  for (const name of names) {
    if (typeof name !== "string" || !name.trim()) continue;
    const backendName = roles && Object.prototype.hasOwnProperty.call(roles, name) ? roles[name] : null;
    const bcfg = backendName ? backends && backends[backendName] : null;
    if (bcfg && bcfg.model) {
      out.push({ model: bcfg.model, backend: backendName });
      continue;
    }
    // Not a known role (or its backend has no concrete model): treat the
    // name itself as a concrete model id.
    out.push({ model: name, backend: null });
  }
  return out;
}
