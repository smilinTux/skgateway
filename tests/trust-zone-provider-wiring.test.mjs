/**
 * trust-zone-provider-wiring.test.mjs: the provider-posture map must reach
 * `deriveTrustZone()` on the REAL catalog build, not just in a fixture.
 *
 * THE BUG THIS LOCKS DOWN. `loadProviderPostures()` shipped with card N2 and
 * was called from nowhere in src/. `buildCapabilityCatalog()` forwarded
 * `{ metrics }` and no `providers` key, so `resolveProviderPosture()` returned
 * null for every entry, so `deriveTrustZone()` could never see
 * `data_retention: 'contractual-zero'` and returned 2 (free-remote) for
 * everything non-local. Anthropic, the ONE provider on this fleet whose terms
 * prohibit training on our content, was classified alongside nvidia,
 * openrouter and opencode, which all do train on submitted content.
 *
 * The consequence was not a wrong label on a dashboard. `internal` maps to a
 * ceiling of zone 1, so with every remote model reading as zone 2, `internal`
 * and `secret` collapsed to the same local-only membership and
 * `sk-xl-internal` could never resolve at all, there being no local XL model.
 * It failed SAFE, which is why nobody noticed, and it made the entire internal
 * tier inert.
 *
 * WHY THESE TESTS AND NOT THE EXISTING ONES. tests/capabilities.test.mjs
 * already asserts zone 1 for a contractual-zero posture, and
 * tests/buckets.test.mjs already asserts an internal bucket keeps a
 * paid-contractual model. Both pass on the broken code, because both HAND
 * INJECT the value: capabilities.test.mjs passes its own `providers` object,
 * and buckets.test.mjs writes `trust_zone` straight into its fixture entries.
 * They assert a number the live code path could not produce. So every test
 * here goes through a real `buildCapabilityCatalog()` call reading the real
 * committed overlay, and each one is paired with a negative control proving it
 * is the posture map doing the work.
 *
 * Run with:  node --test tests/trust-zone-provider-wiring.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pin the router's catalog cache to a fixture BEFORE importing router.mjs,
// which captures MATCH_CATALOG_CACHE_PATH as a module-level constant at import
// time (same convention as tests/router-match.test.mjs).
const FIX_DIR = mkdtempSync(join(tmpdir(), 'skgw-trust-zone-wiring-'));
const CATALOG_CACHE_PATH = join(FIX_DIR, 'model_catalog_cache.json');
process.env.SKGATEWAY_MODEL_CATALOG_CACHE_PATH = CATALOG_CACHE_PATH;

const { buildCapabilityCatalog } = await import('../src/ranking/catalog.mjs');
const { loadProviderPostures } = await import('../src/discovery/provider-posture.mjs');
const { resolveBucket } = await import('../src/policy/buckets.mjs');
const { TRUST_ZONES } = await import('../src/policy/sensitivity.mjs');
const { backendTrustZone, _buildMatchCatalogForTests } = await import('../src/proxy/router.mjs');

/** Injected lifecycle: this suite is about capabilities, not lifecycle state. */
const activeLifecycle = () => ({ state: 'active' });

/**
 * Catalog entries in the shape the real fleet produces. `provider` is the
 * OWNING BACKEND NAME for static models (index.mjs's tagLocalModels) and the
 * discovery provider name for discovered ones, which is exactly what
 * resolveProviderPosture() keys on.
 */
const FLEET = [
  {
    id: 'claude-opus-4-8',
    provider: 'anthropic',
    free: false,
    card: { tier: 'paid-cloud', size_class: 'XL', supported_parameters: ['tools'] },
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic-direct',
    free: false,
    card: { tier: 'paid-cloud', size_class: 'L', supported_parameters: ['tools'] },
  },
  {
    id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
    provider: 'nvidia',
    free: true,
    card: { tier: 'paid-cloud', size_class: 'L' },
  },
  {
    id: 'openrouter/some-paid-route',
    provider: 'openrouter',
    free: false,
    card: { tier: 'paid-cloud', size_class: 'L' },
  },
  {
    id: 'opencode/big-pickle',
    provider: 'opencode',
    free: false,
    card: { tier: 'paid-cloud', size_class: 'L' },
  },
  {
    id: 'ornith-1.0-9b',
    provider: 'local',
    free: true,
    card: { tier: 'local', size_class: 'M' },
  },
];

const zonesById = (catalog) =>
  Object.fromEntries(catalog.map((e) => [e.id, e.capabilities.trust_zone]));

