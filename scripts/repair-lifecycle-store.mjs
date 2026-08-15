#!/usr/bin/env node
/**
 * repair-lifecycle-store.mjs (card affa0aac / C2)
 *
 * Repairs ~/.config/skgateway/model_catalog_store.json after the 2026-08-14
 * inversion, where the store had drifted into the exact opposite of the truth:
 * models live in a provider's catalog were marked `eol` and hidden, while
 * models retired by the provider were marked `active` and advertised.
 *
 * Two causes, both documented on card 767adc4e:
 *   1. `sliceByProvider` scopes presence reconciliation to entries that already
 *      carry a `provider` tag, so completion-path records (which never get one)
 *      can never accumulate `absent_cycles`.
 *   2. Unit tests wrote into the production store, leaving records stamped with
 *      injected test clocks (eol_at 1000 / 4000 / 10000) and synthetic ids.
 *
 * This script is the reproducible repair. It is SAFE TO RE-RUN: every decision
 * is derived from the providers' live catalogs at run time, not from a captured
 * snapshot, so running it twice converges rather than compounding.
 *
 * It deliberately does NOT set `last_verified_at`. That field means "a real
 * completion or probe confirmed this model answers", and catalog membership is
 * not that. Restoring a model to `active` on catalog evidence is honest;
 * claiming we verified it would not be. Once a record is `active` the
 * eol-cannot-be-promoted trap no longer applies, so leaving the field null is
 * safe as well as truthful.
 *
 * Usage:
 *   node scripts/repair-lifecycle-store.mjs            # dry run, prints a diff
 *   node scripts/repair-lifecycle-store.mjs --apply    # writes the store
 *
 * Env:
 *   NVIDIA_API_KEY                      required to read the nvidia catalog
 *   SKGATEWAY_MODEL_CATALOG_STORE_PATH  override the store path (default: the
 *                                       real one under ~/.config/skgateway)
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { load as yamlLoad } from 'js-yaml';
import { join } from 'node:path';

const STORE_PATH =
  process.env.SKGATEWAY_MODEL_CATALOG_STORE_PATH ||
  join(homedir(), '.config', 'skgateway', 'model_catalog_store.json');

const APPLY = process.argv.includes('--apply');
const VERIFY = process.argv.includes('--verify');

/**
 * Earliest timestamp we accept as a real epoch-ms clock reading (2001-09-09).
 * Anything below this is an injected test clock (the observed pollution used
 * 1000, 4000 and 10000), not a time.
 */
const MIN_PLAUSIBLE_EPOCH_MS = 1_000_000_000_000;

/** Ids that are obviously unit-test fixtures rather than real models. */
function isSyntheticId(id) {
  if (!id || typeof id !== 'string') return true;
  // Single-token ids with no vendor prefix and no dot/dash structure, e.g. "x".
  if (!id.includes('/') && id.length <= 2) return true;
  // Fixture vendors used by the test suite.
  return /^(qwen\/[ab]|g\/c(:free)?)$/.test(id);
}

