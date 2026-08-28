/**
 * bucket-routing-integration.test.mjs: the two sovereignty flags, exercised.
 *
 * THE GAP THIS FILLS. Before this file, `tests/` had ZERO hits for
 * `buckets_enabled` and ZERO for `sensitivity_enforced`. Nothing asserted
 * either 503 body shape, nothing asserted that the shadow-versus-enforce
 * toggle changed any behaviour, and nothing called `resolveBucketCandidates()`
 * at all. Two flags that exist to stop work leaving our hardware had never
 * been switched on by a test, and a client was about to be written against a
 * contract nothing had ever executed.
 *
 * That absence hid two live defects, both found by writing these tests:
 *
 *   1. `resolveBucketCandidates()` referenced `emitSiem`, a `const` declared
 *      inside `routeAndSend`'s body, from a module-level function. Every call
 *      threw `ReferenceError: emitSiem is not defined` before reaching the
 *      fail-closed 503 below. A VALID bucket id failed exactly as hard as an
 *      invalid one, and the bucket layer could not have worked on the day
 *      somebody flipped the flag.
 *
 *   2. A near-miss bucket id (`sk-xl-secrets`) returned 200 from an arbitrary
 *      model. `parseBucketId()` correctly refused it, the bucket branch was
 *      skipped, and `isRegistryRouted()` then caught it on the bare `sk-`
 *      prefix and resolved it through `defaults.role`, which on this fleet is
 *      `sk-auto`, a difficulty classifier. One transposed letter discarded the
 *      capability floor and the trust-zone ceiling, silently.
 *
 * EVERY TOGGLE TEST HERE IS PAIRED WITH ITS NEGATIVE CONTROL. A flag test that
 * would pass with the flag ignored entirely is worthless, and this suite exists
 * precisely because "it passed" had already stopped meaning anything.
 *
 * Run with:  node --test tests/bucket-routing-integration.test.mjs
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Pin every path-based store to an isolated fixture BEFORE importing
// router.mjs, which captures each as a module-level constant at import time
// (same convention as tests/router-match.test.mjs).
const FIX_DIR = mkdtempSync(join(tmpdir(), 'skgw-bucket-integration-'));
const REGISTRY_PATH = join(FIX_DIR, 'registry.yaml');
const STORE_PATH = join(FIX_DIR, 'model_catalog_store.json');
const CATALOG_CACHE_PATH = join(FIX_DIR, 'model_catalog_cache.json');
process.env.SKMODELS_REGISTRY = REGISTRY_PATH;
process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH = STORE_PATH;
process.env.SKGATEWAY_MODEL_CATALOG_CACHE_PATH = CATALOG_CACHE_PATH;

const {
  createRouter,
  routeAndSend,
  requestZoneCeiling,
  bucketLivenessTimeoutMs,
  DEFAULT_BUCKET_LIVENESS_TIMEOUT_MS,
} = await import('../src/proxy/router.mjs');
const { loadConfig } = await import('../src/config.mjs');
const { _resetCacheForTests } = await import('../src/discovery/model_catalog_store.mjs');
const { resetLocalHealth } = await import('../src/proxy/local-failover.mjs');
const { looksLikeBucketAttempt, parseBucketId, allBuckets } = await import('../src/policy/buckets.mjs');

const HEADERS = { 'content-type': 'application/json' };
const bodyFor = (model) => Buffer.from(JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }));

let _cfgSeq = 0;
/**
 * Write a minimal gateway config carrying just the routing flags under test.
 * Deliberately minimal: config.mjs fills the rest from its DEFAULTS, so these
 * tests move exactly one variable at a time.
 */
function writeConfig({ buckets_enabled = false, sensitivity_enforced = false, match_enabled = false } = {}) {
  const p = join(FIX_DIR, `gw-${_cfgSeq++}.yaml`);
  writeFileSync(
    p,
    `routing:\n  buckets_enabled: ${buckets_enabled}\n  sensitivity_enforced: ${sensitivity_enforced}\n  match_enabled: ${match_enabled}\n`,
    'utf8',
  );
  return p;
}

const applyConfig = (flags) => loadConfig({ configPath: writeConfig(flags), silent: true });

