// Tests for src/policy/lanes.mjs, card f32a2001 (SKRSI-ROUTE-SELECTOR-01).
// AC1: S/M/L/XL -> sk-s/sk-m/sk-l, provider-neutral, deterministic.
// AC2: sovereign corpus requires an explicit lane marker and leads with the
//      reviewed Qwen logical route (sk-l).
// AC3: briefs carry ordered candidates, selected route, fallback reasons,
//      and served-model attribution.
// AC4: unavailable routes, fallback ordering, and refusal to guess literal
//      model names.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveRoutes,
  routeCandidates,
  bindRoute,
  buildWorkerBrief,
  buildWorkerBriefJson,
  looksLikeLiteralModelId,
  LANE_MARKERS,
  CARD_SIZES,
  LOGICAL_ROUTES,
} from '../src/policy/lanes.mjs';
import { resolveBucket } from '../src/policy/buckets.mjs';

// A synthetic catalog. IDs carry digits, which is exactly what routes must
// never do: the digit fingerprint is the point.
function okCatalog() {
  return [
    { id: 'glm-4.7', model_class: 'L', sensitivity: 'public', resolution_status: 'active' },
    { id: 'qwen3-32b', model_class: 'M', sensitivity: 'public', resolution_status: 'active' },
    { id: 'gpt-4o', model_class: 'S', sensitivity: 'public', resolution_status: 'active' },
  ];
}

test('AC1: S, M, L, XL all resolve deterministically to neutral sk-* routes', () => {
  for (const size of CARD_SIZES) {
    const r = resolveRoutes({ size });
    assert.ok(r.ok, `size ${size} must resolve`);
    assert.ok(LOGICAL_ROUTES.includes(r.selected), `selected for ${size} must be neutral`);
    assert.ok(r.routes.length >= 2, `size ${size} must have fallback candidates`);
    for (const route of r.routes) {
      assert.match(route, /^sk-(s|m|l)$/, `route ${route} must not name a provider family`);
    }
  }
});

test('AC1: identical input yields identical ordered output (determinism)', () => {
  const a = resolveRoutes({ size: 'M' });
  const b = resolveRoutes({ size: ' m ' });
  assert.deepEqual(a.routes, b.routes);
  assert.equal(a.selected, b.selected);
  assert.deepEqual(a.fallback_reasons, b.fallback_reasons);
});

test('AC1: XL folds onto sk-l, which leads its ladder', () => {
  const r = resolveRoutes({ size: 'XL' });
  assert.equal(r.selected, 'sk-l');
  assert.equal(r.routes[0], 'sk-l');
});

test('AC1: no size means refused, never guessed', () => {
  const r = resolveRoutes({});
  assert.equal(r.ok, false);
  assert.equal(r.refusal_reason, 'size_required');
});

test('AC1: an invalid size is refused with the valid vocabulary in the error', () => {
  const r = resolveRoutes({ size: 'XXL' });
  assert.equal(r.ok, false);
  assert.equal(r.refusal_reason, 'invalid_card_size');
  assert.match(r.error, /S, M, L, or XL/);
});

test('AC1: output never contains a provider family name', () => {
  const families = ['glm', 'qwen', 'gpt', 'codex', 'kimi', 'cursor', 'zai'];
  for (const size of CARD_SIZES) {
    for (const lane of [null, 'lane:sovereign-corpus']) {
      const r = resolveRoutes({ size, lane });
      assert.ok(r.ok);
      const text = JSON.stringify(r).toLowerCase();
      for (const family of families) {
        assert.ok(!text.includes(family), `family name ${family} leaked into routes output`);
      }
    }
    const brief = JSON.stringify(buildWorkerBrief({ size })).toLowerCase();
    for (const family of families) {
      assert.ok(!brief.includes(family), `family name ${family} leaked into brief`);
    }
  }
});

test('AC2: bare sovereign wording without a marker is refused, not inferred', () => {
  const r = resolveRoutes({ size: 'M', lane: 'sovereign' });
  assert.equal(r.ok, false);
  assert.equal(r.refusal_reason, 'semantic_lane_marker_required');
  assert.match(r.error, /explicit semantic-lane marker/);
});

test('AC2: the canonical marker resolves to the sovereign-corpus lane', () => {
  for (const marker of LANE_MARKERS['sovereign-corpus']) {
    const r = resolveRoutes({ size: 'M', lane: marker });
    assert.ok(r.ok, `marker ${marker} must be accepted`);
    assert.equal(r.lane, 'sovereign-corpus');
  }
});

test('AC2: sovereign corpus always leads with the reviewed Qwen logical route', () => {
  for (const size of CARD_SIZES) {
    const r = resolveRoutes({ size, lane: 'lane:sovereign-corpus' });
    assert.ok(r.ok);
    assert.equal(r.routes[0], 'sk-l', `sovereign lane for ${size} must lead with sk-l`);
  }
});

test('AC2: sovereign lane keeps the card size class in the ladder after the lead', () => {
  const r = resolveRoutes({ size: 'S', lane: 'lane:sovereign-corpus' });
  assert.equal(r.routes[0], 'sk-l');
  assert.ok(r.routes.includes('sk-s'));
});

test('AC2: unknown lanes are refused, never coerced to general or sovereign', () => {
  const r = resolveRoutes({ size: 'L', lane: 'cheapseats' });
  assert.equal(r.ok, false);
  assert.equal(r.refusal_reason, 'invalid_semantic_lane');
});

