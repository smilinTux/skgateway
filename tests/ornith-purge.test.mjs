import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load as yamlLoad } from 'js-yaml';

import { mergeDiscoveredCatalog } from '../src/proxy/advertise.mjs';
import { buildServingCatalog } from '../src/discovery.mjs';
import { resolveBucket } from '../src/policy/buckets.mjs';

const DEAD = ['ornith-1.5-9b', 'ornith-1.0-35b', 'ornith-big', 'ornith-1.0-9b'];
const cfg = yamlLoad(readFileSync(new URL('../config/skgateway.yaml', import.meta.url), 'utf8'));

test('all dead Ornith ids are absent from advertised and bucket projections', () => {
  assert.deepEqual(cfg.advertise.excluded_models, DEAD);
  const declared = Object.values(cfg.backends).flatMap((backend) => backend.models || []);
  assert.deepEqual(declared.filter((id) => DEAD.includes(id)), []);

  const staleCache = DEAD.map((id) => ({
    id,
    provider: 'ornith',
    url: 'http://dead.invalid/v1',
    capabilities: { trust_zone: 0, size_class: 'XL', sovereignty: 'local' },
  }));
  const advertised = mergeDiscoveredCatalog([], staleCache, DEAD);
  assert.deepEqual(advertised, []);

  const catalog = buildServingCatalog({ backends: cfg.backends, excludedModels: DEAD });
  for (const modelClass of ['S', 'M', 'L', 'XL']) {
    for (const sensitivity of ['public', 'internal', 'secret']) {
      const { members } = resolveBucket({ bucket: { model_class: modelClass, sensitivity }, catalog });
      assert.deepEqual(members.filter((m) => DEAD.includes(m.id)), [], `${modelClass}/${sensitivity}`);
    }
  }
});
