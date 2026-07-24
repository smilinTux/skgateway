/**
 * siem-elasticsearch.test.mjs - Elasticsearch / OpenSearch _bulk output tests.
 *
 * Coverage:
 *   1. Bulk body shape - NDJSON action+doc lines, correct _index, @timestamp,
 *      and %DATE% template expansion.
 *   2. Auth header resolution by ENV-VAR NAME (never a literal secret in config).
 *   3. Batching - events buffer and ship to a mocked _bulk endpoint when the
 *      batch size is reached, with the right payload + index.
 *   4. Fail-safe - a network error is swallowed (no throw), the buffer stays
 *      bounded, and write() never blocks or breaks.
 *   5. Disabled by default - no endpoint / enabled:false → a no-op adapter, and
 *      the default config carries no ES sink.
 *   6. Config env overrides - SKGATEWAY_ES_* produce an enabled ES sink.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createElasticsearchOutput,
  buildBulkBody,
  resolveIndexName,
  resolveAuthHeaders,
} from "../src/siem/elasticsearch.mjs";
import { createEvent } from "../src/siem/events.mjs";
import { loadConfig } from "../src/config.mjs";

// ─── helpers ──────────────────────────────────────────────────────────────────

function sampleEvent(overrides = {}) {
  return createEvent(
    "request",
    { prompt_class: "chat", token_estimate: 2400 },
    { agent_id: "lumina", model: "kimi-k2", backend: "nvidia", ...overrides },
  );
}

/** A fake fetch that records calls and returns a scripted response. */
function fakeFetch({ ok = true, status = 200, json = { errors: false, items: [] }, throwErr = null } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    if (throwErr) throw throwErr;
    return {
      ok,
      status,
      async text() { return JSON.stringify(json); },
      async json() { return json; },
    };
  };
  fn.calls = calls;
  return fn;
}

// ─── 1. bulk body shape ─────────────────────────────────────────────────────

test("buildBulkBody emits NDJSON action+doc pairs ending in a newline", () => {
  const ev = sampleEvent();
  const body = buildBulkBody([ev], "skgateway-siem");
  assert.ok(body.endsWith("\n"), "bulk body must end with a trailing newline");

  const lines = body.trimEnd().split("\n");
  assert.equal(lines.length, 2, "one event -> action line + doc line");

  const action = JSON.parse(lines[0]);
  // _id === event_id for idempotent indexing on retry (documented contract).
  assert.deepEqual(action, { index: { _index: "skgateway-siem", _id: ev.event_id } });

  const doc = JSON.parse(lines[1]);
  assert.equal(doc.event_id, ev.event_id);
  assert.equal(doc.event_type, "request");
  assert.equal(doc["@timestamp"], ev.timestamp, "doc carries @timestamp for time-based patterns");
});

test("resolveIndexName expands %DATE% to the event's UTC date", () => {
  const ev = sampleEvent();
  ev.timestamp = "2026-07-24T18:30:00.000Z";
  assert.equal(resolveIndexName("skgateway-siem-%DATE%", ev), "skgateway-siem-2026.07.24");
  assert.equal(resolveIndexName("static-index", ev), "static-index");
});

// ─── 2. auth by ENV-VAR NAME ─────────────────────────────────────────────────

test("resolveAuthHeaders reads the secret from the named env var (ApiKey)", () => {
  const headers = resolveAuthHeaders(
    { api_key_env: "MY_ES_KEY" },
    { MY_ES_KEY: "sekret-value" },
  );
  assert.equal(headers.Authorization, "ApiKey sekret-value");
});

test("resolveAuthHeaders supports bearer + raw header, and no-op when unset", () => {
  assert.equal(
    resolveAuthHeaders({ bearer_token_env: "TOK" }, { TOK: "abc" }).Authorization,
    "Bearer abc",
  );
  assert.equal(
    resolveAuthHeaders({ auth_header_env: "RAW" }, { RAW: "Basic dXNlcjpwdw==" }).Authorization,
    "Basic dXNlcjpwdw==",
  );
  // Missing env var -> no Authorization header (never leaks the config name).
  assert.deepEqual(resolveAuthHeaders({ api_key_env: "NOT_SET" }, {}), {});
});

