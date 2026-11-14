# Deploying SKGateway

This is the supported way to run SKGateway in production: a tagged release
from this public repo, configured from your own private per-site config
repo, installed and upgraded with `deploy/skgateway-deploy`. It replaces
hand-patched checkouts and untracked runtime directories with one repeatable
command, and it is the same shape a customer deployment uses.

## Contents

1. [Concepts](#concepts)
2. [Config repo layout](#config-repo-layout)
3. [Secrets](#secrets)
4. [First install](#first-install)
5. [Upgrade](#upgrade)
6. [Rollback](#rollback)
7. [Status](#status)
8. [Multiple instances on one host](#multiple-instances-on-one-host)
9. [Optional add-ons: shadow instance, tailnet ingress, canary loopback](#optional-add-ons-shadow-instance-tailnet-ingress-canary-loopback)
10. [Troubleshooting](#troubleshooting)

## Concepts

- **Release**: a tag `skgateway-vX.Y.Z` cut from `main` in this repo. Anything
  running in production is on `main` first; `skgateway-deploy` refuses a tag
  that isn't reachable from `main`.
- **Instance**: one running gateway process, identified by a short name
  (`nor`, `nam`, `codex`, ...). One host can run more than one instance. Each
  instance gets its own systemd **user** unit, port, config and secrets.
- **Config repo**: a private git repo, one per site, with one directory per
  instance. It is the source of truth for what each instance runs (the
  release tag it's pinned to) and how it's configured. A deploy refuses to
  run from a config repo with uncommitted changes, so the repo's commit
  history is the deployment history.
- **Dry-run by default**: `skgateway-deploy` without `--execute` prints every
  action it would take and changes nothing on disk. Always dry-run before
  `--execute` on a host you care about.

`skgateway-deploy` only ever touches the invoking user's own XDG
directories: `~/.config/systemd/user/`, `~/.config/skgateway/`,
`~/.local/share/skgateway/`, `~/.local/state/skgateway/`, and
`~/.local/libexec/skgateway/` for optional add-ons. It never needs root.

## Config repo layout

See [`deploy/example-config-repo/`](../deploy/example-config-repo/) for a
working example with placeholder values. One directory per instance:

```
<instance>/
  instance.env       # PORT, RELEASE, and optional add-on flags (below)
  skgateway.yaml      # full gateway config for this instance
  policies.yaml        # authz policies
  secrets.env.enc       # API keys etc., encrypted (see Secrets)
README.md
```

`instance.env` is a flat `KEY=value` file (no quoting, no shell expansion).
Required keys:

| Key | Meaning |
|---|---|
| `CONFIG_SCHEMA` | The config-repo schema this instance.env is written against. See [Config schema](#config-schema). |
| `PORT` | The port this instance's gateway process listens on. |
| `RELEASE` | The release tag this instance is pinned to. `--release` on the command line must match this, or the deploy refuses (see `--force-release`). |

Optional keys:

| Key | Meaning |
|---|---|
| `NODE_OPTIONS` | Passed through to the Node process via the unit's `Environment=`. |
| `SECRETS_METHOD` | `ansible-vault`, `sops`, or `none`. Default `none`. See [Secrets](#secrets). |
| `VAULT_PASSWORD_FILE` | Path to the ansible-vault password file, only when `SECRETS_METHOD=ansible-vault`. **Never commit this file or put it inside the config repo.** |

The release tag lives in `instance.env`, so **changing the release is a PR**:
bump `RELEASE`, merge, then run `skgateway-deploy` on the host. That PR is
the upgrade record.

### Config schema

`CONFIG_SCHEMA` is a plain integer naming the shape of `instance.env` (and,
going forward, anything else `skgateway-deploy` reads from the config repo)
that this instance.env was written against. Each release of this repo knows
the minimum schema it can run: `skgateway-deploy` refuses to deploy a config
repo pinned to an older schema, and the error names the value to set, e.g.:

```
instance.env CONFIG_SCHEMA=0 is older than this release's minimum supported
schema (1): .../demo/instance.env -- set CONFIG_SCHEMA=1 (see
docs/DEPLOYING.md#config-schema for what changed since your config repo was
written)
```

A config repo that predates `CONFIG_SCHEMA` (the key is simply absent) is
treated as schema `0`. This exists so a future breaking change to the
config-repo shape (a renamed key, a new required file, a changed meaning)
can ship as "bump `MIN_CONFIG_SCHEMA` in `deploy/skgateway-deploy` and say
here what changed" instead of a deploy silently misreading an old config
repo. Bumping it is a deliberate act by whoever lands that change; it does
not happen automatically with every release.

History:

- **1** (current minimum): initial schema. No prior shape to migrate from.

## Secrets

`<instance>/secrets.env.enc` holds API keys and other credentials for the
instance, encrypted so they're safe to commit. `skgateway-deploy` decrypts it
to `~/.config/skgateway/<instance>/secrets.env` (mode `0600`) and the
instance's systemd unit loads it with `EnvironmentFile=`. The plaintext file
on disk is per-host, per-instance, and never committed anywhere.

Three methods are supported via `SECRETS_METHOD` in `instance.env`:

- **`ansible-vault`** (recommended; this is what the rest of the SKStacks
  fleet already uses for vault files, so there's one encryption tool to
  manage across the fleet rather than two). Requires `VAULT_PASSWORD_FILE`
  in `instance.env`, pointing at a password file that lives **outside** the
  config repo (e.g. `~/.vault_pass_env/<site>_vault_pass`, not synced, not
  committed). Encrypt with:
  ```
  ansible-vault encrypt --vault-password-file <password-file> <instance>/secrets.env.enc
  ```
- **`sops`**: supported for sites that already use sops/age elsewhere.
  `skgateway-deploy` runs `sops --decrypt`, which uses sops's own key
  discovery (age key file, KMS, etc.): nothing sops-specific is configured
  by this script.
- **`none`**: no encryption; the file is read as-is. Only appropriate for a
  local/dev instance with no real credentials. CI and the test suite use this
  so tests need no real keys.

## First install

1. Clone or update this repo's checkout on the host (this is the checkout
   `skgateway-deploy` itself runs from; it's also where release-tag
   reachability is verified against, and where releases are cloned from via
   its `origin` remote).
2. Clone your private config repo somewhere on the host, e.g.
   `~/skgateway-config/`.
3. Dry-run first:
   ```
   deploy/skgateway-deploy --release skgateway-v1.2.0 --config-repo ~/skgateway-config --instance nor
   ```
   Read the output. It prints every file it would write, the rendered unit,
   and what it would run, without changing anything.
4. If that looks right, actually deploy:
   ```
   deploy/skgateway-deploy --release skgateway-v1.2.0 --config-repo ~/skgateway-config --instance nor --execute
   ```
   This clones the release (shallow, at the tag) into
   `~/.local/share/skgateway/releases/<tag>/` and runs `npm ci --omit=dev`
   there, decrypts secrets to `~/.config/skgateway/<instance>/secrets.env`
   (`0600`), renders and installs
   `~/.config/systemd/user/skgateway-<instance>.service`, restarts it, and
   health-checks `GET /healthz` and `GET /v1/models` on `127.0.0.1:<PORT>`
   for up to 60 seconds. If the instance never answers both of those, the
   previous release's unit is restored automatically and the command exits
   `3`.

## Upgrade

1. In the config repo: open a PR bumping `RELEASE` in `<instance>/instance.env`
   to the new tag. Merge it.
2. On the host, with the config repo checkout updated to that merge:
   ```
   deploy/skgateway-deploy --release <new-tag> --config-repo ~/skgateway-config --instance nor --execute
   ```
   The previous release's checkout and unit file are kept (one level of
   history) so a `--rollback` is always available after an upgrade, even if
   the health check passed but something is wrong in a way health checks
   don't catch.

`--release` must equal the `RELEASE` already pinned in `instance.env` unless
you pass `--force-release`, which keeps an operator from accidentally
deploying a tag the config repo PR process never recorded. `--force-release`
exists for recovery (e.g. hand-testing a tag before writing the PR); it does
not rewrite `instance.env`.

## Rollback

```
deploy/skgateway-deploy --rollback --instance nor --execute
```

Restores the previously-installed unit file (pointing at the previous
release's checkout, which was never deleted) and restarts the instance.
Running it twice flips back and forth between the two most recent releases.
Dry-run (no `--execute`) shows what it would restore without changing
anything.

A failed health check during a deploy already does this automatically (exit
code `3`); `--rollback` is for rolling back something that passed its health
check but is wrong for another reason.

`--rollback` only restores the main instance unit and release. The optional
add-on units (shadow/ingress/canary, below) are left exactly as the last
deploy rendered them; roll those back by re-running a deploy with the
instance.env flags set the way you want, or by hand.

## Status

```
deploy/skgateway-deploy --status --instance nor
```

Prints the current and previous release tags, the configured port, the unit
file path, and the systemd `is-active` state. Read-only, makes no changes.

## Multiple instances on one host

Run the same command once per instance name; each gets its own unit
(`skgateway-<instance>.service`), its own secrets file
(`~/.config/skgateway/<instance>/secrets.env`), and its own release checkout
is shared across instances pinned to the same tag (it's just a read-only
Node checkout, reused rather than re-cloned when the tag matches and the
checkout is clean). A port collision between two instances on the same host
is a config-repo mistake: give each instance its own `PORT`.

## Optional add-ons: shadow instance, tailnet ingress, canary loopback

Three patterns that started as one-off, site-specific systemd units on
`chiap01`/`chiap08` are available as generic templates, each OFF unless its
instance.env flag is set, and never auto-enabled even when the flag is set:
`skgateway-deploy` writes the unit file(s); starting them is a deliberate,
separate `systemctl --user enable --now` once you've reviewed what was
rendered. All three are parameterized only from `<instance>/instance.env`.

### Shadow instance (`SHADOW_ENABLED`)

Runs a second gateway process for the same instance, same release checkout,
on a different port and a different config file (e.g. a separate shared or
restricted-profile backend served alongside the main one).

| Key | Meaning |
|---|---|
| `SHADOW_ENABLED` | `1` to render `skgateway-shadow-<instance>.service`. Default off. |
| `SHADOW_PORT` | Required when enabled. The shadow process's port. |
| `SHADOW_CONFIG` | Optional. Defaults to `<instance>/skgateway.shadow.yaml` in the config repo. |

### Tailnet ingress (`INGRESS_SOCKET`)

A systemd socket-activated proxy (`systemd-socket-proxyd`, shipped with
systemd) that accepts only on one named network interface and forwards to
the instance's own loopback port. This is how the original chiap01 pattern
exposed a loopback-only backend across an estate tailnet without binding it
to a LAN or public address directly.

| Key | Meaning |
|---|---|
| `INGRESS_SOCKET` | `1` to render `skgateway-ingress-<instance>.socket` and `.service`. Default off. |
| `TAILNET_INTERFACE` | Optional. The interface to bind (`BindToDevice=`). Defaults to `tailscale0`. |
| `INGRESS_PORT` | Optional. The port exposed on that interface. Defaults to the instance's `PORT`. |

`BindToDevice=` on a `systemd --user` socket unit may need elevated network
capabilities on some hosts/kernels. If your host doesn't permit it under the
user instance, copy the rendered `.socket`/`.service` files from
`~/.config/systemd/user/` into `/etc/systemd/system/` by hand and manage them
as root, the way the original chiap01 units did; `skgateway-deploy` itself
only ever writes to the user scope.

### Canary loopback health check (`CANARY`)

A supervised SSH port-forward from this host to a remote loopback backend,
with a health script run after each (re)start. This is how the chiap08
canary watched chiap01's shared backend without sending it any inference
traffic.

| Key | Meaning |
|---|---|
| `CANARY` | `1` to render `skgateway-canary-<instance>.service` and its health script. Default off. |
| `CANARY_LOCAL_PORT` | Required when enabled. The local port the SSH tunnel listens on. |
| `CANARY_REMOTE_HOST` | Required when enabled. The SSH host alias to connect to (identity and known-hosts come from your SSH config, never inline). |
| `CANARY_REMOTE_PORT` | Required when enabled. The port on the remote host's loopback to forward to. |
| `CANARY_SSH_CONFIG` | Optional. Defaults to `~/.ssh/config`. |

The health script is installed at
`~/.local/libexec/skgateway/canary-<instance>-health` and polls
`http://127.0.0.1:<CANARY_LOCAL_PORT>/health` a few times after the tunnel
(re)starts; it does not send inference traffic.

## Troubleshooting

- **"release tag not found" / "not reachable from main"**: the tag must
  exist in the checkout `skgateway-deploy` runs from, and be an ancestor of
  `main`. Fetch tags (`git fetch --tags`) and confirm the release PR merged.
- **"config repo has uncommitted changes"**: commit or stash before
  deploying. This check exists so the config repo's history is always a
  faithful record of what's running.
- **"--release does not match RELEASE"**: the config repo's `instance.env`
  pins a different tag than the one you passed. Either deploy the pinned
  tag, or open the PR to bump `RELEASE` first. `--force-release` overrides
  this for recovery, not as a routine path.
- **Health check fails and rolls back (exit `3`)**: check
  `journalctl --user -u skgateway-<instance> -n 100` for why the new release
  didn't come up; the previous release is already restored and serving.
