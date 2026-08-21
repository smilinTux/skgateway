/**
 * match-catalog-serving-config-union.test.mjs: the catalog the router MATCHES
 * against must contain the models the gateway is configured to SERVE.
 *
 * THE BUG THIS LOCKS DOWN. buildMatchCatalog() read the on-disk discovery
 * cache and nothing else. discovery.mjs has three provider adapters (nvidia,
 * openrouter, opencode) and no producer for Anthropic or for our own hardware,
 * so that file could never hold a Claude model or an Ornith model however
 * often it was refreshed. Measured on this node 2026-08-16: 66 models served
 * on /v1/models including ornith-1.0-9b, ornith-tiny and four claude-* ids;
 * 96 models in the cache, 79 nvidia, 16 openrouter, one `local` (id
 * `c3-neutral`, in no current config). The cache mtime was that morning, so it
 * was FRESH and wrong, which is worse than stale and wrong because nothing
 * looked broken.
 *
 * `secret` has a trust-zone ceiling of 0 and `internal` a ceiling of 1, so
 * those two tiers can only be filled by a local model or by Anthropic. With
 * neither in the catalog, sk-*-secret and sk-*-internal find no eligible
 * member and 503 while the zone-2 free-remote cloud buckets resolve fine. The
 * sovereignty feature failed exactly where it mattered.
 *
 * WHY THESE TESTS AND NOT THE EXISTING ONES. tests/buckets.test.mjs writes
 * `trust_zone` straight into its fixture entries and tests/capabilities.test.
 * mjs passes its own providers map, so both assert numbers the live path could
 * not produce; that is exactly how this class of bug survives. Every test here
 * goes through a REAL catalog build, the same discipline as
 * tests/trust-zone-provider-wiring.test.mjs, and asserts trust zones and class
 * floors rather than mere presence. Presence is what a naive test asserts and
 * presence is precisely what passes while the tier is still broken: a model
 * added downstream of applyCardOverlays() has no curated size_class, scores
 * `unknown` in meetsClassFloor(), clears only floor `S`, and so is in the
 * catalog and still absent from every sk-l-secret bucket.
 *
 * Run with:  node --test --import ./tests/_setup.mjs tests/match-catalog-serving-config-union.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pin the router's catalog cache to a fixture BEFORE importing router.mjs,
// which captures MATCH_CATALOG_CACHE_PATH as a module-level constant at import
// time (same convention as tests/trust-zone-provider-wiring.test.mjs).
const FIX_DIR = mkdtempSync(join(tmpdir(), 'skgw-match-union-'));
const CATALOG_CACHE_PATH = join(FIX_DIR, 'model_catalog_cache.json');
process.env.SKGATEWAY_MODEL_CATALOG_CACHE_PATH = CATALOG_CACHE_PATH;

const { buildServingCatalog, servingConfigModels } = await import('../src/discovery.mjs');
const { buildCapabilityCatalog } = await import('../src/ranking/catalog.mjs');
const { resolveBucket, meetsClassFloor } = await import('../src/policy/buckets.mjs');
const { TRUST_ZONES } = await import('../src/policy/sensitivity.mjs');
const { _buildMatchCatalogForTests } = await import('../src/proxy/router.mjs');

/** Injected lifecycle: this suite is about membership, not lifecycle state. */
const activeLifecycle = () => ({ state: 'active' });

/**
 * The shape of this node's real serving config (`~/.skcapstone/gateway/
 * skgateway.yaml`), reduced to what the union reads. Backend NAMES matter:
 * capabilities.mjs's resolveProviderPosture() keys the data_retention posture
 * off them. Urls matter: deriveSovereignty() falls back to isLocalUrl(url) for
 * any model with no operator-declared tier.
 */
