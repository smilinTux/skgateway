/**
 * media-routes.mjs — local-only OpenAI-compatible speech-to-text and embeddings.
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
 * @module proxy/media-routes
 */

const MAX_BODY = 200 * 1024 * 1024;

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

/**
 * `POST /v1/embeddings` — OpenAI-compatible embeddings, local backends only.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{mediaCfg: object, fetch: typeof fetch, authorize: (req: object) => Promise<{ok: boolean, consumer?: string}>}} ctx
 */
export async function handleEmbeddings(req, res, ctx) {
  const auth = await ctx.authorize(req);
  if (!auth || !auth.ok) return err(res, 401, "unauthorized");
  let body;
  try {
    body = JSON.parse((await readBody(req)).toString("utf8"));
  } catch (e) {
    return err(res, e.status || 400, "invalid JSON body");
  }
  const t = resolveMediaAlias(ctx.mediaCfg, "embed", body.model);
  if (!t) return err(res, 400, `unknown embeddings model '${body.model}' (use sk-embed)`);
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
  }
}

function multipartModel(buf, boundary) {
  const s = buf.toString("latin1", 0, Math.min(buf.length, 64 * 1024));
  const m = s.match(new RegExp(`--${boundary}\\r\\nContent-Disposition: form-data; name="model"\\r\\n\\r\\n([^\\r]*)\\r\\n`));
  return m ? m[1] : null;
}

/**
 * `POST /v1/audio/transcriptions` — OpenAI-compatible speech-to-text, local
 * backends only. The multipart body is forwarded byte-for-byte except for the
 * `model` field, which is rewritten from the alias (e.g. "sk-stt") to the
 * backend's real model name (e.g. "whisper-1") so the backend accepts it.
 *
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{mediaCfg: object, fetch: typeof fetch, authorize: (req: object) => Promise<{ok: boolean, consumer?: string}>}} ctx
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
  const alias = multipartModel(buf, bm[1]);
  const t = resolveMediaAlias(ctx.mediaCfg, "stt", alias);
  if (!t) return err(res, 400, `unknown transcription model '${alias}' (use sk-stt)`);
  const swapped = Buffer.from(
    buf.toString("latin1").replace(`name="model"\r\n\r\n${alias}\r\n`, `name="model"\r\n\r\n${t.model}\r\n`),
    "latin1",
  );
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
  }
}
