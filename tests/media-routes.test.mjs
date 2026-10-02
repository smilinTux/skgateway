import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { resolveMediaAlias, handleEmbeddings, handleTranscriptions, MAX_BODY } from "../src/proxy/media-routes.mjs";

const cfg = { aliases: {
  "sk-stt":   { kind: "stt",   url: "http://stt.local/v1/audio/transcriptions", model: "whisper-1", timeout_ms: 1000 },
  "sk-embed": { kind: "embed", url: "http://emb.local/v1/embeddings", model: "mxbai-embed-large", timeout_ms: 1000 },
} };

function fakeRes() {
  const r = { status: 0, headers: {}, body: "" };
  r.writeHead = (s, h = {}) => { r.status = s; Object.assign(r.headers, Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))); };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.end = (b = "") => { r.body += b; r.done = true; };
  return r;
}
function jsonReq(obj, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(obj))]);
  req.headers = { "content-type": "application/json", ...headers };
  req.method = "POST";
  return req;
}
const allow = async () => ({ ok: true, consumer: "nextcloud-skhub" });

test("resolveMediaAlias maps known aliases and rejects unknown or wrong kind", () => {
  assert.equal(resolveMediaAlias(cfg, "embed", "sk-embed").model, "mxbai-embed-large");
  assert.equal(resolveMediaAlias(cfg, "stt", "sk-embed"), null);
  assert.equal(resolveMediaAlias(cfg, "embed", "gpt-4o"), null);
});

test("embeddings forwards a single input and sets x-sk-model-served", async () => {
  let sent;
  const fetch = async (url, init) => { sent = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ object: "list", data: [{ embedding: new Array(1024).fill(0.1), index: 0 }] }), { status: 200 }); };
  const res = fakeRes();
  await handleEmbeddings(jsonReq({ model: "sk-embed", input: "hi" }), res, { mediaCfg: cfg, fetch, authorize: allow });
  assert.equal(res.status, 200);
  assert.equal(sent.url, "http://emb.local/v1/embeddings");
  assert.equal(sent.body.model, "mxbai-embed-large");
  assert.equal(res.headers["x-sk-model-served"], "sk-embed=mxbai-embed-large");
  assert.equal(JSON.parse(res.body).data[0].embedding.length, 1024);
});

test("embeddings accepts a list input", async () => {
  const fetch = async (_u, init) => { const n = JSON.parse(init.body).input.length;
    return new Response(JSON.stringify({ object: "list", data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [i] })) }), { status: 200 }); };
  const res = fakeRes();
  await handleEmbeddings(jsonReq({ model: "sk-embed", input: ["a", "b", "c"] }), res, { mediaCfg: cfg, fetch, authorize: allow });
  assert.deepEqual(JSON.parse(res.body).data.map((d) => d.index), [0, 1, 2]);
});

test("unknown embed model returns 400 and never calls a backend", async () => {
  let called = false; const fetch = async () => { called = true; };
  const res = fakeRes();
  await handleEmbeddings(jsonReq({ model: "text-embedding-3-large", input: "x" }), res, { mediaCfg: cfg, fetch, authorize: allow });
  assert.equal(res.status, 400); assert.equal(called, false);
});

test("stt backend down returns 502 without failover", async () => {
  let calls = 0; const fetch = async () => { calls++; throw new Error("ECONNREFUSED"); };
  const body = Buffer.from("--b\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nsk-stt\r\n--b--\r\n");
  const req = Readable.from([body]); req.headers = { "content-type": "multipart/form-data; boundary=b" }; req.method = "POST";
  const res = fakeRes();
  await handleTranscriptions(req, res, { mediaCfg: cfg, fetch, authorize: allow });
  assert.equal(res.status, 502); assert.equal(calls, 1);
  assert.match(res.body, /sk-stt/);
});

test("transcriptions passes a 30 MB multipart body through", async () => {
  const big = Buffer.alloc(30 * 1024 * 1024, 7);
  const head = Buffer.from("--b\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nsk-stt\r\n--b\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n");
  const tail = Buffer.from("\r\n--b--\r\n");
  let got = 0;
  const fetch = async (url, init) => { const b = Buffer.from(await new Response(init.body).arrayBuffer()); got = b.length;
    assert.equal(url, "http://stt.local/v1/audio/transcriptions");
    assert.match(b.toString("latin1", 0, 400), /whisper-1/);
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 }); };
  const req = Readable.from([head, big, tail]); req.headers = { "content-type": "multipart/form-data; boundary=b" }; req.method = "POST";
  const res = fakeRes();
  await handleTranscriptions(req, res, { mediaCfg: cfg, fetch, authorize: allow });
  assert.equal(res.status, 200); assert.ok(got > 30 * 1024 * 1024);
  assert.equal(res.headers["x-sk-model-served"], "sk-stt=whisper-1");
});

