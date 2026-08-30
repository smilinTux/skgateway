#!/usr/bin/env node

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { fetch as fetchCatalog, normalize } from '../src/discovery/providers/openrouter.mjs';
import { buildCapabilityCatalog } from '../src/ranking/catalog.mjs';
import { allBuckets, resolveBucket } from '../src/policy/buckets.mjs';
import { defaultLifecycle } from '../src/discovery/lifecycle.mjs';

export const COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_TIMEOUT_MS = 45000;
export const DEFAULT_DELAY_MS = 500;
export const PUBLIC_SYNTHETIC_PROMPT = 'Reply with exactly OPENROUTER_PUBLIC_OK.';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

export function classifyProbe({ status = null, error = null } = {}) {
  if (error === 'timeout') return { health: 'unmeasured', lifecycle: 'suspect', reason: 'timeout' };
  if (error === 'cancelled') return { health: 'cancelled', lifecycle: 'unchanged', reason: 'client_cancelled' };
  if (error) return { health: 'unmeasured', lifecycle: 'suspect', reason: 'network_error' };
  if (status >= 200 && status < 300) return { health: 'available', lifecycle: 'active', reason: 'completion_2xx' };
  if (status === 429) return { health: 'throttled', lifecycle: 'active', reason: 'rate_limited' };
  if (status === 404 || status === 410) return { health: 'unavailable', lifecycle: 'eol_candidate', reason: `provider_${status}` };
  if (status >= 500) return { health: 'unmeasured', lifecycle: 'suspect', reason: `provider_${status}` };
  return { health: 'rejected', lifecycle: 'unchanged', reason: `provider_${status ?? 'unknown'}` };
}

