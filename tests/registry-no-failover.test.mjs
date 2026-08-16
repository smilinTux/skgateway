/**
 * registry-no-failover.test.mjs — a backend may declare that it must NEVER be
 * substituted by the cloud failover.
 *
 * Card ba782c14. Some roles are defined by a PROPERTY, not by capacity, and a
 * substitute cannot satisfy them:
 *
 *   sk-creative  is the abliterated/uncensored text brain. Answering it with a
 *                guardrailed cloud model does not degrade the role, it INVERTS
 *                it, and returns 200 while doing so.
 *   sk-embed     an embedding space is not interchangeable at all.
 *   anything     whose whole point is that the prompt never leaves our hardware.
 *
 * Measured on 2026-08-16 before this flag existed: with qwen-vl's backend
 * (chiap08 :11436) refused, `model=sk-creative` returned HTTP 200 with
 * `response.model = openai/gpt-oss-20b`. The router log for that same request
 * said `backend=qwen-vl model -> Qwen3.6-27b-abliterated-Q4_K_M`. Uncensored,
 * private prompts were being answered by a third-party cloud provider, and
 * nothing in the response said so.
 *
 * The N1 sovereignty gate (card 45d7a30b) already blocks that crossing, but only
 * when the CALLER declares `require.sensitivity`. When the caller declares
 * nothing, requestZoneCeiling() returns null and the fallback is allowed. This
 * flag closes that hole from the SERVER side, where the property actually lives:
 * the backend knows it is irreplaceable, the caller may not.
 *
 * Run with:  node --test tests/registry-no-failover.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "../src/proxy/registry.mjs";

const dir = mkdtempSync(join(tmpdir(), "skgw-nofo-"));
const fixture = join(dir, "registry.yaml");
writeFileSync(
  fixture,
  `backends:
  qwen-vl:
    url: http://100.81.238.58:11436/v1
    model: Qwen3.6-27b-abliterated-Q4_K_M
    ctx: 32768
    kind: chat
    vision: true
    no_failover: true
  ornith:
    url: http://192.168.0.100:8082/v1
    model: ornith-1.0-9b
    ctx: 131072
    kind: chat
roles:
  sk-creative: qwen-vl
  sk-default: ornith
defaults:
  role: sk-default
`,
);

describe("registry no_failover", () => {
  test("a backend declaring no_failover surfaces it on the resolved route", () => {
    const reg = resolve({ model: "sk-creative" }, fixture);
    assert.ok(reg, "sk-creative should resolve");
    assert.equal(reg.backend, "qwen-vl");
    assert.equal(
      reg.noFailover,
      true,
      "the resolved route must carry noFailover so the router can refuse to substitute",
    );
  });

  test("a backend that does not declare it defaults to substitutable", () => {
    const reg = resolve({ model: "sk-default" }, fixture);
    assert.ok(reg, "sk-default should resolve");
    assert.equal(
      reg.noFailover,
      false,
      "absent means false: failover stays ON by default, this flag is opt-in per backend",
    );
  });
});
