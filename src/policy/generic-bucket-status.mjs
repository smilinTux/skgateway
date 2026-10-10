/**
 * generic-bucket-status.mjs: make the GENERIC size buckets (sk-s, sk-m, sk-l,
 * sk-xl) first-class routing targets for the fleet.
 *
 * The fleet routes builds and reviews to a generic bucket and lets the
 * operator switch underlying models on and off purely in gateway config
 * (routing.bucket_excluded_models, routing.generic_bucket_providers,
 * routing.generic_bucket_excluded_models). For that the fleet needs three
 * facts per bucket, and before this module none of them existed:
 *
 *   /v1/models  is the bucket usable for tool-calling reasoning work right now?
 *   /queue      what capacity domain backs it (summed member pool max/active)?
 *   /health     is any member backend up?
 *
 * A generic bucket qualifies when AT LEAST ONE of its current members
 * qualifies (a focused alias requires all of them, because it carries a single
 * provider's identity; a generic bucket carries none). A member qualifies when
 * its concrete /v1/models row is advertised, not stale, not unavailable, not
 * capacity-throttled, reasoning-capable, and supports tools + tool_choice.
 *
 * Pure apart from the injected lookups, so tests can drive it without a server.
 */

import { allBuckets, resolveBucket, genericBucketFence } from './buckets.mjs';
import { buildCapabilityCatalog } from '../ranking/catalog.mjs';

/** The generic bucket ids the fleet addresses. */
export const GENERIC_BUCKET_IDS = Object.freeze(['sk-s', 'sk-m', 'sk-l', 'sk-xl']);

/** True when a concrete /v1/models row can serve tool-calling reasoning work. */
export function rowQualifies(row) {
  const params = row?.card?.supported_parameters;
  return row?.advertised === true && row?.stale === false
    && row?.status !== 'unavailable'
    && row?.capacity?.state !== 'unavailable' && row?.capacity?.state !== 'throttled'
    && row?.card?.reasoning === true
    && Array.isArray(params) && params.includes('tools') && params.includes('tool_choice');
}

/** The backend id that serves a concrete row (config key; health/pool key). */
export function rowBackend(row) {
  return row?.owned_by || row?.provider || null;
}

/**
 * Qualified members of every generic bucket.
 *
 * @param {Array<object>} data visible /v1/models rows (concrete + alias)
 * @param {object} cfg gateway config (routing fences)
 * @param {{membership?: Array<object>, sensitivityPolicy?: object, lifecycle?: Function, providers?: object}} [opts]
 *   membership: unfiltered merged catalog used for bucket resolution (defaults to data)
 * @returns {Map<string, {bucket: object, rows: Array<object>}>} keyed by bucket id
 */
export function genericBucketQualification(data, cfg = {}, {
  membership = data, sensitivityPolicy, lifecycle = () => null, providers,
} = {}) {
  const fence = genericBucketFence(cfg?.routing);
  const bucketExcluded = new Set(cfg?.routing?.bucket_excluded_models || []);
  const advertiseExcluded = new Set(cfg?.advertise?.excluded_models || []);
  const admitted = (row) => !row?.kind && !bucketExcluded.has(row?.id)
    && !advertiseExcluded.has(row?.id) && fence(row);
  const catalog = buildCapabilityCatalog(membership.filter(admitted), {
    getLifecycleFn: lifecycle,
    ...(providers !== undefined ? { providers } : {}),
  });
  const concrete = new Map();
  for (const row of data) {
    if (admitted(row) && !concrete.has(row.id)) concrete.set(row.id, row);
  }
  const out = new Map();
  for (const bucket of allBuckets()) {
    if (bucket.provider || !GENERIC_BUCKET_IDS.includes(bucket.bucket)) continue;
    const { members } = resolveBucket({ bucket, catalog, sensitivityPolicy });
    const rows = members.map((m) => concrete.get(m.id)).filter((row) => row && rowQualifies(row));
    out.set(bucket.bucket, { bucket, rows });
  }
  return out;
}

/**
 * Project the generic bucket entries on /v1/models. Only bucket-kind entries
 * whose id is a generic bucket are touched; everything else passes through.
 *
 * @param {Array<object>} data
 * @param {Map<string, {bucket: object, rows: Array<object>}>} qualification
 * @returns {Array<object>}
 */
