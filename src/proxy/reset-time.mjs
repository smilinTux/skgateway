/**
 * Shared reset/Retry-After header parser (follow-up to PR #202).
 *
 * One parser for every reset flavor the gateway can receive from an upstream:
 *   - delta-seconds ("120")
 *   - HTTP-date ("Wed, 21 Oct 2015 07:28:00 GMT")
 *   - duration strings ("500ms", "60s", "2m", "1h")
 *   - epoch seconds / epoch milliseconds (the resetAt semantics)
 *
 * Returns a non-negative delta in milliseconds relative to `now`, or null
 * when the value is absent or unparseable, so callers can fall back to a
 * status-specific default. The returned delta is NOT capped here on purpose:
 * throttle cooldown call sites cap at MAX_THROTTLE_COOLDOWN_MS, while quota
 * window bookkeeping (reset_at in metrics/provider-usage.mjs) keeps the full
 * provider-declared horizon verbatim.
 */

/** Ceiling on any single cooldown, including a Retry-After-derived one, so a
 * provider that sends back an absurd value (or a full daily reset window in
 * seconds) can never take a door out of rotation for longer than this from
 * this process's point of view. */
export const MAX_THROTTLE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Parse a reset value into a delta-milliseconds value relative to `now`.
 *
 * Numeric values reuse the `resetAt` epoch semantics: values above 10e9 are
 * epoch milliseconds, anything smaller is epoch seconds (times 1000). When
 * the computed timestamp is in the future it is treated as an absolute
 * epoch; when it is in the past it is treated as a relative delta, which is
 * what makes plain delta-seconds ("120") work.
 *
 * @param {*} value
 * @param {number} now epoch milliseconds to measure against
 * @returns {?number} non-negative delta milliseconds, or null when unparseable
 */
export function parseResetDelayMs(value, now = Date.now()) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (Number.isFinite(number)) {
    if (number < 0) return null;
    const ms = number > 10_000_000_000 ? number : number * 1000;
    return ms > now ? ms - now : ms;
  }
  const duration = String(value).match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (duration) {
    const scale = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[duration[2].toLowerCase()];
    return Number(duration[1]) * scale;
  }
  const dateMs = Date.parse(String(value));
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - now;
    return delta > 0 ? delta : 0;
  }
  return null;
}