export async function probeModel(model, {
  apiKey,
  fetchFn = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cancelAfterMs = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  const controller = new AbortController();
  const startedAt = now();
  const started = performance.now();
  let timedOut = false;
  let cancelled = false;
  const timer = setTimeout(() => {
    timedOut = cancelAfterMs == null;
    cancelled = cancelAfterMs != null;
    controller.abort();
  }, cancelAfterMs ?? timeoutMs);

  try {
    const response = await fetchFn(COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: PUBLIC_SYNTHETIC_PROMPT }],
        max_tokens: 32,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    let body = {};
    try { body = await response.json(); } catch {}
    const classification = classifyProbe({ status: response.status });
    return {
      requested_model: model,
      served_model: typeof body?.model === 'string' ? body.model : null,
      started_at: startedAt,
      finished_at: now(),
      latency_ms: Math.round(performance.now() - started),
      http_status: response.status,
      provider_error_code: typeof body?.error?.code === 'number' || typeof body?.error?.code === 'string'
        ? String(body.error.code)
        : null,
      content_present: typeof body?.choices?.[0]?.message?.content === 'string'
        && body.choices[0].message.content.length > 0,
      ...classification,
    };
  } catch (error) {
    const kind = timedOut ? 'timeout' : cancelled ? 'cancelled' : 'network';
    return {
      requested_model: model,
      served_model: null,
      started_at: startedAt,
      finished_at: now(),
      latency_ms: Math.round(performance.now() - started),
      http_status: null,
      provider_error_code: null,
      content_present: false,
      ...classifyProbe({ error: kind }),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function bucketPlacement(entry) {
  return allBuckets().map((bucket) => {
    const { members, rejected, ceiling } = resolveBucket({
      bucket,
      catalog: [entry],
      isRoutable: (candidate) => candidate.lifecycle?.state === 'active',
    });
    const rejection = rejected.find((item) => item.id === entry.id);
    return {
      bucket: bucket.bucket,
      eligible: members.some((item) => item.id === entry.id),
      trust_zone_ceiling: ceiling,
      reason: rejection?.reason || 'eligible',
    };
  });
}

export function buildEvaluatedCatalog(cards, probes) {
  const byId = new Map(probes.map((probe) => [probe.requested_model, probe]));
  const catalog = buildCapabilityCatalog(cards, {
    getLifecycleFn: (id) => {
      const probe = byId.get(id);
      return { ...defaultLifecycle(), state: probe?.lifecycle === 'active' ? 'active' : 'suspect' };
    },
    metricsFn: (id) => {
      const probe = byId.get(id);
      return {
        latency_p50_ms: probe?.latency_ms ?? null,
        success_rate: probe?.health === 'available' ? 1 : probe?.health === 'throttled' ? null : 0,
      };
    },
  });
  return catalog.map((entry) => ({
    id: entry.id,
    provider: entry.provider,
    free: entry.free,
    card: entry.card,
    lifecycle: entry.lifecycle,
    capabilities: entry.capabilities,
    probe: byId.get(entry.id),
    bucket_placement: bucketPlacement(entry),
  }));
}

function parseArgs(argv) {
  const options = { output: null, timeoutMs: DEFAULT_TIMEOUT_MS, delayMs: DEFAULT_DELAY_MS };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--output') options.output = argv[++i];
    else if (argv[i] === '--timeout') options.timeoutMs = Number(argv[++i]);
    else if (argv[i] === '--delay') options.delayMs = Number(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!options.output) throw new Error('--output is required');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) throw new Error('--timeout must be positive');
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) throw new Error('--delay must be nonnegative');
  return options;
}

export async function runEvaluation({
  apiKey,
  output,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  delayMs = DEFAULT_DELAY_MS,
  catalogFetch = fetchCatalog,
  probeFn = probeModel,
  now = () => new Date().toISOString(),
} = {}) {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required');
  const fetchedAt = now();
  const raw = await catalogFetch(apiKey);
  const cards = normalize(raw, { now: () => Date.parse(fetchedAt) });
  const probes = [];
  for (const card of cards) {
    probes.push(await probeFn(card.id, { apiKey, timeoutMs }));
    if (delayMs > 0) await sleep(delayMs);
  }

  const cancelModel = cards.find((card) => card.id === 'openrouter/free')?.id || cards[0]?.id || null;
  const cancellation = cancelModel
    ? await probeFn(cancelModel, { apiKey, timeoutMs, cancelAfterMs: 10 })
    : null;
  const recovery = cancelModel
    ? await probeFn(cancelModel, { apiKey, timeoutMs })
    : null;
  const models = buildEvaluatedCatalog(cards, probes);
  const counts = probes.reduce((out, probe) => {
    out[probe.health] = (out[probe.health] || 0) + 1;
    return out;
  }, {});
  const artifact = {
    schema_version: 1,
    generated_at: now(),
    catalog_fetched_at: fetchedAt,
    provider: 'openrouter',
    provider_catalog_url: 'https://openrouter.ai/api/v1/models',
    completions_url: COMPLETIONS_URL,
    credential_reference: '/home/skuser01/api-keys/openrouter.env:OPENROUTER_API_KEY',
    public_synthetic_only: true,
    response_content_retained: false,
    provider_catalog_count: Array.isArray(raw?.data) ? raw.data.length : 0,
    normalized_free_chat_count: cards.length,
    summary: counts,
    cancellation_probe: cancellation,
    recovery_probe: recovery,
    models,
  };

  const target = resolve(output);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
  return artifact;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const artifact = await runEvaluation({
    apiKey: process.env.OPENROUTER_API_KEY,
    output: options.output,
    timeoutMs: options.timeoutMs,
    delayMs: options.delayMs,
  });
  process.stdout.write(`${JSON.stringify({
    output: resolve(options.output),
    provider_catalog_count: artifact.provider_catalog_count,
    normalized_free_chat_count: artifact.normalized_free_chat_count,
    summary: artifact.summary,
    cancellation: artifact.cancellation_probe?.health || null,
    recovery: artifact.recovery_probe?.health || null,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
