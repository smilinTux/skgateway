/**
 * discovery-refresh-env.test.mjs — SKGATEWAY_MODELS_REFRESH_S override.
 *
 * The dynamic NVIDIA/OpenRouter catalog is re-polled on an interval driven by
 * config.discovery.refresh_seconds (default 3600). Ops must be able to retune
 * that interval from the environment (e.g. shorten it while a provider churns)
 * without editing the yaml. A malformed value must NEVER disable the poller or
 * feed setInterval a NaN/negative delay, so it is ignored and the prior value
 * stands. All hermetic: applyEnvOverrides is pure over a plain config object.
 *
 * Run with:  node --test tests/discovery-refresh-env.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEnvOverrides } from '../src/config.mjs';

function baseCfg() {
  return {
    server: {}, backends: { nvidia: {} }, metrics: {},
    discovery: { enabled: true, refresh_seconds: 3600 },
  };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('SKGATEWAY_MODELS_REFRESH_S overrides discovery.refresh_seconds', () => {
  withEnv({ SKGATEWAY_MODELS_REFRESH_S: '300' }, () => {
    const cfg = applyEnvOverrides(baseCfg());
    assert.equal(cfg.discovery.refresh_seconds, 300);
  });
});

test('unset SKGATEWAY_MODELS_REFRESH_S leaves the configured value intact', () => {
  withEnv({ SKGATEWAY_MODELS_REFRESH_S: undefined }, () => {
    const cfg = applyEnvOverrides(baseCfg());
    assert.equal(cfg.discovery.refresh_seconds, 3600);
  });
});

test('a non-numeric SKGATEWAY_MODELS_REFRESH_S is ignored (poller never disabled)', () => {
  withEnv({ SKGATEWAY_MODELS_REFRESH_S: 'soon' }, () => {
    const cfg = applyEnvOverrides(baseCfg());
    assert.equal(cfg.discovery.refresh_seconds, 3600);
  });
});

test('a zero or negative SKGATEWAY_MODELS_REFRESH_S is ignored', () => {
  withEnv({ SKGATEWAY_MODELS_REFRESH_S: '0' }, () => {
    assert.equal(applyEnvOverrides(baseCfg()).discovery.refresh_seconds, 3600);
  });
  withEnv({ SKGATEWAY_MODELS_REFRESH_S: '-5' }, () => {
    assert.equal(applyEnvOverrides(baseCfg()).discovery.refresh_seconds, 3600);
  });
});

test('override still applies when the config carries no discovery block yet', () => {
  withEnv({ SKGATEWAY_MODELS_REFRESH_S: '120' }, () => {
    const cfg = { server: {}, backends: { nvidia: {} }, metrics: {} };
    const out = applyEnvOverrides(cfg);
    assert.equal(out.discovery.refresh_seconds, 120);
  });
});
