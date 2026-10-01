# c1a30113: legacy model catalog repair

The live gateway advertised `glm-4.6` and `glm-4.7` after bucket admission had
already excluded them. An exact `glm-4.6` request returned a different served
model and failed independent-review qualification. That failed receipt remains
preserved; it is not accepted as review evidence.

The only installed configuration change is the existing catalog control:

```yaml
advertise:
  reconcile: hide
  excluded_models: [glm-4.6, glm-4.7]
```

No gateway source, worker model table, model alias, credential, or existing
bucket exclusion changed. The exact running source baseline is
`85945618e509f5a808094ef7eb7fdf763dbbc392`; the three relevant installed module
hashes match that baseline. This commit records evidence only.

## Results

- Parsed configuration deep equality proved this is the sole added field.
  Before/after catalog checks reproduced the advertised legacy entries and
  showed the candidate hides both while retaining `glm-5.3`.
- Existing catalog and invalid-reload regressions: 23 passed, zero failed or
  skipped. The initial run correctly refused production lifecycle-store writes;
  the successful run used an explicit private test store. An initial parser
  probe used an absent package; the corrected probe used existing `js-yaml`.
- Independent review: qualified PASS, no blocking findings, requested
  `sk-zai-m`, served `glm-5.3`. Exact prompt SHA256:
  `f19d86e105a051e86ed3e0aa2117fb3cf679502d56a66adaa3b59fedc8dcad19`.
- Installed with a private original-host backup and guarded SIGHUP at zero
  observed active/queued requests. The same service PID remained active.
  `/health` passed and `/v1/models` lost exactly the two specified IDs.
- Fresh production route discovery excluded both legacy IDs. One completion
  requested the gateway-resolved `sk-glm-m`, served `glm-5.3`, returned `OK`,
  and passed exact backend attribution: HTTP 200, 1.883 seconds, 20 tokens.
- Independent readback verified private owned regular backup files, unchanged
  runtime modules, preserved config metadata, and exact byte restoration from
  the backup. Actual rollback was not exercised on the healthy live gateway.

## Custody and rollback

Private evidence remains under `~/.skcapstone/evidence/work/c1a30113/`:
`PLAN.json`, `CONFIG-CHECK.json`, `REGRESSION.log`, `REVIEW.json`,
`review-zai-1790889466588554464.json`, `INSTALL.json`,
`POST-INSTALL-COMPLETION.json`, and `READBACK.json`.

Config before SHA256:
`09f899d3cf0ba94e9b3af1afd7cc968e77fd85bd1e078e9aa00330da8c27a28c`.
Config after SHA256:
`49d95696872ef496da1ff2ff1bb4efc3f446ac49e76fc931db3c004a2de69543`.

The private backup remains on chiap01 under
`~/.local/state/skgateway/operator/catalog-c1a30113-20261001-c1a30113/`.
The reviewed `catalog_config.py rollback` command restores only that exact
preimage after checking the current hash, service binding, and idle state,
then sends SIGHUP and verifies health. It refuses unrelated intervening edits.

No application deployment, provider bypass, wider fleet trial, physical-device
qualification, or completion of the broader Sep21 plan is claimed. Existing
card `a4e0f068` ownership and evidence are preserved. Canonical task `c1a30113`
links these receipts through guarded native transitions.
