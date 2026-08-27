/**
 * Advertised-vs-working reconciliation (card 5c680ee9).
 *
 * The gateway advertises a catalog of models on GET /v1/models, built straight
 * from the committed backend config. But a declared model whose only backend(s)
 * are down or quarantined is not actually usable: advertising it hands callers a
 * model that will fail. This module reconciles the advertised catalog against
 * the router's live health/quarantine signal so callers are not offered dead
 * models.
 *
 * This is a RUNTIME VIEW only. Nothing is deleted from the committed config.
 * When a backend recovers (quarantine cleared, cooldown elapsed, or error-rate
 * status back to up/degraded) Backend.isAvailable() flips true again and the
 * model is re-admitted automatically on the next /v1/models read.
 *
 * Modes (config.advertise.reconcile, alias config.reconcile_advertised):
 *   "flag"  (default) advertise every declared model, annotate each entry with
 *                     status: "available" | "unavailable". Non-breaking: no
 *                     model silently disappears from the catalog.
 *   "hide"            omit models whose every serving backend is unavailable.
 *   "off"             legacy behavior: advertise everything, no status field.
 *
 * Availability composes with the existing quarantine + error-rate health
 * machine via Backend.isAvailable() (down / quarantined / in-cooldown all
 * resolve to false there). It is orthogonal to per-agent routing: the catalog
 * is caller-agnostic, and allowsAgent() still enforces access at call time.
 */

import { isAnthropicBackend, isAnthropicModelId } from "./anthropic-adapter.mjs";
import { isZaiBackend } from "./zai-adapter.mjs";
import { isCodexBackend } from "./codex-adapter.mjs";

/** Valid reconcile modes. */
export const RECONCILE_MODES = new Set(["flag", "hide", "off"]);

/** Default mode: non-breaking (nothing silently disappears). */
export const DEFAULT_RECONCILE_MODE = "flag";

/**
 * Coerce an arbitrary config value into a valid reconcile mode.
 * Unknown / missing values fall back to the safe default ("flag").
 *
 * @param {*} value
 * @returns {"flag"|"hide"|"off"}
 */
export function normalizeReconcileMode(value) {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (RECONCILE_MODES.has(v)) return v;
  }
  return DEFAULT_RECONCILE_MODE;
}

/**
 * Resolve the reconcile mode from a gateway config object.
 * Supports both the nested `advertise.reconcile` key and the flat
 * `reconcile_advertised` alias.
 *
 * @param {object} [config]
 * @returns {"flag"|"hide"|"off"}
 */
export function reconcileModeFromConfig(config = {}) {
  const raw = config?.advertise?.reconcile ?? config?.reconcile_advertised;
  return normalizeReconcileMode(raw);
}

/**
 * Is `model` served by at least one currently-available backend?
 *
 * A backend counts as available per Backend.isAvailable(), which already folds
 * in quarantine (out of rotation until cooldown), the error-rate down/degraded
 * status, and the down cooldown. When the router exposes no health signal, or
 * when no router backend claims the model, we fail OPEN (return true) so the
 * catalog never shrinks on missing signal.
 *
 * @param {string} model
 * @param {?{getHealth?:Function,getBackend?:Function}} router
 * @returns {boolean}
 */
export function isModelAvailable(model, router) {
  if (!router || typeof router.getHealth !== "function" || typeof router.getBackend !== "function") {
    return true;
  }
  let serving = 0;
  for (const id of Object.keys(router.getHealth())) {
    const b = router.getBackend(id);
    if (!b || typeof b.supportsModel !== "function") continue;
    if (!b.supportsModel(model)) continue;
    serving++;
    if (typeof b.isAvailable === "function" && b.isAvailable()) return true;
  }
  // No router-tracked backend serves this model -> cannot judge, assume usable.
  return serving === 0;
}

/**
 * Build the reconciled /v1/models `data` array.
 *
 * Mirrors the legacy catalog construction (dedupe by model id, skip wildcard
 * patterns, owned_by = first declaring backend) and layers the reconcile mode
 * on top.
 *
 * @param {Record<string, {models?: string[]}>} [backends]  config.backends
 * @param {?object} [router]  router instance (getHealth/getBackend), or null
 * @param {string}  [mode]    "flag" | "hide" | "off"
 * @returns {Array<{id:string,object:string,created:number,owned_by:string,status?:string}>}
 */
