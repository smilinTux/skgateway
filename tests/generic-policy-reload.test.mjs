import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getConfig, loadConfig, reloadConfig } from '../src/config.mjs';
import { orderMembersByGenericWeight } from '../src/policy/buckets.mjs';
import { genericPolicyRevision } from '../src/policy/generic-participation.mjs';

const members = [
  { id: 'deepseek-a', provider: 'deepseek' },
  { id: 'zai-a', provider: 'zai' },
];

function yaml(deepseekWeight, zaiWeight) {
  return `routing:\n  generic_participation:\n    providers:\n      deepseek: { enabled: true, weight: ${deepseekWeight} }\n      zai: { enabled: true, weight: ${zaiWeight} }\n`;
}

test('valid reload changes the next choice while rejected reload preserves policy and revision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skgw-g4-reload-'));
  const path = join(dir, 'gateway.yaml');
  writeFileSync(path, yaml(1, 0));
  await loadConfig({ configPath: path, silent: true });

  const policyA = getConfig().routing.generic_participation;
  const revisionA = genericPolicyRevision(policyA);
  assert.equal(orderMembersByGenericWeight(members, 0, 'sk-l', policyA)[0].provider, 'deepseek');

  writeFileSync(path, yaml('invalid', 1));
  assert.equal(reloadConfig(true).ok, false);
  assert.equal(genericPolicyRevision(getConfig().routing.generic_participation), revisionA);
  assert.equal(
    orderMembersByGenericWeight(members, 0, 'sk-l', getConfig().routing.generic_participation)[0].provider,
    'deepseek',
  );

  writeFileSync(path, yaml(0, 1));
  assert.equal(reloadConfig(true).ok, true);
  const policyC = getConfig().routing.generic_participation;
  assert.notEqual(genericPolicyRevision(policyC), revisionA);
  assert.equal(orderMembersByGenericWeight(members, 0, 'sk-l', policyC)[0].provider, 'zai');
});