describe('the provider posture map reaches the live catalog build', () => {
  test('a REAL catalog build puts Anthropic in zone 1 and every training provider in zone 2', () => {
    // No `providers` opt. This is precisely how index.mjs's buildRankCatalog()
    // and router.mjs's buildMatchCatalog() call it, so if the default wiring
    // is missing this test fails, which is the whole point of writing it this
    // way rather than passing a posture map in.
    const zones = zonesById(buildCapabilityCatalog(FLEET, { getLifecycleFn: activeLifecycle }));

    assert.equal(
      zones['claude-opus-4-8'], TRUST_ZONES.PAID_CONTRACTUAL,
      'anthropic backend: contractual-zero retention is zone 1, not zone 2',
    );
    assert.equal(
      zones['claude-sonnet-4-6'], TRUST_ZONES.PAID_CONTRACTUAL,
      'anthropic-direct resolves onto the same posture entry as anthropic',
    );

    for (const id of [
      'nvidia/llama-3.3-nemotron-super-49b-v1.5',
      'openrouter/some-paid-route',
      'opencode/big-pickle',
    ]) {
      assert.equal(
        zones[id], TRUST_ZONES.FREE_REMOTE,
        `${id} trains on submitted content, so it must stay zone 2`,
      );
    }

    assert.equal(zones['ornith-1.0-9b'], TRUST_ZONES.SOVEREIGN_LOCAL, 'our own hardware is zone 0');
  });

  test('NEGATIVE CONTROL: with the posture map suppressed, Anthropic falls back to zone 2', () => {
    // This is the OLD behaviour, reproduced deliberately. If this ever agrees
    // with the test above, the assertion above has stopped depending on the
    // posture map and has stopped testing anything.
    const zones = zonesById(
      buildCapabilityCatalog(FLEET, { getLifecycleFn: activeLifecycle, providers: null }),
    );
    assert.equal(
      zones['claude-opus-4-8'], TRUST_ZONES.FREE_REMOTE,
      'no posture map means no contractual-zero evidence, so fail to least-trusted',
    );
    assert.notEqual(
      zones['claude-opus-4-8'],
      buildCapabilityCatalog(FLEET, { getLifecycleFn: activeLifecycle })[0].capabilities.trust_zone,
      'the default and the suppressed case must differ, or the wiring is not doing anything',
    );
  });

  test('the committed overlay is the source of the claim, and it is dated', () => {
    // The zone-1 answer above is only as good as the file it comes from, and a
    // retention claim with no verification date is worthless in six months
    // (card N2's own acceptance criterion). Assert the data, so an edit that
    // quietly drops the posture or the date fails here rather than silently
    // widening or narrowing a sovereignty tier.
    const providers = loadProviderPostures();
    assert.equal(providers.anthropic?.data_retention, 'contractual-zero');
    assert.match(providers.anthropic?.verified || '', /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(providers.anthropic?.ref, 'a retention claim must cite where it came from');
    for (const p of ['nvidia', 'openrouter', 'opencode']) {
      assert.equal(providers[p]?.data_retention, 'trains', `${p} trains on submitted content`);
    }
    assert.equal(providers.local?.data_retention, 'local-only');
  });

  test('the live @match/bucket catalog path gets the same zones as the admin path', () => {
    // router.mjs's buildMatchCatalog() reads the on-disk discovery cache and
    // delegates to the same buildCapabilityCatalog(). Card C7 exists so these
    // two cannot drift; this asserts the posture wiring landed on BOTH sides of
    // that seam rather than only the one this suite happens to call directly.
    writeFileSync(CATALOG_CACHE_PATH, JSON.stringify({ models: FLEET }), 'utf8');
    const live = zonesById(_buildMatchCatalogForTests());
    assert.equal(live['claude-opus-4-8'], TRUST_ZONES.PAID_CONTRACTUAL);
    assert.equal(live['nvidia/llama-3.3-nemotron-super-49b-v1.5'], TRUST_ZONES.FREE_REMOTE);
    assert.equal(live['ornith-1.0-9b'], TRUST_ZONES.SOVEREIGN_LOCAL);
  });
});

describe('the behavioural consequence: the internal tier stops being inert', () => {
  const buildFleet = (opts = {}) =>
    buildCapabilityCatalog(FLEET, { getLifecycleFn: activeLifecycle, ...opts });

  test('an internal bucket now admits Anthropic as well as local', () => {
    // THIS IS A REAL WIDENING, and it is the intended one. Before the wiring,
    // sk-l-internal admitted local models only. It now admits Anthropic too,
    // which is what "internal" was defined to mean all along (ceiling zone 1,
    // paid-contractual allowed) and what it could never actually deliver.
    const { members } = resolveBucket({
      bucket: { model_class: 'L', sensitivity: 'internal' },
      catalog: buildFleet(),
    });
    const ids = members.map((m) => m.id).sort();
    assert.deepEqual(ids, ['claude-opus-4-8', 'claude-sonnet-4-6']);
    assert.ok(
      !ids.includes('nvidia/llama-3.3-nemotron-super-49b-v1.5'),
      'widening internal must not admit a provider that trains',
    );
    // ornith is zone 0 and would qualify on sovereignty, but it is declared M
    // and this is an L floor: the capability floor is unaffected by the zone
    // change, which is the other half of "widened deliberately, not loosened".
    assert.ok(!ids.includes('ornith-1.0-9b'), 'the class floor still applies');
  });

  test('sk-xl-internal can resolve at all now, and could not before', () => {
    // There is no local XL model on this fleet, so with Anthropic misread as
    // zone 2 an XL internal bucket was guaranteed empty: a permanent 503 for a
    // tier the config said was available.
    const bucket = { model_class: 'XL', sensitivity: 'internal' };
    const after = resolveBucket({ bucket, catalog: buildFleet() });
    const before = resolveBucket({ bucket, catalog: buildFleet({ providers: null }) });
    assert.deepEqual(after.members.map((m) => m.id), ['claude-opus-4-8']);
    assert.equal(before.members.length, 0, 'negative control: the old wiring could never fill this bucket');
  });

  test('secret is NOT widened: it stays sovereign-only', () => {
    // The widening must be confined to zone 1. If a contractual-zero provider
    // ever satisfies `secret`, the two tiers have collapsed again in the other
    // direction, which would be strictly worse than the bug being fixed.
    const { members } = resolveBucket({
      bucket: { model_class: 'M', sensitivity: 'secret' },
      catalog: buildFleet(),
    });
    assert.deepEqual(members.map((m) => m.id), ['ornith-1.0-9b']);
  });

  test('internal and secret no longer have identical membership', () => {
    // The single clearest symptom of the bug: two tiers that the policy
    // defines differently resolving to exactly the same pool.
    const catalog = buildFleet();
    const internal = resolveBucket({ bucket: { model_class: 'M', sensitivity: 'internal' }, catalog })
      .members.map((m) => m.id).sort();
    const secret = resolveBucket({ bucket: { model_class: 'M', sensitivity: 'secret' }, catalog })
      .members.map((m) => m.id).sort();
    assert.notDeepEqual(internal, secret);

    const brokenCatalog = buildFleet({ providers: null });
    const brokenInternal = resolveBucket({ bucket: { model_class: 'M', sensitivity: 'internal' }, catalog: brokenCatalog })
      .members.map((m) => m.id).sort();
    const brokenSecret = resolveBucket({ bucket: { model_class: 'M', sensitivity: 'secret' }, catalog: brokenCatalog })
      .members.map((m) => m.id).sort();
    assert.deepEqual(brokenInternal, brokenSecret, 'negative control: they WERE identical before');
  });
});

describe('the catalog and the failover gate now agree about Anthropic', () => {
  test('backendTrustZone and the derived capability zone give the same answer', () => {
    // router.mjs's backendTrustZone() hardcodes /^anthropic/ -> zone 1 for
    // failover-time gating, independently of the catalog. Before this fix the
    // two disagreed: the failover gate called Anthropic zone 1 while the
    // catalog called the same models zone 2, so the same provider was
    // admissible for an `internal` job at failover time and inadmissible at
    // ranking time. They agree now. Neither implementation was changed to make
    // this true, which is the point: wiring the posture map made the derived
    // value match the hand-written one, rather than the hand-written one being
    // bent to match a broken derivation.
    const catalogZone = zonesById(
      buildCapabilityCatalog(FLEET, { getLifecycleFn: activeLifecycle }),
    )['claude-opus-4-8'];

    assert.equal(backendTrustZone({ backendId: 'anthropic', backendUrl: 'https://api.anthropic.com/v1' }), TRUST_ZONES.PAID_CONTRACTUAL);
    assert.equal(backendTrustZone({ backendId: 'anthropic-direct', backendUrl: 'https://api.anthropic.com/v1' }), TRUST_ZONES.PAID_CONTRACTUAL);
    assert.equal(catalogZone, backendTrustZone({ backendId: 'anthropic', backendUrl: 'https://api.anthropic.com/v1' }));

    // And they still agree about a training provider, in the other direction.
    assert.equal(backendTrustZone({ backendId: 'nvidia', backendUrl: 'https://integrate.api.nvidia.com/v1' }), TRUST_ZONES.FREE_REMOTE);
  });
});
