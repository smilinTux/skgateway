import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAllowlist } from '../src/advertise.mjs';

const cat = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('empty allowlist advertises all', () => {
  const out = applyAllowlist(cat, []);
  assert.equal(out.length, 3);
  assert.ok(out.every((m) => m.advertised === true));
});

test('non-empty allowlist filters + flags', () => {
  const out = applyAllowlist(cat, ['a', 'c']);
  assert.deepEqual(out.map((m) => m.id), ['a', 'c']);
  assert.ok(out.every((m) => m.advertised === true));
});
