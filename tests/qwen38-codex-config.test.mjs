import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { load as parseYaml } from 'js-yaml';

const config = parseYaml(fs.readFileSync(new URL('../config/skgateway-codex.yaml', import.meta.url), 'utf8'));
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/qwen38-codex-config.json', import.meta.url), 'utf8'));

test('codex staged Qwen mapping matches deterministic audited fixture', () => {
  const actual = {
    backends: Object.fromEntries(Object.entries(fixture.backends).map(([id, expected]) => [id, {
      models: config.backends[id].models,
      context_limit: config.backends[id].context_limit,
      provider_purity: config.backends[id].provider_purity,
    }])),
    capacity_domains: Object.fromEntries(Object.entries(fixture.capacity_domains).map(([id, expected]) => [id, {
      members: config.pooling.capacity_domains[id].members,
      max: config.pooling.capacity_domains[id].max,
      maxQueue: config.pooling.capacity_domains[id].maxQueue,
    }])),
  };
  assert.deepEqual(actual, fixture);
});
