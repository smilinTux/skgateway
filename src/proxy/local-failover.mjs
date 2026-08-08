/**
 * local-failover.mjs — health-aware, sovereign-first local-backend failover.
 *
 * The gateway routes logical roles (sk-default, ornith-tiny, …) to a sovereign
 * local llama backend (e.g. ornith on 192.168.0.100:8082) via the skmodels
 * registry. That backend is a single point of failure: when the local GPU wedges
 * (broken NVIDIA driver, llama-server pegged, /v1/chat/completions hanging), the
 * registry route builds ONE candidate with no fallback and every caller stalls to
 * a multi-minute timeout.
 *
 * This module makes the local route HEALTH-AWARE so it keeps answering during a
 * local outage by transparently failing over to a known-good cloud FREE model
 * (default deepseek-ai/deepseek-v4-flash via the nvidia backend). Two independent
 * guards, sovereign-first (the default free model is kept LIVE; the old default
 * deepseek-ai/deepseek-v4-flash reached EOL and 410'd, see GTD 6cf41f1382c4):
 *
 *   1. Liveness probe — a fast, cached GET {base}/models with a short timeout.
 *      When the local backend is unreachable or slow to even list models, the
 *      request skips it and goes straight to cloud. The verdict is cached briefly
 *      (TTL) so every request does not re-probe; when local recovers the verdict
 *      expires and traffic routes back automatically.
 *   2. Bounded completion — the caller applies a short idle timeout to the local
 *      completion so a request that got past the probe but then HANGS still fails
 *      over (the router's existing candidate loop handles the [local, cloud]
 *      fallover once the local attempt 504s).
 *
 * All behaviour is env-configurable and defaults ON. The client-visible wire
 * contract is unchanged: a failed-over request returns a standard OpenAI chat
 * completion from the cloud backend.
 *
 * @module proxy/local-failover
 */

/**
 * Parse an integer env value, falling back to `dflt` on absent/blank/NaN.
 * @param {string|undefined} v
 * @param {number} dflt
 * @returns {number}
 */
