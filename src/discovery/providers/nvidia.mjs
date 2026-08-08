/**
 * nvidia.mjs (card P2.1): the NVIDIA NIM provider adapter.
 *
 * NVIDIA's `/v1/models` returns essentially bare ids (`id`, `object`,
 * `owned_by`; design doc 5.1), so there is no provider-declared card to keep.
 * Instead of scraping build.nvidia.com (brittle, rate-limited, deferred as
 * Q2's optional spike and explicitly OUT of scope for this card),
 * `normalize()` does heuristic org/family/size/variant parsing of the bare id
 * (`-instruct`, `-thinking`, `coder`, dense param counts, MoE `-a<N>b`
 * active-param counts) and tags the result `source:'heuristic'` so every
 * downstream consumer (capabilities.mjs, the ranker, `/admin/models`) can see
 * this is a guess, not a provider-declared fact (design 6.1 basis honesty).
 * It never claims `tool_use` support or a `context_length`/
 * `max_output_tokens` it doesn't actually have; `config/model-cards.
 * overrides.yaml` (card P2.2) is where committed, validated knowledge for
 * these ids lives.
 *
 * `fetch()` is the network call (kept identical to the pre-P2.1
 * `fetchNvidia()` in discovery.mjs, which now delegates here).
 *
 * @module discovery/providers/nvidia
 */

// Same non-chat filter as discovery.mjs's isChatModel/NON_CHAT (kept in sync
// deliberately, not imported, to avoid a circular import between this module
// and discovery.mjs while discovery.mjs itself now imports this module).
const NON_CHAT = [
  /embed/i, /\bbge\b/i, /rerank/i, /content-safety/i, /guard/i,
  /\bfuyu\b/i, /\bocr\b/i, /vision-embed/i, /moderation/i,
];

function isChatModel(id) {
  if (!id || typeof id !== 'string') return false;
  return !NON_CHAT.some((re) => re.test(id));
}

// Variant tokens the heuristic looks for in the bare id, in priority order.
// 'code' folds into 'coder' (either spelling is reported as 'coder').
const VARIANT_TOKENS = ['thinking', 'reasoning', 'coder', 'code', 'instruct', 'chat'];
const VISION_TOKENS = ['vl', 'vision', 'multimodal'];

function tokenBoundaryRe(token) {
  return new RegExp(`(?:^|[-_])${token}(?:[-_]|$)`, 'i');
}

/**
 * Heuristic org/family/size/variant parse of a bare NVIDIA model id (design
 * 5.1). Pure string parsing, best-effort: an id that doesn't match any
 * pattern still yields a sensible `family` (the id itself) with `size`/
 * `variant`/`active_params` left `null` rather than guessed wrong.
 *
 * @param {string} id e.g. "qwen/qwen3.5-122b-a10b"
 */
function parseHeuristicId(id) {
  const slashIdx = id.indexOf('/');
  const org = slashIdx === -1 ? null : id.slice(0, slashIdx);
  const rest = slashIdx === -1 ? id : id.slice(slashIdx + 1);

  const variants = [];
  for (const token of VARIANT_TOKENS) {
    if (tokenBoundaryRe(token).test(rest)) {
      variants.push(token === 'code' ? 'coder' : token);
    }
  }
  const uniqueVariants = [...new Set(variants)];

  // MoE active-param count, e.g. "-a10b" in "qwen3.5-122b-a10b".
  const activeMatch = rest.match(/[-_]a(\d+(?:\.\d+)?)b(?:[-_]|$)/i);
  const active_params = activeMatch ? `${activeMatch[1]}b` : null;

  // Dense/total param count: the first bounded "<digits>b" token that is NOT
  // the active-param token above (so "a10b" never double-counts as "10b").
  let size = null;
  for (const m of rest.matchAll(/(?:^|[-_])(\d+(?:\.\d+)?)b(?:[-_]|$)/gi)) {
    if (activeMatch && m[0] === activeMatch[0]) continue;
    size = `${m[1]}b`;
    break;
  }

  const vision = VISION_TOKENS.some((t) => tokenBoundaryRe(t).test(rest));

  // Family = the id stripped of the size/active-param/variant tokens above.
  let family = rest.replace(/[-_]a\d+(?:\.\d+)?b(?:[-_]|$)/gi, '-');
  family = family.replace(/(?:^|[-_])\d+(?:\.\d+)?b(?:[-_]|$)/gi, '-');
  for (const token of VARIANT_TOKENS) {
    family = family.replace(new RegExp(`(?:^|[-_])${token}(?:[-_]|$)`, 'gi'), '-');
  }
  family = family.replace(/^[-_]+|[-_]+$/g, '').replace(/[-_]{2,}/g, '-');
  if (!family) family = rest;

  return {
    org,
    family,
    size,
    active_params,
    variant: uniqueVariants[0] || null,
    variants: uniqueVariants,
    vision,
  };
}

/**
 * GET https://integrate.api.nvidia.com/v1/models and return the parsed JSON.
 * Throws `Error("nvidia <status>")` on a non-ok response, matching the
 * pre-P2.1 `fetchNvidia()` contract in discovery.mjs (discoverCatalog's
 * fail-soft/cache-fallback handling relies on this shape).
 *
 * @param {string} apiKey
 * @returns {Promise<object>}
 */
export async function fetch(apiKey) {
  const r = await globalThis.fetch('https://integrate.api.nvidia.com/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) throw new Error(`nvidia ${r.status}`);
  return r.json();
}

/**
 * Normalize a captured NVIDIA `/v1/models` payload into ModelCard[] (design
 * doc 4.1), dropping non-chat ids (same filter as the pre-P2.1
 * `parseNvidia()`) and heuristically parsing the rest. Pure and fail-soft: a
 * malformed/empty payload yields `[]` rather than throwing.
 *
 * @param {object} json NVIDIA `/v1/models` response, `{ data: [...] }`
 * @param {{now?: () => number}} [opts]
 * @returns {Array<{id:string, provider:'nvidia', free:true, card:object}>}
 */
export function normalize(json, opts = {}) {
  const clock = opts.now || Date.now;
  const data = (json && Array.isArray(json.data)) ? json.data : [];
  const fetched_at = clock();

  return data
    .filter((m) => m && typeof m.id === 'string')
    .filter((m) => isChatModel(m.id))
    .map((m) => {
      const h = parseHeuristicId(m.id);
      const descriptionParts = [h.org, h.family, h.size]
        .filter((p) => p != null && p !== '');
      let description = descriptionParts.join(' ') || m.id;
      if (h.active_params) description += ` (active ${h.active_params})`;
      if (h.variants.length) description += ` [${h.variants.join(', ')}]`;

      return {
        id: m.id,
        provider: 'nvidia',
        free: true,
        card: {
          // NVIDIA's bare-id catalog carries no context/output-token
          // declaration; a committed manual overlay (card P2.2) is the
          // honest source for these, not a guess here.
          context_length: null,
          max_output_tokens: null,
          modality: h.vision ? 'text+image->text' : 'text->text',
          // No provider signal for tool support: never claim it (design 6.1,
          // "tool_use (reliable) is not card-derivable").
          supported_parameters: [],
          description,
          pricing: { prompt: '0', completion: '0' },
          source: 'heuristic',
          fetched_at,
          org: h.org,
          family: h.family,
          size: h.size,
          active_params: h.active_params,
          variant: h.variant,
          variants: h.variants,
        },
      };
    });
}