async function fetchNvidiaIds() {
  const key = process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('NVIDIA_API_KEY is not set; cannot read the nvidia catalog');
  const r = await fetch('https://integrate.api.nvidia.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!r.ok) throw new Error(`nvidia ${r.status}`);
  const j = await r.json();
  return new Set((j.data || []).map((m) => m.id));
}

async function fetchOpenRouterIds() {
  const r = await fetch('https://openrouter.ai/api/v1/models');
  if (!r.ok) throw new Error(`openrouter ${r.status}`);
  const j = await r.json();
  // Match the adapter's own free filter: a model we do not consider free was
  // never ours to route to, so its absence is not evidence of anything.
  const free = (j.data || []).filter((m) => {
    const p = m.pricing || {};
    return String(m.id).endsWith(':free') || (String(p.prompt) === '0' && String(p.completion) === '0');
  });
  return new Set(free.map((m) => m.id));
}

/**
 * Ids declared under the discovery-managed backends in the gateway config.
 * These are the nvidia entries that live-fetch may never return (the
 * sliceByProvider blind spot), so config is the only place they appear.
 */
function declaredDiscoveryIds(configPath) {
  const out = { nvidia: new Set(), openrouter: new Set() };
  try {
    const cfg = yamlLoad(readFileSync(configPath, 'utf8')) || {};
    for (const provider of ['nvidia', 'openrouter']) {
      for (const id of cfg.backends?.[provider]?.models || []) {
        if (typeof id === 'string' && !id.includes('*')) out[provider].add(id);
      }
    }
  } catch {
    // fail soft: an unreadable config just means we rely on live catalogs.
  }
  return out;
}

/**
 * Which discovery provider owns this id, or null if it is not discovery-managed
 * at all.
 *
 * CRITICAL: returning null means "catalog presence says nothing about this
 * model". Local backends (ornith, qwen38) and Anthropic models are declared
 * statically and their liveness is a BACKEND HEALTH question, not a catalog
 * membership question. Retiring them because they are absent from NVIDIA's
 * catalog would be exactly the category error this whole epic is about, and a
 * dry run of an earlier version of this script did precisely that to
 * claude-opus-4-8 and ornith-1.0-9b. Never widen this to a default.
 */
function providerOf(id, lc, nvidiaIds, orIds, declared) {
  if (lc && (lc.provider === 'nvidia' || lc.provider === 'openrouter')) return lc.provider;
  if (orIds.has(id) || declared.openrouter.has(id)) return 'openrouter';
  if (nvidiaIds.has(id) || declared.nvidia.has(id)) return 'nvidia';
  return null;
}

const main = async () => {
  const store = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
  const [nvidiaIds, orIds] = await Promise.all([fetchNvidiaIds(), fetchOpenRouterIds()]);
  const declared = declaredDiscoveryIds(
    process.env.SKGATEWAY_CONFIG || join(homedir(), '.skcapstone', 'gateway', 'skgateway.yaml'),
  );

  console.log(`store            : ${STORE_PATH}`);
  console.log(`records          : ${Object.keys(store).length}`);
  console.log(`nvidia live      : ${nvidiaIds.size}`);
  console.log(`openrouter free  : ${orIds.size}`);
  console.log('');

  const now = Date.now();
  const next = {};
  const actions = { dropped: [], restored: [], retired: [], tagged: [], untouched: 0 };

  for (const [id, lc] of Object.entries(store)) {
    // 1. Purge synthetic ids and records stamped with a test clock.
    if (isSyntheticId(id)) {
      actions.dropped.push([id, 'synthetic id']);
      continue;
    }
    if (typeof lc?.eol_at === 'number' && lc.eol_at > 0 && lc.eol_at < MIN_PLAUSIBLE_EPOCH_MS) {
      // The record itself is a test write. Do not trust ANY of its fields:
      // rebuild it from live catalog evidence below rather than patching it.
      const provider = providerOf(id, lc, nvidiaIds, orIds, declared);
      const live = nvidiaIds.has(id) || orIds.has(id);
      if (live || provider === null) {
        next[id] = {
          state: 'active',
          last_verified_at: typeof lc.last_verified_at === 'number' ? lc.last_verified_at : null,
          consecutive_permanent_errors: 0,
          absent_cycles: 0,
          eol_reason: null,
          eol_at: null,
          ...(provider ? { provider } : {}),
        };
        actions.restored.push([
          id,
          provider === null
            ? `test-clock eol_at=${lc.eol_at}, not discovery-managed (fabricated eol)`
            : `test-clock eol_at=${lc.eol_at}, live in ${provider} catalog`,
        ]);
      } else {
        actions.dropped.push([id, `test-clock eol_at=${lc.eol_at}, absent from every live catalog`]);
      }
      continue;
    }

    const provider = providerOf(id, lc, nvidiaIds, orIds, declared);

    // NOT discovery-managed (local backends, Anthropic, chiap08-*). Catalog
    // presence is meaningless for these: their liveness is backend health, and
    // the discovery sweep never reasons about them. Leave the record exactly as
    // it is. See the providerOf() doc comment for why this guard exists.
    if (provider === null) {
      next[id] = { ...lc };
      actions.untouched += 1;
      continue;
    }

    const live = nvidiaIds.has(id) || orIds.has(id);
    const tagging = !lc.provider ? { provider } : {};

    // 2. Marked eol but present in the provider's live catalog -> restore.
    //    This is the class that cannot self-heal, because applyCatalogPresence
    //    only promotes eol -> active when last_verified_at is non-null.
    if (lc.state === 'eol' || lc.state === 'dead') {
      if (live) {
        next[id] = {
          ...lc,
          state: 'active',
          consecutive_permanent_errors: 0,
          absent_cycles: 0,
          eol_reason: null,
          eol_at: null,
          ...tagging,
        };
        actions.restored.push([id, `eol but live in ${provider} catalog`]);
      } else {
        next[id] = { ...lc, ...tagging };
        if (tagging.provider) actions.tagged.push([id, `tagged ${provider}`]);
        else actions.untouched += 1;
      }
      continue;
    }

    // 3. Marked active but GONE from the provider's catalog -> retire.
    //    These are the ids being advertised while answering 410, and they are
    //    the sliceByProvider blind spot: untagged, so the presence sweep has
    //    never been able to see them.
    if (live) {
      next[id] = { ...lc, absent_cycles: 0, ...tagging };
      if (tagging.provider) actions.tagged.push([id, `tagged ${provider}`]);
      else actions.untouched += 1;
      continue;
    }

    next[id] = {
      ...lc,
      state: 'eol',
      eol_reason: 'dropped_from_catalog',
      eol_at: now,
      ...tagging,
    };
    actions.retired.push([id, `active but absent from the ${provider || 'unknown'} catalog`]);
  }

  const show = (label, rows) => {
    console.log(`${label}: ${rows.length}`);
    for (const [id, why] of rows) console.log(`   ${id.padEnd(50)} ${why}`);
    console.log('');
  };
  show('RESTORED to active', actions.restored);
  show('RETIRED to eol', actions.retired);
  show('DROPPED', actions.dropped);
  show('TAGGED with a provider', actions.tagged);
  console.log(`unchanged: ${actions.untouched}`);
  console.log(`result   : ${Object.keys(next).length} records`);
  console.log('');

  // --verify: catalog presence is NOT proof of servability. Measured
  // 2026-08-14: NVIDIA's /v1/models lists 102 ids and a large fraction of them
  // answer 404 to an actual completion, so a repair based on catalog membership
  // alone restores models that cannot serve. This pass exercises each
  // discovery-managed model with a real (tiny) completion through the GATEWAY
  // and retires the ones that fail permanently, which is the same evidence the
  // probe sweep (card 1f65cf45 / C3) will collect on a schedule once it is
  // wired. Until then this is the manual stand-in.
  //
  // A 429 is explicitly NOT a failure here: it means alive and throttled (card
  // 9e28de88 / C10). Recording it as eol would evict a model for being popular.
  if (VERIFY) {
    // Probe the PROVIDER DIRECTLY, never through the gateway.
    //
    // Routing verification through the gateway makes it call
    // recordModelOutcome() for every probe, so the gateway rewrites the whole
    // lifecycle store while this script is also rewriting it. Both sides do a
    // read-modify-write of the entire JSON with no locking, so whichever writes
    // last wins and the other's updates are silently lost. That is exactly what
    // happened on the first run of this pass: 47 correctly-retired ids came
    // back as `active`. Probing the provider directly keeps the gateway out of
    // the store entirely, and it also isolates provider truth from gateway
    // routing behavior, which is what we actually want to measure.
    //
    // A 429 is explicitly NOT a failure: it means alive and throttled (card
    // 9e28de88 / C10). Recording it as eol would evict a model for being popular.
    const key = process.env.NVIDIA_API_KEY;
    const endpoints = {
      nvidia: { url: 'https://integrate.api.nvidia.com/v1/chat/completions', auth: `Bearer ${key}` },
      openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', auth: process.env.OPENROUTER_API_KEY ? `Bearer ${process.env.OPENROUTER_API_KEY}` : null },
    };
    const targets = Object.entries(next)
      .filter(([, lc]) => lc.state === 'active' && endpoints[lc.provider])
      .map(([id, lc]) => [id, lc.provider]);
    console.log(`verifying ${targets.length} discovery-managed models directly against their providers ...`);
    let ok = 0, retired = 0, skipped = 0;
    for (const [id, provider] of targets) {
      const ep = endpoints[provider];
      let status = 0;
      try {
        const headers = { 'content-type': 'application/json' };
        if (ep.auth) headers.Authorization = ep.auth;
        const r = await fetch(ep.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 2048 }),
          signal: AbortSignal.timeout(60_000),
        });
        status = r.status;
      } catch {
        status = 0; // network/timeout: inconclusive, leave the record alone
      }
      if (status >= 200 && status < 300) {
        next[id] = { ...next[id], last_verified_at: Date.now(), consecutive_permanent_errors: 0 };
        ok += 1;
      } else if (status === 404 || status === 410) {
        next[id] = { ...next[id], state: 'eol', eol_reason: 'probe_failed', eol_at: Date.now() };
        retired += 1;
      } else {
        skipped += 1; // 429, 5xx, timeout: not lifecycle evidence
      }
    }
    console.log(`verified live: ${ok}   retired: ${retired}   inconclusive: ${skipped}`);
    console.log('');
  }

  if (!APPLY) {
    console.log('DRY RUN. Re-run with --apply to write.');
    return;
  }
  const backup = `${STORE_PATH}.bak-repair-${new Date(now).toISOString().replace(/[:.]/g, '')}`;
  copyFileSync(STORE_PATH, backup);
  writeFileSync(STORE_PATH, JSON.stringify(next, null, 2));
  console.log(`backup written : ${backup}`);
  console.log(`store repaired : ${STORE_PATH}`);
};

main().catch((e) => {
  console.error(`repair failed: ${e.message}`);
  process.exit(1);
});
