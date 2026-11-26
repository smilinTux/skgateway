/**
 * privacy.mjs: the privacy.content_logs switch (docs/CONFIGURATION.md, "privacy").
 *
 * On (the default) the gateway logs as it always has, including slices of
 * upstream error bodies and model text where a log line quotes them. Off, no
 * request or response text reaches a log line, a SIEM event, metrics.db or a
 * cache: every site that would quote text logs its length or error class
 * instead. Content still flows to the backend and back to the caller; only
 * what the gateway keeps changes.
 *
 * Process-wide on purpose: the sites live in core.mjs, router.mjs, the
 * sanitizer and index.mjs, and threading a flag through each call chain would
 * touch far more code than the sites themselves. index.mjs sets it at boot and
 * on every config reload.
 */

let contentLogs = true;

/** Set from config.privacy.content_logs. Anything but an explicit false is on. */
export function setContentLogs(value) {
  contentLogs = value !== false;
}

/** True when log lines may quote request or response text. */
export function contentLogsOn() {
  return contentLogs;
}

/**
 * Text for a log line: the text (cut to `max` chars when given) while content
 * logs are on, only its length while they are off.
 */
export function logText(text, max) {
  const s = typeof text === "string" ? text : (text == null ? "" : String(text));
  if (!contentLogs) return `[${s.length} chars withheld]`;
  return max ? s.slice(0, max) : s;
}

/**
 * An error for a log line. A JSON SyntaxError quotes the input it failed on,
 * and upstream errors can carry body text, so while content logs are off only
 * the error class (and a system error code, if any) is logged.
 */
export function logError(err) {
  if (contentLogs) return err?.message ?? String(err);
  const name = typeof err?.name === "string" && /^[A-Za-z]{1,40}$/.test(err.name) ? err.name : "Error";
  const code = typeof err?.code === "string" && /^[A-Z0-9_]{1,40}$/.test(err.code) ? ` code=${err.code}` : "";
  return name + code;
}

/**
 * Per-request fields that say who is asking or from where rather than what
 * was metered: the caller's address, session id, user agent, request path and
 * key fingerprint. With content logs off they are withheld from every SIEM
 * and audit event (top level and `details`), so an event carries only the
 * client id, agent id, model, backend, token counts, cost, status and time.
 */
const REQUEST_META = ["remote", "session_id", "user_agent", "path", "fingerprint"];

const strip = (obj) => {
  const out = { ...obj };
  for (const k of REQUEST_META) delete out[k];
  return out;
};

/** The event as is while content logs are on; without the REQUEST_META fields while off. */
export function withholdRequestMeta(evt) {
  if (contentLogs || !evt || typeof evt !== "object") return evt;
  const out = strip(evt);
  if (out.details && typeof out.details === "object" && !Array.isArray(out.details)) out.details = strip(out.details);
  return out;
}

/** A per-request value for metrics.db: the value while content logs are on, undefined (NULL) while off. */
export function metaValue(value) {
  return contentLogs ? value : undefined;
}