function intEnv(v, dflt) {
  if (v == null || String(v).trim() === "") return dflt;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/**
 * Read the local-failover configuration from the environment.
 *
 * Env knobs (all optional):
 *   SKGATEWAY_LOCAL_FAILOVER              on/off master switch (default ON;
 *                                         "0"/"false"/"off"/"no" disable it)
 *   SKGATEWAY_LOCAL_FALLBACK_MODEL        cloud fallback model id
 *                                         (default "openai/gpt-oss-20b", a live free model)
 *   SKGATEWAY_LOCAL_FALLBACK_BACKEND      router backend id serving the fallback
 *                                         model (default "nvidia")
 *   SKGATEWAY_LOCAL_HEALTH_TIMEOUT_MS     liveness-probe timeout ms (default 3000)
 *   SKGATEWAY_LOCAL_COMPLETION_TIMEOUT_MS bounded local completion timeout ms
 *                                         (default 10000)
 *   SKGATEWAY_LOCAL_HEALTH_TTL_MS         health-verdict cache TTL ms (default 20000)
 *
 * @param {NodeJS.ProcessEnv} [env=process.env]
 * @returns {{
 *   enabled: boolean,
 *   fallbackModel: string,
 *   fallbackBackend: string,
 *   probeTimeoutMs: number,
 *   completionTimeoutMs: number,
 *   verdictTtlMs: number,
 * }}
 */
export function getFailoverConfig(env = process.env) {
  const raw = env.SKGATEWAY_LOCAL_FAILOVER;
  const off = raw != null && ["0", "false", "off", "no"].includes(String(raw).trim().toLowerCase());
  return {
    enabled: !off,
    // A LIVE free model. The previous default (deepseek-ai/deepseek-v4-flash)
    // reached end-of-life and now returns 410 Gone, so a transient local outage
    // failed over straight into a hard failure. openai/gpt-oss-20b is a currently
    // advertised free NVIDIA model (verified 200). See GTD 6cf41f1382c4; keeping
    // this default LIVE is the discovery/advertise layer's ongoing job.
    fallbackModel: env.SKGATEWAY_LOCAL_FALLBACK_MODEL || "openai/gpt-oss-20b",
    fallbackBackend: env.SKGATEWAY_LOCAL_FALLBACK_BACKEND || "nvidia",
    probeTimeoutMs: intEnv(env.SKGATEWAY_LOCAL_HEALTH_TIMEOUT_MS, 3000),
    completionTimeoutMs: intEnv(env.SKGATEWAY_LOCAL_COMPLETION_TIMEOUT_MS, 10000),
    verdictTtlMs: intEnv(env.SKGATEWAY_LOCAL_HEALTH_TTL_MS, 20000),
  };
}

/**
 * Is `url` a sovereign/local backend (private, loopback, tailnet, or a local
 * mDNS/.internal name)? Failover is gated on this so a genuinely-cloud registry
 * backend is never silently redirected. Covers loopback, RFC1918 ranges, the
 * Tailscale CGNAT range (100.64/10), link-local, and localhost/.local/.internal
 * hostnames. On a parse failure it returns false (fail closed = no failover).
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isLocalUrl(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  if (host === "localhost" || host === "::1" || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  // Strip IPv6 brackets already handled by URL.hostname; match IPv4 octets.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127) return true;                          // 127.0.0.0/8 loopback
  if (a === 10) return true;                           // 10.0.0.0/8
  if (a === 192 && b === 168) return true;             // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16.0.0/12
  if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 (tailscale CGNAT)
  if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local
  return false;
}

// ── Health-verdict cache ─────────────────────────────────────────────────────
// url -> { healthy: boolean, at: number(ms) }. Shared across requests so a local
// outage is not re-probed on every call; the verdict expires after verdictTtlMs
// (so recovery is picked up automatically) and is also refreshed by the outcome
// of real completions (recordLocalOutcome), giving faster convergence than the
// probe alone.
const _verdicts = new Map();

/**
 * Return the cached verdict for `url` if still within `ttlMs`, else null.
 * @param {string} url
 * @param {number} ttlMs
 * @param {number} nowMs
 * @returns {boolean|null}
 */
function cachedVerdict(url, ttlMs, nowMs) {
  const v = _verdicts.get(url);
  if (v && nowMs - v.at < ttlMs) return v.healthy;
  return null;
}

/**
 * Record a health verdict for `url`.
 * @param {string} url
 * @param {boolean} healthy
 * @param {number} [nowMs]
 */
export function recordLocalOutcome(url, healthy, nowMs = Date.now()) {
  if (!url) return;
  _verdicts.set(url, { healthy: !!healthy, at: nowMs });
}

/**
 * Peek the raw cached verdict entry (for observability/tests). Returns
 * `{ healthy, at }` or undefined.
 * @param {string} url
 * @returns {{healthy:boolean, at:number}|undefined}
 */
export function peekVerdict(url) {
  return _verdicts.get(url);
}

/** Clear all cached verdicts (test helper). */
export function resetLocalHealth() {
  _verdicts.clear();
}

/**
 * Fast, cached liveness probe of a local OpenAI-compatible backend. Issues a
 * GET {base}/models bounded by `timeoutMs`; any non-2xx, network error, or
 * timeout is treated as unhealthy. The verdict is cached for `ttlMs` so repeated
 * requests inside the window reuse it instead of re-probing.
 *
 * Fail-soft: never throws. `fetchImpl` and `now` are injectable for tests.
 *
 * @param {string} url  Backend base url, e.g. "http://192.168.0.100:8082/v1"
 * @param {object} opts
 * @param {number} opts.probeTimeoutMs
 * @param {number} opts.verdictTtlMs
 * @param {Function} [opts.now]        clock (defaults to Date.now)
 * @param {Function} [opts.fetchImpl]  fetch implementation (defaults to global fetch)
 * @returns {Promise<boolean>} true if the local backend looks alive
 */
export async function probeLocalHealth(url, opts = {}) {
  const {
    probeTimeoutMs = 3000,
    verdictTtlMs = 20000,
    now = Date.now,
    fetchImpl = fetch,
  } = opts;
  const nowMs = now();
  const cached = cachedVerdict(url, verdictTtlMs, nowMs);
  if (cached != null) return cached;

  const probeUrl = `${String(url).replace(/\/$/, "")}/models`;
  let healthy = false;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), probeTimeoutMs);
  try {
    const r = await fetchImpl(probeUrl, { method: "GET", signal: ac.signal });
    healthy = !!(r && r.ok);
  } catch {
    healthy = false;
  } finally {
    clearTimeout(timer);
  }
  _verdicts.set(url, { healthy, at: nowMs });
  return healthy;
}
