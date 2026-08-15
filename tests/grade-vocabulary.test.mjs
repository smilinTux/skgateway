/**
 * The grade vocabulary is shared with the Joule Economy epic in skcapstone,
 * and it has already drifted once: a downstream grading pass labelled the RISK
 * axis with S/M/L/XL, the size vocabulary.
 *
 * That collapse is not cosmetic. The two axes exist to be read apart: "size M,
 * risk crit" says ordinary work with dangerous consequences and calls for a
 * human, while "size M, risk XL" cannot be read at all without knowing the
 * column order. The session that produced it had to add a prose disclaimer
 * ("both XL risks are blast radius, not difficulty") to disambiguate its own
 * table, which is precisely the cost these tests exist to prevent.
 *
 * These assertions are deliberately literal. If someone widens an enum, this
 * fails loudly instead of a second vocabulary quietly appearing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const vocab = JSON.parse(
  readFileSync(join(here, '..', 'docs', 'specs', 'joule-grade-vocabulary.json'), 'utf8'),
);

test('size is exactly S, M, L, XL', () => {
  assert.deepEqual(vocab.size.values, ['S', 'M', 'L', 'XL']);
});

test('risk is exactly low, med, high, crit', () => {
  assert.deepEqual(vocab.risk.values, ['low', 'med', 'high', 'crit']);
});

test('risk NEVER reuses a size label, in any case form', () => {
  const sizeLabels = new Set(vocab.size.values.map((v) => v.toLowerCase()));
  for (const r of vocab.risk.values) {
    assert.equal(
      sizeLabels.has(String(r).toLowerCase()),
      false,
      `risk value ${r} collides with a size label; the axes must stay readable apart`,
    );
  }
});

test('sensitivity is its own axis and is not a rank', () => {
  assert.deepEqual(vocab.sensitivity.values, ['public', 'internal', 'secret']);
  assert.equal(vocab.sensitivity.ranks, undefined, 'sensitivity is not ordered like size and risk');
});

test('the two ranked axes align one to one, which is what makes max() valid', () => {
  const s = Object.values(vocab.size.ranks).sort((a, b) => a - b);
  const r = Object.values(vocab.risk.ranks).sort((a, b) => a - b);
  assert.deepEqual(s, [0, 1, 2, 3]);
  assert.deepEqual(r, [0, 1, 2, 3]);
});

test('model_class is derived by max of the two ranks', () => {
  const CLASS = vocab.model_class.values;
  for (const ex of vocab.model_class.worked_examples) {
    const expected = CLASS[Math.max(vocab.size.ranks[ex.size], vocab.risk.ranks[ex.risk])];
    assert.equal(ex.model_class, expected, `${ex.size}/${ex.risk} should be ${expected}`);
  }
});

test('crit carries the route-to-human rule that XL does not', () => {
  assert.match(vocab.risk.definitions.crit, /Chef/i);
});
