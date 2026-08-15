/**
 * energy-e2e.test.mjs - the explicit negative-control suite for the joule
 * meter (spec 4.7). This is the P0 blocking gate: P0 is not complete until
 * this file passes.
 *
 * Unlike tests/energy-metering-integration.test.mjs (which drives the live
 * request path through routeAndSend + a stub upstream + a stub skmeter),
 * this file operates directly on marginalJoules / resolveBasis / readMeter
 * with a stub meter whose counter we advance by hand. It answers three
 * narrow questions:
 *
 *   1. A metered backend yields measured_gpu and the exact joule delta.
 *   2. A counter that did not advance yields 0, NOT null, and resolveBasis
 *      still says measured_gpu because the meter did answer. This is the
 *      0-vs-null distinction the whole ledger rests on.
 *   3. NEGATIVE CONTROL: a dead meter yields null energy and never throws.
 *
 * What this file does NOT do, so nobody reads more into it than is here: it
 * routes nothing. There is no router, no backend, no cloud request. The real
 * routed cloud-request negative control (spec 4.7 item 3) lives in
 * scripts/skmeter-validate.sh against live hardware; the routed failover and
 * disabled-path checks live in tests/energy-metering-integration.test.mjs.
 * A gate that names a check it does not perform is this project's own failure
 * family, so the names here describe exactly the arithmetic they exercise.
 *
 * Run with:  node --test tests/energy-e2e.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { marginalJoules, resolveBasis } from '../src/metrics/energy.mjs';
import { readMeter } from '../src/proxy/meter-client.mjs';

// A stub meter whose counter we advance by hand, so we control the "energy".
function stubMeter(state) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ counter_j: state.counter, node: 'stub-node' }));
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

test('a metered backend yields measured_gpu and the exact delta', async () => {
  const state = { counter: 1000 };
  const { srv, port } = await stubMeter(state);
  const url = `http://127.0.0.1:${port}/energy`;

  const before = await readMeter(url, 500);
  state.counter += 1713; // the "inference" happens
  const after = await readMeter(url, 500);
  srv.close();

  const j = marginalJoules(before, after);
  assert.equal(j, 1713);
  assert.equal(resolveBasis({ metered: j !== null, backendIsLocal: true }), 'measured_gpu');
});

test('a counter that did not advance yields 0, not null, and the basis still says the meter answered', async () => {
  // Guards the 0-vs-null distinction, which is the whole ledger's foundation:
  // "the GPU did no work" (0) and "we do not know what the GPU did" (null) are
  // different facts and must never collapse into each other. A metered request
  // whose counter stayed put is the shape a cloud-served request takes at this
  // layer, but nothing here routes anything: this exercises marginalJoules
  // arithmetic and resolveBasis priority, not routing. The routed version of
  // this check runs against live hardware in scripts/skmeter-validate.sh.
  const state = { counter: 4242 };
  const { srv, port } = await stubMeter(state);
  const url = `http://127.0.0.1:${port}/energy`;

  const before = await readMeter(url, 500);
  // No local work happens, so the counter does not advance between reads.
  const after = await readMeter(url, 500);
  srv.close();

  const j = marginalJoules(before, after);
  assert.equal(j, 0, 'a counter that did not move measured zero joules, and zero is a real answer');
  assert.notEqual(j, null, 'zero must not collapse into "unknown"');
  assert.equal(
    resolveBasis({ metered: true, backendIsLocal: false }),
    'measured_gpu',
    'metered wins over locality: the meter answered, so the basis says measured',
  );
});

test('NEGATIVE CONTROL: a dead meter yields null energy and never throws', async () => {
  const before = await readMeter('http://127.0.0.1:1/energy', 200);
  const after = await readMeter('http://127.0.0.1:1/energy', 200);
  assert.equal(marginalJoules(before, after), null);
  assert.equal(resolveBasis({ metered: false, backendIsLocal: false }), 'imputed_cloud');
});
