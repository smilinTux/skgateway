import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';

import { mergeDiscoveredCatalog, excludedModelIds, withoutExcludedModels, isCatalogDisabledBackend } from '../src/proxy/advertise.mjs';
import { buildServingCatalog } from '../src/discovery.mjs';
import { resolveBucket } from '../src/policy/buckets.mjs';

const DEAD = ['ornith-1.5-9b', 'ornith-1.0-35b', 'ornith-big', 'ornith-1.0-9b'];
const cfg = yamlLoad(readFileSync(new URL('../config/skgateway.yaml', import.meta.url), 'utf8'));

// mergeDiscoveredCatalog/buildServingCatalog never took an excludedModels
// denylist directly; the already-shipped design (card db431f61 ->
// excludedModelIds/withoutExcludedModels in advertise.mjs, used the same way
// by index.mjs and router.mjs) filters a built catalog through that helper
// pair instead. This test exercises that real call shape rather than an
// API this repo never actually wired in.
test('all dead Ornith ids are absent from advertised and bucket projections', () => {
  assert.deepEqual(cfg.advertise.excluded_models, DEAD);

  // A dead id may still be documented on a backend's `models` list (e.g. the
  // `enabled: false` ornith entry, kept for the history and so re-enabling
  // the backend is a one-line flip) -- isCatalogDisabledBackend/the
  // excluded_models denylist are what keep it out of every catalog, not the
  // absence of the id from a backend's declaration. What must actually be
  // true is: every backend declaring a dead id is catalog-disabled.
  for (const [backendId, backend] of Object.entries(cfg.backends)) {
    const declaresDead = (backend.models || []).some((id) => DEAD.includes(id));
    if (declaresDead) {
      assert.ok(isCatalogDisabledBackend(backend), `${backendId} declares a dead id but is not catalog-disabled`);
    }
  }

  const excluded = excludedModelIds(cfg);
  assert.deepEqual([...excluded].sort(), [...DEAD].sort());

  const staleCache = DEAD.map((id) => ({
    id,
    provider: 'ornith',
    url: 'http://dead.invalid/v1',
    capabilities: { trust_zone: 0, size_class: 'XL', sovereignty: 'local' },
  }));
  const advertised = withoutExcludedModels(mergeDiscoveredCatalog([], staleCache), excluded);
  assert.deepEqual(advertised, []);

  const catalog = withoutExcludedModels(buildServingCatalog({ backends: cfg.backends }), excluded);
  for (const modelClass of ['S', 'M', 'L', 'XL']) {
    for (const sensitivity of ['public', 'internal', 'secret']) {
      const { members } = resolveBucket({ bucket: { model_class: modelClass, sensitivity }, catalog });
      assert.deepEqual(members.filter((m) => DEAD.includes(m.id)), [], `${modelClass}/${sensitivity}`);
    }
  }
});
