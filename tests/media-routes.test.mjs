import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { resolveMediaAlias, handleEmbeddings, handleTranscriptions } from "../src/proxy/media-routes.mjs";

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
