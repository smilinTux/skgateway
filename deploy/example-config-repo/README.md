# Example SKGateway config repo

This is a placeholder layout for a private per-site SKGateway config repo,
the kind `deploy/skgateway-deploy` expects via `--config-repo`. Copy this
structure into your own private git repo, replace the placeholder values,
encrypt `secrets.env.enc` for real, and commit. See
[`docs/DEPLOYING.md`](../../docs/DEPLOYING.md) in the main skgateway repo for
the full walkthrough.

Every real site should look like this:

```
<instance-name>/
  instance.env       # port, pinned release tag, secrets method, optional add-on flags
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
add-ons, commented out and off. Rename it to your real instance name
(`nor`, `nam`, `codex`, ...) and delete the keys you don't need.
