/**
 * router.mjs — Multi-backend router for SKGateway
 *
 * Manages a registry of LLM backends (Anthropic, NVIDIA NIM, Ollama, and
 * any custom endpoint).  For each incoming inference request it selects the
 * best healthy backend, attaches the appropriate auth headers, and—on
 * failure—falls over to the next eligible backend by priority.
 *
 * Public API (returned by `createRouter`):
 *
 *   route(request)    — Resolve a RouteResult for the request
 *   getHealth()       — Snapshot of every backend's health state
 *   addBackend(cfg)   — Register a new backend at runtime
 *   removeBackend(id) — Deregister a backend by id
 *
 * @module router
 */

import fs from "node:fs";
import path from "node:path";
import { sendUpstream } from "./upstream.mjs";
import { isAnthropicBackend, toAnthropicRequest, toOpenAIResponse } from "./anthropic-adapter.mjs";
import { getPool } from "./connection-pool.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Window size for the sliding error-rate calculation (number of requests). */
const HEALTH_WINDOW = 100;

/** Mark backend degraded once error rate exceeds this threshold (10 %). */
const DEGRADED_ERROR_RATE = 0.10;

/** Mark backend down once error rate exceeds this threshold (50 %). */
const DOWN_ERROR_RATE = 0.50;

/**
 * After a backend is marked down it enters a cooldown.  Any health check
 * issued during the cooldown resolves immediately as "down" without making
 * a real request.  After the cooldown expires the backend is put back into
 * "degraded" and allowed one probe request to determine liveness.
 *
 * Default: 60 seconds.
 */
const DEFAULT_COOLDOWN_MS = 60_000;

/** Timeout (ms) used for liveness probe requests during recovery. */
const PROBE_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// Type documentation (JSDoc only — no TypeScript)
// ---------------------------------------------------------------------------

/**
 * @typedef {'api_key'|'oauth'|'bearer'|'none'} AuthType
 *
 * @typedef {Object} BackendConfig
 * @property {string}   id                  Unique identifier (e.g. "anthropic")
 * @property {string}   url                 Base URL including /v1 suffix
 * @property {AuthType} auth_type           Authentication strategy
 * @property {string[]} models              Model IDs or glob patterns served by this backend
 * @property {number}   priority            Lower = higher priority (1 beats 2)
 * @property {string}   [api_key]           Literal key (less preferred than env var)
 * @property {string}   [api_key_env]       Env-var name holding the API key
 * @property {string}   [credentials_file]  Path to JSON credentials (oauth flow)
 * @property {number}   [cooldown_ms]       Cooldown after DOWN before re-probe
 *
 * @typedef {Object} HealthSnapshot
 * @property {'up'|'degraded'|'down'} status
 * @property {number}   errorRate     0–1 float
 * @property {number}   latencyP50    ms (median of recent requests)
 * @property {number}   lastCheck     epoch ms of last successful or failed request
 * @property {number}   totalRequests
 * @property {number}   totalErrors
 *
 * @typedef {Object} RouteResult
 * @property {string}   backendId    Which backend was selected
 * @property {string}   backendUrl   Full upstream URL base
 * @property {Record<string, string>} authHeaders  Headers to inject before forwarding
 * @property {Backend}  backend      The Backend instance (for recording outcomes)
 *
 * @typedef {Object} RouteRequest
 * @property {string}  [model]        Model ID from the incoming request body
 * @property {string}  [agentId]      Agent identifier (for restriction checks)
 * @property {string}  [path]         Request path (e.g. "/v1/chat/completions")
 */

// ---------------------------------------------------------------------------
// Glob matching helper
// ---------------------------------------------------------------------------

/**
 * Test whether a model ID matches a pattern.
 * Patterns may use `*` as a wildcard (e.g. "dolphin-*").
 * An exact match is also accepted.
 *
 * @param {string} pattern
 * @param {string} model
 * @returns {boolean}
 */
