### Per-estate runtime configs, and fail closed instead of booting another estate

One `main` serves estates with different provider sets (nor: ccapi plus
local/free models; chi: glm, kimi, codex, deepseek), so the estate now lives in
config rather than in a branch or a checkout.

- `resolveConfigPath()` no longer falls through to the in-repo
  `config/skgateway.yaml`. That file is a real 499-line estate config, not an
  example, so a host with a missing or misnamed runtime config silently booted
  another estate's providers, endpoints and admission caps while reporting
  healthy. Resolution now throws and names what to set.
- `$SKWORLD_ESTATE` selects `~/.skcapstone/gateway/skgateway.<estate>.yaml` at
  precedence 3. The estate is in the filename, not the directory, so one synced
  directory can serve both estates. `$SKGATEWAY_CONFIG` still outranks it.
- `configs/estates/{nor,chi}.yaml` hold the persisted per-estate configs.
  Nothing loads from there at runtime; it is the versioned copy.
- `src/metrics/delivery.mjs` no longer hardcodes a sibling directory named
  after chi's codex checkout for the metrics DB. `$SKGATEWAY_METRICS_DB`
  overrides it, defaulting to the old path.
