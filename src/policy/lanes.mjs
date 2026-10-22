// lanes.mjs: bind a CARD to provider-neutral LOGICAL ROUTES.
//
// Card f32a2001 (SKRSI-ROUTE-SELECTOR-01). RSI finding from SKLegal c32a1004:
// workers were launched with literal public model names in their briefs and
// stalled or failed, because literal names rot while the catalog stays live.
// The fix sits at the scheduling layer and has three moving parts:
//
//   1. A card carries a SIZE (S, M, L, XL) and an OPTIONAL semantic lane.
//   2. Size + lane resolve DETERMINISTICALLY to an ordered list of logical
//      routes: `sk-s`, `sk-m`, `sk-l` (XL folds onto sk-l, one max class).
//      Provider families are never named and never consulted here.
//   3. The sovereign-corpus lane is OPT-IN through an explicit marker and
//      always leads with the reviewed Qwen logical route. It is never
//      inferred from size, sensitivity, or content heuristics.
//
// Lanes and buckets are DIFFERENT LAYERS. buckets.mjs (card 2ba73bf9) binds a
// live pool to `(model_class, sensitivity)`; this module only decides WHICH
// bucket ids a card may address, in what order, and records why the order is
// what it is. bindRoute() is the single seam between the two: the logical
// route IS the bucket id, parsed with the same strict grammar every request
// already goes through, and resolved with the same resolveBucket() every
// request already uses. One parser, one resolver, no second vocabulary.
//
// The reviewed Qwen route is sk-l. The reviewed sovereign model is the
// Huihui Qwen3.8 27B replica pool (registry backend `qwen38`, canonical card
// `qwen3.8-27b-huihui-abliterated-q4_k_m`, curated size_class L). That
// binding lives in config/ and docs/, OUTSIDE cards and OUTSIDE this module,
// exactly as the card requires: this file names only the logical route.

/**
 * @module policy/lanes
 */

import { isBucketId, parseBucketId, resolveBucket } from './buckets.mjs';

/** Card sizes, verbatim from the canonical grade vocabulary. */
export const CARD_SIZES = Object.freeze(['S', 'M', 'L', 'XL']);

/** Provider-neutral logical routes a card can resolve to. Never a family. */
export const LOGICAL_ROUTES = Object.freeze(['sk-s', 'sk-m', 'sk-l']);

/**
 * Size -> selected logical route. XL folds onto sk-l: the vocabulary exposes
 * one max class, and a route that exists only on paper is a literal name in
 * waiting. Keeping XL a valid CARD size but not a ROUTE keeps briefs stable
 * while the top end re-homes.
 */
export const SIZE_TO_ROUTE = Object.freeze({
  S: 'sk-s',
  M: 'sk-m',
  L: 'sk-l',
  XL: 'sk-l',
});

/**
 * Fallback ladder per selected route: nearest class first, max class last,
 * so a capacity loss degrades to the closest capable lane instead of falling
 * off a cliff. Ordered, deduplicated, deterministic.
 */
export const ROUTE_FALLBACKS = Object.freeze({
  'sk-s': Object.freeze(['sk-s', 'sk-m', 'sk-l']),
  'sk-m': Object.freeze(['sk-m', 'sk-s', 'sk-l']),
  'sk-l': Object.freeze(['sk-l', 'sk-m', 'sk-s']),
});

/**
 * The sovereign-corpus lane always leads with this route: the reviewed Qwen
 * logical route (see module header). Lives here so the choice is written
 * down exactly once.
 */
export const SOVEREIGN_LANE_ROUTE = 'sk-l';

/** Semantic lanes. `general` is what every unmarked card gets. */
export const SEMANTIC_LANES = Object.freeze(['general', 'sovereign-corpus']);

/**
 * Markers that REQUEST the sovereign-corpus lane. The bare alias exists for
 * human-typed cards; `lane:sovereign-corpus` is the canonical form emitted
 * into briefs. Anything else must be refused, never coerced.
 */
export const LANE_MARKERS = Object.freeze({
  'sovereign-corpus': Object.freeze(['lane:sovereign-corpus', 'sovereign-corpus']),
});

/** Canonical marker for a lane, for brief emission; null for `general`. */
export function describeLane(lane) {
  if (lane === 'sovereign-corpus') return LANE_MARKERS['sovereign-corpus'][0];
  return null;
}

