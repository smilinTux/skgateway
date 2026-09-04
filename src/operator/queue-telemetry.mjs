/**
 * Add configured Kimi capacity domains to a queue snapshot without creating
 * unconfigured pools or exposing request content and credentials.
 * @param {Record<string, object>} stats
 * @param {{getStats: Function}} pool
 * @param {object} config
 * @returns {Record<string, object>}
 */
export function exposeKimiQueueStats(stats, pool, config) {
  const out = stats;
  const configured = config?.pooling?.capacity_domains || {};
  for (const domainId of ["kimi-coding", "kimi-k3"]) {
    if (Object.prototype.hasOwnProperty.call(configured, domainId)
      && !Object.prototype.hasOwnProperty.call(out, domainId)) {
      out[domainId] = pool.getStats(domainId);
    }
  }
  const models = Object.values(config?.backends || {})
    .filter((backend) => Array.isArray(backend?.models))
    .flatMap((backend) => backend.models)
    .filter((model) => typeof model === "string" && /^kimi(?:[-_/]|$)/i.test(model));
  for (const [poolId, entry] of Object.entries(out)) {
    if (!/kimi/i.test(poolId) && !entry.members.some((member) => /kimi/i.test(member))) continue;
    const rows = new Map((entry.attributions || []).map((row) => [
      JSON.stringify([row.provider, row.requestedModel, row.servedModel]), row,
    ]));
    for (const model of models) {
      const row = {
        provider: poolId,
        requestedModel: model,
        servedModel: model,
        totalProcessed: 0,
        totalDropped: 0,
        totalTimedOut: 0,
        totalCancelled: 0,
        totalErrors: 0,
      };
      const key = JSON.stringify([row.provider, row.requestedModel, row.servedModel]);
      if (!rows.has(key)) rows.set(key, row);
    }
    entry.attributions = [...rows.values()];
  }
  return out;
}