function modelMatches(pattern, model) {
  if (!pattern || !model) return false;
  if (pattern === model) return true;
  // Convert glob-style "*" into a regex
  const reStr = "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
  return new RegExp(reStr, "i").test(model);
}

// ---------------------------------------------------------------------------
// Sliding-window latency tracker (P50 via reservoir sampling)
// ---------------------------------------------------------------------------

/**
 * Fixed-size circular buffer that tracks recent latency samples and computes
 * an approximate P50 (median) without sorting the full dataset on every call.
 *
 * @internal
 */
class LatencyTracker {
  /**
   * @param {number} [capacity=200] Maximum samples held in memory
   */
  constructor(capacity = 200) {
    this._capacity = capacity;
    /** @type {number[]} */
    this._samples = [];
    this._head = 0; // next write position (circular)
  }

  /**
   * Record a new latency sample (milliseconds).
   * @param {number} ms
   */
  record(ms) {
    if (this._samples.length < this._capacity) {
      this._samples.push(ms);
    } else {
      this._samples[this._head] = ms;
      this._head = (this._head + 1) % this._capacity;
    }
  }

  /**
   * Compute approximate P50 of recorded samples.
   * Returns 0 when no samples are present.
   * @returns {number}
   */
  p50() {
    if (this._samples.length === 0) return 0;
    const sorted = [...this._samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
      : sorted[mid];
  }
}

// ---------------------------------------------------------------------------
// Backend class
// ---------------------------------------------------------------------------

/**
 * Represents one upstream LLM backend with its configuration, health state,
 * and auth-token cache.
 */
export class Backend {
  /**
   * @param {BackendConfig} config
   */
  constructor(config) {
    this.id = config.id;
    this.url = config.url.replace(/\/$/, ""); // strip trailing slash
    this.auth_type = config.auth_type || "none";
    this.models = Array.isArray(config.models) ? config.models : [];
    this.priority = typeof config.priority === "number" ? config.priority : 99;
    this.cooldown_ms = config.cooldown_ms || DEFAULT_COOLDOWN_MS;

    // Auth credentials
    this._api_key = config.api_key || null;
    this._api_key_env = config.api_key_env || null;
    this._credentials_file = config.credentials_file || null;

    // Agent-level restrictions — set of agent IDs allowed to use this backend.
    // Empty set = no restrictions.
    /** @type {Set<string>} */
    this._allowedAgents = new Set(config.allowed_agents || []);

    // ----- Health state -----
    /** @type {'up'|'degraded'|'down'} */
    this._status = "up";
    /** @type {number} epoch ms */
    this._lastCheck = 0;
    /** @type {number} epoch ms — when the backend was last marked down */
    this._downSince = 0;
    /** @type {boolean} — are we currently running a recovery probe? */
    this._probing = false;

    // Sliding window (last HEALTH_WINDOW outcomes: true=success, false=error)
    /** @type {boolean[]} */
    this._window = [];
    this._windowHead = 0;
    this._windowErrors = 0; // count of `false` in window

    this._totalRequests = 0;
    this._totalErrors = 0;

    this._latency = new LatencyTracker(200);

    // OAuth token cache
    this._oauthToken = null;
    /** @type {number} epoch ms */
    this._oauthExpiry = 0;
  }

  // -------------------------------------------------------------------------
  // Model matching
  // -------------------------------------------------------------------------

  /**
   * Returns true if this backend can serve the given model ID.
   * An empty models list is treated as "accept everything".
   *
   * @param {string} model
   * @returns {boolean}
   */
  supportsModel(model) {
    if (!model || this.models.length === 0) return true;
    return this.models.some((pattern) => modelMatches(pattern, model));
  }

  // -------------------------------------------------------------------------
  // Agent restriction checks
  // -------------------------------------------------------------------------