/** A fake upstream that answers 200 and records what model it was asked for. */
function startUpstream(name) {
  const state = { count: 0, lastModel: null, modelsStatus: 200, hangCompletions: false };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.endsWith('/models') && req.method === 'GET') {
        res.writeHead(state.modelsStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        state.count++;
        try { state.lastModel = JSON.parse(Buffer.concat(chunks).toString('utf-8')).model ?? null; }
        catch { state.lastModel = null; }
        if (state.hangCompletions) return;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ served: name, model: state.lastModel }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        // 127.0.0.1 is local per isLocalUrl(). Some tests need a NON-local
        // address for the same server, see cloudBase below.
        base: `http://127.0.0.1:${port}/v1`,
        state,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

const parseBody = (r) => JSON.parse(r.body.toString('utf-8'));

// ───────────────────────────────────────────────────────────────────────────
// Pure: which ids count as a missed bucket
// ───────────────────────────────────────────────────────────────────────────

describe('a bucket-shaped id is recognized as an ATTEMPT, not just "unknown"', () => {
  test('the near misses that used to fall through are attempts', () => {
    for (const id of ['sk-xl-secrets', 'sk-xxl-secret', 'sk-l-internals', 'sk-xl-', 'sk--secret', 'SK-XL-SECRETS']) {
      const r = looksLikeBucketAttempt(id);
      assert.equal(r.attempted, true, `${id} must be recognized as a missed bucket`);
      assert.ok(r.reason, 'and it must be able to say which half was wrong');
    }
  });

  test('EVERY live registry role is untouched, which is the part that takes the fleet down if wrong', () => {
    // These are the real ids in ~/.skcapstone/models/registry.yaml. If any one
    // of them starts reading as a bucket attempt, every caller using it gets a
    // 400 and the gateway is down. Conservative by construction: none of them
    // has the three-part sk-<a>-<b> shape at all.
    for (const id of [
      'sk-default', 'sk-auto', 'sk-heavy', 'sk-synth', 'sk-code',
      'sk-vision', 'sk-creative', 'sk-embed', 'ornith-tiny',
    ]) {
      assert.equal(looksLikeBucketAttempt(id).attempted, false, `${id} is a real role and must keep working`);
    }
  });

  test('an ordinary three-part sk- id is not an attempt either', () => {
    // Condition 3 of the check: at least one segment must be real vocabulary.
    // A future role named for what it does, not for a class or a sensitivity,
    // is not somebody missing a bucket.
    for (const id of ['sk-code-review', 'sk-fast-cheap', 'sk-tools-beta']) {
      assert.equal(looksLikeBucketAttempt(id).attempted, false, `${id} is not a bucket attempt`);
    }
  });

  test('a VALID bucket is not an attempt, it is an arrival', () => {
    for (const b of allBuckets()) {
      assert.equal(looksLikeBucketAttempt(b.bucket).attempted, false);
      assert.ok(parseBucketId(b.bucket));
    }
  });

  test('a concrete model id is never an attempt', () => {
    for (const id of ['claude-opus-4-8', 'openai/gpt-oss-20b', 'ornith-1.0-9b', 'big-pickle', '', null, undefined, 42]) {
      assert.equal(looksLikeBucketAttempt(id).attempted, false);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Integration: buckets_enabled
// ───────────────────────────────────────────────────────────────────────────

describe('buckets_enabled: bucket addressing, end to end through routeAndSend', () => {
  let pool;
  let hanging;
  let router;

  const REGISTRY = (extraRoles = '') => `backends:
  poolbackend:
    url: ${pool.base}
    model: pool-l-local
    kind: chat
roles:
  sk-default: poolbackend
${extraRoles}defaults:
  role: sk-default
`;

  /**
   * One sovereign L-class model. Enough to fill sk-l-secret and to leave
   * sk-xl-secret empty, which is the pair the 503 test needs.
   */
  const CATALOG = [
    { id: 'pool-l-local', provider: 'local', free: true, card: { tier: 'local', size_class: 'L' } },
    { id: 'pool-l-free', provider: 'nvidia', free: true, card: { tier: 'free-remote', size_class: 'L' } },
  ];

  before(async () => {
    pool = await startUpstream('pool');
    hanging = await startUpstream('hanging');
    hanging.state.hangCompletions = true;
    writeFileSync(REGISTRY_PATH, REGISTRY(), 'utf8');
    router = createRouter({
      backends: { poolbackend: { url: pool.base, auth_type: 'none', models: ['pool-l-local', 'pool-l-free'], priority: 1 } },
    });
  });

  after(async () => {
    await hanging.close();
    await pool.close();
  });

  beforeEach(() => {
    _resetCacheForTests();
    writeFileSync(STORE_PATH, JSON.stringify({}), 'utf8');
    writeFileSync(CATALOG_CACHE_PATH, JSON.stringify({ models: CATALOG }), 'utf8');
    writeFileSync(REGISTRY_PATH, REGISTRY(), 'utf8');
    pool.state.count = 0;
    pool.state.lastModel = null;
  });

  test('flag ON: a valid bucket resolves to a member and dispatches', async () => {
    // This is also the regression test for the emitSiem ReferenceError: before
    // that fix, resolveBucketCandidates() threw before it could return
    // candidates at all, so this request could not succeed.
    await applyConfig({ buckets_enabled: true });
    const r = await routeAndSend(
      router, { model: 'sk-l-secret', agentId: 't' }, '/chat/completions', 'POST', HEADERS, bodyFor('sk-l-secret'), false,
    );
    assert.equal(r.status, 200, 'a valid bucket must actually route');
    assert.equal(pool.state.count, 1);
    assert.equal(
      pool.state.lastModel, 'pool-l-local',
      'secret admits only the sovereign member, and the body was rewritten to it',
    );
  });

  test('flag ON: an S-graded public request prefers sovereign local over a costlier coin flip', async () => {
    await applyConfig({ buckets_enabled: true });
    const r = await routeAndSend(
      router, { model: 'sk-s-public', agentId: 't' }, '/chat/completions', 'POST', HEADERS, bodyFor('sk-s-public'), false,
    );
    assert.equal(r.status, 200);
    assert.equal(pool.state.lastModel, 'pool-l-local', 'the default starts with the cheapest sovereign tier');
  });

  test('x-sk-prefer keeps an explicit ordered member chain and selects a matching family', async () => {
    writeFileSync(CATALOG_CACHE_PATH, JSON.stringify({ models: [
      {
        id: 'local-a', provider: 'local', free: true,
        card: { family: 'codex', cost_tier: 'local', size_class: 'L' },
      },
      {
        id: 'local-b', provider: 'local', free: true,
        card: { family: 'claude', cost_tier: 'local', size_class: 'L' },
      },
      {
        id: 'paid-c', provider: 'anthropic', free: false,
        card: { family: 'claude', cost_tier: 'paid-cloud', size_class: 'L' },
      },
    ] }), 'utf8');
    _resetCacheForTests();
    const preferenceRouter = createRouter({
      backends: {
        poolbackend: {
          url: pool.base,
          auth_type: 'none',
          models: ['local-a', 'local-b', 'paid-c'],
          priority: 1,
        },
      },
    });
    await applyConfig({ buckets_enabled: true });

    const r = await routeAndSend(
      preferenceRouter,
      { model: 'sk-s-public', agentId: 't', preference: 'claude' },
      '/chat/completions', 'POST', HEADERS, bodyFor('sk-s-public'), false,
    );

    assert.equal(r.status, 200, r.body.toString('utf8'));
    assert.equal(pool.state.lastModel, 'local-b');
    assert.equal(r.bucketMember, 'local-b');
  });

  test('x-sk-prefer cannot promote a family from a costlier tier', async () => {
    writeFileSync(CATALOG_CACHE_PATH, JSON.stringify({ models: [
      {
        id: 'local-a', provider: 'local', free: true,
        card: { family: 'codex', cost_tier: 'local', size_class: 'L' },
      },
      {
        id: 'paid-c', provider: 'anthropic', free: false,
        card: { family: 'claude', cost_tier: 'paid-cloud', size_class: 'L' },
      },
    ] }), 'utf8');
    _resetCacheForTests();
    const costRouter = createRouter({
      backends: {
        poolbackend: {
          url: pool.base,
          auth_type: 'none',
          models: ['local-a', 'paid-c'],
          priority: 1,
        },
      },
    });
    await applyConfig({ buckets_enabled: true });

    const r = await routeAndSend(
      costRouter,
      { model: 'sk-s-public', agentId: 't', preference: 'claude' },
      '/chat/completions', 'POST', HEADERS, bodyFor('sk-s-public'), false,
    );

    assert.equal(r.status, 200, r.body.toString('utf8'));
    assert.equal(pool.state.lastModel, 'local-a');
    assert.equal(r.bucketMember, 'local-a');
  });

  test('invalid preference fails before any upstream launch', async () => {
    await applyConfig({ buckets_enabled: true });
    for (const [model, preference] of [
      ['sk-s-public', 'gpt-5.6-sol'],
      ['sk-s-internal', 'free'],
    ]) {
      const before = pool.state.count;
      const r = await routeAndSend(
        router,
        { model, agentId: 't', preference },
        '/chat/completions', 'POST', HEADERS, bodyFor(model), false,
      );
      assert.equal(r.status, 400);
      assert.equal(parseBody(r).error.type, 'invalid_bucket_preference');
      assert.equal(pool.state.count, before, 'validation failure must dispatch nothing');
    }
  });

  test('the liveness boundary cannot be disabled and preserves a shorter backend timeout', () => {
    assert.equal(bucketLivenessTimeoutMs(0, undefined), DEFAULT_BUCKET_LIVENESS_TIMEOUT_MS);
    assert.equal(bucketLivenessTimeoutMs(0, '0'), DEFAULT_BUCKET_LIVENESS_TIMEOUT_MS);
    assert.equal(bucketLivenessTimeoutMs(0, 'not-a-number'), DEFAULT_BUCKET_LIVENESS_TIMEOUT_MS);
    assert.equal(bucketLivenessTimeoutMs(250, '500'), 250);
    assert.equal(bucketLivenessTimeoutMs(750, '500'), 500);
  });

  test('flag ON: a listed backend that never completes is bounded and the next live member serves', async () => {
    const previousTimeout = process.env.SKGATEWAY_BUCKET_LIVENESS_TIMEOUT_MS;
    process.env.SKGATEWAY_BUCKET_LIVENESS_TIMEOUT_MS = '40';
    const abort = new AbortController();
    const guard = setTimeout(() => abort.abort(), 500);
    try {
      writeFileSync(CATALOG_CACHE_PATH, JSON.stringify({ models: [
        { id: 'hung-local', provider: 'local', free: true, card: { tier: 'local', size_class: 'L' } },
        { id: 'healthy-local', provider: 'local', free: true, card: { tier: 'local', size_class: 'L' } },
      ] }), 'utf8');
      _resetCacheForTests();
      const livenessRouter = createRouter({
        backends: {
          hung: { url: hanging.base, auth_type: 'none', models: ['hung-local'], priority: 1 },
          healthy: { url: pool.base, auth_type: 'none', models: ['healthy-local'], priority: 1 },
        },
      });
      await applyConfig({ buckets_enabled: true });

      const r = await routeAndSend(
        livenessRouter,
        { model: 'sk-s-public', agentId: 't' },
        '/chat/completions', 'POST', HEADERS, bodyFor('sk-s-public'), false, null, abort.signal,
      );

      assert.equal(r.status, 200, 'the hung listed member must not hold the bucket request');
      assert.equal(r.backendId, 'healthy');
      assert.equal(r.bucketMember, 'healthy-local');
      assert.equal(hanging.state.count > 0, true, 'the first member accepted the completion and then hung');

      const hungAttempts = hanging.state.count;
      const r2 = await routeAndSend(
        livenessRouter,
        { model: 'sk-s-public', agentId: 't' },
        '/chat/completions', 'POST', HEADERS, bodyFor('sk-s-public'), false,
      );
      assert.equal(r2.status, 200);
      assert.equal(r2.bucketMember, 'healthy-local');
      assert.equal(
        hanging.state.count,
        hungAttempts,
        'the failed completion probe marks the black hole down, so it cannot win the next selection',
      );

      const r3 = await routeAndSend(
        livenessRouter,
        { model: 'sk-s-public', agentId: 't' },
        '/chat/completions', 'POST', HEADERS, bodyFor('sk-s-public'), false,
      );
      assert.equal(r3.status, 200);
      assert.equal(r3.bucketMember, 'hung-local', 'request three rotates selection back toward the failed member');
      assert.equal(r3.backendId, 'healthy', 'the preserved local URL lets health-aware expansion serve healthy');
      assert.equal(
        hanging.state.count,
        hungAttempts,
        'rotation back toward the black hole skips its down local URL and serves the healthy member',
      );
    } finally {
      clearTimeout(guard);
      if (previousTimeout === undefined) delete process.env.SKGATEWAY_BUCKET_LIVENESS_TIMEOUT_MS;
      else process.env.SKGATEWAY_BUCKET_LIVENESS_TIMEOUT_MS = previousTimeout;
    }
  });

  test('NEGATIVE CONTROL: ordinary named-model routing keeps its existing timeout contract', async () => {
    const namedRouter = createRouter({
      backends: {
        hung: { url: hanging.base, auth_type: 'none', models: ['named-hung'], priority: 1 },
      },
    });
    const abort = new AbortController();
    const guard = setTimeout(() => abort.abort(), 60);
    try {
      await applyConfig({ buckets_enabled: true });
      const r = await routeAndSend(
        namedRouter,
        { model: 'named-hung', agentId: 't' },
        '/chat/completions', 'POST', HEADERS, bodyFor('named-hung'), false, null, abort.signal,
      );
      assert.equal(r.status, 499, 'bucket liveness must not alter explicit named-model traffic');
    } finally {
      clearTimeout(guard);
    }
  });

  test('flag ON: an empty pool returns the exact bucket_no_eligible_member 503 contract', async () => {
    // sk-xl-secret: no sovereign XL model exists, so the pool is empty and the
    // correct answer is a 503 that an operator can act on, not a substitution.
    await applyConfig({ buckets_enabled: true });
    const r = await routeAndSend(
      router, { model: 'sk-xl-secret', agentId: 't' }, '/chat/completions', 'POST', HEADERS, bodyFor('sk-xl-secret'), false,
    );

    assert.equal(r.status, 503);
    assert.equal(r.headers['content-type'], 'application/json');
    const { error } = parseBody(r);
    // The exact shape a client is about to be built against.
    assert.equal(error.type, 'bucket_no_eligible_member');
    assert.equal(error.code, 503);
    assert.equal(error.bucket, 'sk-xl-secret');
    assert.equal(error.model_class, 'XL');
    assert.equal(error.sensitivity, 'secret');
    assert.equal(error.ceiling, 0, 'secret means ceiling zone 0');
    assert.ok(Array.isArray(error.excluded), 'the rejects are the actionable part');
    assert.ok(error.excluded.length > 0, 'an empty pool with no reasons is an outage report, not a decision');
    for (const ex of error.excluded) {
      assert.ok(ex.id, 'each reject names the model');
      assert.ok(ex.reason, 'and why it was excluded');
    }
    assert.equal(pool.state.count, 0, 'NOTHING was dispatched: fail closed means closed');
  });

  test('flag ON: a near-miss bucket id fails with invalid_bucket_id instead of being served', async () => {
    // The measured defect: this used to return 200 from sk-auto's pick.
    await applyConfig({ buckets_enabled: true });
    const r = await routeAndSend(
      router, { model: 'sk-xl-secrets', agentId: 't' }, '/chat/completions', 'POST', HEADERS, bodyFor('sk-xl-secrets'), false,
    );
    assert.equal(r.status, 400, '400 not 503: the address is wrong, and waiting does not fix it');
    const { error } = parseBody(r);
    assert.equal(error.type, 'invalid_bucket_id');
    assert.equal(error.model, 'sk-xl-secrets');
    assert.match(error.reason, /sensitivity "secrets" is not/);
    assert.ok(error.valid_buckets.includes('sk-xl-secret'), 'the caller is told the correction, not left guessing');
    assert.equal(error.valid_buckets.length, 12);
    assert.equal(pool.state.count, 0, 'nothing was routed');
  });

  test('flag ON: the OTHER half of a near miss (bad class, real sensitivity) also fails', async () => {
    await applyConfig({ buckets_enabled: true });
    const r = await routeAndSend(
      router, { model: 'sk-xxl-secret', agentId: 't' }, '/chat/completions', 'POST', HEADERS, bodyFor('sk-xxl-secret'), false,
    );
    assert.equal(r.status, 400);
    assert.match(parseBody(r).error.reason, /model_class "xxl" is not/);
  });

  test('flag ON: real registry roles keep working, which is the blast radius of getting this wrong', async () => {
    await applyConfig({ buckets_enabled: true });
    const r = await routeAndSend(
      router, { model: 'sk-default', agentId: 't' }, '/chat/completions', 'POST', HEADERS, bodyFor('sk-default'), false,
    );
    assert.equal(r.status, 200, 'sk-default must be untouched by the bucket layer');
    assert.equal(pool.state.lastModel, 'pool-l-local');
  });

  test('flag ON: an id the registry explicitly defines is never treated as a typo', async () => {
    // A deliberately-named role that happens to have bucket shape. The
    // registry declaring it is the evidence that it is not a mistake, so it
    // routes rather than 400ing. Without this escape hatch the gate would be a
    // trap for any future sk-<word>-<word> role.
    writeFileSync(REGISTRY_PATH, REGISTRY('  sk-l-fast: poolbackend\n'), 'utf8');
    await applyConfig({ buckets_enabled: true });
    // Sanity: the pure check DOES flag it, so the exemption is doing the work.
    assert.equal(looksLikeBucketAttempt('sk-l-fast').attempted, true);
    const r = await routeAndSend(
      router, { model: 'sk-l-fast', agentId: 't' }, '/chat/completions', 'POST', HEADERS, bodyFor('sk-l-fast'), false,
    );
    assert.equal(r.status, 200, 'a registry-declared role wins over the typo heuristic');
  });

  test('NEGATIVE CONTROL, flag OFF: a bucket id is genuinely NOT a bucket', async () => {
    // So nobody later reads a green suite and assumes the bucket layer has
    // been armed all along. With the flag off, sk-l-secret is an ordinary sk-*
    // id: it falls through to registry routing and is SERVED, with no floor
    // and no ceiling applied. That is today's real behaviour and it is exactly
    // why the flag exists.
    await applyConfig({ buckets_enabled: false });
    const r = await routeAndSend(
      router, { model: 'sk-l-secret', agentId: 't' }, '/chat/completions', 'POST', HEADERS, bodyFor('sk-l-secret'), false,
    );
    assert.equal(r.status, 200, 'flag off means the bucket layer is inert, not enforcing');
    assert.equal(pool.state.count, 1, 'it was routed through the registry default, not gated');
  });

  test('NEGATIVE CONTROL, flag OFF: the typo gate is off too, and still returns 200', async () => {
    // The pre-fix behaviour, pinned. With buckets disabled there is no bucket
    // contract to violate, so sk-xl-secrets keeps falling through. This is the
    // control that proves the 400 above comes from the flag and not from some
    // unrelated id validation.
    await applyConfig({ buckets_enabled: false });
    const r = await routeAndSend(
      router, { model: 'sk-xl-secrets', agentId: 't' }, '/chat/completions', 'POST', HEADERS, bodyFor('sk-xl-secrets'), false,
    );
    assert.equal(r.status, 200);
    assert.notEqual(r.status, 400, 'the 400 must come from buckets_enabled, or it is testing nothing');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Integration: sensitivity_enforced (shadow vs enforce)
// ───────────────────────────────────────────────────────────────────────────

describe('sensitivity_enforced: the cloud-failover gate, shadow versus enforce', () => {
  let local;
  let cloud;
  let cloudBase;
  let router;

  // The failover gate only engages when the registry-resolved backend is
  // local. The FALLBACK must be non-local or backendTrustZone() would call it
  // zone 0 and there would be no boundary to cross. Same server, addressed via
  // 0.0.0.0, which isLocalUrl() does not recognize as private but which still
  // connects to the loopback listener.
  const REGISTRY = () => `backends:
  localbackend:
    url: ${local.base}
    model: local-model
    kind: chat
roles:
  sk-default: localbackend
defaults:
  role: sk-default
`;

  /** A request that DECLARES its sensitivity, the shape index.mjs builds. */
  const secretRequest = () => ({
    model: 'sk-default',
    agentId: 't',
    requirements: { require: { sensitivity: 'secret' } },
  });

  before(async () => {
    local = await startUpstream('local');
    cloud = await startUpstream('cloud');
    cloudBase = `http://0.0.0.0:${cloud.port}/v1`;
    writeFileSync(REGISTRY_PATH, REGISTRY(), 'utf8');
    router = createRouter({
      backends: { cloudbackend: { url: cloudBase, auth_type: 'none', models: ['*'], priority: 9 } },
      failover: true,
    });
  });

  after(async () => { await local.close(); await cloud.close(); });

  beforeEach(() => {
    _resetCacheForTests();
    resetLocalHealth();
    writeFileSync(STORE_PATH, JSON.stringify({}), 'utf8');
    writeFileSync(REGISTRY_PATH, REGISTRY(), 'utf8');
    local.state.count = 0;
    local.state.modelsStatus = 200;
    cloud.state.count = 0;
    cloud.state.lastModel = null;
    delete process.env.SKGATEWAY_LOCAL_FAILOVER;
    process.env.SKGATEWAY_LOCAL_FALLBACK_BACKEND = 'cloudbackend';
    process.env.SKGATEWAY_LOCAL_FALLBACK_MODEL = 'cloud-model';
    process.env.SKGATEWAY_LOCAL_HEALTH_TIMEOUT_MS = '1500';
    process.env.SKGATEWAY_LOCAL_COMPLETION_TIMEOUT_MS = '1500';
    process.env.SKGATEWAY_LOCAL_HEALTH_TTL_MS = '20000';
  });

  test('ENFORCE ON + local down + secret: the exact sensitivity_no_eligible_candidate 503 contract', async () => {
    local.state.modelsStatus = 503; // liveness probe fails, local is unusable
    await applyConfig({ sensitivity_enforced: true });

    const r = await routeAndSend(
      router, secretRequest(), '/chat/completions', 'POST', HEADERS, bodyFor('sk-default'), false,
    );

    assert.equal(r.status, 503);
    assert.equal(r.headers['content-type'], 'application/json');
    const { error } = parseBody(r);
    assert.equal(error.type, 'sensitivity_no_eligible_candidate');
    assert.equal(error.code, 503);
    assert.equal(error.sensitivity, 'secret');
    assert.equal(error.ceiling, 0);
    assert.equal(error.rejected_zone, 2, 'the free-remote fallback is the zone that was refused');
    assert.equal(cloud.state.count, 0, 'the whole point: the request did NOT leave for the cloud');
  });

  test('NEGATIVE CONTROL, ENFORCE OFF: the identical request is served by the cloud fallback', async () => {
    // Same registry, same catalog, same dead local backend, same declared
    // sensitivity. The ONLY difference is the flag. If this returned 503 too,
    // the enforce test above would prove nothing about the flag.
    local.state.modelsStatus = 503;
    await applyConfig({ sensitivity_enforced: false });

    const r = await routeAndSend(
      router, secretRequest(), '/chat/completions', 'POST', HEADERS, bodyFor('sk-default'), false,
    );

    assert.equal(r.status, 200, 'shadow mode logs and does nothing else');
    assert.equal(cloud.state.count, 1, 'in shadow mode the secret request DID cross into zone 2');
    assert.equal(cloud.state.lastModel, 'cloud-model');
  });

  test('ENFORCE ON + local HEALTHY + secret: served locally with the cloud safety net REMOVED', async () => {
    // The other half of enforcement, and the easier one to get wrong: when the
    // sovereign backend is fine, the request is served, but the forbidden
    // fallback must not be sitting behind it as a candidate. A net that
    // violates the constraint is worse than no net.
    await applyConfig({ sensitivity_enforced: true });
    const r = await routeAndSend(
      router, secretRequest(), '/chat/completions', 'POST', HEADERS, bodyFor('sk-default'), false,
    );
    assert.equal(r.status, 200);
    assert.equal(local.state.count, 1, 'the sovereign backend served it');
    assert.equal(cloud.state.count, 0, 'and the forbidden fallback was never a candidate');
  });

  test('ENFORCE ON but NO declared sensitivity: unchanged, because silence is not "secret"', async () => {
    // requestZoneCeiling() returns null for a caller that declared nothing, so
    // the gate does not apply. Making silence mean secret would fail-close the
    // whole fleet on the day it shipped. Pinned so nobody "fixes" it later.
    local.state.modelsStatus = 503;
    await applyConfig({ sensitivity_enforced: true });
    const r = await routeAndSend(
      router, { model: 'sk-default', agentId: 't' }, '/chat/completions', 'POST', HEADERS, bodyFor('sk-default'), false,
    );
    assert.equal(r.status, 200);
    assert.equal(cloud.state.count, 1, 'an undeclared request keeps todays failover behaviour');
  });

  test('ENFORCE ON + public sensitivity: zone 2 is within the ceiling, so the fallback proceeds', async () => {
    // Proves the gate reads the DECLARED level rather than blocking any
    // declaration at all.
    local.state.modelsStatus = 503;
    await applyConfig({ sensitivity_enforced: true });
    const r = await routeAndSend(
      router,
      { model: 'sk-default', agentId: 't', requirements: { require: { sensitivity: 'public' } } },
      '/chat/completions', 'POST', HEADERS, bodyFor('sk-default'), false,
    );
    assert.equal(r.status, 200);
    assert.equal(cloud.state.count, 1, 'public tolerates free-remote');
  });

  test('ENFORCE ON + internal sensitivity: a free-remote fallback is still refused', async () => {
    // internal has ceiling zone 1. The fallback backend here is zone 2, so it
    // is blocked. This is the tier the provider-posture wiring fix widened, and
    // widening it to Anthropic must not have widened it to a training provider.
    local.state.modelsStatus = 503;
    await applyConfig({ sensitivity_enforced: true });
    const r = await routeAndSend(
      router,
      { model: 'sk-default', agentId: 't', requirements: { require: { sensitivity: 'internal' } } },
      '/chat/completions', 'POST', HEADERS, bodyFor('sk-default'), false,
    );
    assert.equal(r.status, 503);
    const { error } = parseBody(r);
    assert.equal(error.type, 'sensitivity_no_eligible_candidate');
    assert.equal(error.sensitivity, 'internal');
    assert.equal(error.ceiling, 1);
    assert.equal(cloud.state.count, 0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The undocumented flag coupling
// ───────────────────────────────────────────────────────────────────────────

describe('sensitivity_enforced is INERT on its own: it needs match_enabled too', () => {
  test('the gate is a no-op for any request without requirements, whatever the flag says', () => {
    // requestZoneCeiling() is the ONLY thing that decides whether the gate
    // applies, and it reads request.requirements.require.sensitivity. No
    // requirements means null means unconstrained, so sensitivity_enforced
    // changes nothing for such a request. (The integration test above proves
    // this end to end: enforce ON, no declared sensitivity, cloud still served
    // the request.)
    assert.equal(requestZoneCeiling({}), null);
    assert.equal(requestZoneCeiling({ model: 'sk-default' }), null);
    assert.equal(requestZoneCeiling({ requirements: {} }), null);
    assert.equal(requestZoneCeiling({ requirements: { require: {} } }), null);

    const zc = requestZoneCeiling({ requirements: { require: { sensitivity: 'secret' } } });
    assert.deepEqual(zc, { ceiling: 0, sensitivity: 'secret' });
  });

  test('THE COUPLING: only match_enabled populates requirements on a live request', () => {
    // src/index.mjs line ~1562 builds the routeRequest and sets
    //   requirements: resolveRequestRequirements(req.headers["x-sk-require"], matchRoutingEnabled)
    // and resolveRequestRequirements() hard-returns undefined while
    // match_enabled is off. So on a real HTTP request, requirements is
    // populated if and only if routing.match_enabled is ON.
    //
    // Therefore sensitivity_enforced ALONE is inert: turning it on without
    // match_enabled arms nothing, and there is no way for the operator to tell.
    // No error, no log line, and the shadow soak reports zero would-be blocks,
    // which reads exactly like "nothing needed blocking". The two flags are
    // coupled and the documented rollout order does not mention it.
    //
    // This is asserted here rather than through index.mjs because importing
    // index.mjs boots a live HTTP server on a fixed port (see
    // tests/header-require.test.mjs, which needs a whole server for it). The
    // observable consequence, that an undeclared request is ungated, is pinned
    // end to end by "ENFORCE ON but NO declared sensitivity" above. The
    // coupling itself is documented in docs/routing-flags.md.
    //
    // matchRoutingEnabled is ALSO captured at module scope in index.mjs, so it
    // does not re-read on a SIGHUP config reload the way isBucketsEnabled() and
    // isSensitivityEnforced() do. Flipping match_enabled needs a restart.
    assert.equal(requestZoneCeiling({ model: 'sk-default' }), null, 'the flag-off request shape is ungated');
  });
});
