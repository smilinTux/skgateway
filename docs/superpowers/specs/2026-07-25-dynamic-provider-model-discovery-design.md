# SKGateway Dynamic Provider Model Discovery (NVIDIA NIM free + OpenRouter free)

**Status:** design approved (brainstorm 2026-07-25), pending implementation plan.
**Author:** Lumina (with Chef). **Pairs with:** the skchat unified reply-model
picker spec (that picker consumes this gateway's `/v1/models`).

## 1. Goal

SKGateway's advertised model catalog (`GET /v1/models`) becomes **dynamic**:
instead of a hardcoded per-backend model list, it discovers models live from the
providers and always reflects what is actually available.

Sources (Chef's requirement, "for now"):
- **Local** — the ornith/beellama/ollama backends from `skgateway.yaml` (unchanged).
- **NVIDIA NIM (free)** — every card the NIM catalog serves, fetched live from
  `https://integrate.api.nvidia.com/v1/models` (the whole `integrate.api.nvidia.com`
  catalog is the free tier). Verified: **118 cards** with the existing
  `NVIDIA_API_KEY`.
- **OpenRouter (free only)** — models from `https://openrouter.ai/api/v1/models`
  filtered to free (`pricing.prompt == 0 && pricing.completion == 0`, or id
  ending `:free`). Verified: **18 free of 345**. Paid OpenRouter models are
  excluded for now (a config flag can widen later).

The list is refreshed periodically, cached on disk for resilience, reconciled
with backend health (existing card `5c680ee9` behavior), and routing is updated
so any discovered id routes to its provider backend.

## 2. Current state

- `GET /v1/models` -> `buildModelCatalog(config.backends, router, advertiseReconcileMode)`
  (`src/index.mjs`) builds from each backend's **static** `models:` list in
  `skgateway.yaml`, reconciled against health.
- Backends configured: local ornith/beellama (`.100:8082`, `chiap08:11436`),
  ollama (`.100:11434`), anthropic, and **nvidia**
  (`integrate.api.nvidia.com/v1`, `api_key_env: NVIDIA_API_KEY`) with a hardcoded
  model subset. **No OpenRouter backend.**
- `NVIDIA_API_KEY` is set (`~/.config/skgateway/secrets.env`). **No
  `OPENROUTER_API_KEY`** yet (needed to INVOKE free models; listing is keyless).

## 3. Architecture

Three units; the discovery module is the only new moving part.

### 3.1 Provider discovery module (`src/discovery.mjs`, new)

- `fetchNvidiaModels()` -> GET `integrate.api.nvidia.com/v1/models` (Bearer
  `NVIDIA_API_KEY`) -> ids. Filter to **text-generation chat** models: drop
  pure-embedding (`baai/bge-*`, `*embedqa*`, `nvidia/embed*`) and vision-only
  encoders (`adept/fuyu-*`, etc.) via a small capability heuristic/excludelist so
  the reply-model catalog is not polluted with non-chat cards.
- `fetchOpenRouterFreeModels()` -> GET `openrouter.ai/api/v1/models` -> keep only
  free (pricing zero or `:free`), then the same chat-only filter (drop
  `*content-safety*`, embeddings). No key needed to list.
- `discoverCatalog()` -> merge `{local (config), nvidia, openrouter}` into one
  list, each entry tagged `{id, provider, free, context?, label?}`. **Dedup by
  id** (a model served by more than one backend appears once; precedence
  local > nvidia > openrouter for routing).
- **Cache + resilience:** in-memory + on-disk (`~/.config/skgateway/model_catalog_cache.json`,
  mirroring the Hermes `provider_models_cache.json` pattern), TTL ~1h, refreshed
  on a timer and on demand. Provider unreachable -> serve last good cache, mark
  those entries `stale: true`; never fail `/v1/models`.

### 3.2 OpenRouter backend (config)

Add to `skgateway.yaml`:
```yaml
  openrouter:
    url: https://openrouter.ai/api/v1
    auth_type: api_key
    api_key_env: OPENROUTER_API_KEY
    discovery: free            # free | all — "free" filters at discovery time
    max_concurrent: 10
```
Prereq: add `OPENROUTER_API_KEY` to `~/.config/skgateway/secrets.env`. Without it,
discovery still LISTS free models (keyless) but calls to them 401 -> the health
reconciler flags them `unavailable` (honest, not hidden).

### 3.3 Catalog + routing (extend existing)

- `buildModelCatalog` gains the discovered models (merged with the static/local
  config entries) so `/v1/models` returns local + NVIDIA-free-chat +
  OpenRouter-free-chat, each with `provider` + `free` + `available` tags.
- The **router's** model->backend map is augmented from discovery: nvidia ids ->
  nvidia backend, openrouter free ids -> openrouter backend, local ids -> local
  backends. So any advertised id is routable. The existing per-request routing,
  concurrency caps, and body-size limits still apply (unknown-model body limits
  fall back to a safe default).
- Existing reconciliation (`advertise.reconcile`) is preserved: advertise all,
  annotate `available`/`unavailable` by reachability + quarantine.

### 3.4 Config knobs

```yaml
discovery:
  enabled: true
  refresh_seconds: 3600
  providers:
    nvidia:     { enabled: true,  free_only: true,  chat_only: true }
    openrouter: { enabled: true,  free_only: true,  chat_only: true }
```
`free_only: true` for both is the "for now" default; flipping OpenRouter to
`false` later widens to paid without code changes.

## 4. Testing / acceptance

- **Unit (fixtures, no live HTTP):** `fetchNvidiaModels`/`fetchOpenRouterFreeModels`
  parse fixture JSON -> the chat-only, free-only id sets (a paid OpenRouter model
  and a bge embedding are excluded; a `:free` and a normal chat card are kept).
  `discoverCatalog` dedups by id with the right provider precedence.
- **Resilience:** a provider fetch that throws -> the cached catalog is served and
  entries marked `stale`; `/v1/models` never 500s.
- **Live:** `GET /v1/models` shows local + ~NVIDIA-free-chat + ~OpenRouter-free
  with provider tags; a chat completion to a discovered NVIDIA free id routes and
  returns; an OpenRouter free id returns once `OPENROUTER_API_KEY` is set, and is
  flagged `unavailable` (not hidden) when it is not.

## 5. Integration with the skchat picker (W1)

The skchat unified reply-model picker fetches this `/v1/models` for its dynamic
concrete-model catalog. Once this ships, the picker automatically shows the
enriched set. The picker groups by `provider` and marks `free`; its legacy-alias
collapse (`qwen3.6...` -> `ornith-tiny`) and role section are unchanged. No
skchat change is required for the catalog to grow.

## 6. Out of scope

- Paid OpenRouter models (flag exists; off "for now").
- Non-chat catalogs (embeddings, vision, safety) as reply models.
- Per-model cost accounting changes (the existing pricing map still applies;
  discovered free models price at 0).
- The skchat picker UI itself (its own spec).

## 7. Component boundaries

- **discovery (`discovery.mjs`):** what — turn provider APIs into a merged,
  filtered, cached model list; use — `discoverCatalog()`; depends on — provider
  HTTP + keys + config flags.
- **config:** the openrouter backend + `discovery:` block; depends on — secrets.
- **catalog/router (existing):** consume the discovered list for `/v1/models` +
  routing; depend on — discovery. Callers (skchat picker) depend only on
  `/v1/models`.
