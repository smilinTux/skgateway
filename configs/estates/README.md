# Per-estate runtime configs

One skgateway `main` serves estates that run entirely different provider sets:

| estate | providers |
|--------|-----------|
| `nor`  | ccapi (`claude --print`, first-party subscription billing) + local/free models |
| `chi`  | glm, kimi, codex, deepseek |

These files are the **persisted source of truth** for each estate's runtime
config. They are not loaded from here at runtime. Each host reads its own copy
out of `~/.skcapstone/gateway/`, so a checkout can move to any branch without
touching what a live gateway serves.

## Deploying one

```bash
cp configs/estates/nor.yaml ~/.skcapstone/gateway/skgateway.nor.yaml
# then either name it explicitly:
#   SKGATEWAY_CONFIG=~/.skcapstone/gateway/skgateway.nor.yaml
# or let the estate select it:
#   SKWORLD_ESTATE=nor
systemctl --user restart skgateway
```

`resolveConfigPath()` precedence:

1. `--config <path>`
2. `$SKGATEWAY_CONFIG`
3. `~/.skcapstone/gateway/skgateway.$SKWORLD_ESTATE.yaml`
4. `~/.skcapstone/gateway/skgateway.yaml`
5. throw

The estate goes in the **filename**, not the directory, so the synced dir can
reach both estates without two hosts fighting over one path.

## No in-repo fallback, deliberately

`config/skgateway.yaml` (499 lines) and `config/skgateway-codex.yaml` are real
per-estate configs that the test suite loads as fixtures. They used to be
precedence 5, which meant a host with a missing or misnamed runtime config
silently booted **another estate's** providers, endpoints and admission caps
while looking healthy. For a router that is worse than downtime, so resolution
now fails closed and names what to set.

## Secrets

Never inline a key here. Use `api_key_env: SOME_VAR` and keep the value in
`~/.config/skgateway/secrets.env`, which systemd loads via `EnvironmentFile=`.
Both committed configs were scanned before landing: 0 secret-shaped lines, 0
inline `api_key:`.
