/**
 * lifecycle-presence-and-isolation.test.mjs
 *
 * Covers the two fixes for the 2026-08-14 catalog inversion, where the
 * lifecycle store had drifted into the exact opposite of the truth: 83 models
 * live in a provider catalog were marked eol and hidden, while 7 the provider
 * had retired were marked active and advertised.
 *
 *   Card 7330bb05 / C1  sliceByProvider ignored config-declared ids, so a model
 *                       declared in backends.<provider>.models but never
 *                       returned by a live fetch could not accumulate
 *                       absent_cycles and was immune to retirement.
 *   Card affa0aac / C2  unit tests wrote into the production store, and an
 *                       `eol` record with no prior verification could never be
 *                       promoted by catalog presence, so it stayed hidden
 *                       forever even while the provider served it every cycle.
 *
 * Each fix gets a NEGATIVE CONTROL: a test that fails if the fix is reverted.
 * Both bugs survived a green suite for weeks precisely because the existing
 * tests asserted the happy path only.
 *
 * Run with:  node --test tests/lifecycle-presence-and-isolation.test.mjs
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { discoverCatalog } from '../src/discovery.mjs';
import {
  getLifecycle,
  recordModelOutcome,
  assertNotProductionStoreInTest,
  PRODUCTION_STORE_PATH,
  _resetCacheForTests,
} from '../src/discovery/model_catalog_store.mjs';
import {
  applyCatalogPresence,
  defaultLifecycle,
  LIFECYCLE_STATES,
  THRESHOLDS,
} from '../src/discovery/lifecycle.mjs';

const DIR = mkdtempSync(join(tmpdir(), 'skgw-presence-isolation-'));
let _seq = 0;
const freshPath = () => join(DIR, `store-${_seq++}.json`);

beforeEach(() => _resetCacheForTests());

// ─── C1: config-declared ids enter presence reconciliation ───────────────────

describe('C1: a declared-but-absent model is retired without burning a caller', () => {
  /**
   * The exact production shape: `qwen/qwen3.5-122b-a10b` was declared in
   * backends.nvidia.models, had vanished from NVIDIA's live catalog, and its
   * store record came from the completion path so it carried NO provider tag.
   * It sat at absent_cycles 0 forever.
   */
  const DECLARED_BUT_GONE = 'qwen/qwen3.5-122b-a10b';
  const STILL_LIVE = 'openai/gpt-oss-20b';

  async function runCycles(storePath, count) {
    for (let i = 0; i < count; i++) {
      await discoverCatalog({
        nvidiaFetch: async () => ({ data: [{ id: STILL_LIVE }] }),
        openrouterFetch: async () => ({ data: [] }),
        cache: {},
        now: () => 1_800_000_000_000 + i * 3_600_000,
        lifecycleStorePath: storePath,
        cardOverrides: {},
        declaredModels: { nvidia: new Set([DECLARED_BUT_GONE, STILL_LIVE]) },
      });
    }
  }

  test('reaches eol from presence signals alone, with no completion traffic', async () => {
    const storePath = freshPath();
    // Seed it exactly as the completion path would: no provider tag at all.
    writeFileSync(
      storePath,
      JSON.stringify({ [DECLARED_BUT_GONE]: defaultLifecycle() }, null, 2),
    );

    await runCycles(storePath, THRESHOLDS.absentEolThreshold);

    const lc = getLifecycle(DECLARED_BUT_GONE, storePath);
    assert.equal(
      lc.state,
      LIFECYCLE_STATES.EOL,
      'a declared id absent from every fetch must reach eol on presence signals alone',
    );
    assert.equal(lc.eol_reason, 'dropped_from_catalog');
    assert.equal(
      lc.consecutive_permanent_errors,
      0,
      'retirement must NOT have required a real caller to eat a 410',
    );
  });

  test('the declared id gets a provider tag so later cycles keep seeing it', async () => {
    const storePath = freshPath();
    writeFileSync(
      storePath,
      JSON.stringify({ [DECLARED_BUT_GONE]: defaultLifecycle() }, null, 2),
    );
    await runCycles(storePath, 1);
    assert.equal(getLifecycle(DECLARED_BUT_GONE, storePath).provider, 'nvidia');
  });

  test('a declared id with NO store record at all still enters the sweep', async () => {
    const storePath = freshPath();
    writeFileSync(storePath, JSON.stringify({}, null, 2));
    await runCycles(storePath, 1);
    const lc = getLifecycle(DECLARED_BUT_GONE, storePath);
    assert.ok(lc.absent_cycles >= 1, 'declared-but-never-seen must start accruing absence');
  });

  test('a model still in the catalog is untouched', async () => {
    const storePath = freshPath();
    writeFileSync(storePath, JSON.stringify({}, null, 2));
    await runCycles(storePath, THRESHOLDS.absentEolThreshold);
    assert.equal(getLifecycle(STILL_LIVE, storePath).state, LIFECYCLE_STATES.ACTIVE);
  });

  test('NEGATIVE CONTROL: without declaredModels the bug reproduces', async () => {
    const storePath = freshPath();
    writeFileSync(
      storePath,
      JSON.stringify({ [DECLARED_BUT_GONE]: defaultLifecycle() }, null, 2),
    );
    // Same cycles, but the declaration is not supplied: this is exactly the
    // pre-fix code path (sliceByProvider sees no provider tag, so the id is
    // never reconciled).
    for (let i = 0; i < THRESHOLDS.absentEolThreshold + 2; i++) {
      await discoverCatalog({
        nvidiaFetch: async () => ({ data: [{ id: STILL_LIVE }] }),
        openrouterFetch: async () => ({ data: [] }),
        cache: {},
        now: () => 1_800_000_000_000 + i * 3_600_000,
        lifecycleStorePath: storePath,
        cardOverrides: {},
        declaredModels: { nvidia: new Set() },
      });
    }
    const lc = getLifecycle(DECLARED_BUT_GONE, storePath);
    assert.equal(
      lc.state,
      LIFECYCLE_STATES.ACTIVE,
      'this asserts the ORIGINAL bug: an untagged, undeclared id never gets reconciled. ' +
        'If this ever fails, the scoping rule changed and the C1 tests above need rereading.',
    );
    assert.equal(lc.absent_cycles, 0);
  });

  test('a record already tagged to another provider is never stolen', async () => {
    const storePath = freshPath();
    const shared = 'openai/gpt-oss-20b';
    writeFileSync(
      storePath,
      JSON.stringify({ [shared]: { ...defaultLifecycle(), provider: 'openrouter' } }, null, 2),
    );
    // nvidia declares it and does not serve it; openrouter still serves it.
    await discoverCatalog({
      nvidiaFetch: async () => ({ data: [] }),
      openrouterFetch: async () => ({ data: [{ id: shared, pricing: { prompt: '0', completion: '0' } }] }),
      cache: {},
      now: () => 1_800_000_000_000,
      lifecycleStorePath: storePath,
      cardOverrides: {},
      declaredModels: { nvidia: new Set([shared]), openrouter: new Set() },
    });
    const lc = getLifecycle(shared, storePath);
    assert.equal(lc.provider, 'openrouter', 'nvidia must not adopt an id openrouter owns');
    assert.equal(lc.absent_cycles, 0, 'and must not mark it absent against the wrong catalog');
  });
});

