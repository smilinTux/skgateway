/**
 * media-routes.mjs: local-only OpenAI-compatible speech-to-text and embeddings.
 *
 * Aliases come from config `media.aliases` (sk-stt, sk-embed). A backend failure
 * is returned to the caller as a 502, never substituted with another backend or
 * a cloud provider: these aliases exist specifically because the audio/text they
 * carry (Nextcloud Talk recordings, document content) is private, and the one
 * documented fleet failure mode for a gateway is silently serving a different
 * model than the one requested (see memory
 * silent-model-substitution-is-the-fleet-failure-mode). No-failover here means
 * literally one alias -> one configured URL, with no retry against anything else.
 *
 * Also enforces a small per-kind concurrency cap (config `media.max_concurrent_stt`,
 * `media.max_concurrent_embed`), since these routes front local backends with
 * real capacity limits (one whisper-server process, one embedding server).
 *
 * @module proxy/media-routes
 */

export const MAX_BODY = 200 * 1024 * 1024;

const DEFAULT_MAX_CONCURRENT = { stt: 2, embed: 8 };

/**
 * Resolve a media alias (e.g. "sk-embed") to its backend, enforcing that the
 * alias was declared for the kind being requested ("embed" or "stt").
 *
 * @param {{aliases?: Record<string, {kind: string, url: string, model: string, timeout_ms?: number}>}} mediaCfg
 * @param {"embed"|"stt"} kind
 * @param {string} model the alias name the caller sent as `model`
 * @returns {{url: string, model: string, timeoutMs: number} | null}
 */
export function resolveMediaAlias(mediaCfg, kind, model) {
  const a = mediaCfg && mediaCfg.aliases && mediaCfg.aliases[model];
  if (!a || a.kind !== kind) return null;
  return { url: a.url, model: a.model, timeoutMs: a.timeout_ms || 60000 };
}

async function readBody(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function send(res, status, obj, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
}

function err(res, status, message) {
  send(res, status, { error: { message, type: "skgateway_media" } });
}

// ─── Per-kind concurrency limiter ───────────────────────────────────────────
// Module-level fallback used when a caller (production or a test) does not
// supply ctx.limiter: a plain {stt, embed} counter object. Production wiring
// (src/index.mjs) passes one explicit limiter instance created once at module
// load, so counts are shared across every request for the process lifetime,
// not per-request (ctx is otherwise rebuilt fresh per request).
const DEFAULT_LIMITER = { stt: 0, embed: 0 };

/** Create a fresh, independent limiter (one process-lifetime instance per gateway). */
export function createMediaLimiter() {
  return { stt: 0, embed: 0 };
}

function limiterFor(ctx) {
  return ctx.limiter || DEFAULT_LIMITER;
}

function maxConcurrentFor(mediaCfg, kind) {
  const key = kind === "stt" ? "max_concurrent_stt" : "max_concurrent_embed";
  const configured = mediaCfg && mediaCfg[key];
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_CONCURRENT[kind];
}

/** Try to take a slot; returns true if acquired (caller must release() when done). */
function tryAcquire(ctx, kind) {
  const limiter = limiterFor(ctx);
  const max = maxConcurrentFor(ctx.mediaCfg, kind);
  if (limiter[kind] >= max) return false;
  limiter[kind] += 1;
  return true;
}

function release(ctx, kind) {
  const limiter = limiterFor(ctx);
  limiter[kind] = Math.max(0, limiter[kind] - 1);
}

function tooManyRequests(res, alias, max) {
  res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
  res.end(JSON.stringify({
    error: {
      message: `${alias} is at capacity (max ${max} concurrent request${max === 1 ? "" : "s"}); try again shortly`,
      type: "skgateway_media",
      code: "too_many_concurrent",
    },
  }));
}

/**
 * `POST /v1/embeddings`: OpenAI-compatible embeddings, local backends only.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{mediaCfg: object, fetch: typeof fetch, authorize: (req: object) => Promise<{ok: boolean, consumer?: string}>, limiter?: {stt: number, embed: number}}} ctx
 */
export async function handleEmbeddings(req, res, ctx) {
  const auth = await ctx.authorize(req);
  if (!auth || !auth.ok) return err(res, 401, "unauthorized");
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch (e) {
    return err(res, e.status || 400, e.status === 413 ? e.message : "invalid JSON body");
  }
  const t = resolveMediaAlias(ctx.mediaCfg, "embed", body.model);
  if (!t) return err(res, 400, `unknown embeddings model '${body.model}' (use sk-embed)`);
  if (!tryAcquire(ctx, "embed")) {
    return tooManyRequests(res, body.model, maxConcurrentFor(ctx.mediaCfg, "embed"));
  }
  try {
    const r = await ctx.fetch(t.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, model: t.model }),
      signal: AbortSignal.timeout(t.timeoutMs),
    });
    const text = await r.text();
    res.writeHead(r.status, { "content-type": "application/json", "x-sk-model-served": `${body.model}=${t.model}` });
    return res.end(text);
  } catch (e) {
    return err(res, 502, `${body.model} backend unavailable: ${e.message}`);
  } finally {
    release(ctx, "embed");
  }
}