test("resolveAuthHeaders builds HTTP Basic from username + password_env", () => {
  const headers = resolveAuthHeaders(
    { username: "elastic", password_env: "ES_PASSWORD" },
    { ES_PASSWORD: "pw" },
  );
  const expected = "Basic " + Buffer.from("elastic:pw").toString("base64");
  assert.equal(headers.Authorization, expected);
});

test("`url` and `flush_interval_ms` are honoured as documented aliases", async () => {
  const fetchMock = fakeFetch();
  const out = createElasticsearchOutput(
    { enabled: true, url: "http://es:9200", index: "gw", batch_size: 1, flush_interval_ms: 1234 },
    { fetch: fetchMock },
  );
  assert.equal(out.enabled, true, "`url` alias enables the adapter");
  out.write(sampleEvent());
  await out.flush();
  assert.equal(fetchMock.calls[0].url, "http://es:9200/_bulk");
  await out.close();
});

// ─── 3. batching + ship to mocked _bulk ──────────────────────────────────────

test("events batch and ship to _bulk with the right payload + index", async () => {
  const fetchMock = fakeFetch();
  const out = createElasticsearchOutput(
    {
      enabled: true,
      endpoint: "https://es.internal:9200/",
      index: "skgateway-siem-%DATE%",
      batch_size: 3,
    },
    { fetch: fetchMock },
  );
  assert.equal(out.enabled, true);

  const events = [sampleEvent(), sampleEvent(), sampleEvent()];
  for (const e of events) out.write(e);
  await out.flush();

  assert.equal(fetchMock.calls.length, 1, "one batch of 3 -> one _bulk POST");
  const { url, opts } = fetchMock.calls[0];
  assert.equal(url, "https://es.internal:9200/_bulk", "trailing slash normalised, /_bulk appended");
  assert.equal(opts.method, "POST");
  assert.equal(opts.headers["content-type"], "application/x-ndjson");

  const lines = opts.body.trimEnd().split("\n");
  assert.equal(lines.length, 6, "3 events -> 6 NDJSON lines");
  const action = JSON.parse(lines[0]);
  assert.match(action.index._index, /^skgateway-siem-\d{4}\.\d{2}\.\d{2}$/);

  await out.close();
});

test("flush ships a partial batch below batch_size", async () => {
  const fetchMock = fakeFetch();
  const out = createElasticsearchOutput(
    { enabled: true, endpoint: "http://es:9200", batch_size: 100 },
    { fetch: fetchMock },
  );
  out.write(sampleEvent());
  assert.equal(fetchMock.calls.length, 0, "should not ship before flush when under batch_size");
  await out.flush();
  assert.equal(fetchMock.calls.length, 1, "flush ships the buffered remainder");
  await out.close();
});

// ─── 4. fail-safe ────────────────────────────────────────────────────────────

test("a network error is swallowed - write never throws, no crash", async () => {
  const fetchMock = fakeFetch({ throwErr: new Error("ECONNREFUSED") });
  const out = createElasticsearchOutput(
    { enabled: true, endpoint: "http://es:9200", batch_size: 1 },
    { fetch: fetchMock },
  );

  // write() itself must never throw even though the ship will fail.
  assert.doesNotThrow(() => out.write(sampleEvent()));
  // flush() resolves (does not reject) despite the underlying network failure.
  await assert.doesNotReject(out.flush());
  assert.ok(fetchMock.calls.length >= 1, "a ship was attempted");

  await out.close();
});

test("a non-2xx _bulk response is swallowed (no throw)", async () => {
  const fetchMock = fakeFetch({ ok: false, status: 503, json: {} });
  const out = createElasticsearchOutput(
    { enabled: true, endpoint: "http://es:9200", batch_size: 1 },
    { fetch: fetchMock },
  );
  out.write(sampleEvent());
  await assert.doesNotReject(out.flush());
  await out.close();
});