  /**
   * Returns true if the given agent is allowed to use this backend.
   * When no restriction list is configured every agent is allowed.
   *
   * @param {string|undefined} agentId
   * @returns {boolean}
   */
  allowsAgent(agentId) {
    if (this._allowedAgents.size === 0) return true;
    return agentId != null && this._allowedAgents.has(agentId);
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  /**
   * Returns a point-in-time snapshot of this backend's health.
   * @returns {HealthSnapshot}
   */
  getHealth() {
    return {
      status: this._status,
      errorRate: this._computeErrorRate(),
      latencyP50: this._latency.p50(),
      lastCheck: this._lastCheck,
      totalRequests: this._totalRequests,
      totalErrors: this._totalErrors,
    };
  }

  /**
   * Whether this backend is available to receive a request right now.
   * Backends in cooldown are treated as down until the cooldown expires,
   * at which point they are tentatively allowed one probe request.
   *
   * @returns {boolean}
   */
  isAvailable() {
    if (this._status === "up" || this._status === "degraded") return true;
    // Down — check if cooldown has elapsed
    if (this._status === "down") {
      const elapsed = Date.now() - this._downSince;
      if (elapsed >= this.cooldown_ms) {
        // Transition to degraded to allow one probe
        this._status = "degraded";
        console.log(`[router] backend=${this.id} cooldown expired — transitioning down→degraded for re-probe`);
        return true;
      }
    }
    return false;
  }

  /**
   * Record the outcome of one upstream request and update health state.
   *
   * @param {boolean} success   true if the request completed without error (non-5xx)
   * @param {number}  latencyMs round-trip time in milliseconds
   */
  recordOutcome(success, latencyMs) {
    this._lastCheck = Date.now();
    this._totalRequests++;
    if (!success) this._totalErrors++;
    this._latency.record(latencyMs);

    // Update sliding window
    if (this._window.length < HEALTH_WINDOW) {
      this._window.push(success);
      if (!success) this._windowErrors++;
    } else {
      const evicted = this._window[this._windowHead];
      this._window[this._windowHead] = success;
      this._windowHead = (this._windowHead + 1) % HEALTH_WINDOW;
      if (!evicted) this._windowErrors--;
      if (!success) this._windowErrors++;
    }

    this._evaluateStatus();
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  /**
   * Build the Authorization / x-api-key headers for this backend.
   * For `oauth` backends the token is loaded (and refreshed) from the
   * credentials file.  Returns an empty object for `none` auth.
   *
   * @returns {Promise<Record<string, string>>}
   */
  async buildAuthHeaders() {
    switch (this.auth_type) {
      case "api_key":
      case "bearer": {
        const key = this._resolveApiKey();
        if (!key) {
          console.warn(`[router] backend=${this.id} auth_type=${this.auth_type} but no key found`);
          return {};
        }
        return { authorization: `Bearer ${key}` };
      }

      case "oauth": {
        const token = await this._getOAuthToken();
        if (!token) return {};
        return { authorization: `Bearer ${token}` };
      }

      case "none":
      default:
        return {};
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** @returns {number} 0–1 */
  _computeErrorRate() {
    if (this._window.length === 0) return 0;
    return this._windowErrors / this._window.length;
  }

  /** Re-evaluate and potentially change status based on current error rate. */
  _evaluateStatus() {
    const rate = this._computeErrorRate();

    if (rate >= DOWN_ERROR_RATE) {
      if (this._status !== "down") {
        console.warn(
          `[router] backend=${this.id} error_rate=${(rate * 100).toFixed(1)}% — marking DOWN` +
          ` (cooldown=${this.cooldown_ms}ms)`
        );
        this._status = "down";
        this._downSince = Date.now();
      }
    } else if (rate >= DEGRADED_ERROR_RATE) {
      if (this._status !== "degraded") {
        console.warn(
          `[router] backend=${this.id} error_rate=${(rate * 100).toFixed(1)}% — marking DEGRADED`
        );
        this._status = "degraded";
      }
    } else {
      if (this._status !== "up") {
        console.log(
          `[router] backend=${this.id} error_rate=${(rate * 100).toFixed(1)}% — recovered to UP`
        );
        this._status = "up";
      }
    }
  }

  /**
   * Resolve the API key for api_key / bearer auth.
   * Precedence: env var → literal config value.
   *
   * @returns {string|null}
   */
  _resolveApiKey() {
    if (this._api_key_env) {
      const fromEnv = process.env[this._api_key_env];
      if (fromEnv) return fromEnv;
    }
    return this._api_key || null;
  }

  /**
   * Return a valid OAuth access token, refreshing if expired.
   * The token file is expected to be a JSON object with at least:
   *   { access_token: string, expires_at: number /* epoch seconds *\/ }
   *
   * If the file contains `refresh_token` and the token is expired, this
   * method logs a warning (full OAuth refresh requires per-provider logic
   * outside this module's scope).
   *
   * @returns {Promise<string|null>}
   */
  async _getOAuthToken() {
    const now = Date.now();

    // Return cached token if still valid (with 60s buffer)
    if (this._oauthToken && now < this._oauthExpiry - 60_000) {
      return this._oauthToken;
    }

    if (!this._credentials_file) {
      console.warn(`[router] backend=${this.id} oauth auth but no credentials_file configured`);
      return null;
    }

    const filePath = this._credentials_file.replace(/^~/, process.env.HOME || "");
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const credsRaw = JSON.parse(raw);
      // Support both flat tokens and the Claude Code format:
      //   { "claudeAiOauth": { accessToken, expiresAt, refreshToken } }
      const creds = credsRaw.claudeAiOauth || credsRaw;

      const accessToken = creds.access_token || creds.accessToken;
      if (!accessToken) {
        console.warn(`[router] backend=${this.id} credentials file has no access token: ${filePath}`);
        return null;
      }

      // expires_at may be epoch seconds or ms — normalise to ms
      const expRaw = creds.expires_at || creds.expiry || creds.expiresAt || 0;
      const expiryMs = expRaw > 1e12 ? expRaw : expRaw * 1000;
      const refreshToken = creds.refresh_token || creds.refreshToken;

      // Proactively refresh within 5 min of expiry. Claude Code OAuth tokens
      // live ~8h; without this the subscription path dies every 8h unless a
      // `claude` CLI happens to refresh the creds for us.
      if (refreshToken && now >= expiryMs - 300_000) {
        const refreshed = await this._refreshOAuth(refreshToken, filePath, credsRaw);
        if (refreshed) {
          this._oauthToken = refreshed.accessToken;
          this._oauthExpiry = refreshed.expiryMs;
          return this._oauthToken;
        }
        console.warn(`[router] backend=${this.id} oauth refresh failed; using stale token`);
      }

      this._oauthToken = accessToken;
      this._oauthExpiry = expiryMs;
      return this._oauthToken;
    } catch (err) {
      console.error(`[router] backend=${this.id} failed to load credentials file ${filePath}: ${err.message}`);
      return null;
    }
  }

  /**
   * Refresh an expired Claude Code OAuth token using the subscription
   * refresh_token, persisting the new tokens back to the credentials file
   * (preserving its shape). Mirrors Claude Code / CLIProxyAPI behaviour.
   *
   * @returns {Promise<{accessToken:string, expiryMs:number}|null>}
   */
  async _refreshOAuth(refreshToken, filePath, credsRaw) {
    const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"; // Claude Code CLI
    try {
      const resp = await fetch("https://console.anthropic.com/v1/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "anthropic" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }),
      });
      if (!resp.ok) {
        console.error(`[router] backend=${this.id} oauth refresh HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        return null;
      }
      const data = await resp.json();
      const accessToken = data.access_token;
      if (!accessToken) return null;
      const newRefresh = data.refresh_token || refreshToken;
      const expiryMs = Date.now() + (data.expires_in ? data.expires_in * 1000 : 8 * 3600 * 1000);
      try {
        if (credsRaw.claudeAiOauth) {
          credsRaw.claudeAiOauth.accessToken = accessToken;
          credsRaw.claudeAiOauth.refreshToken = newRefresh;
          credsRaw.claudeAiOauth.expiresAt = expiryMs;
        } else {
          credsRaw.access_token = accessToken;
          credsRaw.refresh_token = newRefresh;
          credsRaw.expires_at = expiryMs;
        }
        fs.writeFileSync(filePath, JSON.stringify(credsRaw, null, 2), { mode: 0o600 });
      } catch (werr) {
        console.warn(`[router] backend=${this.id} could not persist refreshed token: ${werr.message}`);
      }
      console.log(`[router] backend=${this.id} oauth token refreshed (expires in ${Math.round((expiryMs - Date.now()) / 3600000)}h)`);
      return { accessToken, expiryMs };
    } catch (err) {
      console.error(`[router] backend=${this.id} oauth refresh error: ${err.message}`);
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

/**
 * Create a multi-backend router.
 *
 * @param {object} config
 * @param {Record<string, Omit<BackendConfig, 'id'>>} [config.backends]
 *   Map of backend ID → backend configuration (from YAML `backends:` block).
 * @param {string} [config.default_backend]
 *   ID of the backend to use when no model matches any backend's list.
 *   Defaults to the backend with the lowest priority number.
 * @param {boolean} [config.failover]
 *   Whether to attempt failover to secondary backends on error.  Default true.
 * @param {boolean} [config.siem_log]
 *   Emit structured SIEM events for failover and health changes.  Default true.
 *
 * @returns {{
 *   route(request: RouteRequest): Promise<RouteResult[]>,
 *   getHealth(): Record<string, HealthSnapshot>,
 *   addBackend(cfg: BackendConfig): void,
 *   removeBackend(id: string): void,
 * }}
 */
export function createRouter(config = {}) {
  const failoverEnabled = config.failover !== false;
  const siemLog = config.siem_log !== false;

  /** @type {Map<string, Backend>} */
  const backends = new Map();

  // Populate initial registry from config
  if (config.backends && typeof config.backends === "object") {
    for (const [id, cfg] of Object.entries(config.backends)) {
      backends.set(id, new Backend({ id, ...cfg }));
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Return backends sorted ascending by priority (lowest number = first).
   * Only includes backends that are currently available (not in hard cooldown).
   *
   * @returns {Backend[]}
   */
  function availableByPriority() {
    return [...backends.values()]
      .filter((b) => b.isAvailable())
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * Find backends that claim to support `model`, sorted by priority.
   * Falls back to all available backends if none explicitly match.
   *
   * @param {string|undefined} model
   * @param {string|undefined} agentId
   * @returns {Backend[]}
   */
  function candidatesFor(model, agentId) {
    const available = availableByPriority().filter((b) => b.allowsAgent(agentId));

    if (!model) return available;

    // Exact or glob match first
    const matched = available.filter((b) => b.supportsModel(model));
    if (matched.length > 0) return matched;

    // No backend claims this model — fall back to all available backends
    // (the upstream will return 404/400 for unsupported models, which the
    // retry loop will treat as a hard error and move on).
    return available;
  }

  /**
   * Emit a structured SIEM event to stdout (JSON Lines format).
   * Consumers (siem/file.mjs, siem/elastic.mjs) can parse these.
   *
   * @param {string} event
   * @param {Record<string, unknown>} fields
   */
  function siemEvent(event, fields) {
    if (!siemLog) return;
    const entry = {
      ts: new Date().toISOString(),
      event,
      source: "router",
      ...fields,
    };
    process.stdout.write(JSON.stringify(entry) + "\n");
  }

  // -------------------------------------------------------------------------
  // route()
  // -------------------------------------------------------------------------

  /**
   * Resolve the best backend for the given request.  On failover the function
   * returns a modified RouteResult with the fallback backend.  The caller is
   * expected to call `backend.recordOutcome()` after each upstream attempt so
   * health tracking stays accurate.
   *
   * This function does NOT make any network calls — it only selects the
   * backend.  Use `sendUpstream` (from upstream.mjs) to make the actual
   * request, then call `backend.recordOutcome()` with the result.
   *
   * Failover example:
   * ```js
   * const { route, getHealth } = createRouter(config);
   *
   * const candidates = await route(request);   // returns RouteResult[]
   * for (const result of candidates) {
   *   const start = Date.now();
   *   const res = await sendUpstream(path, method, headers, body, new URL(result.backendUrl));
   *   result.backend.recordOutcome(res.status < 500, Date.now() - start);
   *   break;
   * }
   * ```
   *
   * @param {RouteRequest} request
   * @returns {Promise<RouteResult[]>}
   *   Ordered list of RouteResult objects to try, primary first.
   *   Guaranteed non-empty as long as at least one backend is registered.
   *   Throws if the registry is empty.
   */
  async function route(request) {
    const { model, agentId } = request;

    if (backends.size === 0) {
      throw new Error("[router] No backends registered — cannot route request");
    }

    const candidates = candidatesFor(model, agentId);

    if (candidates.length === 0) {
      // All backends are down or restricted for this agent — return all backends
      // sorted by priority so the caller can attempt anyway and surface the error.
      const all = [...backends.values()].sort((a, b) => a.priority - b.priority);
      console.warn(
        `[router] All backends unavailable for model=${model} agent=${agentId} — ` +
        `returning full list (caller will get upstream errors)`
      );
      siemEvent("all_backends_unavailable", { model, agentId, backendCount: all.length });
      return await Promise.all(
        all.map(async (b) => ({
          backendId: b.id,
          backendUrl: b.url,
          authHeaders: await b.buildAuthHeaders(),
          backend: b,
        }))
      );
    }

    // Resolve auth headers for each candidate in parallel
    const results = await Promise.all(
      candidates.map(async (b) => ({
        backendId: b.id,
        backendUrl: b.url,
        authHeaders: await b.buildAuthHeaders(),
        backend: b,
      }))
    );

    if (results.length > 1 && failoverEnabled) {
      const primary = results[0].backendId;
      const fallbacks = results.slice(1).map((r) => r.backendId).join(", ");
      console.log(
        `[router] model=${model || "(none)"} → primary=${primary} ` +
        `fallbacks=[${fallbacks}]`
      );
    } else {
      console.log(`[router] model=${model || "(none)"} → backend=${results[0].backendId}`);
    }

    return failoverEnabled ? results : [results[0]];
  }

  // -------------------------------------------------------------------------
  // getHealth()
  // -------------------------------------------------------------------------

  /**
   * Return a snapshot of every backend's health.
   *
   * @returns {Record<string, HealthSnapshot>}
   */
  function getHealth() {
    const out = {};
    for (const [id, backend] of backends) {
      out[id] = backend.getHealth();
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // addBackend() / removeBackend()
  // -------------------------------------------------------------------------

  /**
   * Register a new backend (or replace an existing one with the same id).
   *
   * @param {BackendConfig} cfg
   */
  function addBackend(cfg) {
    if (!cfg.id) throw new Error("[router] addBackend: cfg.id is required");
    backends.set(cfg.id, new Backend(cfg));
    console.log(
      `[router] registered backend=${cfg.id} url=${cfg.url} ` +
      `priority=${cfg.priority} models=[${cfg.models?.join(", ")}]`
    );
  }

  /**
   * Deregister a backend by id.  In-flight requests to that backend are not
   * interrupted; only future `route()` calls are affected.
   *
   * @param {string} id
   */
  function removeBackend(id) {
    if (!backends.has(id)) {
      console.warn(`[router] removeBackend: unknown backend id=${id}`);
      return;
    }
    backends.delete(id);
    console.log(`[router] deregistered backend=${id}`);
  }

  // -------------------------------------------------------------------------
  // Return router interface
  // -------------------------------------------------------------------------

  return { route, getHealth, addBackend, removeBackend };
}

// ---------------------------------------------------------------------------
// Default router instance built from environment / well-known config path
// ---------------------------------------------------------------------------

/**
 * Build a router from the standard SKGateway YAML config, if available.
 * Falls back to a sensible single-backend default when no config is found.
 *
 * Supports a minimal config subset (no YAML parser dependency — reads JSON
 * equivalent or a small hand-rolled YAML subset via regex).  The full YAML
 * parser lives in the gateway entry point which can pass a pre-parsed config
 * object to `createRouter()` directly.
 *
 * @param {object} [overrides]   Merged on top of the discovered config
 * @returns {ReturnType<typeof createRouter>}
 */
export function createDefaultRouter(overrides = {}) {
  // The gateway entry point typically calls createRouter(parsedConfig) directly.
  // This factory is a convenience for tests and ad-hoc scripts.
  const defaultConfig = {
    backends: {
      nvidia: {
        url: process.env.SKGATEWAY_TARGET || "https://integrate.api.nvidia.com/v1",
        auth_type: "api_key",
        api_key_env: "NVIDIA_API_KEY",
        models: ["kimi-k2-instruct", "kimi-k2.5", "kimi-think", "minimax-*", "mistral-*", "llama-*"],
        priority: 2,
      },
      ollama: {
        url: process.env.OLLAMA_URL || "http://192.168.0.100:11434/v1",
        auth_type: "none",
        models: ["dolphin-*"],
        priority: 3,
      },
    },
    failover: true,
    siem_log: true,
    ...overrides,
  };

  // Anthropic is conditional on having a credentials file or env token
  const anthropicCredsFile =
    process.env.ANTHROPIC_CREDENTIALS_FILE ||
    path.join(process.env.HOME || "", ".openclaw", "credentials", "anthropic.json");

  if (process.env.ANTHROPIC_API_KEY) {
    defaultConfig.backends.anthropic = {
      url: "https://api.anthropic.com/v1",
      auth_type: "api_key",
      api_key_env: "ANTHROPIC_API_KEY",
      models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-*"],
      priority: 1,
    };
  } else if (fs.existsSync(anthropicCredsFile)) {
    defaultConfig.backends.anthropic = {
      url: "https://api.anthropic.com/v1",
      auth_type: "oauth",
      credentials_file: anthropicCredsFile,
      models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-*"],
      priority: 1,
    };
  }

  return createRouter(defaultConfig);
}

// ---------------------------------------------------------------------------
// Convenience: route + upstream in one call WITH connection pooling
// ---------------------------------------------------------------------------

/**
 * High-level helper used by the proxy request handler.
 * Tries each candidate backend in order, acquires a pool slot, sends the
 * request, records outcomes, and returns the first successful response.
 * On failover it emits a SIEM log line.
 *
 * NEW: Uses connection pooler to enforce per-backend concurrency limits
 * and queue excess requests.
 *
 * @param {ReturnType<typeof createRouter>} router
 * @param {RouteRequest} request
 * @param {string}  upstreamPath   Request path (e.g. "/v1/chat/completions")
 * @param {string}  method         HTTP method
 * @param {Record<string, string>} clientHeaders  Incoming client headers
 * @param {Buffer}  body           Buffered request body
 * @param {boolean} [usePool=true] Whether to use the connection pool
 * @returns {Promise<{
 *   status: number,
 *   headers: Record<string, string>,
 *   body: Buffer,
 *   backendId: string,
 *   failover: boolean,
 *   queueWaitMs?: number,
 * }>}
 */
export async function routeAndSend(router, request, upstreamPath, method, clientHeaders, body, usePool = true) {
  const pool = usePool ? getPool() : null;
  const candidates = await router.route(request);

  let lastResult = null;
  let didFailover = false;

  for (let i = 0; i < candidates.length; i++) {
    const { backendId, backendUrl, authHeaders, backend } = candidates[i];

    if (i > 0) {
      didFailover = true;
      // SIEM failover event written to stdout as a JSON line
      process.stdout.write(JSON.stringify({
        ts: new Date().toISOString(),
        event: "failover",
        source: "router",
        from: candidates[i - 1].backendId,
        to: backendId,
        model: request.model,
        agentId: request.agentId,
        previousStatus: lastResult?.status,
      }) + "\n");
      console.warn(
        `[router] FAILOVER: ${candidates[i - 1].backendId} → ${backendId}` +
        ` (prev_status=${lastResult?.status})`
      );
    }

    // Merge auth headers into a sanitized copy of client headers
    const forwardHeaders = { ...clientHeaders };
    for (const [k, v] of Object.entries(authHeaders)) {
      forwardHeaders[k] = v;
    }
    // Strip headers that must not be forwarded as-is
    delete forwardHeaders.host;
    delete forwardHeaders.connection;
    delete forwardHeaders["keep-alive"];

    const targetUrl = new URL(backendUrl);
    const queueStart = Date.now();

    // Acquire a connection pool slot (waits if at capacity)
    let slot = null;
    if (pool) {
      try {
        slot = await pool.acquire(backendId);
      } catch (err) {
        // Pool rejected (queue full) — log and fall back to serving a 503
        console.error(`[routeAndSend] pool rejected backend=${backendId}: ${err.message}`);
        return {
          status: 503,
          headers: { "content-type": "application/json" },
          body: Buffer.from(JSON.stringify({
            error: {
              message: `Backend ${backendId} is at capacity. Queue full.`,
              code: "capacity_exceeded",
              backend: backendId,
            }
          })),
          backendId,
          failover: didFailover,
        };
      }
    }

    const queueWaitMs = Date.now() - queueStart;

    let res;
    try {
      if (isAnthropicBackend(backend)) {
        // Translate OpenAI chat-completions → Anthropic Messages API.
        const tr = toAnthropicRequest(body, {
          authorization: forwardHeaders.authorization,
        });
        if (tr) {
          const aHeaders = { ...forwardHeaders, ...tr.headers };
          delete aHeaders["content-length"];
          const raw = await sendUpstream(tr.path, method, aHeaders, tr.body, targetUrl);
          res = toOpenAIResponse(raw, request.model);
        } else {
          res = await sendUpstream(upstreamPath, method, forwardHeaders, body, targetUrl);
        }
      } else {
        res = await sendUpstream(upstreamPath, method, forwardHeaders, body, targetUrl);
      }
    } catch (err) {
      // sendUpstream resolves with 502 on network error, but be defensive
      res = {
        status: 502,
        headers: {},
        body: Buffer.from(JSON.stringify({ error: { message: err.message } })),
      };
    } finally {
      // Always release the slot, even on error
      if (pool && slot) {
        pool.release(backendId);
      }
    }

    const latencyMs = Date.now() - queueStart;
    const success = res.status < 500;
    backend.recordOutcome(success, latencyMs);

    lastResult = { ...res, backendId, failover: didFailover, queueWaitMs };

    if (success) {
      console.log(
        `[router] ${res.status} OK backend=${backendId} latency=${latencyMs}ms` +
        (didFailover ? " (failover)" : "") +
        (queueWaitMs > 0 ? ` queued=${queueWaitMs}ms` : "" )
      );
      return lastResult;
    }

    console.warn(
      `[router] ${res.status} ERROR backend=${backendId} latency=${latencyMs}ms` +
      (i < candidates.length - 1 ? " — trying next backend" : " — no more backends")
    );
  }

  // All backends failed — return the last response so the caller can relay the error
  return lastResult;
}
