# Qwen3.8 chiap08 source alignment — 2026-08-21

This is bounded evidence for the checked-in SKGateway declaration. It does not claim a
deployment, restart, sustained-load qualification, or completion of SKHarness routing
card `d3c6377a`.

## Runtime observation

- `llama-qwen38.service` was `active/running` on chiap08 with PID `3966692`, listening
  on `0.0.0.0:11439` and reporting
  `qwen3.8-27b-huihui-abliterated-q4_k_m` from `GET /v1/models`.
- Direct completions using `qwen38-abliterated` and `qwen3.8-27b` both returned HTTP
  200; each response body named the Huihui id as the model actually served.
- Through SKGateway on `.41`, `qwen3.8-27b`, `qwen38-abliterated`, and role
  `sk-creative` returned HTTP 200 with chiap08/qwen38 backend attribution and the
  Huihui id in the response body. One earlier `qwen38-abliterated` attempt timed out
  after 60 seconds while the four-slot server was processing concurrent ~170K-token
  requests; the server cancelled that task on client disconnect, and a bounded retry
  passed in 1.026 seconds. This proves reachability and truthful identity, not an SLA.

## Source join

Before this change, the live synced config declared the Huihui id first while
`config/skgateway.yaml` omitted it and the committed model card described the retired
UD-Q5 weights as current. After the change, the `chiap08-qwen38` source and live blocks
agree exactly on URL, no-auth posture, priority, and ordered model ownership:

1. `qwen3.8-27b-huihui-abliterated-q4_k_m` — exact served id;
2. `qwen3.8-27b-ud-q5_k_xl` — retained pre-cutover request alias;
3. `qwen3.8-27b` — short request alias; and
4. `qwen38-abliterated` — custom local alias.

The source config SHA-256 is
`b6ab53b7e08cdda4cf51ba556af53597d8295c59e18b0a4c9898abc32b275dc8`; the unchanged
live config SHA-256 is
`a0b14202fed06d71d675e130d3922da4002ae17dd35673035c208f9aaa93ccb5`. The full files
remain intentionally different because the service loads the synced per-node file;
only the bounded `chiap08-qwen38` block is asserted equal here.

Hermetic regression:

```bash
node --test --import ./tests/_setup.mjs tests/qwen38-source-config.test.mjs
```