const SERVING_BACKENDS = {
  local: {
    url: 'http://192.168.0.100:8082/v1',
    auth_type: 'none',
    models: ['ornith-tiny', 'ornith-1.0-9b', 'qwen3.6-27b-abliterated'],
  },
  'chiap08-qwen38': {
    url: 'http://100.81.238.58:11439/v1',
    auth_type: 'none',
    models: [
      'qwen3.8-27b-huihui-abliterated-q4_k_m',
      'qwen3.8-27b-ud-q5_k_xl',
      'qwen3.8-27b',
      'qwen38-abliterated',
    ],
  },
  nvidia: {
    url: 'https://integrate.api.nvidia.com/v1',
    auth_type: 'api_key',
    // One id that IS in the discovery cache fixture below and one that is not,
    // because on the real node 7 of the 9 declared nvidia ids were absent from
    // the cache while /v1/models advertised all nine.
    models: ['nvidia/llama-3.3-nemotron-super-49b-v1.5', 'minimaxai/minimax-m2.7'],
  },
  anthropic: {
    // The loopback claude-code-api wrapper. auth_type "none" and a 127.0.0.1
    // url, so nothing but the model id marks these as paid.
    url: 'http://127.0.0.1:18782/v1',
    auth_type: 'none',
    models: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  },
  'anthropic-direct': {
    url: 'https://api.anthropic.com/v1',
    auth_type: 'oauth',
    models: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  },
  ollama: {
    url: 'http://192.168.0.100:11434/v1',
    auth_type: 'none',
    models: ['dolphin-*'],
  },
};

/**
 * What the discovery cache actually holds on this node: nvidia + openrouter
 * rows with their adapter cards, and not one sovereign or Anthropic id.
 */
const DISCOVERY_CACHE = {
  models: [
    {
      id: 'nvidia/llama-3.3-nemotron-super-49b-v1.5',
      provider: 'nvidia',
      free: true,
      stale: false,
      // max_output_tokens is deliberately a field the committed overlay does
      // NOT declare for this id, so it can only have come from discovery.
      card: { source: 'heuristic', size_class: 'L', context_length: 131072, max_output_tokens: 4096 },
    },
    {
      id: 'openai/gpt-oss-20b',
      provider: 'nvidia',
      free: true,
      stale: false,
      card: { source: 'heuristic', size_class: 'M' },
    },
    {
      id: 'deepseek/deepseek-r1:free',
      provider: 'openrouter',
      free: true,
      stale: false,
      card: { source: 'openrouter', size_class: 'XL', context_length: 64000 },
    },
    {
      id: 'opencode/big-pickle',
      provider: 'opencode',
      free: true,
      stale: false,
      card: { source: 'models.dev', size_class: 'L' },
    },
  ],
};

const byId = (catalog) => Object.fromEntries(catalog.map((e) => [e.id, e]));

/** A real build: real overlay file, real union, real capability derivation. */
function realCatalog(backends = SERVING_BACKENDS) {
  const models = buildServingCatalog({ cachePath: CATALOG_CACHE_PATH, backends });
  return buildCapabilityCatalog(models, { getLifecycleFn: activeLifecycle });
}

writeFileSync(CATALOG_CACHE_PATH, JSON.stringify(DISCOVERY_CACHE), 'utf8');