// ─── C2 part 1: tests cannot write the production store ──────────────────────

describe('C2: the production lifecycle store is unwritable from a test run', () => {
  test('the guard throws for the real path', () => {
    assert.throws(
      () => assertNotProductionStoreInTest(PRODUCTION_STORE_PATH),
      /refusing to write the production lifecycle store/,
    );
  });

  test('the guard allows any redirected path', () => {
    assert.doesNotThrow(() => assertNotProductionStoreInTest(freshPath()));
  });

  test('recordModelOutcome refuses the production path', () => {
    assert.throws(
      () => recordModelOutcome('some/model', { status: 410 }, PRODUCTION_STORE_PATH),
      /refusing to write the production lifecycle store/,
      'recordModelOutcome swallows everything in its try block, so the guard must sit outside it',
    );
  });

  test('the real store on this machine is untouched by this suite', () => {
    // The observable that actually matters. On 2026-08-14 a model's
    // absent_cycles moved 24 -> 36 -> 60 purely because the suite ran.
    if (!existsSync(PRODUCTION_STORE_PATH)) return;
    const before = readFileSync(PRODUCTION_STORE_PATH, 'utf8');

    // Layer 1, tests/_setup.mjs: the default path is redirected to a temp dir
    // before any module loads, so an ordinary write goes nowhere near the live
    // store and does NOT throw.
    recordModelOutcome('probe/canary', { status: 200 });

    // Layer 2, the guard: anything that still names the live path explicitly
    // (a suite run without --import, a hardcoded path) fails loudly.
    assert.throws(
      () => recordModelOutcome('probe/canary', { status: 200 }, PRODUCTION_STORE_PATH),
      /refusing to write the production lifecycle store/,
    );

    assert.equal(
      readFileSync(PRODUCTION_STORE_PATH, 'utf8'),
      before,
      'neither layer may let a test run move the live store',
    );
  });
});

// ─── C2 part 3: an eol record with no verification can recover ───────────────

