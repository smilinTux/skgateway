/**
 * catalog.mjs (card C7): the ONE place that turns a raw discovered-model list
 * into the ranker's catalog input shape (design 4.1: `{id, free,
 * lifecycle:{state}, capabilities}`).
 *
 * Before this card, index.mjs's `buildRankCatalog()` (the /admin/models/rank
 * suggest-only API, card P3.3) and router.mjs's `buildMatchCatalog()` (the
 * live `@match` routing path, card P4.2) each rebuilt this mapping inline.
 * `buildRankCatalog()` at least accepted an injectable `opts.metricsFn`;
 * `buildMatchCatalog()` did not, it hardcoded `deriveCapabilities(entry,
 * { metrics: {} })`. Two implementations of the same step is exactly the
 * shape that drifts: whichever one somebody wires a real per-model metrics
 * snapshot into first would silently start ranking differently from the
 * other, an operator reading /admin/models/rank would see one ranking, and
 * live @match routing would apply another.
 *
 * Both callers now delegate here. There is only one mapping, so there is
 * nothing left for the two paths to disagree about beyond the CATALOG
 * ENTRIES themselves (the admin path overlays curated cards on top of
 * discovery; the live path reads the on-disk discovery cache directly for
 * P4.2's own reasons, see router.mjs's buildMatchCatalog docstring) and the
 * `metricsFn` each one is given, which as of this card both default to the
 * SAME empty snapshot (no per-model metrics.db resolver has been wired into
 * either path yet, card C7's own reproduction target was the two paths
 * disagreeing on their DEFAULT, not on real data). When one gets a real
 * metricsFn, it is a one-line change to hand the other the same function,
 * because there is only this one place that consumes it.
 *
 * Pure aside from the injected functions, same read-time-injection
 * discipline `capabilities.mjs` and `rank.mjs` are specified to follow
 * (design 6.2: "no daemon, no precomputed leaderboard").
 *
 * @module ranking/catalog
 */

import { deriveCapabilities } from "./capabilities.mjs";

/**
 * @param {Array<object>} entries discovered-model cards (`{id, free, ...}`)
 * @param {{
 *   getLifecycleFn: (id:string) => object,
 *   deriveCapabilitiesFn?: (card:object, opts:object) => object,
 *   metricsFn?: (id:string) => object,
 * }} opts
 *   `getLifecycleFn` is required (callers pass their own `getLifecycle`
 *   import so this module never has to guess a lifecycle store path).
 *   `deriveCapabilitiesFn` defaults to the real `deriveCapabilities`.
 *   `metricsFn` defaults to `() => ({})`: an id with no resolved metrics
 *   snapshot degrades every empirical capability dimension to its prior,
 *   exactly as `capabilities.mjs` documents.
 * @returns {Array<object>}
 */
export function buildCapabilityCatalog(entries, opts = {}) {
  const getLifecycleFn = opts.getLifecycleFn;
  const deriveCapabilitiesFn = opts.deriveCapabilitiesFn || deriveCapabilities;
  const metricsFn = opts.metricsFn || (() => ({}));
  return entries.map((entry) => ({
    ...entry,
    lifecycle: getLifecycleFn(entry.id),
    capabilities: deriveCapabilitiesFn(entry, { metrics: metricsFn(entry.id) }),
  }));
}