const REFUSALS = Object.freeze({
  SIZE_REQUIRED: 'size_required',
  INVALID_SIZE: 'invalid_card_size',
  INVALID_LANE: 'invalid_semantic_lane',
  MARKER_REQUIRED: 'semantic_lane_marker_required',
  INVALID_ROUTE: 'invalid_route',
  ROUTE_UNAVAILABLE: 'route_unavailable',
});

function norm(value) {
  return String(value ?? '').trim();
}

function normUpper(value) {
  return norm(value).toUpperCase();
}

function normLower(value) {
  return norm(value).toLowerCase();
}

/**
 * Does this string carry a literal model-name fingerprint?
 *
 * `glm-4.7`, `qwen3-32b`, `gpt-4o`, `zai/glm-4.7`, `provider:model`. A size
 * or lane input that looks like this is REFUSED, never mapped to the nearest
 * route: guessing a literal name into a lane is exactly the failure mode
 * this module exists to remove.
 */
export function looksLikeLiteralModelId(value) {
  const v = normLower(value);
  if (!v) return false;
  // Our own logical routes are the exact opposite of a literal model name;
  // the -m/-b/-t suffix heuristics below would otherwise flag "sk-m".
  if (LOGICAL_ROUTES.includes(v)) return false;
  if (v.includes('/')) return true;                          // "zai/glm-4.7"
  if (v.includes(':') && !v.startsWith('lane:')) return true; // "provider:model"
  if (/\d/.test(v)) return true;                             // "glm-4.7", "qwen3-32b"
  if (/-(v\d+)$/i.test(v)) return true;                      // "qwen-v1"
  if (/-(\d+k|b|m|t)$/i.test(v)) return true;                // "qwen-32b", "-128k"
  return false;
}

/**
 * Resolve the semantic lane for a card.
 *
 * @param {string|null} [marker] raw lane marker from the card, if any
 * @returns {{ok: true, lane: string, source: string}
 *   |{ok: false, refusal_reason: string, error: string}}
 */
export function resolveLane(marker) {
  const raw = typeof marker === 'string' ? norm(marker) : '';

  if (raw === '') {
    return { ok: true, lane: 'general', source: 'default' };
  }

  const normalized = normLower(raw);
  if (LANE_MARKERS['sovereign-corpus'].includes(normalized)) {
    return { ok: true, lane: 'sovereign-corpus', source: 'explicit marker' };
  }

  if (looksLikeLiteralModelId(raw)) {
    return {
      ok: false,
      refusal_reason: REFUSALS.INVALID_LANE,
      error: `refusing literal model name as lane marker: "${raw}"`,
    };
  }

  if (normalized === 'sovereign' || normalized === 'sovereign-corpus') {
    return {
      ok: false,
      refusal_reason: REFUSALS.MARKER_REQUIRED,
      error: 'sovereign corpus work requires an explicit semantic-lane marker '
        + `(use "${LANE_MARKERS['sovereign-corpus'][0]}"); the lane is never inferred`,
    };
  }

  return {
    ok: false,
    refusal_reason: REFUSALS.INVALID_LANE,
    error: `unknown semantic lane "${raw}"; valid lanes: ${SEMANTIC_LANES.join(', ')}`,
  };
}

/**
 * Resolve card size + semantic lane to an ordered list of provider-neutral
 * logical routes.
 *
 * Deterministic: the same (size, lane) always yields the same order. No
 * provider family is consulted and none is returned. Live binding happens
 * later and outside the card, via bindRoute() and the bucket layer.
 *
 * @param {object} opts
 * @param {string} opts.size card size: S | M | L | XL (case/space tolerant)
 * @param {string|null} [opts.lane] explicit semantic-lane marker, if the card carries one
 * @returns {{
 *   ok: boolean,
 *   size?: string,
 *   lane?: string,
 *   lane_source?: string,
 *   routes?: string[],
 *   selected?: string|null,
 *   fallback_reasons?: Record<string, string>,
 *   refusal_reason?: string,
 *   error?: string
 * }}
 */