describe('the match catalog contains what the gateway is configured to serve', () => {
  test('BOTH HALVES, with correct trust zones: ornith at zone 0 and Claude at zone 1', () => {
    // FAILS ON THE UNFIXED CODE: neither id is in the discovery cache, so the
    // old buildMatchCatalog() produced neither entry at all.
    //
    // The zone is asserted, not just presence. A sovereign model landing at
    // zone 2 is silently excluded from every `secret` bucket, which is the
    // same outcome as not being in the catalog and looks like success.
    const cat = byId(realCatalog());

    assert.ok(cat['ornith-1.0-9b'], 'the sovereign model the fleet actually uses must be matchable');
    assert.equal(
      cat['ornith-1.0-9b'].capabilities.trust_zone, TRUST_ZONES.SOVEREIGN_LOCAL,
      'our own hardware is zone 0, via isLocalUrl on the backend url',
    );
    assert.equal(cat['ornith-1.0-9b'].capabilities.sovereignty, 'local');

    for (const id of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
      assert.ok(cat[id], `${id} is served on /v1/models, so it must be matchable`);
      assert.equal(
        cat[id].capabilities.trust_zone, TRUST_ZONES.PAID_CONTRACTUAL,
        `${id} is paid-contractual (zone 1) via the provider posture, not free-remote`,
      );
    }
  });

  test('the curated class data survives the union: claude-opus-4-8 comes out size_class XL', () => {
    // FAILS ON THE UNFIXED CODE (absent, so size_class is undefined).
    //
    // THIS IS THE ASSERTION THAT CATCHES THE PLACEMENT TRAP. applyCardOverlays()
    // runs when the cache is WRITTEN, not when it is read. A union performed
    // inside router.mjs's buildMatchCatalog(), downstream of the overlay, adds
    // these models with no card: size_class null, meetsClassFloor() basis
    // 'unknown', and an unknown class clears only floor S. Every assertion in
    // the test above would still pass, and sk-l-secret / sk-xl-internal would
    // still be empty. Presence is not the property under test; usable
    // capability metadata is.
    const cat = byId(realCatalog());

    assert.equal(cat['claude-opus-4-8'].capabilities.size_class, 'XL');
    assert.equal(cat['claude-opus-4-7'].capabilities.size_class, 'XL');
    assert.equal(cat['claude-sonnet-4-6'].capabilities.size_class, 'L');
    assert.equal(cat['claude-haiku-4-5'].capabilities.size_class, 'M');
    assert.equal(cat['ornith-1.0-9b'].capabilities.size_class, 'M');

    // And it is usable, not merely present: the floor check agrees.
    const floor = meetsClassFloor(cat['claude-opus-4-8'], 'XL');
    assert.equal(floor.ok, true, 'an XL floor must accept an XL model');
    assert.equal(floor.modelClass, 'XL');
    assert.notEqual(floor.basis, 'unknown', 'basis unknown means the overlay never reached this entry');
  });

  test('NEGATIVE CONTROL on the overlay: a serving model with no card comes out unknown and clears only S', () => {
    // Documents behaviour AND proves the overlay is doing work above rather
    // than everything defaulting to something permissive. `ornith-tiny` is
    // real: it is declared under backends.local on this node, has no entry in
    // config/model-cards.overrides.yaml, and parseParamsFromId('ornith-tiny')
    // yields params_b null, so there is nothing to derive a size from either.
    //
    // The honest answer is `unknown`, and unknown must FAIL CLOSED against any
    // floor above S. Inventing a size_class for it would be the same sin as
    // inventing a joule estimate.
    const cat = byId(realCatalog());

    assert.ok(cat['ornith-tiny'], 'it is served, so it is in the catalog');
    assert.equal(cat['ornith-tiny'].capabilities.size_class, null, 'no overlay entry, no derivable params, no guess');
    assert.equal(cat['ornith-tiny'].capabilities.trust_zone, TRUST_ZONES.SOVEREIGN_LOCAL, 'the ZONE is still right');

    assert.equal(meetsClassFloor(cat['ornith-tiny'], 'S').ok, true, 'S is the floor everything clears');
    for (const floor of ['M', 'L', 'XL']) {
      const r = meetsClassFloor(cat['ornith-tiny'], floor);
      assert.equal(r.ok, false, `an unknown class must not clear floor ${floor}`);
      assert.equal(r.basis, 'unknown');
    }
  });

  test('a model in BOTH sources yields exactly one entry, and keeps the discovered card', () => {
    // nvidia/llama-3.3-nemotron-super-49b-v1.5 is declared in the serving
    // config AND present in the discovery cache. Discovery wins on every field
    // it carries because it is EVIDENCE (a provider-declared or probed card);
    // the serving config is a DECLARATION and supplies only existence plus the
    // fields discovery has no value for.
    const cat = realCatalog();
    const ids = cat.map((e) => e.id);
    assert.equal(ids.length, new Set(ids).size, 'no id may appear twice');
    assert.equal(
      ids.filter((i) => i === 'nvidia/llama-3.3-nemotron-super-49b-v1.5').length, 1,
      'present in both sources, so exactly one entry',
    );

    const entry = byId(cat)['nvidia/llama-3.3-nemotron-super-49b-v1.5'];

    // The merge is FIELD-LEVEL, not whole-entry, so neither side's data is
    // discarded. Fields only discovery carries:
    assert.equal(entry.card.max_output_tokens, 4096, 'the discovered card survives the union');
    assert.equal(entry.stale, false, 'the discovery cycle flag survives');
    // ... and a field only the serving config carries (no adapter emits `url`):
    assert.equal(entry.url, 'https://integrate.api.nvidia.com/v1', 'the serving url survives');
    assert.equal(entry.provider, 'nvidia');

    // card.source is 'manual' rather than 'heuristic' because applyCardOverlay()
    // ENRICHES a heuristic card from the committed overlay and re-tags it, which
    // is its documented job and has nothing to do with this union. Asserted so
    // nobody later reads 'manual' as evidence that the declaration won.
    assert.equal(entry.card.source, 'manual');
    assert.equal(entry.card.context_length, 131072, 'overlay and discovery agree here');

    // claude-opus-4-8 is declared under TWO backends (anthropic and
    // anthropic-direct). Still one entry, and both names resolve onto the same
    // posture, so the zone is the same either way.
    assert.equal(ids.filter((i) => i === 'claude-opus-4-8').length, 1);
  });

  test('a declared-but-undiscovered model is admitted, because it is still served', () => {
    // Measured on the real node: 7 of the 9 ids under backends.nvidia.models
    // were absent from the discovery cache while buildModelCatalog()
    // advertised all nine on /v1/models. advertise.mjs's tagLocalModels()
    // skips the nvidia/openrouter backends, which is right for a display tag
    // and wrong for a match set, so this union reads every backend.
    const cat = byId(realCatalog());
    assert.ok(cat['minimaxai/minimax-m2.7'], 'declared under nvidia, not in the cache, still served');
    assert.equal(cat['minimaxai/minimax-m2.7'].capabilities.trust_zone, TRUST_ZONES.FREE_REMOTE);
  });

  test('wildcards are not model ids and are never admitted', () => {
    // backends.ollama declares "dolphin-*". It is a pattern; matching against
    // it would put a literal asterisk in a routing decision.
    const ids = realCatalog().map((e) => e.id);
    assert.ok(!ids.some((i) => i.includes('*')), 'no pattern may enter the catalog');
  });
});

