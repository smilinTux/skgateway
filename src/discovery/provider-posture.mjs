/**
 * provider-posture.mjs (card N2, coordination id f942d93b): load the
 * `providers:` block of `config/model-cards.overrides.yaml` (design doc
 * 2026-08-14-model-metadata-risk-job-matching-arch.md 4.3) for
 * `capabilities.mjs`'s `deriveTrustZone()` to consume as `opts.providers`.
 *
 * A small, separate loader rather than an addition to
 * `discovery.mjs`'s `loadCardOverrides()`: that function reads the
 * `overrides:` key specifically (per-model facts); `providers:` is a
 * sibling top-level key in the same file describing per-PROVIDER trust
 * posture (design 4.3: "Lives in the committed overlay ... NOT in a new
 * store"), a different shape entirely, and this module keeps that
 * distinction explicit rather than overloading one loader for both.
 *
 * Same fail-soft discipline as every other store loader in this codebase
 * (`discovery.mjs`'s `loadCardOverrides`, `empirical.mjs`'s ratings
 * reader): a missing file, malformed YAML, or a file with no top-level
 * `providers:` map all yield `{}` so a broken/absent overlay never breaks a
 * caller.
 *
 * WIRED IN as of the trust-zone wiring fix. `src/ranking/catalog.mjs`'s
 * `buildCapabilityCatalog()` calls this by default and forwards the result to
 * `deriveCapabilities(entry, { providers })`, so both catalog builders that
 * exist (index.mjs's `buildRankCatalog()` for /admin/models/rank and
 * router.mjs's `buildMatchCatalog()` for live `@match` + bucket routing) get
 * it from the single shared mapping. Card N2 shipped this loader unwired, and
 * the visible consequence was that `deriveTrustZone()` never saw a
 * `contractual-zero` posture, so Anthropic was classified zone 2 alongside the
 * providers that train on submitted content, and the whole `internal`
 * sensitivity tier was inert. Do not add a second call site: wire through
 * `buildCapabilityCatalog()` so the two paths cannot drift.
 *
 * @module discovery/provider-posture
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { load as yamlLoad } from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Same file as discovery.mjs's CARD_OVERRIDES_PATH; kept as its own named
 * export here so a caller does not have to import discovery.mjs just to
 * find the path. */
export const PROVIDER_POSTURE_PATH = resolve(__dirname, '..', '..', 'config', 'model-cards.overrides.yaml');

/**
 * Load the `providers:` map: provider name -> `{data_retention, verified?,
 * ref?}` (design 4.3). Fail-soft: yields `{}` on any read/parse failure or
 * on a file with no top-level `providers:` map, never throws.
 *
 * @param {string} [path]
 * @returns {Record<string, {data_retention?: string, verified?: string, ref?: string}>}
 */
export function loadProviderPostures(path = PROVIDER_POSTURE_PATH) {
  try {
    const parsed = yamlLoad(readFileSync(path, 'utf8'));
    const providers = parsed && typeof parsed === 'object' ? parsed.providers : null;
    return providers && typeof providers === 'object' && !Array.isArray(providers) ? providers : {};
  } catch {
    return {};
  }
}

export default { PROVIDER_POSTURE_PATH, loadProviderPostures };