export function resolveRoutes({ size, lane = null } = {}) {
  const sizeKey = normUpper(size);

  if (!sizeKey) {
    return {
      ok: false,
      refusal_reason: REFUSALS.SIZE_REQUIRED,
      error: 'card size is required (S, M, L, or XL)',
    };
  }
  if (looksLikeLiteralModelId(sizeKey) || !CARD_SIZES.includes(sizeKey)) {
    const literal = looksLikeLiteralModelId(sizeKey);
    return {
      ok: false,
      refusal_reason: REFUSALS.INVALID_SIZE,
      error: literal
        ? `refusing literal model name "${norm(size)}" as card size; use S, M, L, or XL`
        : `unknown card size "${norm(size)}"; valid sizes: ${CARD_SIZES.join(', ')}`,
    };
  }

  const laneResult = resolveLane(lane);
  if (!laneResult.ok) return laneResult;

  const selected = SIZE_TO_ROUTE[sizeKey];

  // Sovereign corpus: the reviewed Qwen logical route always leads, then the
  // size's ordinary ladder minus what is already present. Deterministic.
  const ladder = ROUTE_FALLBACKS[selected];
  const routes = laneResult.lane === 'sovereign-corpus'
    ? [SOVEREIGN_LANE_ROUTE, ...ladder.filter((r) => r !== SOVEREIGN_LANE_ROUTE)]
    : [...ladder];

  const fallback_reasons = {};
  for (let i = 1; i < routes.length; i++) {
    const route = routes[i];
    if (laneResult.lane === 'sovereign-corpus' && i === 1 && route === ladder[0]) {
      fallback_reasons[route] = 'the card size class leads when the reviewed '
        + `${SOVEREIGN_LANE_ROUTE} route is unavailable`;
    } else if (laneResult.lane === 'sovereign-corpus') {
      fallback_reasons[route] = 'remaining size ladder after the sovereign-corpus route';
    } else {
      fallback_reasons[route] = `fallback for size ${sizeKey}: nearest class first, `
        + `max class last (ladder ${ladder.join(' -> ')})`;
    }
  }

  return {
    ok: true,
    size: sizeKey,
    lane: laneResult.lane,
    lane_source: laneResult.source,
    routes,
    selected,
    fallback_reasons,
  };
}

/**
 * Ordered logical route candidates for a card, or null when the card cannot
 * be routed. Callers that need the reason must call resolveRoutes() instead;
 * this shape is for "give me the list or give me nothing".
 *
 * @param {object} opts see resolveRoutes
 * @returns {string[]|null}
 */
export function routeCandidates(opts) {
  const resolved = resolveRoutes(opts);
  return resolved.ok ? resolved.routes : null;
}

/**
 * Bind a logical route to live catalog members. THE seam to the bucket
 * layer: the route IS the bucket id, parsed with the same strict grammar as
 * a request (`sk-s` == `sk-s-public`), resolved with resolveBucket() and no
 * provider preference, so catalog and lifecycle decide the concrete model.
 *
 * A literal model id is refused, never resolved: `gpt-4o` is not a route.
 * When the caller passes a catalog and the route resolves to no members,
 * the route is reported unavailable (reason `route_unavailable`) instead of
 * an empty success, so callers can walk the fallback ladder.
 *
 * @param {object} args
 * @param {string} args.route logical route (sk-s | sk-m | sk-l)
 * @param {Array<object>} [args.catalog] live catalog entries; omit for a parse-only bind
 * @param {Record<string,number>} [args.sensitivityPolicy] forwarded to resolveBucket
 * @param {(e:object)=>boolean} [args.isRoutable] forwarded to resolveBucket
 * @param {(e:object)=>object|null} [args.getRoutabilityRejection] forwarded to resolveBucket
 * @param {boolean} [args.requireToolUse] forwarded to resolveBucket
 * @returns {{ok: true, route: string, members: Array, rejected: Array, ceiling: number, selected_model: string|null}
 *   |{ok: false, refusal_reason: string, error: string}}
 */
