/** Fail-closed provider boundary for routes explicitly named Codex. */

const CODEX_TOKEN = /(^|[^a-z0-9])codex([^a-z0-9]|$)/i;
const GPT_MODEL = /^(?:openai\/)?gpt-[a-z0-9._-]+$/i;

export function isCodexNamed(value) {
  return typeof value === 'string' && CODEX_TOKEN.test(value.trim());
}

export function isOpenAiGptModel(value) {
  return typeof value === 'string' && GPT_MODEL.test(value.trim());
}

export function isPureCodexCandidate(candidate = {}) {
  const backend = candidate.backend || {};
  const id = String(candidate.backendId || backend.id || '').toLowerCase();
  const provider = String(backend.provider || backend.kind || '').toLowerCase();
  const url = String(candidate.backendUrl || backend.url || '').toLowerCase();
  const model = candidate.model || backend.model;
  const officialProvider = /(^|[:._-])(codex|openai)($|[:._-])/.test(id) ||
    provider === 'codex' || provider === 'openai' ||
    url.includes('api.openai.com') || url.includes('chatgpt.com/backend-api/codex');
  const forbidden = id.includes('openrouter') || provider.includes('openrouter') ||
    url.includes('openrouter.ai');
  return officialProvider && !forbidden && isOpenAiGptModel(model);
}

export function codexPurityProblems(intentValues, candidates) {
  if (!(intentValues || []).some(isCodexNamed)) return [];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return ['Codex route has no eligible OpenAI or Codex candidate'];
  }
  return candidates.flatMap((candidate, index) => isPureCodexCandidate(candidate) ? [] : [
    `Codex candidate ${index + 1} is not an official OpenAI GPT route`,
  ]);
}

/** Validate Codex-named registry roles and contexts at boot and reload. */
export function assertCodexRegistryPurity(registry = {}, errs = []) {
  const backends = registry.backends || {};
  const roles = registry.roles || {};
  const inspect = (label, target) => {
    if (!isCodexNamed(label) && !isCodexNamed(target)) return;
    const backendName = roles[target] || target;
    const backend = backends[backendName];
    if (!backend || !isPureCodexCandidate({
      backendId: `reg:${backendName}`,
      backendUrl: backend.url,
      backend,
      model: backend.model,
    })) errs.push(`${label} must resolve only to an official OpenAI GPT backend`);
  };
  for (const [role, target] of Object.entries(roles)) inspect(`registry role "${role}"`, target);
  for (const [context, target] of Object.entries(registry.contexts || {})) inspect(`registry context "${context}"`, target);
  const fallback = registry.failover?.local_fallback;
  if (isCodexNamed(fallback)) inspect('registry failover.local_fallback', fallback);
  return errs;
}