describe('C2: catalog presence rescues a dropped-from-catalog eol record', () => {
  const now = 1_800_000_000_000;

  test('eol + dropped_from_catalog + present -> suspect, not stuck', () => {
    const stuck = {
      ...defaultLifecycle(),
      state: LIFECYCLE_STATES.EOL,
      last_verified_at: null,
      absent_cycles: 24,
      eol_reason: 'dropped_from_catalog',
    };
    const next = applyCatalogPresence(stuck, { present: true, provider: 'openrouter', now });
    assert.equal(
      next.state,
      LIFECYCLE_STATES.SUSPECT,
      'the provider listing it again directly contradicts why it was retired',
    );
    assert.equal(next.absent_cycles, 0);
    assert.equal(next.eol_reason, null);
  });

  test('presence does NOT overturn a probe that proved the model fails', () => {
    for (const reason of ['probe_failed', 'provider_410']) {
      const condemned = {
        ...defaultLifecycle(),
        state: LIFECYCLE_STATES.EOL,
        last_verified_at: null,
        eol_reason: reason,
        eol_at: now - 1000,
      };
      const next = applyCatalogPresence(condemned, { present: true, provider: 'nvidia', now });
      assert.equal(
        next.state,
        LIFECYCLE_STATES.EOL,
        `catalog membership is weaker evidence than a failed request (${reason}); ` +
          'NVIDIA lists 102 models and 47 of them answer 404',
      );
    }
  });

  test('NEGATIVE CONTROL: repeated presence alone never used to promote', () => {
    // Proves the state machine no longer has an absorbing state here: run many
    // cycles of "present" and confirm it does not sit at eol forever.
    let lc = {
      ...defaultLifecycle(),
      state: LIFECYCLE_STATES.EOL,
      last_verified_at: null,
      eol_reason: 'dropped_from_catalog',
    };
    for (let i = 0; i < 10; i++) {
      lc = applyCatalogPresence(lc, { present: true, provider: 'openrouter', now: now + i });
    }
    assert.notEqual(
      lc.state,
      LIFECYCLE_STATES.EOL,
      'a model confirmed present on ten consecutive cycles must not still be hidden',
    );
  });

  test('a suspect record is still routable so traffic can settle it', async () => {
    const { isRoutable } = await import('../src/discovery/lifecycle.mjs');
    assert.equal(isRoutable({ state: LIFECYCLE_STATES.SUSPECT }), true);
  });
});

// ─── C12: presence must not override strong condemnation, verified or not ────

describe('C12: catalog presence cannot promote a record a probe/completion condemned', () => {
  const now = 1_800_000_000_000;

  test('NEGATIVE CONTROL: a previously-verified provider_410/probe_failed record used to be rescued straight to active by presence alone', () => {
    // Card fb747d52 / C12. The `dropped_from_catalog` gate a few lines above
    // (affa0aac / C2) only guarded the branch that grants `suspect`. The
    // branch that grants `active` outright checked ONLY `last_verified_at !=
    // null`, with no `eol_reason` check at all, so it fired for provider_410
    // and probe_failed records too, as long as they had EVER had one good
    // completion before degrading. That is precisely the "weak evidence
    // overturns strong evidence" hole item 4 of the card calls out: an id
    // that worked once, then failed 3 completions in a row (provider_410) or
    // failed an active probe (probe_failed), got resurrected to `active` the
    // very next cycle just because the provider still lists it.
    for (const reason of ['provider_410', 'probe_failed']) {
      const condemned = {
        ...defaultLifecycle(),
        state: LIFECYCLE_STATES.EOL,
        last_verified_at: now - 60_000, // it DID work once, before it broke
        consecutive_permanent_errors: 3,
        eol_reason: reason,
        eol_at: now - 1000,
      };
      const next = applyCatalogPresence(condemned, { present: true, provider: 'nvidia', now });
      assert.equal(
        next.state,
        LIFECYCLE_STATES.EOL,
        `a prior verification must not let catalog presence move a ${reason} condemnation at all; ` +
          'catalog presence is weak evidence and must not promote past strong evidence, ' +
          'not even as far as suspect, verified or not',
      );
      assert.notEqual(next.state, LIFECYCLE_STATES.ACTIVE);
    }
  });

  test('dropped_from_catalog + previously verified: presence DOES still promote straight to active', () => {
    // The one case where full trust IS appropriate: the provider dropping and
    // re-listing an id is a direct rebuttal of the ONLY reason it left, and
    // the id was verified working before it vanished.
    const lc = {
      ...defaultLifecycle(),
      state: LIFECYCLE_STATES.EOL,
      last_verified_at: now - 60_000,
      eol_reason: 'dropped_from_catalog',
      eol_at: now - 1000,
    };
    const next = applyCatalogPresence(lc, { present: true, provider: 'nvidia', now });
    assert.equal(next.state, LIFECYCLE_STATES.ACTIVE);
    assert.equal(next.consecutive_permanent_errors, 0);
    assert.equal(next.consecutive_successes, 0);
  });
});
