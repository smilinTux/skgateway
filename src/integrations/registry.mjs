/**
 * registry.mjs - integration adapter registry for SKGateway.
 *
 * Purpose
 * ───────
 * A single, generalised registration point that maps an adapter `type` string
 * to a factory `(config, deps) => OutputAdapter`. Today `src/index.mjs` wires
 * SIEM outputs by hand (`outputs.filter(o => o.type === 'syslog').map(...)`);
 * this registry captures that same shape so ANY integration (not just SIEM
 * sinks) can plug in by `type`, and so future integrations follow one contract.
 *
 * Every registered factory MUST return an object satisfying the OutputAdapter
 * contract documented in `./reference-adapter.mjs`:
 *   { write(event), flush(): Promise, close(): Promise, enabled: boolean }
 * and MUST return a fully-shaped no-op when disabled/misconfigured.
 *
 * Usage
 * ─────
 *   import { defaultRegistry } from './integrations/registry.mjs';
 *
 *   const reg = defaultRegistry();
 *   // Build every enabled adapter declared in config.siem.outputs:
 *   const adapters = reg.buildAll(config.siem?.outputs ?? []);
 *   for (const a of adapters) bus.addOutput(a);
 *
 * Register a NEW integration (see docs/INTEGRATIONS.md):
 *   reg.register('my-webhook', (cfg, deps) => createMyWebhookOutput(cfg, deps));
 *
 * @module integrations/registry
 */

import { createReferenceOutput, REFERENCE_TYPE } from './reference-adapter.mjs';
import { createFileOutput } from '../siem/file.mjs';
import { createSyslogOutput } from '../siem/syslog.mjs';
import { createElasticsearchOutput } from '../siem/elasticsearch.mjs';

/**
 * @typedef {(config: object, deps?: object) => {
 *   write: (event: object) => void,
 *   flush: () => Promise<void>,
 *   close: () => Promise<void>,
 *   enabled?: boolean,
 * }} AdapterFactory
 */

/**
 * @typedef {object} AdapterRegistry
 * @property {(type: string, factory: AdapterFactory) => AdapterRegistry} register  Register a factory for a type (chainable).
 * @property {(type: string) => boolean}                                  has       Whether a type is registered.
 * @property {() => string[]}                                             types     List all registered type keys.
 * @property {(config: object, deps?: object) => object|null}             build     Build one adapter from a config entry (null if type unknown).
 * @property {(entries: object[], deps?: object) => object[]}             buildAll  Build adapters for a list of config entries (skips unknown types).
 */

/**
 * Create an empty adapter registry.
 *
 * @returns {AdapterRegistry}
 */
export function createAdapterRegistry() {
  /** @type {Map<string, AdapterFactory>} */
  const factories = new Map();

  const registry = {
    register(type, factory) {
      if (typeof type !== 'string' || !type) {
        throw new TypeError('register(type, factory): type must be a non-empty string');
      }
      if (typeof factory !== 'function') {
        throw new TypeError(`register("${type}", factory): factory must be a function`);
      }
      factories.set(type, factory);
      return registry;
    },

    has(type) {
      return factories.has(type);
    },

    types() {
      return [...factories.keys()];
    },

    build(config, deps = {}) {
      const type = config?.type;
      const factory = type ? factories.get(type) : undefined;
      if (!factory) return null;
      return factory(config, deps);
    },

    buildAll(entries, deps = {}) {
      if (!Array.isArray(entries)) return [];
      const built = [];
      for (const entry of entries) {
        const adapter = registry.build(entry, deps);
        if (adapter) built.push(adapter);
      }
      return built;
    },
  };

  return registry;
}

/**
 * A registry pre-populated with the built-in SKGateway integration adapters:
 * the SIEM sinks (`file`, `syslog`, `elasticsearch`/`opensearch`) plus the
 * `reference` example adapter. Extend it via `.register(...)` for new
 * integrations.
 *
 * @returns {AdapterRegistry}
 */
export function defaultRegistry() {
  const reg = createAdapterRegistry();
  reg.register('file', (cfg) => createFileOutput(cfg));
  reg.register('syslog', (cfg) => createSyslogOutput(cfg));
  reg.register('elasticsearch', (cfg, deps) => createElasticsearchOutput(cfg, deps));
  reg.register('opensearch', (cfg, deps) => createElasticsearchOutput(cfg, deps));
  reg.register(REFERENCE_TYPE, (cfg, deps) => createReferenceOutput(cfg, deps));
  return reg;
}
