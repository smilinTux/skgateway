/**
 * generic-participation.mjs — strict, hot-reloadable generic bucket
 * participation policy.
 *
 * Generic S, M and L buckets are open to every routable provider by default.
 * This module lets an operator FAVOR or DISABLE a provider (or a single model)
 * inside those buckets without touching direct routes or provider-focused
 * `sk-<provider>-<bucket>` routes, which stay provider-pure.
 *
 * The policy is a pure value: `normalizeGenericParticipation()` validates and
 * freezes raw YAML, and `genericParticipationDecision()` answers one question
 * for one catalog entry and one bucket. Nothing here performs weighted
 * selection (that is `orderMembersByGenericWeight()` in buckets.mjs) and
 * nothing here mutates global state, so `config.mjs` can safely run the SAME
 * normalizer at boot and on every SIGHUP reload: an invalid candidate throws
 * before it can replace the active policy.
 *
 * Schema (all keys optional, empty by default):
 *
 *   routing:
 *     generic_participation:
 *       providers:            # global provider default
 *         deepseek: { enabled: true, weight: 45 }
 *         glm: { enabled: true, weight: 35 }   # normalized alias -> zai
 *         codex: { enabled: false }            # removed from GENERIC rotation
 *       models:               # global model override
 *         kimi-k2.5: { enabled: true, weight: 10 }
 *       buckets:              # per generic bucket override
 *         sk-l:               # generic bucket id only (never sk-codex-*)
 *           providers:
 *             deepseek: { enabled: true, weight: 20 }
 *           models:
 *             deepseek-flash: { enabled: false }
 *
 * Precedence (first match wins):
 *   bucket model > bucket provider > global model > global provider > implicit
 *
 * @module policy/generic-participation
 */

import { createHash } from 'node:crypto';
import { parseBucketId } from './buckets.mjs';

/** Weight bounds: an integer from 0 through 10000. */
export const GENERIC_WEIGHT_MIN = 0;
export const GENERIC_WEIGHT_MAX = 10_000;

/** Provider aliases normalized to a single canonical key. */
const PROVIDER_ALIASES = Object.freeze({ glm: 'zai' });

const EMPTY_POLICY = Object.freeze({
  providers: Object.freeze({}),
  models: Object.freeze({}),
  buckets: Object.freeze({}),
});

const TOP_LEVEL_KEYS = new Set(['providers', 'models', 'buckets']);
const OVERRIDE_KEYS = new Set(['enabled', 'weight']);
const BUCKET_KEYS = new Set(['providers', 'models']);

/** Typed error so config.mjs can distinguish policy schema failures. */
export class GenericParticipationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GenericParticipationError';
  }
}

function fail(message) {
  throw new GenericParticipationError(message);
}

/** True only for a YAML mapping, never null or an array. */
function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Canonical, case-folded provider key. `glm` and `zai` are the same provider,
 * which is what makes duplicate-alias detection meaningful.
 */
function normalizeProviderName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    fail('provider name must be a non-empty string');
  }
  const key = name.trim().toLowerCase();
  return PROVIDER_ALIASES[key] || key;
}

/**
 * Validate one `{ enabled, weight }` override object. `enabled` defaults to
 * true and `weight` to the implicit 1, but when present each must be exact.
 */
