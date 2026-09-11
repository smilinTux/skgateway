/**
 * ornith context preflight ceiling (incident 2026-09-11, cron 502 storm).
 *
 * The context preflight (card 9ed4a9f7) only runs for a backend that declares
 * `context_limit`. `ornith` declared none, so the preflight was silently
 * disabled for the backend serving the `sk-default` role -- the role Chef's
 * conventions point every triage/parse/summarize step at.
 *
 * What that cost: hermes agent cron jobs (daily-brief, infra-security-scan-daily)
 * ship ~205,815-byte bodies, ~68,605 estimated tokens against a 65,536-token
 * engine. They were routed to ornith anyway, llama-server truncated them, the
 * model spent its budget on reasoning and returned EMPTY content, and the
 * response contract rejected that as 502 "Upstream returned invalid completion
 * evidence" after ~32s per attempt. Chef saw a provider fault; the truth was a
 * request that never fit.
 *
 * The ceiling is n_ctx minus the registry's min_output_tokens reservation
 * (65536 - 8192 = 57344): the INPUT cannot be allowed to consume the room the
 * visible answer needs, because a request that leaves zero output budget
 * produces exactly the empty-content 502 this guards against.
 *
 * Asserted against the SHIPPED config: the bug was a missing key, so a fixture
 * would have stayed green through the whole incident.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = yaml.load(readFileSync(resolve(REPO_ROOT, "config", "skgateway.yaml"), "utf8"));

test("ornith declares a context_limit so the preflight is armed", () => {
  const ornith = cfg.backends.ornith;
  assert.ok(ornith, "ornith backend must exist");
  assert.equal(
    typeof ornith.context_limit, "number",
    "ornith must declare context_limit — without it the context preflight is " +
    "disabled and oversized prompts are truncated into empty-content 502s.",
  );
  assert.ok(ornith.context_limit > 0, "context_limit must be positive to arm the preflight");
});

test("the ceiling reserves output budget below the engine's n_ctx", () => {
  const N_CTX = 65536;        // llama-server /props on 192.168.0.100:8082
  const MIN_OUTPUT = 8192;    // registry.yaml ornith.min_output_tokens
  assert.equal(
    cfg.backends.ornith.context_limit, N_CTX - MIN_OUTPUT,
    "input ceiling must leave the reserved visible-answer budget free",
  );
});

test("the 2026-09-11 cron body would be refused, a normal one admitted", () => {
  // The preflight's documented heuristic: ~3 bytes per token.
  const estTokens = (bytes) => Math.ceil(bytes / 3);
  const limit = cfg.backends.ornith.context_limit;

  assert.ok(
    estTokens(205815) > limit,
    "the observed 205,815-byte cron body must be rejected up front",
  );
  assert.ok(
    estTokens(4000) < limit,
    "ordinary triage-sized bodies must still be admitted",
  );
});
