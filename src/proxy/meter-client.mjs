/**
 * Read a skmeter energy counter.
 *
 * Fail-open by construction: every failure mode returns null, and null energy
 * is recorded as "unknown". A meter that is down must never fail a user's
 * inference, so this is deliberately the least clever code in the gateway.
 */

/**
 * @param {string|null} url  meter endpoint, e.g. http://192.168.0.100:9420/energy
 * @param {number} timeoutMs hard ceiling; the meter is never worth waiting on
 * @returns {Promise<object|null>}
 */
export async function readMeter(url, timeoutMs = 250) {
  if (!url) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