function normalizeOverride(raw, path) {
  if (!isMapping(raw)) fail(`${path} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!OVERRIDE_KEYS.has(key)) fail(`${path} has unknown key "${key}"`);
  }

  let enabled = true;
  if (hasOwn(raw, 'enabled')) {
    if (typeof raw.enabled !== 'boolean') {
      fail(`${path}.enabled must be a boolean`);
    }
    enabled = raw.enabled;
  }

  let weight = 1;
  if (hasOwn(raw, 'weight')) {
    if (!Number.isInteger(raw.weight)) {
      fail(`${path}.weight must be an integer`);
    }
    if (raw.weight < GENERIC_WEIGHT_MIN || raw.weight > GENERIC_WEIGHT_MAX) {
      fail(
        `${path}.weight must be between ${GENERIC_WEIGHT_MIN} and ` +
        `${GENERIC_WEIGHT_MAX} (got ${raw.weight})`,
      );
    }
    weight = raw.weight;
  }

  return Object.freeze({ enabled, weight });
}

/**
 * Validate a map of overrides. `normalizeKey` canonicalizes each key and may
 * throw for a key that is not allowed in this scope. Duplicate keys that
 * collapse to the same canonical key (e.g. `glm` + `zai`) are rejected.
 */
function normalizeOverrideMap(raw, path, normalizeKey, kind) {
  if (raw === undefined || raw === null) return Object.freeze({});
  if (!isMapping(raw)) fail(`${path} must be an object`);

  const out = {};
  const seen = new Map();
  for (const [key, value] of Object.entries(raw)) {
    const canonical = normalizeKey(key, path);
    if (seen.has(canonical)) {
      fail(
        `${path} contains duplicate ${kind} "${canonical}" ` +
        `(keys "${seen.get(canonical)}" and "${key}" normalize to the same ${kind})`,
      );
    }
    seen.set(canonical, key);
    out[canonical] = normalizeOverride(value, `${path}.${key}`);
  }
  return Object.freeze(out);
}

/**
 * A bucket override target must be a GENERIC bucket id. Focused
 * `sk-<provider>-<bucket>` ids are provider-pure already and are rejected as
 * unknown here rather than silently accepted as a no-op.
 */
function normalizeBucketKey(key, path) {
  const parsed = typeof key === 'string' ? parseBucketId(key) : null;
  if (!parsed) {
    fail(`${path} has unknown bucket id "${key}"`);
  }
  if (parsed.provider) {
    fail(
      `${path} has unknown bucket id "${key}": ` +
      `focused provider buckets bypass generic participation`,
    );
  }
  return parsed.bucket;
}

function normalizeBucketOverrides(raw, path) {
  if (raw === undefined || raw === null) return Object.freeze({});
  if (!isMapping(raw)) fail(`${path} must be an object`);

  const out = {};
  const seen = new Map();
  for (const [key, value] of Object.entries(raw)) {
    const canonical = normalizeBucketKey(key, path);
    if (seen.has(canonical)) {
      fail(
        `${path} contains duplicate bucket "${canonical}" ` +
        `(keys "${seen.get(canonical)}" and "${key}" normalize the same)`,
      );
    }
    seen.set(canonical, key);

    if (!isMapping(value)) fail(`${path}.${key} must be an object`);
    for (const bucketKey of Object.keys(value)) {
      if (!BUCKET_KEYS.has(bucketKey)) {
        fail(`${path}.${key} has unknown key "${bucketKey}"`);
      }
    }

    out[canonical] = Object.freeze({
      providers: normalizeOverrideMap(
        value.providers, `${path}.${key}.providers`, normalizeProviderName, 'provider',
      ),
      models: normalizeOverrideMap(
        value.models, `${path}.${key}.models`, normalizeModelName, 'model',
      ),
    });
  }
  return Object.freeze(out);
}

/** Model ids are opaque, but must be non-empty strings. */
function normalizeModelName(key, path) {
  if (typeof key !== 'string' || !key.trim()) {
    fail(`${path} has an empty model id`);
  }
  return key.trim();
}

/**
 * Normalize and freeze raw `routing.generic_participation` YAML.
 *
 * @param {unknown} raw
 * @returns {{providers: object, models: object, buckets: object}}
 * @throws {GenericParticipationError} on any schema violation
 */
export function normalizeGenericParticipation(raw) {
  if (raw === undefined || raw === null) return EMPTY_POLICY;
  if (!isMapping(raw)) fail('generic_participation must be an object');
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) fail(`generic_participation has unknown key "${key}"`);
  }

  return Object.freeze({
    providers: normalizeOverrideMap(
      raw.providers, 'providers', normalizeProviderName, 'provider',
    ),
    models: normalizeOverrideMap(
      raw.models, 'models', normalizeModelName, 'model',
    ),
    buckets: normalizeBucketOverrides(raw.buckets, 'buckets'),
  });
}

function overrideDecision(override, scope) {
  if (!override.enabled) {
    return { eligible: false, weight: 0, reason: 'disabled', scope };
  }
  return { eligible: true, weight: override.weight, reason: 'enabled', scope };
}

function providerOf(entry) {
  const raw = entry?.provider;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const key = raw.trim().toLowerCase();
  return PROVIDER_ALIASES[key] || key;
}

function modelOf(entry) {
  const raw = entry?.id ?? entry?.model;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * Decide generic participation for one catalog entry and one bucket.
 *
 * Focused provider buckets ALWAYS return `{ eligible: true, weight: 1,
 * reason: 'focused-route' }`; generic exclusions never apply, so disabling
 * Codex generically cannot remove `sk-codex-*` or direct routes.
 *
 * @param {{id?: string, model?: string, provider?: string}} entry
 * @param {string|{bucket?: string}} bucket
 * @param {{providers: object, models: object, buckets: object}} policy
 *   a value from `normalizeGenericParticipation()`
 * @returns {{eligible: boolean, weight: number, reason: string, scope: string|null}}
 */
export function genericParticipationDecision(entry, bucket, policy) {
  const active = policy ?? EMPTY_POLICY;
  const bucketId = typeof bucket === 'string' ? bucket : bucket?.bucket;
  const parsed = typeof bucketId === 'string' ? parseBucketId(bucketId) : null;

  if (parsed?.provider) {
    return { eligible: true, weight: 1, reason: 'focused-route', scope: 'focused' };
  }

  const genericId = parsed ? parsed.bucket
    : (typeof bucketId === 'string' ? bucketId.trim().toLowerCase() : null);
  const provider = providerOf(entry);
  const model = modelOf(entry);

  // 1. bucket model override
  const bucketPolicy = genericId ? active.buckets?.[genericId] : undefined;
  if (bucketPolicy) {
    if (model && bucketPolicy.models?.[model]) {
      return overrideDecision(bucketPolicy.models[model], 'bucket-model');
    }
    // 2. bucket provider override
    if (provider && bucketPolicy.providers?.[provider]) {
      return overrideDecision(bucketPolicy.providers[provider], 'bucket-provider');
    }
  }

  // 3. global model override
  if (model && active.models?.[model]) {
    return overrideDecision(active.models[model], 'model');
  }

  // 4. global provider default
  if (provider && active.providers?.[provider]) {
    return overrideDecision(active.providers[provider], 'provider');
  }

  // 5. implicit: enabled with weight 1
  return { eligible: true, weight: 1, reason: 'default', scope: null };
}

/** Deterministic JSON with object keys sorted, for stable revision hashing. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isMapping(value)) {
    const body = Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

/**
 * Content-addressed revision of a normalized policy. Equal policies always
 * produce the same revision; any material change produces a new one. This is
 * the value an audit trail can carry alongside a selection decision.
 *
 * @param {{providers: object, models: object, buckets: object}} policy
 * @returns {string} 64-char lowercase sha256 hex digest
 */
export function genericPolicyRevision(policy) {
  const active = policy ?? EMPTY_POLICY;
  const material = {
    providers: active.providers ?? {},
    models: active.models ?? {},
    buckets: active.buckets ?? {},
  };
  return createHash('sha256').update(canonicalJson(material)).digest('hex');
}
