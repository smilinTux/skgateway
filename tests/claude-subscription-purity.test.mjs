/**
 * Claude subscription-path purity (incident 2026-09-11, Telegram outage).
 *
 * The `anthropic` backend is the LOCAL claude-code-api wrapper (:18782 =
 * `claude --print`). It is the only route that bills claude-* as genuine
 * first-party subscription usage, and its config block says so outright:
 * "There is NO failover target by design: the subscription path is the only
 * claude-* route."
 *
 * That intent was a comment, not a constraint. Purity is OPT-IN per backend
 * (`provider_purity: true`, card f361407c) and the flag was never set on
 * `anthropic`, so the stated design was unenforced.
 *
 * What that cost, live on 2026-09-11:
 *   07:15  claude-code-api ran out of slots (CCAPI_MAX_CONCURRENT=3) and
 *          answered 500 "queue timeout: no free claude slot within 90s"
 *   07:16  [router] backend=anthropic error_rate=100.0% — marking DOWN
 *   07:16  [router] model=claude-opus-5 → primary=nvidia fallbacks=[...]
 *   ...    NVIDIA NIM has no model named claude-opus-5, so its Go mux replied
 *          with a bare `404 page not found`, which Hermes surfaced to Chef in
 *          Telegram as "The model provider failed after retries."
 *
 * A transient 60s cooldown on the wrapper thus became a hard 404 on a model
 * that was never NVIDIA's to serve. The correct behaviour is to fail closed
 * with 503 model_owner_backend_down, naming the real owner, so the caller's
 * retry loop backs off against the wrapper instead of burning attempts on
 * backends that structurally cannot answer.
 *
 * These tests pin the SHIPPED CONFIG, not a synthetic fixture: the bug was a
 * missing key in config/skgateway.yaml, so a fixture-only test would have
 * stayed green straight through the outage.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { createRouter } from "../src/proxy/router.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = resolve(REPO_ROOT, "config", "skgateway.yaml");

function loadShippedBackends() {
  const cfg = yaml.load(readFileSync(CONFIG_PATH, "utf8"));
  return Object.fromEntries(
    Object.entries(cfg.backends)
      .filter(([, b]) => b.enabled !== false)
      .map(([id, b]) => [id, { ...b, id }]),
  );
}

test("shipped config: anthropic declares provider_purity", () => {
  const backends = loadShippedBackends();
  assert.equal(
    backends.anthropic.provider_purity, true,
    "config/skgateway.yaml backends.anthropic must set provider_purity: true — " +
    "without it a transient claude-code-api cooldown sprays claude-* to NVIDIA, " +
    "which answers `404 page not found`.",
  );
});

test("claude-* routes to the subscription wrapper while it is healthy", async () => {
  const router = createRouter({ backends: loadShippedBackends() });
  for (const model of ["claude-opus-5", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]) {
    const got = await router.route({ model });
    assert.deepEqual(
      got.map((c) => c.backendId), ["anthropic"],
      `${model} must route to anthropic alone`,
    );
  }
});

test("claude-* fails closed when the wrapper is DOWN — never sprays to nvidia", async () => {
  const router = createRouter({ backends: loadShippedBackends() });

  // Drive the backend into the DOWN error-cooldown state exactly as the live
  // error-rate machinery did at 07:16:53 on 2026-09-11.
  const anthropic = router.getBackend("anthropic");
  anthropic._status = "down";
  anthropic._downSince = Date.now();

  for (const model of ["claude-opus-5", "claude-sonnet-4-6"]) {
    await router.route({ model }).then(
      (got) => assert.fail(
        `${model} sprayed to [${got.map((c) => c.backendId).join(", ")}] instead of ` +
        `failing closed — this is the 2026-09-11 Telegram 404 regression`,
      ),
      (err) => {
        assert.equal(err.name, "ModelOwnerDownError");
        assert.equal(err.status, 503);
        assert.deepEqual(err.declaredBy, ["anthropic"]);
      },
    );
  }
});

test("purity on anthropic does not disturb unrelated backends", async () => {
  const router = createRouter({ backends: loadShippedBackends() });
  const anthropic = router.getBackend("anthropic");
  anthropic._status = "down";
  anthropic._downSince = Date.now();

  // A model nobody declares keeps the historic fall-through to all available
  // backends; purity is scoped to declared ids only.
  const undeclared = await router.route({ model: "some-unclaimed-model-id" });
  assert.ok(undeclared.length > 0, "undeclared ids must keep falling through");
  assert.ok(
    !undeclared.some((c) => c.backendId === "anthropic"),
    "a DOWN backend must not appear in the fall-through list",
  );
});
