/**
 * Card 94cffe51: the empty XL-secret bucket is an accepted capability gap.
 *
 * This test reads only committed declarations. It must fail when a sovereign
 * XL declaration appears so the recorded decision is reviewed rather than
 * becoming stale silently. The HTTP-level 503 and zero-dispatch contract is
 * pinned separately in bucket-routing-integration.test.mjs.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { load as yamlLoad } from 'js-yaml';

import { resolveBucket } from '../src/policy/buckets.mjs';
import { TRUST_ZONES } from '../src/policy/sensitivity.mjs';

const cards = yamlLoad(
  readFileSync(new URL('../config/model-cards.overrides.yaml', import.meta.url), 'utf8'),
).overrides;

const sovereignCards = Object.entries(cards)
  .filter(([, card]) => card.tier === 'local')
  .map(([id, card]) => ({ id, card }));

test('committed sovereign declarations provide no XL member', () => {
  assert.ok(sovereignCards.length > 0, 'the test must inspect real sovereign declarations');

  for (const { id, card } of sovereignCards) {
    assert.notEqual(card.size_class, 'XL', `${id} would invalidate the accepted-gap decision`);
  }

  const catalog = sovereignCards.map(({ id, card }) => ({
    id,
    capabilities: {
      size_class: card.size_class,
      trust_zone: TRUST_ZONES.SOVEREIGN_LOCAL,
    },
  }));
  const result = resolveBucket({
    bucket: { model_class: 'XL', sensitivity: 'secret' },
    catalog,
  });

  assert.equal(result.ceiling, TRUST_ZONES.SOVEREIGN_LOCAL);
  assert.deepEqual(result.members, [], 'the accepted gap stays empty, never downgraded');
  assert.equal(result.rejected.length, sovereignCards.length);
  assert.ok(result.rejected.every(({ reason }) => reason.includes('below floor XL')));
});

test('a remote XL model cannot fill the secret gap', () => {
  const remoteXl = {
    id: 'remote-xl',
    capabilities: {
      size_class: 'XL',
      trust_zone: TRUST_ZONES.PAID_CONTRACTUAL,
    },
  };
  const result = resolveBucket({
    bucket: { model_class: 'XL', sensitivity: 'secret' },
    catalog: [remoteXl],
  });

  assert.deepEqual(result.members, []);
  assert.match(result.rejected[0].reason, /trust_zone 1 exceeds ceiling 0/);
});

test('only a sovereign XL declaration closes this exact gap', () => {
  const sovereignXl = {
    id: 'future-reviewed-sovereign-xl',
    capabilities: {
      size_class: 'XL',
      trust_zone: TRUST_ZONES.SOVEREIGN_LOCAL,
    },
  };
  const result = resolveBucket({
    bucket: { model_class: 'XL', sensitivity: 'secret' },
    catalog: [sovereignXl],
  });

  assert.deepEqual(result.members.map(({ id }) => id), [sovereignXl.id]);
});
