/** Dynamic catalog adapter for the authenticated local claude-code-api wrapper. */

import { isChatModelId } from '../classify.mjs';

export async function fetch(baseUrl, token) {
  if (!baseUrl) throw new Error('anthropic wrapper URL is unset');
  if (!token) throw new Error('anthropic wrapper token is unset');
  const endpoint = new URL('models', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const response = await globalThis.fetch(endpoint, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`anthropic wrapper ${response.status}`);
  return response.json();
}

export function normalize(json) {
  const data = json && Array.isArray(json.data) ? json.data : [];
  return data
    .filter((model) => model && typeof model.id === 'string')
    .filter((model) => model.id.startsWith('claude-'))
    .filter((model) => isChatModelId(model.id))
    .map((model) => ({
      id: model.id,
      provider: 'anthropic',
      free: false,
      card: null,
    }));
}