// ─── Multipart "model" field: locate and splice without touching other parts ──
// Operates entirely on Buffer offsets (Buffer.indexOf), never materializing the
// whole (up to 200 MB) body as a string: a latin1 round trip of the full buffer
// plus a rebuilt copy triples peak memory, and converting to a string only to
// search for a field value makes a global String.replace tempting, which is
// unsafe (see below).
//
// The lookup is boundary-delimited, not a blind content search: it walks every
// `--<boundary>` delimiter, and for each part reads ONLY that part's own header
// (bounded to the first 8 KiB after the delimiter, which real multipart headers
// never approach) to decide whether it is the "model" field. A naive
// `buf.toString().replace('name="model"...', ...)` search across the ENTIRE
// body, as a previous version of this file did, matches the FIRST occurrence of
// that literal text anywhere in the buffer, including inside a file part's
// binary content; if the file part precedes the model field and happens to
// contain the same bytes (coincidentally, or by a malicious upload), that
// search finds and "fixes" the wrong spot, corrupting the audio while leaving
// the real model field untouched. Delimiting by the actual boundary markers
// first, then checking only each part's own header, is immune to that: a
// sequence that merely LOOKS like a model field inside a file part's body is
// never inspected as a header, because it is not adjacent to a real `--boundary`
// delimiter.
function findModelPartValueRange(buf, boundary) {
  const delim = Buffer.from(`--${boundary}`, "latin1");
  const headerSep = Buffer.from("\r\n\r\n", "latin1");
  const nameNeedle = 'name="model"';
  let idx = buf.indexOf(delim, 0);
  while (idx !== -1) {
    const partStart = idx + delim.length;
    const headerWindowEnd = Math.min(buf.length, partStart + 8192);
    const relHeaderEnd = buf.subarray(partStart, headerWindowEnd).indexOf(headerSep);
    if (relHeaderEnd !== -1) {
      const headerEnd = partStart + relHeaderEnd;
      const header = buf.toString("latin1", partStart, headerEnd);
      if (header.includes(nameNeedle)) {
        const valueStart = headerEnd + headerSep.length;
        let valueEnd = buf.indexOf(delim, valueStart);
        if (valueEnd === -1) valueEnd = buf.length;
        // Trim the CRLF that precedes the next boundary delimiter, if present.
        if (valueEnd >= 2 && buf[valueEnd - 2] === 0x0d && buf[valueEnd - 1] === 0x0a) {
          valueEnd -= 2;
        }
        return { valueStart, valueEnd };
      }
    }
    idx = buf.indexOf(delim, partStart);
  }
  return null;
}

function readMultipartModelAlias(buf, boundary) {
  const range = findModelPartValueRange(buf, boundary);
  return range ? buf.toString("latin1", range.valueStart, range.valueEnd) : null;
}

/** Replace only the identified "model" field's value, byte-for-byte elsewhere. */
function swapMultipartModel(buf, boundary, newValue) {
  const range = findModelPartValueRange(buf, boundary);
  if (!range) return buf;
  return Buffer.concat([
    buf.subarray(0, range.valueStart),
    Buffer.from(newValue, "latin1"),
    buf.subarray(range.valueEnd),
  ]);
}

/**
 * `POST /v1/audio/transcriptions`: OpenAI-compatible speech-to-text, local
 * backends only. The multipart body is forwarded byte-for-byte except for the
 * `model` field, which is rewritten from the alias (e.g. "sk-stt") to the
 * backend's real model name (e.g. "whisper-1") so the backend accepts it.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{mediaCfg: object, fetch: typeof fetch, authorize: (req: object) => Promise<{ok: boolean, consumer?: string}>, limiter?: {stt: number, embed: number}}} ctx
 */
export async function handleTranscriptions(req, res, ctx) {
  const auth = await ctx.authorize(req);
  if (!auth || !auth.ok) return err(res, 401, "unauthorized");
  const ct = req.headers["content-type"] || "";
  const bm = ct.match(/boundary=([^;]+)/);
  if (!ct.startsWith("multipart/form-data") || !bm) return err(res, 400, "multipart/form-data required");
  let buf;
  try {
    buf = await readBody(req);
  } catch (e) {
    return err(res, e.status || 400, e.message);
  }
  const alias = readMultipartModelAlias(buf, bm[1]);
  const t = resolveMediaAlias(ctx.mediaCfg, "stt", alias);
  if (!t) return err(res, 400, `unknown transcription model '${alias}' (use sk-stt)`);
  if (!tryAcquire(ctx, "stt")) {
    return tooManyRequests(res, alias, maxConcurrentFor(ctx.mediaCfg, "stt"));
  }
  const swapped = swapMultipartModel(buf, bm[1], t.model);
  try {
    const r = await ctx.fetch(t.url, {
      method: "POST",
      headers: { "content-type": ct },
      body: swapped,
      signal: AbortSignal.timeout(t.timeoutMs),
    });
    const text = await r.text();
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") || "application/json", "x-sk-model-served": `${alias}=${t.model}` });
    return res.end(text);
  } catch (e) {
    return err(res, 502, `${alias} backend unavailable: ${e.message}`);
  } finally {
    release(ctx, "stt");
  }
}
