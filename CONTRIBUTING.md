# Contributing to SKGateway

Thanks for helping build the sovereign inference chokepoint. This repo follows the
SKWorld [`SK_REPO_DOC_STANDARD`](https://github.com/smilinTux/sk-standards) - docs and
tests are part of "done".

## Branch model

- `main` is always releasable and protected.
- Branch per unit of work with a conventional prefix:
  `feat/<slug>`, `fix/<slug>`, `docs/<slug>`, `chore/<slug>`, `refactor/<slug>`.
- Keep branches focused; open a PR against `main`.

## Commit convention

- Conventional Commits: `type(scope): summary` (e.g. `fix(metrics): accept
  already-extracted metrics config in collector`).
- When a change maps to a coordination card, reference the card id in the subject or
  body (e.g. `(7e739811)`).
- Every commit MUST end with the trailer:

  ```
  Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
  ```

- Writing style: do NOT use em dashes or en dashes as sentence punctuation. Restructure
  with commas, parentheses, or a new sentence. Regular hyphens are fine.

## Test gate

The green bar blocks merge. Run before opening a PR:

```bash
npm install
npm test          # node --test tests/*.test.mjs - all suites must pass
```

- Any bug fix adds a regression test that fails before the fix and passes after
  (see `tests/metrics-collector.test.mjs` as the reference pattern).
- New features add unit tests under `tests/*.test.mjs`.
- Update `CHANGELOG.md` under `[Unreleased]` (Keep a Changelog format) for any
  user-visible change.

## Code conventions

- ES modules only (`.mjs`), Node 20+ native. No build step, no transpiler.
- New backends: add a `backends` entry in config; add an auth handler in
  `src/proxy/upstream.mjs` only if the scheme is non-standard.
- New policy actions/transforms: extend `src/policy/`.
- New SIEM outputs: add a module in `src/siem/` implementing `write(event)` /
  `init(config)` and register it in `src/siem/events.mjs`.
- Never inline a secret. Reference keys by env-var name (see `SECURITY.md`).

## Review path

1. Open a PR against `main` with a clear description and the compliance checklist from
   `SK_REPO_DOC_STANDARD` §6 where relevant.
2. CI / `npm test` green.
3. At least one maintainer review.
4. Squash or merge to `main`; tag releases per `SOP.md` §5.

## Reporting security issues

Do not use public issues for vulnerabilities. Follow `SECURITY.md`.
