# SKGateway config repo

This is the layout `deploy/skgateway-deploy` in
[smilinTux/skgateway](https://github.com/smilinTux/skgateway) expects via
`--config-repo`: a private, per-site git repo with one directory per gateway
instance. If you're reading this inside the main skgateway repo, this
directory (`deploy/example-config-repo/`) is a placeholder reference layout.
If you're reading this at the root of your own repo, you started from the
[`skgateway-config-template`](https://github.com/smilinTux/skgateway-config-template)
template and this is your walkthrough.

See
[`docs/DEPLOYING.md`](https://github.com/smilinTux/skgateway/blob/main/docs/DEPLOYING.md)
in the main repo for the full reference (secrets methods, upgrade, rollback,
status, optional add-ons, troubleshooting). This README is the short path.

## Layout

```
<instance-name>/
  instance.env       # schema version, port, pinned release tag, secrets method, optional add-on flags
  skgateway.yaml       # full gateway config for this instance
  policies.yaml         # authz policies
  secrets.env.enc        # encrypted credentials
README.md
```

One directory per instance. A host that runs more than one gateway (for
example a main instance plus a shadow backend) still only needs one
`<instance-name>/` directory per logical instance name passed to
`--instance`; the optional add-ons (shadow/ingress/canary) are flags inside
that same `instance.env`, not separate instances.

`example-instance/` here shows every supported key, including the optional
add-ons, commented out and off.

## Use this template

1. On the [`skgateway-config-template`](https://github.com/smilinTux/skgateway-config-template)
   repo, click **Use this template → Create a new repository**. **Choose
   Private.** This repo will hold real (if encrypted) credentials and your
   site's real backend hostnames; it must never be public.
2. Clone your new repo, then rename `example-instance/` to your real
   instance name (`nor`, `nam`, `codex`, ...). Delete any optional add-on
   keys you don't need from `instance.env`.
3. Fill in `<instance>/instance.env`: set `PORT`, pick the `RELEASE` tag
   you're deploying (a tag from
   [skgateway's releases](https://github.com/smilinTux/skgateway/tags)),
   and leave `CONFIG_SCHEMA` at the value this template shipped with unless
   `docs/DEPLOYING.md#config-schema` says otherwise.
4. Fill in `<instance>/skgateway.yaml` with your real backends, and
   `<instance>/policies.yaml` with your authz policies. Field reference:
   `docs/CONFIGURATION.md` and `docs/POLICIES.md` in the main repo.
5. Put real credentials in `<instance>/secrets.env.enc` as plain
   `KEY=value` lines, then encrypt it before committing:
   ```
   ansible-vault encrypt --vault-password-file <password-file> <instance>/secrets.env.enc
   ```
   Keep the password file itself **outside** this repo, and set
   `SECRETS_METHOD=ansible-vault` plus `VAULT_PASSWORD_FILE=<path>` in
   `instance.env`. (`sops` is also supported; see `docs/DEPLOYING.md`.)
6. Commit. `skgateway-deploy` refuses to run from a dirty config repo, so
   this repo's commit history is your deployment history.

## Deploy

On the host, with the main skgateway repo checked out at the release tag's
ancestry and this config repo cloned alongside it:

```
deploy/skgateway-deploy --release <tag> --config-repo /path/to/this/repo --instance <name>
```

That's a dry run: it prints every action and changes nothing. Read the
output, then add `--execute` to actually install and start the instance.

## Upgrade

Open a PR in this repo bumping `RELEASE` in `<instance>/instance.env` to the
new tag. Merge it. On the host, with this repo updated to that merge, run
the same `skgateway-deploy --execute` command again with the new `--release`.
The PR is the upgrade record.

## Rollback

```
deploy/skgateway-deploy --rollback --instance <name> --execute
```

Restores the previously-installed release and unit. A failed health check
during a deploy already does this automatically.