test('AC4: refusal to guess literal model names as sizes', () => {
  for (const size of ['glm-4.7', 'qwen3-32b', 'gpt-4o']) {
    const r = resolveRoutes({ size });
    assert.equal(r.ok, false, `size ${size} must be refused`);
    assert.equal(r.refusal_reason, 'invalid_card_size');
    assert.match(r.error, /refusing literal model name/);
  }
});

test('AC4: refusal to guess literal model names as lane markers', () => {
  const r = resolveRoutes({ size: 'M', lane: 'qwen3.8-27b' });
  assert.equal(r.ok, false);
  assert.equal(r.refusal_reason, 'invalid_semantic_lane');
  assert.match(r.error, /refusing literal model name/);
});

test('AC4: refusal at the bind seam: a literal id is not a route', () => {
  for (const route of ['gpt-4o', 'glm-4.7', 'zai/glm-4.7']) {
    const bound = bindRoute({ route });
    assert.equal(bound.ok, false);
    assert.equal(bound.refusal_reason, 'invalid_route');
  }
});

test('AC4: a route with no live members is unavailable, not an empty success', () => {
  const bound = bindRoute({ route: 'sk-l', catalog: [] });
  assert.equal(bound.ok, false);
  assert.equal(bound.refusal_reason, 'route_unavailable');
});

test('AC4: route_unavailable carries the rejects so the caller can walk the ladder', () => {
  const bound = bindRoute({ route: 'sk-l', catalog: [] });
  assert.ok(Array.isArray(bound.rejected));
});

test('AC4: fingerprint detector classifies names, not routes or lanes', () => {
  assert.equal(looksLikeLiteralModelId('glm-4.7'), true);
  assert.equal(looksLikeLiteralModelId('zai/glm-4.7'), true);
  assert.equal(looksLikeLiteralModelId('gpt-4o'), true);
  assert.equal(looksLikeLiteralModelId('sk-l'), false);
  assert.equal(looksLikeLiteralModelId('sovereign-corpus'), false);
});

test('AC3: brief carries candidates, selected route, fallback reasons, attribution', () => {
  const catalog = okCatalog();
  const brief = buildWorkerBrief({ size: 'L', catalog });
  assert.equal(brief.routed, true);
  assert.deepEqual(brief.route_candidates, ['sk-l', 'sk-m', 'sk-s']);
  assert.equal(brief.selected_route, 'sk-l');
  assert.ok(brief.fallback_reasons['sk-m']);
  assert.ok(brief.fallback_reasons['sk-s']);
  assert.equal(brief.served_model, 'glm-4.7');
});

test('AC3: served-model attribution is explicit when supplied', () => {
  const brief = buildWorkerBrief({ size: 'M', servedModel: 'qwen3-32b' });
  assert.equal(brief.routed, true);
  assert.equal(brief.served_model, 'qwen3-32b');
  assert.equal(brief.lane_marker, null);
});

test('AC3: attribution stays null when nothing is bound yet, never invented', () => {
  const brief = buildWorkerBrief({ size: 'M' });
  assert.equal(brief.routed, true);
  assert.equal(brief.served_model, null);
});

test('AC3: unresolvable cards get routed:false plus refusal_reason, not a guess', () => {
  const brief = buildWorkerBrief({ size: 'glm-4.7' });
  assert.equal(brief.routed, false);
  assert.equal(brief.refusal_reason, 'invalid_card_size');
  assert.deepEqual(brief.route_candidates, []);
  assert.equal(brief.selected_route, null);
  assert.equal(brief.served_model, null);
});

test('AC3: brief JSON serializer refuses to emit an unresolvable brief', () => {
  assert.throws(() => buildWorkerBriefJson({ size: 'nope' }), /invalid_card_size/);
  assert.throws(() => buildWorkerBriefJson({ size: 'M', lane: 'sovereign' }), /marker/);
});

test('AC3: brief JSON parses and matches the brief object', () => {
  const brief = buildWorkerBrief({ size: 'XL', lane: 'lane:sovereign-corpus' });
  const parsed = JSON.parse(buildWorkerBriefJson({ size: 'XL', lane: 'lane:sovereign-corpus' }));
  assert.deepEqual(parsed, brief);
});

test('AC4: fallback ordering is nearest-class-first for every size', () => {
  assert.deepEqual(resolveRoutes({ size: 'S' }).routes, ['sk-s', 'sk-m', 'sk-l']);
  assert.deepEqual(resolveRoutes({ size: 'M' }).routes, ['sk-m', 'sk-s', 'sk-l']);
  assert.deepEqual(resolveRoutes({ size: 'L' }).routes, ['sk-l', 'sk-m', 'sk-s']);
});

test('AC4: bindRoute without a catalog is a parse-only bind', () => {
  const bound = bindRoute({ route: 'sk-m' });
  assert.equal(bound.ok, true);
  assert.equal(bound.unresolved, true);
  assert.equal(bound.selected_model, null);
});

test('AC4: bindRoute walks the same resolveBucket the request path uses', () => {
  const catalog = okCatalog();
  const direct = resolveBucket({
    bucket: { bucket: 'sk-m', model_class: 'M', sensitivity: 'public' },
    catalog,
  });
  const bound = bindRoute({ route: 'sk-m', catalog });
  assert.equal(bound.ok, true);
  assert.deepEqual(bound.members, direct.members);
});

test('routeCandidates: list or nothing, no reasons', () => {
  assert.deepEqual(routeCandidates({ size: 'XL' }), ['sk-l', 'sk-m', 'sk-s']);
  assert.deepEqual(
    routeCandidates({ size: 'M', lane: 'lane:sovereign-corpus' }),
    ['sk-l', 'sk-m', 'sk-s'],
  );
  assert.equal(routeCandidates({ size: 'gpt-4o' }), null);
});