/**
 * Tag the statically-declared, LOCAL backend models (everything except the
 * nvidia/openrouter live-discovery providers) like a discovery result:
 * `{ id, provider, free }`.
 *
 * `provider` is the OWNING backend name (never a blanket "local"). `free` is
 * decided per model, not by a blanket default:
 *   - a paid cloud backend (isAnthropicBackend: oauth or api.anthropic.com;
 *     isCodexBackend: the ChatGPT-subscription Codex backend), OR
 *   - a paid model family by id (isAnthropicModelId: claude-*), even when the
 *     serving backend is the OpenAI-compatible local Claude wrapper that
 *     isAnthropicBackend() does not flag,
 * is NOT free. Genuinely-local backends (ornith/beellama/ollama/...) stay free.
 * Wildcard entries (e.g. "dolphin-*") are skipped: they are patterns, not ids.
 *
 * @param {Record<string, {models?: string[], url?: string, auth_type?: string}>} [backends]
 * @returns {Array<{id:string, provider:string, free:boolean}>}
 */
export function tagLocalModels(backends = {}) {
  const out = [];
  for (const [name, b] of Object.entries(backends || {})) {
    if (name === "nvidia" || name === "openrouter") continue;
    const paidBackend = isAnthropicBackend(b) || isCodexBackend(b) || isZaiBackend(b);
    for (const id of (b?.models || [])) {
      if (typeof id === "string" && !id.includes("*")) {
        const paid = paidBackend || isAnthropicModelId(id);
        out.push({ id, provider: name, free: !paid });
      }
    }
  }
  return out;
}

/**
 * Merge the reconciled static catalog (buildModelCatalog output: id / object /
 * created / owned_by / status) with the discovery catalog (tagLocalModels +
 * live nvidia/openrouter: id / provider / free / stale), then GUARANTEE every
 * advertised model carries a non-empty `provider`.
 *
 * Discovery tags are layered on top of a reconciled entry of the same id, so a
 * model known to both keeps its health/status AND gains provider/free. A model
 * known only to discovery is admitted with its discovered shape. A model known
 * only to the reconciled static catalog (e.g. a nvidia/openrouter model declared
 * in config but not returned by this cycle's live fetch) never got a discovery
 * `provider`, so we fall back to its owning backend (owned_by), then a literal
 * "discovery". /v1/models must never advertise a blank/undefined provider: the
 * skchat model picker groups by provider, so an untagged model lands in a
 * mystery bucket.
 *
 * @param {Array<object>} [reconciled]
 * @param {Array<object>} [discovered]
 * @returns {Array<object>}
 */
export function mergeDiscoveredCatalog(reconciled = [], discovered = []) {
  const byId = new Map(reconciled.map((m) => [m.id, { ...m }]));
  for (const { id, ...tags } of discovered) {
    const base = byId.get(id) || { id, object: "model", created: 0, owned_by: tags.provider || "discovery" };
    byId.set(id, { ...base, ...tags, id });
  }
  return [...byId.values()].map((m) => ({
    ...m,
    provider: m.provider || m.owned_by || "discovery",
  }));
}

export function buildModelCatalog(backends = {}, router = null, mode = DEFAULT_RECONCILE_MODE) {
  const m = normalizeReconcileMode(mode);
  const seen = new Set();
  const data = [];
  for (const [id, b] of Object.entries(backends || {})) {
    for (const model of (b?.models || [])) {
      if (typeof model !== "string" || model.includes("*") || seen.has(model)) continue;
      seen.add(model);
      const entry = { id: model, object: "model", created: 0, owned_by: id };
      if (m !== "off") {
        const available = isModelAvailable(model, router);
        if (m === "hide" && !available) continue; // omit dead model from catalog
        if (m === "flag") entry.status = available ? "available" : "unavailable";
      }
      data.push(entry);
    }
  }
  return data;
}