describe('the union fails closed', () => {
  test('an unreadable serving config yields the discovery cache alone and does not throw', () => {
    // The union must NEVER widen membership on an error path. With no config
    // loaded, getConfig() throws; the result is today's exact behaviour.
    const cacheOnly = buildServingCatalog({ cachePath: CATALOG_CACHE_PATH, backends: {} });
    assert.deepEqual(
      cacheOnly.map((e) => e.id).sort(),
      DISCOVERY_CACHE.models.map((m) => m.id).sort(),
    );

    // Malformed shapes must degrade the same way rather than throw.
    for (const bad of [null, undefined, 'not-an-object', 42, []]) {
      assert.doesNotThrow(() => servingConfigModels(bad), `servingConfigModels(${JSON.stringify(bad)})`);
      assert.deepEqual(servingConfigModels(bad), []);
    }
    assert.doesNotThrow(() => buildServingCatalog({ cachePath: CATALOG_CACHE_PATH, backends: null }));

    // A backend with no models list, a null backend, and a non-string id are
    // all skipped rather than crashing the build.
    assert.deepEqual(
      servingConfigModels({ a: null, b: {}, c: { models: [1, null, 'ok'] } }),
      [{ id: 'ok', provider: 'c', free: true }],
    );
  });

  test('an unreadable discovery cache yields the serving config alone and does not throw', () => {
    const servingOnly = buildServingCatalog({
      cachePath: join(FIX_DIR, 'does-not-exist.json'),
      backends: SERVING_BACKENDS,
    });
    const ids = servingOnly.map((e) => e.id);
    assert.ok(ids.includes('ornith-1.0-9b'));
    assert.ok(ids.includes('claude-opus-4-8'));
    assert.ok(!ids.includes('deepseek/deepseek-r1:free'), 'nothing from the missing cache');
  });

  test('the live buildMatchCatalog() path never throws, whatever the config state', () => {
    // _buildMatchCatalogForTests() is the real router entry point. This suite
    // never calls loadConfig(), so getConfig() throws inside the union and the
    // fail-closed branch is the one actually exercised here.
    let cat;
    assert.doesNotThrow(() => { cat = _buildMatchCatalogForTests(); });
    assert.ok(Array.isArray(cat));
    assert.deepEqual(
      cat.map((e) => e.id).sort(),
      DISCOVERY_CACHE.models.map((m) => m.id).sort(),
      'no config loaded means the discovery cache alone, i.e. the old behaviour exactly',
    );
  });
});