test("unauthorized consumer gets 401 and no backend call", async () => {
  let called = false; const fetch = async () => { called = true; };
  const res = fakeRes();
  await handleEmbeddings(jsonReq({ model: "sk-embed", input: "x" }), res, { mediaCfg: cfg, fetch, authorize: async () => ({ ok: false }) });
  assert.equal(res.status, 401); assert.equal(called, false);
});

test("oversized embeddings body returns 413 with the real message, not the JSON-parse fallback", async () => {
  let called = false; const fetch = async () => { called = true; };
  const res = fakeRes();
  const big = Buffer.alloc(MAX_BODY + 1, 1);
  const req = Readable.from([big]); req.headers = { "content-type": "application/json" }; req.method = "POST";
  await handleEmbeddings(req, res, { mediaCfg: cfg, fetch, authorize: allow });
  assert.equal(res.status, 413);
  assert.match(JSON.parse(res.body).error.message, /body too large/);
  assert.equal(called, false);
});

test("a model field value hidden inside a preceding file part's bytes is not mistaken for the real field", async () => {
  // The file part comes FIRST and its own bytes contain the literal sequence
  // a naive full-buffer string search would key on. The real "model" field
  // (the part actually named model="model" per its own header) comes after.
  // Both the file bytes and the swapped model value must be correct: the
  // decoy inside the file must reach the backend untouched, and the real
  // field must be swapped from the alias to the backend's model name.
  const decoy = Buffer.from('name="model"\r\n\r\nsk-stt\r\n');
  const filler = Buffer.alloc(4096, 9);
  const fileBytes = Buffer.concat([filler, decoy, filler]);
  const head = Buffer.from("--b\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\r\nContent-Type: audio/wav\r\n\r\n");
  const mid = Buffer.from("\r\n--b\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nsk-stt\r\n--b--\r\n");
  const sentBody = Buffer.concat([head, fileBytes, mid]);
  let got;
  const fetch = async (url, init) => {
    got = Buffer.from(await new Response(init.body).arrayBuffer());
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  };
  const req = Readable.from([sentBody]); req.headers = { "content-type": "multipart/form-data; boundary=b" }; req.method = "POST";
  const res = fakeRes();
  await handleTranscriptions(req, res, { mediaCfg: cfg, fetch, authorize: allow });
  assert.equal(res.status, 200);
  // The decoy bytes inside the file part must survive unchanged.
  const gotFileRegionStart = head.length;
  const gotFileRegion = got.subarray(gotFileRegionStart, gotFileRegionStart + fileBytes.length);
  assert.ok(gotFileRegion.equals(fileBytes), "file bytes (including the embedded decoy) must reach the backend unchanged");
  // The real model field, after the file part, must be swapped to the backend model.
  assert.match(got.toString("latin1", gotFileRegionStart + fileBytes.length), /name="model"\r\n\r\nwhisper-1\r\n/);
  assert.equal(res.headers["x-sk-model-served"], "sk-stt=whisper-1");
});

test("a second concurrent transcription is rejected with 429 while max_concurrent_stt:1 holds the first in flight", async () => {
  const limitedCfg = { aliases: cfg.aliases, max_concurrent_stt: 1 };
  let firstFetchStarted;
  const firstStarted = new Promise((resolve) => { firstFetchStarted = resolve; });
  let releaseFirst;
  const firstBackendHeld = new Promise((resolve) => { releaseFirst = resolve; });
  let fetchCallCount = 0;
  const fetch = async () => {
    fetchCallCount += 1;
    firstFetchStarted();
    await firstBackendHeld;
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  };
  const bodyBytes = Buffer.from("--b\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nsk-stt\r\n--b--\r\n");
  function mkReq() {
    const req = Readable.from([bodyBytes]); req.headers = { "content-type": "multipart/form-data; boundary=b" }; req.method = "POST";
    return req;
  }
  const res1 = fakeRes();
  const res2 = fakeRes();
  const p1 = handleTranscriptions(mkReq(), res1, { mediaCfg: limitedCfg, fetch, authorize: allow });
  await firstStarted; // the first request now holds its slot inside the backend call
  const p2 = handleTranscriptions(mkReq(), res2, { mediaCfg: limitedCfg, fetch, authorize: allow });
  await p2;
  assert.equal(res2.status, 429);
  assert.equal(fetchCallCount, 1, "the second request must never reach the backend");
  assert.match(res2.body, /sk-stt/);
  assert.ok(res2.headers["retry-after"], "a 429 must carry Retry-After");
  releaseFirst();
  await p1;
  assert.equal(res1.status, 200);
});