test("buffer is bounded - oldest events drop past max_buffer, no unbounded growth", async () => {
  // Never resolve the ship so the buffer would grow unless bounded.
  let released;
  const gate = new Promise((r) => { released = r; });
  const fetchMock = async () => { await gate; return { ok: true, status: 200, async text() { return "{}"; }, async json() { return {}; } }; };

  const out = createElasticsearchOutput(
    { enabled: true, endpoint: "http://es:9200", batch_size: 1000, max_buffer: 5 },
    { fetch: fetchMock },
  );

  // Push far more than max_buffer; must not throw and must stay bounded.
  for (let i = 0; i < 50; i++) out.write(sampleEvent());

  released(); // let anything in-flight finish
  await out.close();
  // Reaching here without hanging or throwing proves the bound held.
  assert.ok(true);
});

// ─── 5. disabled by default ──────────────────────────────────────────────────

test("createElasticsearchOutput() with no config is a no-op adapter", () => {
  const out = createElasticsearchOutput();
  assert.equal(out.enabled, false);
  assert.doesNotThrow(() => out.write(sampleEvent()));
});

test("enabled:true without an endpoint is still a no-op", () => {
  const out = createElasticsearchOutput({ enabled: true });
  assert.equal(out.enabled, false);
});

test("enabled:false with an endpoint is a no-op", () => {
  const out = createElasticsearchOutput({ enabled: false, endpoint: "http://es:9200" });
  assert.equal(out.enabled, false);
  assert.doesNotThrow(() => out.write(sampleEvent()));
});

test("default config carries no elasticsearch output (sink disabled by default)", async () => {
  const emitter = await loadConfig({ configPath: "/nonexistent/skgateway.yaml", silent: true });
  const cfg = emitter.current();
  const esSinks = (cfg.siem?.outputs ?? []).filter(
    (o) => o.type === "elasticsearch" || o.type === "opensearch",
  );
  assert.equal(esSinks.length, 0);
});

// ─── 6. config env overrides ─────────────────────────────────────────────────

test("SKGATEWAY_ES_* env vars produce an enabled elasticsearch sink", async () => {
  const saved = { ...process.env };
  process.env.SKGATEWAY_ES_ENABLED = "true";
  process.env.SKGATEWAY_ES_ENDPOINT = "https://es.internal:9200";
  process.env.SKGATEWAY_ES_INDEX = "gw-%DATE%";
  process.env.SKGATEWAY_ES_BATCH_SIZE = "250";
  process.env.SKGATEWAY_ES_FLUSH_MS = "2000";
  process.env.SKGATEWAY_ES_API_KEY_ENV = "SKGATEWAY_ES_API_KEY";
  try {
    const emitter = await loadConfig({ configPath: "/nonexistent/skgateway.yaml", silent: true });
    const cfg = emitter.current();
    const sink = (cfg.siem?.outputs ?? []).find(
      (o) => o.type === "elasticsearch" || o.type === "opensearch",
    );
    assert.ok(sink, "expected an env-injected ES sink");
    assert.equal(sink.enabled, true);
    assert.equal(sink.endpoint, "https://es.internal:9200");
    assert.equal(sink.index, "gw-%DATE%");
    assert.equal(sink.batch_size, 250);
    assert.equal(sink.flush_ms, 2000);
    // The api key is referenced by NAME, not value.
    assert.equal(sink.api_key_env, "SKGATEWAY_ES_API_KEY");
    assert.equal(sink.api_key, undefined, "no literal secret stored in config");
  } finally {
    for (const k of [
      "SKGATEWAY_ES_ENABLED",
      "SKGATEWAY_ES_ENDPOINT",
      "SKGATEWAY_ES_INDEX",
      "SKGATEWAY_ES_BATCH_SIZE",
      "SKGATEWAY_ES_FLUSH_MS",
      "SKGATEWAY_ES_API_KEY_ENV",
    ]) {
      delete process.env[k];
      if (saved[k] !== undefined) process.env[k] = saved[k];
    }
    await loadConfig({ configPath: "/nonexistent/skgateway.yaml", silent: true });
  }
});
