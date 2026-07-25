/**
 * reference-adapter.test.mjs - the REFERENCE integration adapter + registry.
 *
 * Verifies the adapter contract that every SKGateway integration must follow:
 *   - disabled by default → fully-shaped no-op ({write,flush,close,enabled:false})
 *   - enabled → records events, honours the ring cap, echoes via injected sink
 *   - write() is fail-safe (never throws), flush/close idempotent
 *   - the adapter registers cleanly with the real SIEM event bus
 *   - the adapter registry builds adapters by `type` and skips unknown types
 *
 * Run with:  node --test tests/reference-adapter.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createReferenceOutput,
  REFERENCE_TYPE,
} from '../src/integrations/reference-adapter.mjs';
import {
  createAdapterRegistry,
  defaultRegistry,
} from '../src/integrations/registry.mjs';
import { createEventBus, createEvent } from '../src/siem/events.mjs';

describe('reference adapter - disabled by default', () => {
  test('no config → no-op adapter with the full contract shape', async () => {
    const out = createReferenceOutput();
    assert.equal(out.enabled, false);
    assert.equal(typeof out.write, 'function');
    assert.equal(typeof out.flush, 'function');
    assert.equal(typeof out.close, 'function');

    // no-op: safe to drive, records nothing
    assert.doesNotThrow(() => out.write({ event_type: 'request' }));
    await out.flush();
    await out.close();
    assert.deepEqual(out.events(), []);
    assert.equal(out.count(), 0);
  });

  test('enabled must be strictly true (truthy strings do not enable)', () => {
    assert.equal(createReferenceOutput({ enabled: 'yes' }).enabled, false);
    assert.equal(createReferenceOutput({ enabled: 1 }).enabled, false);
    assert.equal(createReferenceOutput({ enabled: false }).enabled, false);
  });
});

describe('reference adapter - enabled', () => {
  test('records events and counts them', () => {
    const out = createReferenceOutput({ enabled: true });
    assert.equal(out.enabled, true);
    out.write({ event_type: 'request', severity: 'info' });
    out.write({ event_type: 'error', severity: 'error' });
    assert.equal(out.count(), 2);
    assert.equal(out.events().length, 2);
    assert.equal(out.events()[0].event_type, 'request');
  });

  test('honours the max_keep ring cap while count keeps total', () => {
    const out = createReferenceOutput({ enabled: true, max_keep: 2 });
    out.write({ event_type: 'a' });
    out.write({ event_type: 'b' });
    out.write({ event_type: 'c' });
    assert.equal(out.count(), 3);              // total accepted
    assert.equal(out.events().length, 2);      // ring bounded
    assert.deepEqual(out.events().map((e) => e.event_type), ['b', 'c']);
  });

  test('echo uses the injected sink', () => {
    const lines = [];
    const out = createReferenceOutput(
      { enabled: true, echo: true, label: 'demo' },
      { sink: (l) => lines.push(l) },
    );
    out.write({ event_type: 'policy_violation', severity: 'warning' });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /integration:demo/);
    assert.match(lines[0], /policy_violation/);
  });

  test('write is fail-safe and never throws; close is idempotent', async () => {
    const out = createReferenceOutput({ enabled: true });
    // a value that JSON round-trips fine but exercises the guarded path
    assert.doesNotThrow(() => out.write(null));
    out.write({ event_type: 'ok' });
    await out.close();
    await out.close();                         // idempotent
    assert.deepEqual(out.events(), []);        // ring released on close
    // writes after close are silently ignored, never throw
    assert.doesNotThrow(() => out.write({ event_type: 'late' }));
  });

  test('registers cleanly with the real SIEM event bus', async () => {
    const out = createReferenceOutput({ enabled: true });
    const bus = createEventBus();
    assert.doesNotThrow(() => bus.addOutput(out));
    await bus.emit(createEvent('request', { prompt_class: 'chat' }, { agent_id: 'lumina' }));
    await bus.drain();
    assert.equal(out.count(), 1);
    await bus.close();
  });
});

describe('adapter registry', () => {
  test('register / has / types / build one adapter by type', () => {
    const reg = createAdapterRegistry();
    reg.register('reference', (cfg, deps) => createReferenceOutput(cfg, deps));
    assert.equal(reg.has('reference'), true);
    assert.equal(reg.has('nope'), false);
    assert.deepEqual(reg.types(), ['reference']);

    const built = reg.build({ type: 'reference', enabled: true });
    assert.equal(built.enabled, true);
  });

  test('build returns null for unknown or typeless entries', () => {
    const reg = createAdapterRegistry();
    assert.equal(reg.build({ type: 'unknown' }), null);
    assert.equal(reg.build({}), null);
    assert.equal(reg.build(null), null);
  });

  test('register rejects bad arguments', () => {
    const reg = createAdapterRegistry();
    assert.throws(() => reg.register('', () => {}), TypeError);
    assert.throws(() => reg.register('x', 'not-a-fn'), TypeError);
  });

  test('buildAll builds known types and skips unknown ones', () => {
    const reg = createAdapterRegistry();
    reg.register('reference', (cfg, deps) => createReferenceOutput(cfg, deps));
    const adapters = reg.buildAll([
      { type: 'reference', enabled: true },
      { type: 'reference' },            // disabled → no-op, still built
      { type: 'mystery' },              // unknown → skipped
    ]);
    assert.equal(adapters.length, 2);
    assert.equal(adapters[0].enabled, true);
    assert.equal(adapters[1].enabled, false);
    assert.deepEqual(reg.buildAll('not-an-array'), []);
  });

  test('defaultRegistry ships the built-in SIEM sinks plus reference', () => {
    const reg = defaultRegistry();
    for (const t of ['file', 'syslog', 'elasticsearch', 'opensearch', REFERENCE_TYPE]) {
      assert.equal(reg.has(t), true, `expected built-in type "${t}"`);
    }
    // A disabled elasticsearch entry builds a no-op (no endpoint, disabled).
    const es = reg.build({ type: 'elasticsearch' });
    assert.equal(es.enabled, false);
  });
});
