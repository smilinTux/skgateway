/**
 * model-address.mjs: name a model together with WHERE it is served.
 *
 * Card ce839ab2 / C11. Chef's proposal: `chiap08/qwen3.8-27b` rather than a
 * bare `qwen3.8-27b`.
 *
 * THIS IS NOT COSMETIC. It removes a class of bug by construction, and the bug
 * is not hypothetical. While writing the lifecycle-store repair for card
 * affa0aac, a dry run would have retired `claude-opus-4-8`, `claude-sonnet-4-6`,
 * `ornith-1.0-9b`, `qwen3.6-27b-abliterated` and `qwen3.8-27b`, all alive and
 * several load-bearing, because they were "absent from NVIDIA's catalog". A
 * bare id carries no provenance: `ornith-1.0-9b` looks exactly like something
 * that could have come from a provider catalog, so absence from that catalog
 * read as evidence about it. With `chiap08/ornith-1.0-9b` the category error is
 * impossible to make, by anyone, including a future script and a future agent.
 *
 * The fix used at the time was a `providerOf()` helper returning null for
 * non-discovery models. That works and it encodes in ONE script a fact that
 * should be visible in the DATA. The next tool to touch the store has to
 * rediscover it.
 *
 * SEPARATOR. Provider model ids already contain slashes
 * (`nvidia/nemotron-nano-9b-v2`, `openai/gpt-oss-20b`), so a bare `/` split is
 * genuinely ambiguous: in `nvidia/nemotron-nano-9b-v2` the leading `nvidia` is
 * the model's VENDOR, not our backend. Splitting on the first `/` would read
 * that as host=nvidia, which is right by accident here and wrong for
 * `openai/gpt-oss-20b` served BY nvidia.
 *
 * So the canonical separator is `::`, which cannot collide:
 *     chiap08::qwen3.8-27b
 *     nvidia::openai/gpt-oss-20b
 *     192.168.0.100::ornith-1.0-9b
 * A single `/` form is ALSO accepted, but only when the prefix matches a known
 * backend name, i.e. disambiguated by lookup rather than by syntax. That honors
 * the shape Chef wrote without guessing.
 *
 * SCOPE, DELIBERATELY BOUNDED. This is an ADDRESSING layer. It does NOT re-key
 * the lifecycle store, `ratings.jsonl`, or `metrics.db`.
 *
 * The card names the store re-key as the real risk in this work, and it is
 * right: a half-migrated store would produce exactly the split-brain the parent
 * card 767adc4e is about, and `ratings.jsonl` plus `metrics.db` hold measured
 * history that the ranker depends on and that cannot be regenerated. Those
 * stores stay keyed on the bare concrete model id, which is already unique
 * within a provider and is what every existing record uses. Namespacing
 * disambiguates ADDRESSING (which door did you mean) without touching
 * IDENTITY (which model is this). If a future card wants the store re-keyed, it
 * can do that as its own migration with its own rollback, rather than riding
 * along on a naming change.
 *
 * @module policy/model-address
 */

/** Canonical, collision-proof separator. */
export const SEPARATOR = '::';

/**
 * Parse a model string into `{host, model}`.
 *
 * Returns `host: null` for a bare id, which is the overwhelmingly common case
 * and must keep working untouched: every client today sends bare ids, and a
 * flag day is not acceptable.
 *
 * @param {string} id
 * @param {{knownHosts?: Iterable<string>}} [opts] backend names, used only to
 *   disambiguate the single-slash form
 * @returns {{host: string|null, model: string, form: 'bare'|'canonical'|'slash'}}
 */
export function parseModelAddress(id, { knownHosts } = {}) {
  if (typeof id !== 'string' || !id) return { host: null, model: '', form: 'bare' };
  const raw = id.trim();

  const sep = raw.indexOf(SEPARATOR);
  if (sep > 0) {
    const host = raw.slice(0, sep);
    const model = raw.slice(sep + SEPARATOR.length);
    // An empty half is a malformed address, not an invitation to guess.
    if (host && model) return { host, model, form: 'canonical' };
    return { host: null, model: raw, form: 'bare' };
  }

  // Single-slash form: ONLY when the prefix is a known backend. Without that
  // check `nvidia/nemotron-nano-9b-v2` would parse as host=nvidia, which is
  // right by luck, while `openai/gpt-oss-20b` would parse as host=openai, which
  // is wrong: openai is the model's vendor and nvidia is the host. Guessing
  // here would silently mis-address a model, which is the whole failure mode
  // this card exists to remove.
  if (knownHosts) {
    const hosts = knownHosts instanceof Set ? knownHosts : new Set(knownHosts);
    const slash = raw.indexOf('/');
    if (slash > 0) {
      const maybeHost = raw.slice(0, slash);
      const rest = raw.slice(slash + 1);
      if (hosts.has(maybeHost) && rest) return { host: maybeHost, model: rest, form: 'slash' };
    }
  }

  return { host: null, model: raw, form: 'bare' };
}

/** True when `id` names a host explicitly. */
export function isNamespaced(id, opts) {
  return parseModelAddress(id, opts).host !== null;
}

/**
 * Build the canonical namespaced form. Returns the bare model when `host` is
 * falsy, so callers can format unconditionally.
 *
 * @param {string|null} host
 * @param {string} model
 * @returns {string}
 */
export function formatModelAddress(host, model) {
  if (!host) return model;
  return `${host}${SEPARATOR}${model}`;
}

/**
 * The concrete model id to send upstream. Always the bare half: a provider has
 * never heard of our backend names, and forwarding `chiap08::qwen3.8-27b` would
 * 400 everywhere.
 *
 * @param {string} id
 * @param {object} [opts]
 * @returns {string}
 */
export function toUpstreamModel(id, opts) {
  return parseModelAddress(id, opts).model;
}

/**
 * Does this address select `entry`?
 *
 * A BARE address matches on model id alone, which is today's behavior and stays
 * the default. A NAMESPACED address additionally requires the host to match, so
 * it can disambiguate a model served by more than one provider. Measured
 * 2026-08-15: nine models are currently free from two or more providers, and
 * `openai/gpt-oss-20b` (nvidia) versus `openai/gpt-oss-20b:free` (openrouter)
 * are distinguishable today only by a `:free` suffix convention that happens to
 * exist rather than by anything structural.
 *
 * @param {string} id the requested address
 * @param {{id: string, provider?: string, owned_by?: string}} entry
 * @param {object} [opts]
 * @returns {boolean}
 */
export function addressMatches(id, entry, opts) {
  const { host, model } = parseModelAddress(id, opts);
  if (!entry || entry.id !== model) return false;
  if (host === null) return true;
  return host === entry.provider || host === entry.owned_by;
}

/**
 * Annotate an advertised catalog entry with its canonical namespaced address,
 * keeping the bare `id` untouched.
 *
 * ADDITIVE ON PURPOSE. `/v1/models` entries keep `id` as the bare string every
 * existing client already sends, and gain an `address` field alongside it.
 * Clients migrate when they choose rather than when we ship, which is the only
 * way to do this without a flag day. The skchat picker groups by `provider` and
 * is unaffected either way.
 *
 * @param {object} entry
 * @returns {object}
 */
export function withAddress(entry) {
  if (!entry || typeof entry.id !== 'string') return entry;
  const host = entry.provider || entry.owned_by || null;
  return host ? { ...entry, address: formatModelAddress(host, entry.id) } : { ...entry };
}