describe('the buckets that could not resolve, now can, and the ones that must not, still do not', () => {
  test('an sk-l-secret bucket is no longer empty', () => {
    // FAILS ON THE UNFIXED CODE: zero members, a permanent 503.
    // The exact Huihui served id and its three aliases are declared under
    // chiap08-qwen38 (a tailscale 100.64/10 address, so isLocalUrl), and the
    // overlay curates all four as size_class L.
    const catalog = realCatalog();
    const { members } = resolveBucket({ bucket: { model_class: 'L', sensitivity: 'secret' }, catalog });
    assert.ok(members.length > 0, 'sk-l-secret must have an eligible member');
    for (const m of members) {
      assert.equal(m.trust_zone, TRUST_ZONES.SOVEREIGN_LOCAL, 'secret admits zone 0 only');
    }
    assert.ok(members.some((m) => m.id.startsWith('qwen3.8-27b')), 'a sovereign L model serves it');
  });

  test('an sk-xl-internal bucket resolves to Anthropic', () => {
    // FAILS ON THE UNFIXED CODE: there is no local XL model on this fleet and
    // no Claude model was in the catalog, so this bucket was guaranteed empty.
    const catalog = realCatalog();
    const { members } = resolveBucket({ bucket: { model_class: 'XL', sensitivity: 'internal' }, catalog });
    const ids = members.map((m) => m.id).sort();
    assert.deepEqual(ids, ['claude-opus-4-7', 'claude-opus-4-8']);
  });

  test('an sk-m-secret bucket resolves to the sovereign 9B', () => {
    const catalog = realCatalog();
    const { members } = resolveBucket({ bucket: { model_class: 'M', sensitivity: 'secret' }, catalog });
    assert.ok(members.map((m) => m.id).includes('ornith-1.0-9b'));
  });

  test('NEGATIVE CONTROL: secret over the UNIONED catalog still excludes every training provider', () => {
    // The union widens the candidate pool, so the ceiling has to be shown
    // still holding over the WIDER set, not just the old one. Every
    // nvidia/openrouter/opencode model must be rejected from a secret bucket
    // at every class floor, with the trust zone as the stated reason.
    const catalog = realCatalog();
    const trainingProviders = new Set(['nvidia', 'openrouter', 'opencode']);
    const trainingIds = catalog
      .filter((e) => trainingProviders.has(e.provider))
      .map((e) => e.id);
    assert.ok(trainingIds.length >= 5, 'the fixture must actually contain training-provider models');

    for (const floor of ['S', 'M', 'L', 'XL']) {
      const { members, rejected } = resolveBucket({
        bucket: { model_class: floor, sensitivity: 'secret' },
        catalog,
      });
      for (const id of trainingIds) {
        assert.ok(!members.some((m) => m.id === id), `${id} must never serve a secret bucket (floor ${floor})`);
        const r = rejected.find((x) => x.id === id);
        assert.ok(r, `${id} must be rejected with a reason`);
        assert.match(r.reason, /trust_zone/, `${id} must be rejected on its ZONE, not incidentally on its class`);
      }
      for (const m of members) {
        assert.equal(m.trust_zone, TRUST_ZONES.SOVEREIGN_LOCAL);
      }
    }
  });

  test('NEGATIVE CONTROL: internal admits Anthropic but no training provider, over the unioned catalog', () => {
    const catalog = realCatalog();
    const { members } = resolveBucket({ bucket: { model_class: 'L', sensitivity: 'internal' }, catalog });
    for (const m of members) {
      assert.ok(
        m.trust_zone <= TRUST_ZONES.PAID_CONTRACTUAL,
        `${m.id} at zone ${m.trust_zone} exceeds the internal ceiling`,
      );
    }
    assert.ok(members.some((m) => m.id === 'claude-sonnet-4-6'), 'internal admits paid-contractual');
    assert.ok(
      !members.some((m) => m.id === 'nvidia/llama-3.3-nemotron-super-49b-v1.5'),
      'internal must not admit a provider that trains, even at a class it clears',
    );
  });

  test('NEGATIVE CONTROL: the union is what does the work, not the fixture', () => {
    // Reproduce the pre-fix world deliberately: cache only, no serving config.
    // If these buckets ever fill from the cache alone, the assertions above
    // have stopped depending on the union and have stopped testing anything.
    const cacheOnly = buildCapabilityCatalog(
      buildServingCatalog({ cachePath: CATALOG_CACHE_PATH, backends: {} }),
      { getLifecycleFn: activeLifecycle },
    );
    for (const bucket of [
      { model_class: 'L', sensitivity: 'secret' },
      { model_class: 'M', sensitivity: 'secret' },
      { model_class: 'XL', sensitivity: 'internal' },
      { model_class: 'L', sensitivity: 'internal' },
    ]) {
      const { members } = resolveBucket({ bucket, catalog: cacheOnly });
      assert.equal(
        members.length, 0,
        `sk-${bucket.model_class.toLowerCase()}-${bucket.sensitivity} was empty before the union`,
      );
    }
    // ... while a public bucket filled fine from the cache alone, which is the
    // asymmetry that made this bug invisible: the feature failed exactly where
    // it mattered and succeeded where it did not.
    const pub = resolveBucket({ bucket: { model_class: 'L', sensitivity: 'public' }, catalog: cacheOnly });
    assert.ok(pub.members.length > 0, 'the cloud tier worked the whole time');
  });
});
