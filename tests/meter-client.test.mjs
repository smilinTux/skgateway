import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readMeter } from '../src/proxy/meter-client.mjs';

function stubMeter(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

test('readMeter returns the parsed payload', async () => {
  const { srv, port } = await stubMeter((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ counter_j: 1713.2, node: 'dot100', watts_now: 99.1 }));
  });
  const out = await readMeter(`http://127.0.0.1:${port}/energy`, 500);
  srv.close();
  assert.equal(out.counter_j, 1713.2);
  assert.equal(out.node, 'dot100');
});

test('readMeter returns null on a non-200', async () => {
  const { srv, port } = await stubMeter((req, res) => { res.writeHead(500); res.end('nope'); });
  const out = await readMeter(`http://127.0.0.1:${port}/energy`, 500);
  srv.close();
  assert.equal(out, null);
});

test('readMeter returns null on unparseable json', async () => {
  const { srv, port } = await stubMeter((req, res) => { res.writeHead(200); res.end('not json'); });
  const out = await readMeter(`http://127.0.0.1:${port}/energy`, 500);
  srv.close();
  assert.equal(out, null);
});

test('readMeter returns null on a connection refused', async () => {
  // Port 1 is reserved and nothing listens there.
  const out = await readMeter('http://127.0.0.1:1/energy', 300);
  assert.equal(out, null);
});

test('readMeter times out rather than hanging the request', async () => {
  const { srv, port } = await stubMeter(() => { /* never respond */ });
  const t0 = Date.now();
  const out = await readMeter(`http://127.0.0.1:${port}/energy`, 200);
  const elapsed = Date.now() - t0;
  srv.close();
  assert.equal(out, null);
  assert.ok(elapsed < 1000, `should give up fast, took ${elapsed}ms`);
});

test('readMeter returns null for a missing url', async () => {
  assert.equal(await readMeter(null, 200), null);
  assert.equal(await readMeter('', 200), null);
});
