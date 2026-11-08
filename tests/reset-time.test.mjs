import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_THROTTLE_COOLDOWN_MS, parseResetDelayMs } from "../src/proxy/reset-time.mjs";

// Fixed epoch (exactly on a second boundary) so HTTP-date math is deterministic.
const NOW = 1_800_000_000_000;

test("delta-seconds parse as relative milliseconds", () => {
  assert.equal(parseResetDelayMs("120", NOW), 120_000);
  assert.equal(parseResetDelayMs("0", NOW), 0);
  assert.equal(parseResetDelayMs(300, NOW), 300_000);
});

test("HTTP-date parses as a non-negative delta from now", () => {
  const future = new Date(NOW + 90_000).toUTCString();
  assert.equal(parseResetDelayMs(future, NOW), 90_000);
  const past = new Date(NOW - 60_000).toUTCString();
  assert.equal(parseResetDelayMs(past, NOW), 0);
});

test("duration strings parse as relative milliseconds", () => {
  assert.equal(parseResetDelayMs("500ms", NOW), 500);
  assert.equal(parseResetDelayMs("60s", NOW), 60_000);
  assert.equal(parseResetDelayMs("2m", NOW), 120_000);
  assert.equal(parseResetDelayMs("1h", NOW), 3_600_000);
  assert.equal(parseResetDelayMs("1.5h", NOW), 5_400_000);
});

test("epoch seconds and epoch milliseconds parse as a delta from now", () => {
  const futureSeconds = String(Math.floor((NOW + 300_000) / 1000));
  assert.equal(parseResetDelayMs(futureSeconds, NOW), 300_000);
  assert.equal(parseResetDelayMs(String(NOW + 300_000), NOW), 300_000);
});

test("absent, negative and unparseable values return null", () => {
  assert.equal(parseResetDelayMs(undefined, NOW), null);
  assert.equal(parseResetDelayMs(null, NOW), null);
  assert.equal(parseResetDelayMs("", NOW), null);
  assert.equal(parseResetDelayMs("-5", NOW), null);
  assert.equal(parseResetDelayMs("garbage", NOW), null);
});

test("MAX_THROTTLE_COOLDOWN_MS is the 24h cooldown ceiling", () => {
  assert.equal(MAX_THROTTLE_COOLDOWN_MS, 24 * 60 * 60 * 1000);
});
