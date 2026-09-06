/** Fail-closed provider boundary for routes explicitly named Codex. */

const CODEX_TOKEN = /(^|[^a-z0-9])codex([^a-z0-9]|$)/i;
const GPT_MODEL = /^(?:openai\/)?gpt-[a-z0-9._-]+$/i;

function values(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') {
    for (const key of ['members', 'candidates', 'targets', 'fallbacks', 'failover']) {
      if (key in value) return values(value[key]);
    }
  }
  return [value];
}

export function isCodexNamed(value) {
  return typeof value === 'string' && CODEX_TOKEN.test(value.trim().normalize('NFKC'));
}

export function isOpenAiGptModel(value) {
  return typeof value === 'string' && GPT_MODEL.test(value.trim());
}

function isOfficialOpenAiUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase();
    return host === 'api.openai.com' ||
      (host === 'chatgpt.com' && /^\/backend-api\/codex(?:\/|$)/.test(url.pathname));
  } catch {
    return false;
  }
}

export function isPureCodexCandidate(candidate = {}) {
  const backend = candidate.backend || {};
  const provider = String(backend.provider || backend.kind || '').trim().toLowerCase();
  const authType = String(backend.auth_type || '').trim().toLowerCase();
  const url = candidate.backendUrl || backend.url || '';
  const model = candidate.model || backend.model;
  const officialProvider = provider === 'codex' || provider === 'openai' ||
    authType === 'codex_oauth' || isOfficialOpenAiUrl(url);
  const aggregator = provider === 'openrouter' || /(^|[^a-z])openrouter([^a-z]|$)/i.test(
    String(candidate.backendId || backend.id || ''),
  ) || String(url).toLowerCase().includes('openrouter.ai');
  // Candidate objects created for dispatch carry authHeaders. If Codex OAuth
  // could not load a credential, fail before transport rather than making an
  // attributable but avoidable unauthenticated provider request. Static config
  // validation does not carry authHeaders and remains a structural check.
  const hasDispatchHeaders = Object.prototype.hasOwnProperty.call(candidate, 'authHeaders');
  const credentialReady = authType !== 'codex_oauth' || !hasDispatchHeaders || (
    typeof candidate.authHeaders?.authorization === 'string' &&
    candidate.authHeaders.authorization.startsWith('Bearer ') &&
    typeof candidate.authHeaders?.['chatgpt-account-id'] === 'string' &&
    candidate.authHeaders['chatgpt-account-id'].length > 0
  );
  return officialProvider && !aggregator && credentialReady && isOpenAiGptModel(model);
}

export function codexPurityProblems(intentValues, candidates) {
  if (!(intentValues || []).flatMap(values).some(isCodexNamed)) return [];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return ['Codex route has no eligible OpenAI or Codex candidate'];
  }
  return candidates.flatMap((candidate, index) => isPureCodexCandidate(candidate) ? [] : [
    `Codex candidate ${index + 1} is not an official OpenAI GPT route`,
  ]);
}

/** Validate Codex-named registry roles, aliases and buckets at boot and reload. */
export function assertCodexRegistryPurity(registry = {}, errs = []) {
  const backends = registry.backends || {};
  const routes = {
    ...(registry.roles || {}),
    ...(registry.aliases || {}),
    ...(registry.buckets || {}),
  };

  const inspect = (label, target, inheritedCodex = false, seen = new Set()) => {
    const codexRoute = inheritedCodex || isCodexNamed(label) || values(target).some(isCodexNamed);
    if (!codexRoute) return;
    for (const member of values(target)) {
      if (typeof member !== 'string' || !member.trim()) {
        errs.push(`${label} has an unknown Codex route member`);
        continue;
      }
      const name = member.trim();
      if (Object.prototype.hasOwnProperty.call(routes, name)) {
        if (seen.has(name)) {
          errs.push(`${label} contains a cyclic Codex route through "${name}"`);
          continue;
        }
        inspect(label, routes[name], true, new Set([...seen, name]));
        continue;
      }
      const backend = backends[name];
      if (!backend || !isPureCodexCandidate({
        backendId: `reg:${name}`,
        backendUrl: backend.url,
        backend,
        model: backend.model,
      })) errs.push(`${label} member "${name}" must be an official OpenAI GPT backend`);
    }
  };

  for (const [role, target] of Object.entries(registry.roles || {})) {
    inspect(`registry role "${role}"`, target, isCodexNamed(role), new Set([role]));
  }
  for (const [alias, target] of Object.entries(registry.aliases || {})) {
    inspect(`registry alias "${alias}"`, target, isCodexNamed(alias), new Set([alias]));
  }
  for (const [bucket, target] of Object.entries(registry.buckets || {})) {
    inspect(`registry bucket "${bucket}"`, target, isCodexNamed(bucket), new Set([bucket]));
  }
  for (const [context, target] of Object.entries(registry.contexts || {})) {
    inspect(`registry context "${context}"`, target, isCodexNamed(context));
  }
  for (const fallback of values(registry.failover?.local_fallback)) {
    if (isCodexNamed(fallback)) inspect('registry failover.local_fallback', fallback, true);
  }
  return errs;
}

/** Validate Codex-named configured backends before the listener starts. */
export function assertCodexConfigPurity(config = {}, errs = []) {
  for (const [name, backend] of Object.entries(config.backends || {})) {
    const models = Array.isArray(backend?.models) ? backend.models : [backend?.model].filter(Boolean);
    if (!isCodexNamed(name) && !models.some(isCodexNamed)) continue;
    // A discovery-backed Codex backend may intentionally start with no static
    // catalog. Runtime purity still checks every discovered candidate before
    // dispatch, while stale or empty discovery fails closed with no candidate.
    if (models.length === 0) continue;
    for (const model of models) {
      if (model.includes('*') || !isPureCodexCandidate({ backendId: name, backendUrl: backend.url, backend, model })) {
        errs.push(`backends.${name} model "${model}" must be an official OpenAI GPT route`);
      }
    }
  }
  return errs;
}
