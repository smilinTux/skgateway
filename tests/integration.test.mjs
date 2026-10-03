/**
 * integration.test.mjs — skgateway ⇄ skcapstone bridge.
 *
 * Verifies the polyglot contract from
 * skcapstone/docs/ADR-optional-integration-backbone.md:
 *   - standalone (SK_STANDALONE=1) / absent (no ~/.skcapstone) → native fallback
 *   - present (shared home exists) → writes pubsub message + registry entry in
 *     the exact format the Python side reads.
 *
 * Run with:  node --test tests/integration.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isPresent,
  levelForSeverity,
  alert,
  forwardSiemEvent,
  registerService,
  SERVICE,
} from "../src/integration.mjs";

let home;
const savedEnv = {};

beforeEach(() => {
  savedEnv.HOME_ENV = process.env.SKCAPSTONE_HOME;
  savedEnv.STANDALONE = process.env.SK_STANDALONE;
  savedEnv.HEALTH_URL = process.env.SKGATEWAY_HEALTH_URL;
  delete process.env.SKGATEWAY_HEALTH_URL;
  delete process.env.SK_STANDALONE;
  home = mkdtempSync(join(tmpdir(), "skgw_sk_"));
  process.env.SKCAPSTONE_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (savedEnv.HEALTH_URL === undefined) delete process.env.SKGATEWAY_HEALTH_URL;
  else process.env.SKGATEWAY_HEALTH_URL = savedEnv.HEALTH_URL;
  if (savedEnv.HOME_ENV === undefined) delete process.env.SKCAPSTONE_HOME;
  else process.env.SKCAPSTONE_HOME = savedEnv.HOME_ENV;
  if (savedEnv.STANDALONE === undefined) delete process.env.SK_STANDALONE;
  else process.env.SK_STANDALONE = savedEnv.STANDALONE;
});

function readTopic(topic) {
  const dir = join(home, "pubsub", "topics", topic);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith("msg-"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

describe("severity mapping", () => {
  test("maps gateway severities to sk-alert levels", () => {
    assert.equal(levelForSeverity("info"), "info");
    assert.equal(levelForSeverity("warning"), "warn");
    assert.equal(levelForSeverity("error"), "error");
    assert.equal(levelForSeverity("critical"), "critical");
    assert.equal(levelForSeverity("bogus"), "warn");
  });
});

describe("standalone / absent", () => {
  test("SK_STANDALONE disables integration", () => {
    process.env.SK_STANDALONE = "1";
    assert.equal(isPresent(), false);
    assert.equal(alert("x", { a: 1 }, "error"), false);
    assert.equal(registerService(), false);
  });

  test("absent shared home → not present, alert falls back", () => {
    process.env.SKCAPSTONE_HOME = join(home, "does-not-exist");
    assert.equal(isPresent(), false);
    assert.equal(alert("upstream_down", { backend: "x" }, "error"), false);
  });
});

describe("present (file-based publish)", () => {
  test("alert writes a pubsub message in the Python-compatible format", () => {
    assert.equal(isPresent(), true);
    assert.equal(alert("rate_limit", { backend: "nvidia", status: 429 }, "warn"), true);

    const msgs = readTopic("skgateway.warn");
    assert.equal(msgs.length, 1);
    const m = msgs[0];
    assert.equal(m.topic, "skgateway.warn");
    assert.equal(m.sender, SERVICE);
    assert.equal(m.ttl_seconds, 86400);
    assert.deepEqual(m.tags, ["warn"]);
    assert.equal(m.payload.event, "rate_limit");
    assert.equal(m.payload.backend, "nvidia");
    // message_id present, published_at ISO-8601 (parseable by Python)
    assert.match(m.message_id, /^[0-9a-f-]{12}$/);
    assert.ok(!Number.isNaN(Date.parse(m.published_at)));
  });

  test("forwardSiemEvent drops info, forwards warn+", () => {
    assert.equal(
      forwardSiemEvent({ event_type: "request_ok", severity: "info", details: {} }),
      false,
    );
    assert.equal(readTopic("skgateway.info").length, 0);

    assert.equal(
      forwardSiemEvent({
        event_type: "backend_error",
        severity: "error",
        details: { backend: "nvidia", status: 502 },
      }),
      true,
    );
    const msgs = readTopic("skgateway.error");
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].payload.event, "backend_error");
    assert.equal(msgs[0].payload.severity, "error");
    assert.equal(msgs[0].payload.status, 502);
  });

  test("registerService writes a discovery registry entry", () => {
    assert.equal(
      registerService({ healthUrl: "https://gateway.example/health" }),
      true,
    );
    const entry = JSON.parse(
      readFileSync(join(home, "registry", "skgateway.json"), "utf8"),
    );
    assert.equal(entry.name, "skgateway");
    assert.equal(entry.health_url, "https://gateway.example/health");
  });
});


test("unconfigured or host-local startup preserves the shared gateway record", () => {
  assert.equal(registerService({ healthUrl: "https://gateway.example/health" }), true);
  const path = join(home, "registry", "skgateway.json");
  const before = readFileSync(path, "utf8");
  assert.equal(registerService(), false);
  for (const healthUrl of ["http://localhost:1234/health", "http://127.0.0.1/health", "http://[::1]/health", "http://[::ffff:127.0.0.1]/health", "http://127.9.8.7/health", "http://localhost./health", "http://0.0.0.0/health", "http://[::]/health", "https://user:password@gateway.example/health", "file:///tmp/health", "invalid"]) {
    assert.equal(registerService({ healthUrl }), false);
    assert.equal(readFileSync(path, "utf8"), before);
  }
});

test("startup can advertise an explicit reachable liveness endpoint", () => {
  process.env.SKGATEWAY_HEALTH_URL = "https://gateway.example/health";
  assert.equal(registerService(), true);
  assert.equal(JSON.parse(readFileSync(join(home, "registry", "skgateway.json"))).health_url, process.env.SKGATEWAY_HEALTH_URL);
});
