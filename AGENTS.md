# SKGateway — Agent Onboarding

This file provides instructions for ANY AI coding agent working on SKGateway,
regardless of tool, IDE, or platform. SKGateway is the sole provider router
for the SK stack: it owns provider selection, health, bucket membership,
weights, model exclusions, and attribution. It is a transport router, not an
authorization or legal-policy owner.

## Which role are you

Your coordination card title tells you your role:

- No `[REVIEW` tag: you are the producer. Implement exactly your card's
  assigned TDD and allowed path list.
- `[REVIEW` tag: you are the independent reviewer. Your card completes with
  a verdict link, not by redoing the work.

If your card has no TDD or allowed path list, stop and report that gap
before writing anything.

## Step 1: Learn the coordination protocol

```bash
skcapstone coord briefing
skcapstone coord status
```

All task writes go through `skcapstone coord`. Never create, append, rewrite,
or delete CardStore JSONL directly. Work only your claimed card, with your
explicit `--agent <identity>` on every command.

## Repository facts

- Node.js service. Configuration is JSON (`--config`), validated fail-closed
  at boot and at SIGHUP reload. A rejected reload must keep the last valid
  configuration active; accepted policies are atomic swaps with a revision.
- Routing identity: canonical model IDs are authoritative for candidate
  selection, bucket membership, qualification, health, throttling, policy,
  requested-model attribution, and audit. Provider wire IDs appear only in
  the outbound attempt body when a backend declares an explicit model map.
  The provider response's model is the served-model attribution.
- Providers are configured declaratively. Never hard-code a private model
  host, endpoint, operator alias, or script path into runtime source.

## Tests

Run the focused file first, then the full suite, and record exact commands
and counts in your evidence:

```bash
node --test --import ./tests/_setup.mjs tests/<focused>.test.mjs
npm test
```

- Test-first: capture RED before source changes when your TDD requires it.
- Never weaken, skip, or delete a test to make a suite pass. A test
  correction is allowed only when it replaces a stale environmental
  assumption with a stronger invariant.
- Inherited failures must be reproduced on your accepted base with the same
  environment and recorded by test name, assertion, and aggregate counts.

## Boundaries

- Credentials live only in the existing secret-loading boundary (for example
  the managed `providers.env`). They never enter tracked configuration,
  source, logs, prompts, cards, or evidence. Do not print environment
  contents or credential values.
- A card worktree never pushes, merges, deploys, restarts services, signals
  or mutates the live gateway, its registry, release pointers, or systemd
  units. Installation and operations are separate cards with their own
  gates, artifacts, canaries, and rollback.
- No provider or network service outside local test fixtures may be called
  from source tests. Provider canaries belong to operational cards.
- Do not modify GPU configuration or node assignments.
- Never use em dash or en dash characters in code, comments, documentation,
  or generated artifacts.

## Completion evidence

Under your card's evidence directory, record: changed paths, the exact test
commands and counts, RED evidence when required, inherited failures,
candidate commit and patch identities when your TDD binds them, known
limitations, and rollback notes. Then `skcapstone coord link <id> evidence
<path>`, record your verdict, move the card to review, and stop. Never
self-review or complete a card before independent review.
