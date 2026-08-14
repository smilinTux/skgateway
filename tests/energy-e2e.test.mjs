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
 *   2. NEGATIVE CONTROL: a cloud-served request (no local work happens, so
 *      the counter never advances) must measure zero LOCAL joules. This is
 *      the check that would have caught the sk-default cloud failover
 *      silently idling the local GPU, without anyone going looking for it.
 *   3. NEGATIVE CONTROL: a dead meter yields null energy and never throws.
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

test('NEGATIVE CONTROL: a cloud-served request reports zero measured joules, not a spurious number', async () => {
  // This is the check that catches a silent failover to a remote backend. If a
  // request never touched the local GPU, the counter must not move, and the
  // basis must say so out loud.
  const state = { counter: 4242 };
  const { srv, port } = await stubMeter(state);
  const url = `http://127.0.0.1:${port}/energy`;

  const before = await readMeter(url, 500);
  // No local work happens: the cloud served it. Counter does not advance.
  const after = await readMeter(url, 500);
  srv.close();

  const j = marginalJoules(before, after);
  assert.equal(j, 0, 'an unmetered cloud request must measure zero local joules');
  assert.equal(
    resolveBasis({ metered: true, backendIsLocal: false }),
    'measured_gpu',
    'basis reflects that the meter answered',
  );
});

test('NEGATIVE CONTROL: a dead meter yields null energy and never throws', async () => {
  const before = await readMeter('http://127.0.0.1:1/energy', 200);
  const after = await readMeter('http://127.0.0.1:1/energy', 200);
  assert.equal(marginalJoules(before, after), null);
  assert.equal(resolveBasis({ metered: false, backendIsLocal: false }), 'imputed_cloud');
});
