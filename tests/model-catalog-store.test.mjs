/**
 * model-catalog-store.test.mjs: file-backed lifecycle store (card P1.2).
 *
 * Covers src/discovery/model_catalog_store.mjs: round-tripping a lifecycle
 * record through recordModelOutcome()/getLifecycle(), fail-soft writes, and
 * mtime/TTL caching (no fs read per request until the TTL window elapses).
 *
 * Run with:  node --test tests/model-catalog-store.test.mjs
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadCatalogStore,
  getLifecycle,
  recordModelOutcome,
  _resetCacheForTests,
} from "../src/discovery/model_catalog_store.mjs";

const DIR = mkdtempSync(join(tmpdir(), "skgw-catalog-store-"));
let _seq = 0;
function freshPath() {
  return join(DIR, `store-${_seq++}.json`);
}

beforeEach(() => {
  _resetCacheForTests();
});

describe("getLifecycle", () => {
  test("returns defaultLifecycle() for an unseen model / missing file", () => {
    const path = freshPath();
    const lc = getLifecycle("nvidia/no-such-model", path);
    assert.equal(lc.state, "active");
    assert.equal(lc.consecutive_permanent_errors, 0);
    assert.equal(lc.absent_cycles, 0);
    assert.equal(lc.last_verified_at, null);
  });

  test("never throws for a completely bogus path", () => {
    assert.doesNotThrow(() => getLifecycle("some/model", "/nonexistent/dir/x/y/z.json"));
  });
});

describe("recordModelOutcome, round trip", () => {
  test("a 2xx resets the counter and sets last_verified_at", () => {
    const path = freshPath();
    recordModelOutcome("nvidia/foo", { status: 200, now: 1000 }, path);
    const lc = getLifecycle("nvidia/foo", path);
    assert.equal(lc.state, "active");
    assert.equal(lc.consecutive_permanent_errors, 0);
    assert.equal(lc.last_verified_at, 1000);
  });

  test("3 consecutive 410s flip the model to eol (provider_410)", () => {
    const path = freshPath();
    recordModelOutcome("nvidia/dying", { status: 410, now: 1000 }, path);
    recordModelOutcome("nvidia/dying", { status: 410, now: 2000 }, path);
    recordModelOutcome("nvidia/dying", { status: 410, now: 3000 }, path);
    const lc = getLifecycle("nvidia/dying", path);
    assert.equal(lc.state, "eol");
    assert.equal(lc.eol_reason, "provider_410");
    assert.equal(lc.consecutive_permanent_errors, 3);
  });

  test("a 200 in between resets the permanent-error counter", () => {
    const path = freshPath();
    recordModelOutcome("nvidia/flaky", { status: 410, now: 1000 }, path);
    recordModelOutcome("nvidia/flaky", { status: 410, now: 2000 }, path);
    recordModelOutcome("nvidia/flaky", { status: 200, now: 3000 }, path);
    const lc = getLifecycle("nvidia/flaky", path);
    assert.equal(lc.state, "active");
    assert.equal(lc.consecutive_permanent_errors, 0);
  });

  test("recordModelOutcome persists to disk (readable after a cache reset)", () => {
    const path = freshPath();
    recordModelOutcome("nvidia/persisted", { status: 200, now: 5000 }, path);
    _resetCacheForTests();
    const raw = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(raw["nvidia/persisted"].last_verified_at, 5000);
    // and getLifecycle (fresh cache) reads the same thing back off disk.
    const lc = getLifecycle("nvidia/persisted", path);
    assert.equal(lc.last_verified_at, 5000);
  });

  test("recording outcomes for two different models does not cross-contaminate", () => {
    const path = freshPath();
    recordModelOutcome("a/one", { status: 410, now: 1 }, path);
    recordModelOutcome("b/two", { status: 200, now: 2 }, path);
    assert.equal(getLifecycle("a/one", path).consecutive_permanent_errors, 1);
    assert.equal(getLifecycle("b/two", path).state, "active");
  });

  test("ignores calls with no modelId (never throws)", () => {
    const path = freshPath();
    assert.doesNotThrow(() => recordModelOutcome(undefined, { status: 410, now: 1 }, path));
    assert.doesNotThrow(() => recordModelOutcome("", { status: 410, now: 1 }, path));
  });
});

describe("recordModelOutcome, fail-soft writes", () => {
  test("a write that throws (unwritable path) is swallowed, never throws", () => {
    // A regular file used as a path COMPONENT: mkdirSync(dirname(path)) must
    // fail (ENOTDIR/ENOENT) because a path segment is a file, not a directory.
    const blockerFile = join(DIR, `blocker-${_seq++}.json`);
    writeFileSync(blockerFile, "not a directory");
    const path = join(blockerFile, "sub", "store.json");

    assert.doesNotThrow(() => recordModelOutcome("nvidia/x", { status: 410, now: 1 }, path));
    // The failed write must not have persisted anything: reads still see the
    // unseen-model default.
    const lc = getLifecycle("nvidia/x", path);
    assert.equal(lc.state, "active");
    assert.equal(lc.consecutive_permanent_errors, 0);
  });
});

describe("loadCatalogStore, mtime/TTL caching", () => {
  test("within the TTL window, a load returns the stale in-memory copy (no re-read)", () => {
    const path = freshPath();
    writeFileSync(path, JSON.stringify({ "m/1": { state: "active", v: "A" } }));

    const first = loadCatalogStore(path, { now: () => 1000, ttlMs: 2000 });
    assert.equal(first["m/1"].v, "A");

    // External writer changes the file on disk...
    writeFileSync(path, JSON.stringify({ "m/1": { state: "active", v: "B" } }));

    // ...but a load still inside the TTL window must not notice: it never
    // stats/re-reads, so it returns the same stale value.
    const stillStale = loadCatalogStore(path, { now: () => 1500, ttlMs: 2000 });
    assert.equal(stillStale["m/1"].v, "A");
  });

  test("once the TTL elapses, the next load picks up the on-disk change", () => {
    const path = freshPath();
    writeFileSync(path, JSON.stringify({ "m/1": { state: "active", v: "A" } }));

    loadCatalogStore(path, { now: () => 1000, ttlMs: 2000 });
    writeFileSync(path, JSON.stringify({ "m/1": { state: "active", v: "B" } }));

    // now - lastCheckAt (1000) = 3000, past the 2000ms ttl -> re-stat + re-read.
    const fresh = loadCatalogStore(path, { now: () => 4000, ttlMs: 2000 });
    assert.equal(fresh["m/1"].v, "B");
  });

  test("missing file yields {} and does not throw", () => {
    const path = join(DIR, "does-not-exist.json");
    const store = loadCatalogStore(path, { now: () => 1 });
    assert.deepEqual(store, {});
  });
});