export function bindRoute({
  route, catalog, sensitivityPolicy, isRoutable, getRoutabilityRejection, requireToolUse,
} = {}) {
  const id = normLower(route);
  if (looksLikeLiteralModelId(id)) {
    return {
      ok: false,
      refusal_reason: REFUSALS.INVALID_ROUTE,
      error: `refusing literal model name "${norm(route)}"; use a provider-neutral `
        + `logical route (${LOGICAL_ROUTES.join(', ')})`,
    };
  }
  const parsed = isBucketId(id) ? parseBucketId(id) : null;
  if (!parsed || !LOGICAL_ROUTES.includes(parsed.bucket)) {
    return {
      ok: false,
      refusal_reason: REFUSALS.INVALID_ROUTE,
      error: `"${norm(route)}" is not a logical route (${LOGICAL_ROUTES.join(', ')})`,
    };
  }

  // No catalog: parse-only bind. Callers that only want the bucket address
  // get it without pretending to know live membership.
  if (!Array.isArray(catalog)) {
    return {
      ok: true,
      route: parsed.bucket,
      model_class: parsed.model_class,
      sensitivity: parsed.sensitivity,
      members: [],
      rejected: [],
      ceiling: 0,
      selected_model: null,
      unresolved: true,
    };
  }

  const { members, rejected, ceiling } = resolveBucket({
    bucket: parsed,
    catalog,
    sensitivityPolicy,
    isRoutable,
    getRoutabilityRejection,
    requireToolUse,
  });

  if (members.length === 0) {
    return {
      ok: false,
      refusal_reason: REFUSALS.ROUTE_UNAVAILABLE,
      route: parsed.bucket,
      error: `logical route ${parsed.bucket} has no available model right now `
        + `(${rejected.length} excluded)`,
      rejected,
      ceiling,
    };
  }

  // Served-model attribution: what the pool actually put first. This is the
  // field worker briefs quote, so a brief can say WHICH model answered, not
  // just which lane it asked for.
  return {
    ok: true,
    route: parsed.bucket,
    model_class: parsed.model_class,
    sensitivity: parsed.sensitivity,
    members,
    rejected,
    ceiling,
    selected_model: members[0]?.id ?? null,
  };
}

/**
 * Build the routing section of a worker brief.
 *
 * AC3: briefs carry the ordered logical route candidates, the selected
 * route, the fallback reason for every non-selected candidate, and
 * served-model attribution. Attribution is honest by construction: it is
 * the caller's binding when supplied, else the first live member of the
 * selected route when a catalog is supplied, else null. A brief NEVER
 * invents a served model to fill the field.
 *
 * An unresolvable card (bad size, bad lane, literal model name) produces a
 * brief with routed:false, a machine-readable refusal_reason, and the human
 * error, and NEVER a guessed route.
 *
 * @param {object} opts
 * @param {string} opts.size card size
 * @param {string|null} [opts.lane] explicit semantic-lane marker
 * @param {string|null} [opts.servedModel] known served-model attribution, if a binding already happened
 * @param {Array<object>} [opts.catalog] live catalog; when passed, attribution falls back to the selected route's first member
 * @param {object} [rest] remaining keys forwarded to bindRoute for the fallback attribution
 * @returns {object} brief
 */
export function buildWorkerBrief({ size, lane = null, servedModel = null, catalog, ...rest } = {}) {
  const resolved = resolveRoutes({ size, lane });

  if (!resolved.ok) {
    return {
      routed: false,
      card_size: norm(size) || null,
      semantic_lane: null,
      lane_marker: null,
      route_candidates: [],
      selected_route: null,
      fallback_reasons: {},
      served_model: null,
      refusal_reason: resolved.refusal_reason,
      error: resolved.error,
    };
  }

  let served_model = servedModel ?? null;
  if (served_model == null && Array.isArray(catalog)) {
    const bound = bindRoute({ route: resolved.selected, catalog, ...rest });
    if (bound.ok) served_model = bound.selected_model;
  }

  return {
    routed: true,
    card_size: resolved.size,
    semantic_lane: resolved.lane,
    lane_marker: describeLane(resolved.lane),
    route_candidates: resolved.routes,
    selected_route: resolved.selected,
    fallback_reasons: resolved.fallback_reasons,
    served_model,
  };
}

/**
 * Serialize a worker brief to JSON through the serializer, never string
 * concatenation. Unresolvable cards have no brief to send: they throw, so a
 * half-brief can never be silently embedded in a dispatch payload.
 *
 * @param {object} opts see buildWorkerBrief
 * @returns {string} pretty-printed JSON
 */
export function buildWorkerBriefJson(opts) {
  const brief = buildWorkerBrief(opts);
  if (!brief.routed) {
    throw new Error(`cannot serialize worker brief: ${brief.refusal_reason}: ${brief.error}`);
  }
  return JSON.stringify(brief, null, 2);
}
