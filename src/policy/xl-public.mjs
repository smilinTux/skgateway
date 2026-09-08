/** Source-only XL public capability binding. No provider calls or runtime mutation. */

export const XL_PUBLIC_BUCKET = 'sk-xl-public';
export const QWEN_BUCKET = 'sk-qwen';
export const ASTRA_ID = 'gpt-6-astra';
export const FABLE_PLACEHOLDER = Object.freeze({
  id: 'fable-5.1',
  status: 'unavailable_placeholder',
  endpoint: null,
  credentials: null,
  fallback: null,
  dispatch_eligible: false,
  qualified: false,
});

export class UnavailableModelError extends Error {
  constructor(model) {
    super(`model unavailable: ${model}`);
    this.name = 'UnavailableModelError';
    this.code = 'MODEL_UNAVAILABLE';
    this.model = model;
  }
}

function isAstra(entry) {
  const id = entry?.id ?? entry?.model ?? entry?.slug;
  const capability = entry?.capability ?? entry?.capabilities ?? {};
  return id === ASTRA_ID
    && (entry?.availability === true || entry?.supported_in_api === true || capability.availability === true)
    && (entry?.public_eligible === true || capability.public_eligible === true);
}

/** Resolve only from an authoritative, already-fetched provider catalog. */
export function resolveXlPublic({ catalog = [], capabilityRevision, transportProfile, gatewayRevision, policyResult = 'allow' } = {}) {
  const astra = catalog.find(isAstra);
  if (!astra) return { ok: false, code: 'ASTRA_UNAVAILABLE', requested_bucket: XL_PUBLIC_BUCKET };
  if (!capabilityRevision || !transportProfile || !gatewayRevision) {
    return { ok: false, code: 'PROVENANCE_INCOMPLETE', requested_bucket: XL_PUBLIC_BUCKET };
  }
  return {
    ok: true,
    requested_bucket: XL_PUBLIC_BUCKET,
    served_model: ASTRA_ID,
    provider_capability_revision: capabilityRevision,
    transport_profile: transportProfile,
    gateway_revision: gatewayRevision,
    policy_result: policyResult,
  };
}

export function resolveRequestedModel(model) {
  if (model === 'fable-5.1' || model === FABLE_PLACEHOLDER.id) throw new UnavailableModelError(model);
  return model;
}

export function allowsXlPublic({ sensitivity = 'public', model } = {}) {
  return sensitivity === 'public' && model !== 'matter' && model !== 'sk-matter';
}

export function xlPublicProposal(args = {}) {
  if (!allowsXlPublic(args)) return { ok: false, code: 'PROTECTED_CONTENT_DENIED', policy_result: 'deny' };
  return resolveXlPublic(args);
}

export function qwenRouteUnchanged(route) {
  return route?.bucket === QWEN_BUCKET && route?.model === 'sk-qwen';
}