export function applyGenericBucketMetadata(data, qualification) {
  return data.map((entry) => {
    if (entry?.kind !== 'bucket') return entry;
    const q = qualification.get(entry.id);
    if (!q) return entry;
    const base = { ...entry, provider: 'skgateway', owned_by: 'skgateway', kind: 'bucket' };
    if (q.rows.length === 0) {
      const { card, members, member_backends, ...rest } = base;
      return { ...rest, advertised: false, stale: true };
    }
    const tiers = new Set(q.rows.map((row) => row.card?.tier));
    const [tier] = tiers;
    return {
      ...base,
      advertised: true,
      stale: false,
      card: {
        size_class: q.bucket.model_class,
        reasoning: true,
        supported_parameters: ['tools', 'tool_choice', 'reasoning'],
        ...(tiers.size === 1 && tier ? { tier } : {}),
      },
      members: q.rows.map((row) => row.id),
      member_backends: [...new Set(q.rows.map(rowBackend).filter(Boolean))],
    };
  });
}

/** Distinct member backends of each qualified generic bucket. */
function qualifiedBackends(qualification) {
  const out = [];
  for (const [id, q] of qualification) {
    const backends = [...new Set(q.rows.map(rowBackend).filter(Boolean))];
    if (backends.length) out.push([id, backends]);
  }
  return out;
}

/**
 * /queue rows for qualified generic buckets, same shape as pool.getStats().
 * Member backends that share one pool capacity domain are counted ONCE, so a
 * bucket never advertises more concurrency than physically exists.
 *
 * @param {Map} qualification
 * @param {(backendId: string) => object} getStats pool.getStats
 * @returns {Record<string, object>}
 */
export function genericBucketQueueRows(qualification, getStats) {
  const SUM = ['active', 'queued', 'max', 'maxQueue', 'totalProcessed', 'totalDropped',
    'totalDeferred', 'totalTimedOut', 'totalCancelled', 'peakActive', 'peakQueue'];
  const out = {};
  for (const [id, backends] of qualifiedBackends(qualification)) {
    const row = { capacityDomain: id, members: backends };
    for (const k of SUM) row[k] = 0;
    let queueTimeoutMs = 0;
    const domains = new Set();
    for (const backend of backends) {
      const stats = getStats(backend) || {};
      const domain = stats.capacityDomain || backend;
      if (domains.has(domain)) continue;
      domains.add(domain);
      for (const k of SUM) if (Number.isFinite(stats[k])) row[k] += stats[k];
      if (Number.isFinite(stats.queueTimeoutMs)) queueTimeoutMs = Math.max(queueTimeoutMs, stats.queueTimeoutMs);
    }
    row.queueTimeoutMs = queueTimeoutMs;
    row.memberDomains = [...domains];
    out[id] = row;
  }
  return out;
}

const STATUS_RANK = ['up', 'degraded', 'unknown', 'down'];

/**
 * /health rows for qualified generic buckets, same shape family as a backend's
 * HealthSnapshot (status/observed/quarantined/lastCheck) plus a capacity view.
 *
 * @param {Map} qualification
 * @param {Record<string, object>} health router.getHealth()
 * @returns {Record<string, object>}
 */
export function genericBucketHealthRows(qualification, health = {}) {
  const out = {};
  for (const [id, backends] of qualifiedBackends(qualification)) {
    const snaps = backends.map((b) => health?.[b]).filter(Boolean);
    const statuses = snaps.map((s) => s.status);
    const status = STATUS_RANK.find((s) => statuses.includes(s)) || statuses[0] || 'unknown';
    const rows = qualification.get(id).rows;
    out[id] = {
      status,
      observed: snaps.some((s) => s.observed === true),
      quarantined: snaps.length > 0 && snaps.every((s) => s.quarantined === true),
      lastCheck: Math.max(0, ...snaps.map((s) => Number(s.lastCheck) || 0)),
      members: backends,
      capacity: {
        current: true,
        state: rows.some((row) => !row.capacity?.state || row.capacity.state === 'available')
          ? 'available' : 'throttled',
      },
    };
  }
  return out;
}
