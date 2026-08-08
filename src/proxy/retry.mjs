/**
 * retry.mjs — Multi-layer retry and fallback engine for SKGateway
 *
 * Implements a four-layer retry strategy learned from production experience
 * with NVIDIA NIM, Anthropic, Ollama, and other LLM backends:
 *
 *   Layer 1 — Retry same backend + same model with reduced tools
 *   Layer 2 — Retry same backend with alternate model (failover model)
 *   Layer 3 — Failover to next backend in priority order
 *   Layer 4 — Text-only fallback (strip all tools), last-resort
 *
 * Each layer is independently configurable. The engine also provides:
 *   - Exponential backoff with jitter for 429 rate limits
 *   - Respect for Retry-After headers
 *   - Per-backend circuit breakers (open → half-open → closed)
 *   - Per-backend rate limit state tracking
 *   - Full request metadata attached to responses for SIEM logging
 *
 * @module retry
 */

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * @typedef {'rate_limit'|'bad_payload'|'auth_error'|'backend_error'|'overloaded'|'timeout'|'network'|'unknown'} ErrorClass
 */

/**
 * Classify an HTTP status code (or network error) into a high-level error
 * class that drives layer-selection logic.
 *
 * @param {number} status  HTTP status code (502 is used for network errors)
 * @param {string} [body]  Raw response body text for sub-classification
 * @returns {ErrorClass}
 */
export function classifyError(status, body = "") {
  switch (status) {
    case 400:
      return "bad_payload";   // likely tool/schema issue → reduce tools
    case 401:
    case 403:
      return "auth_error";    // token expired / insufficient scope → refresh once
    case 429:
      return "rate_limit";    // backoff with Retry-After → wait and retry
    case 500:
    case 502:
    case 503:
      return "backend_error"; // upstream infra → failover
    case 529:
      return "overloaded";    // Anthropic-specific → backoff then failover
    case 504:
      return "timeout";       // upstream timeout → failover
    case 410:
      // Model reached end-of-life (410 Gone). This is PERMANENT, but from the
      // router's view it must behave like a backend_error so the request FAILS
      // OVER to the next backend instead of returning 410 to the caller. (Pruning
      // the EOL id from the catalog so it is never selected is the discovery/
      // advertise layer's job; this is the safety net.)
      return "backend_error";
    default:
      // NVIDIA returns 400 "single tool-calls" for parallel tool call rejections
      if (status === 400 && body.includes("single tool-calls")) return "bad_payload";
      if (status >= 500) return "backend_error";
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Backoff helpers
// ---------------------------------------------------------------------------

/**
 * Compute an exponential-backoff delay with full jitter.
 * `delay = random(0, min(maxDelay, baseDelay * 2^attempt))`
 *
 * Full jitter is preferred over equal jitter for high-concurrency systems
 * because it spreads retries more evenly across the retry window.
 *
 * @param {number} attempt    Zero-based attempt index (0 = first retry)
 * @param {number} baseDelay  Base delay in ms (default: 500)
 * @param {number} maxDelay   Maximum delay cap in ms (default: 30 000)
 * @returns {number}  Milliseconds to wait before this attempt
 */
export function jitteredBackoff(attempt, baseDelay = 500, maxDelay = 30_000) {
  const cap = Math.min(maxDelay, baseDelay * 2 ** attempt);
  return Math.floor(Math.random() * cap);
}

/**
 * Parse the `Retry-After` header into a millisecond delay.
 * Handles both delta-seconds and HTTP-date formats.
 *
 * @param {string|undefined} header  Raw `Retry-After` header value
 * @param {number}           fallback Fallback ms when header is absent/invalid
 * @returns {number}
 */
export function parseRetryAfter(header, fallback = 2_000) {
  if (!header) return fallback;
  // Delta-seconds form
  const seconds = parseFloat(header);
  if (!isNaN(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  // HTTP-date form
  const ts = Date.parse(header);
  if (!isNaN(ts)) {
    const ms = ts - Date.now();
    return ms > 0 ? ms : 0;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/**
 * @typedef {'closed'|'open'|'half-open'} CircuitState
 */

/**
 * @typedef {Object} CircuitBreaker
 * @property {CircuitState} state
 * @property {number}       failures      Consecutive failure count
 * @property {number}       lastFailureAt Timestamp of most recent failure (ms)
 * @property {number}       threshold     Failures before opening circuit
 * @property {number}       cooldown      Ms before transitioning to half-open
 */

/**
 * Create a circuit breaker for one backend.
 *
 * @param {number} [threshold=5]       Consecutive failures before opening
 * @param {number} [cooldown=30_000]   Cooldown period in ms before half-open
 * @returns {CircuitBreaker}
 */
function createCircuitBreaker(threshold = 5, cooldown = 30_000) {
  return {
    state: "closed",
    failures: 0,
    lastFailureAt: 0,
    threshold,
    cooldown,
  };
}

/**
 * Check whether a circuit breaker allows a request through.
 * Transitions half-open when cooldown has elapsed.
 *
 * @param {CircuitBreaker} cb
 * @returns {boolean}  true = request is allowed; false = circuit is open
 */
function circuitAllows(cb) {
  if (cb.state === "closed") return true;
  if (cb.state === "half-open") return true; // allow probe
  // open: check if cooldown has elapsed
  if (Date.now() - cb.lastFailureAt >= cb.cooldown) {
    cb.state = "half-open";
    return true;
  }
  return false;
}

/**
 * Record a successful request on a circuit breaker (closes the circuit).
 *
 * @param {CircuitBreaker} cb
 */
function circuitSuccess(cb) {
  cb.failures = 0;
  cb.state = "closed";
}

/**
 * Record a failed request on a circuit breaker.
 * Opens the circuit once the failure threshold is reached.
 *
 * @param {CircuitBreaker} cb
 */
function circuitFailure(cb) {
  cb.failures++;
  cb.lastFailureAt = Date.now();
  if (cb.failures >= cb.threshold) {
    cb.state = "open";
  }
}

// ---------------------------------------------------------------------------
// Per-backend rate limit state
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RateLimitState
 * @property {number} retryAfterMs  Earliest time (ms since epoch) we may retry
 * @property {number} count429      Total 429s received from this backend
 */

/**
 * Create empty rate limit state for one backend.
 *
 * @returns {RateLimitState}
 */
function createRateLimitState() {
  return { retryAfterMs: 0, count429: 0 };
}

/**
 * Return true if the backend is currently under a rate limit hold.
 *
 * @param {RateLimitState} state
 * @returns {boolean}
 */
function isRateLimited(state) {
  return Date.now() < state.retryAfterMs;
}

// ---------------------------------------------------------------------------
// Request context — threaded through the full retry path
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AttemptRecord
 * @property {number}     attemptNumber    1-based overall attempt index
 * @property {number}     layer            Retry layer (1–4)
 * @property {string}     backendId        Backend identifier
 * @property {string}     model            Model used for this attempt
 * @property {number}     toolCount        Number of tools sent
 * @property {number}     startedAt        ms timestamp
 * @property {number}     latencyMs        Round-trip time for this attempt
 * @property {number}     status           HTTP response status
 * @property {ErrorClass} errorClass       Classified error (or null on success)
 * @property {string}     [errorMessage]   Short error description
 */

/**
 * @typedef {Object} RetryMetadata
 * @property {number}          totalAttempts    Total upstream calls made
 * @property {number}          totalLatencyMs   Wall-clock time from first call
 * @property {string[]}        backendsTried    Ordered list of backend IDs used
 * @property {AttemptRecord[]} attempts         Per-attempt detail records
 * @property {boolean}         usedFallback     True if text-only layer was used
 * @property {boolean}         succeeded        True if a 2xx response was obtained
 * @property {string}          finalBackend     Backend that produced the response
 * @property {string}          finalModel       Model that produced the response
 */

// ---------------------------------------------------------------------------
// Core engine factory
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} LayerConfig
 * @property {number} [maxAttempts]   Per-layer attempt limit
 * @property {number} [baseDelay]     Backoff base delay in ms
 * @property {number} [maxDelay]      Backoff cap in ms
 */

/**
 * @typedef {Object} RetryConfig
 * @property {LayerConfig} [layer1]          Same backend, reduced tools
 * @property {LayerConfig} [layer2]          Same backend, alternate model
 * @property {LayerConfig} [layer3]          Next backend failover
 * @property {LayerConfig} [layer4]          Text-only last resort
 * @property {number}      [circuitThreshold] Failures before opening circuit (default: 5)
 * @property {number}      [circuitCooldown]  Circuit cooldown in ms (default: 30 000)
 * @property {number}      [max429Retries]    429 retries before escalating (default: 3)
 * @property {number}      [rateLimitBase]    Base delay for 429 backoff in ms (default: 2 000)
 * @property {number}      [rateLimitMax]     Max delay for 429 backoff in ms (default: 60 000)
 */

/**
 * @typedef {Object} BackendRequest
 * @property {string} backendId    Backend identifier (e.g. "nvidia", "anthropic")
 * @property {string} url          Full upstream URL
 * @property {string} method       HTTP method
 * @property {Record<string,string>} headers  Request headers
 * @property {object} body         Parsed JSON body (will be serialised per attempt)
 * @property {string} model        Model name
 * @property {string[]} [alternateModels]  Fallback model names for Layer 2
 */

/**
 * The primary interface the retry engine uses to talk to backends.
 * The router provides this function bound to each backend.
 *
 * @callback SendFn
 * @param {BackendRequest} req  Request descriptor
 * @returns {Promise<{ status: number, headers: Record<string,string>, body: Buffer }>}
 */

/**
 * @typedef {Object} Router
 * @property {(req: BackendRequest) => Promise<{status:number,headers:Record<string,string>,body:Buffer}>} send
 *   Send a request to the backend described in `req`.
 * @property {() => BackendRequest[]} getBackends
 *   Return an ordered list of backend descriptors the engine may use for
 *   Layer 3 failover.  Backends are tried in array order.
 * @property {(req: BackendRequest, tools: object[]) => BackendRequest} withReducedTools
 *   Return a new BackendRequest with the tool list replaced by the reduced set.
 * @property {(req: BackendRequest) => BackendRequest} withoutTools
 *   Return a new BackendRequest with all tools stripped (Layer 4).
 * @property {(req: BackendRequest, model: string) => BackendRequest} withModel
 *   Return a new BackendRequest with the model swapped.
 * @property {(req: BackendRequest, toolCount: number) => object[]} reduceTools
 *   Return an array of ≤toolCount tools chosen from the request's tool list.
 * @property {(backendId: string) => Promise<boolean>} [refreshAuth]
 *   Optional. Called on 401 to attempt token refresh before retrying.
 */

/** @type {RetryConfig} */
const DEFAULT_CONFIG = {
  layer1: { maxAttempts: 3, baseDelay: 200,    maxDelay: 5_000  },
  layer2: { maxAttempts: 1, baseDelay: 500,    maxDelay: 10_000 },
  layer3: { maxAttempts: 2, baseDelay: 1_000,  maxDelay: 20_000 },
  layer4: { maxAttempts: 1, baseDelay: 0,      maxDelay: 0      },
  circuitThreshold: 5,
  circuitCooldown:  30_000,
  max429Retries:    3,
  rateLimitBase:    2_000,
  rateLimitMax:     60_000,
};

/**
 * Build a complete config by merging caller-supplied values over the defaults.
 *
 * @param {Partial<RetryConfig>} [cfg]
 * @returns {RetryConfig}
 */
function mergeConfig(cfg = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...cfg,
    layer1: { ...DEFAULT_CONFIG.layer1, ...(cfg.layer1 ?? {}) },
    layer2: { ...DEFAULT_CONFIG.layer2, ...(cfg.layer2 ?? {}) },
    layer3: { ...DEFAULT_CONFIG.layer3, ...(cfg.layer3 ?? {}) },
    layer4: { ...DEFAULT_CONFIG.layer4, ...(cfg.layer4 ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Tool reduction schedule for Layer 1
// ---------------------------------------------------------------------------

/**
 * Compute how many tools to use on each Layer 1 sub-attempt.
 * Attempt 1: 16, attempt 2: 8, attempt 3: 1.
 * Any attempt beyond 3 falls through to Layer 4 text-only.
 *
 * @param {number} attempt  1-based Layer 1 attempt index
 * @returns {number}
 */
function toolBudgetForAttempt(attempt) {
  if (attempt === 1) return 16;
  if (attempt === 2) return 8;
  return 1;
}

// ---------------------------------------------------------------------------
// Sleep helper
// ---------------------------------------------------------------------------

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Main engine
// ---------------------------------------------------------------------------

/**
 * Create a retry engine bound to the given configuration.
 *
 * @param {Partial<RetryConfig>} [userConfig]  Override any default values
 * @returns {{ execute: ExecuteFn }}
 */
export function createRetryEngine(userConfig = {}) {
  const config = mergeConfig(userConfig);

  // Per-backend state maps — keyed by backendId
  /** @type {Map<string, CircuitBreaker>} */
  const circuits = new Map();

  /** @type {Map<string, RateLimitState>} */
  const rateLimits = new Map();

  /**
   * Get (or create) circuit breaker for a backend.
   * @param {string} backendId
   * @returns {CircuitBreaker}
   */
  function getCircuit(backendId) {
    if (!circuits.has(backendId)) {
      circuits.set(backendId, createCircuitBreaker(config.circuitThreshold, config.circuitCooldown));
    }
    return circuits.get(backendId);
  }

  /**
   * Get (or create) rate limit state for a backend.
   * @param {string} backendId
   * @returns {RateLimitState}
   */
  function getRateLimit(backendId) {
    if (!rateLimits.has(backendId)) {
      rateLimits.set(backendId, createRateLimitState());
    }
    return rateLimits.get(backendId);
  }

  /**
   * Return current circuit breaker state snapshot for all backends.
   * Used for health dashboards and SIEM enrichment.
   *
   * @returns {Record<string, { state: CircuitState, failures: number, rateLimited: boolean }>}
   */
  function getCircuitStatus() {
    const out = {};
    for (const [id, cb] of circuits) {
      out[id] = {
        state: cb.state,
        failures: cb.failures,
        rateLimited: isRateLimited(getRateLimit(id)),
      };
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Internal: send with 429-aware retry loop
  // -------------------------------------------------------------------------

  /**
   * Send a request, handling 429 with backoff internally.
   * Does NOT handle circuit breaker — caller must check before calling.
   *
   * @param {BackendRequest}    req
   * @param {Router}            router
   * @param {AttemptRecord[]}   attempts    Mutated in-place with each try
   * @param {number}            layerNum    For logging
   * @param {number}            overallAttempt  Global 1-based counter, mutated via wrapper
   * @param {{ n: number }}     counter     Shared mutable counter object
   * @returns {Promise<{ status: number, headers: Record<string,string>, body: Buffer }>}
   */
  async function sendWithRateLimitRetry(req, router, attempts, layerNum, counter) {
    const rl = getRateLimit(req.backendId);
    const maxR = config.max429Retries;

    for (let r = 0; r <= maxR; r++) {
      // If a previous 429 set a future retry time, wait for it
      const holdMs = rl.retryAfterMs - Date.now();
      if (holdMs > 0) {
        _log(`[retry] backend=${req.backendId} rate-limit hold ${holdMs}ms (r=${r})`);
        await sleep(holdMs);
      }

      counter.n++;
      const attemptRecord = {
        attemptNumber: counter.n,
        layer: layerNum,
        backendId: req.backendId,
        model: req.model,
        toolCount: Array.isArray(req.body?.tools) ? req.body.tools.length : 0,
        startedAt: Date.now(),
        latencyMs: 0,
        status: 0,
        errorClass: null,
      };

      const res = await router.send(req);
      attemptRecord.latencyMs = Date.now() - attemptRecord.startedAt;
      attemptRecord.status = res.status;

      if (res.status !== 429) {
        attempts.push(attemptRecord);
        return res;
      }

      // 429 handling
      rl.count429++;
      attemptRecord.errorClass = "rate_limit";

      const retryAfterHeader = res.headers["retry-after"];
      const waitMs = parseRetryAfter(
        retryAfterHeader,
        jitteredBackoff(r, config.rateLimitBase, config.rateLimitMax),
      );
      rl.retryAfterMs = Date.now() + waitMs;
      attemptRecord.errorMessage = `429 rate limited — waiting ${waitMs}ms (retry ${r + 1}/${maxR})`;
      attempts.push(attemptRecord);

      _log(`[retry] 429 from backend=${req.backendId} retry=${r + 1}/${maxR} wait=${waitMs}ms`);

      if (r === maxR) {
        // Exhausted 429 retries — return the 429 so the outer loop escalates
        return res;
      }

      await sleep(waitMs);
    }

    // Should not reach here, but satisfy the type system
    throw new Error("unexpected sendWithRateLimitRetry exit");
  }

  // -------------------------------------------------------------------------
  // Internal: check auth refresh
  // -------------------------------------------------------------------------

  /**
   * @param {string} backendId
   * @param {Router} router
   * @returns {Promise<boolean>}
   */
  async function tryRefreshAuth(backendId, router) {
    if (typeof router.refreshAuth === "function") {
      try {
        return await router.refreshAuth(backendId);
      } catch (err) {
        _log(`[retry] auth refresh failed for backend=${backendId}: ${err.message}`);
        return false;
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // execute — public API
  // -------------------------------------------------------------------------

  /**
   * @callback ExecuteFn
   * @param {BackendRequest} request  Original request descriptor
   * @param {Router}         router   Backend router
   * @returns {Promise<{ response: { status:number, headers:Record<string,string>, body:Buffer }, metadata: RetryMetadata }>}
   */

  /**
   * Execute a request through the multi-layer retry engine.
   *
   * The returned `metadata` object provides a full audit trail of every
   * attempt made, suitable for SIEM logging.
   *
   * @type {ExecuteFn}
   */
  async function execute(request, router) {
    const overallStart = Date.now();
    /** @type {AttemptRecord[]} */
    const attempts = [];
    /** @type {string[]} */
    const backendsTried = [];
    const counter = { n: 0 };

    let finalResponse = null;
    let finalBackend = request.backendId;
    let finalModel = request.model;
    let usedFallback = false;

    // Collect ordered backends from the router for Layer 3
    const allBackends = typeof router.getBackends === "function"
      ? router.getBackends()
      : [request];

    // -----------------------------------------------------------------------
    // Layer 1: Same backend, progressively reduce tools
    // -----------------------------------------------------------------------
    const l1Cfg = config.layer1;
    const cb1 = getCircuit(request.backendId);

    if (circuitAllows(cb1)) {
      if (!backendsTried.includes(request.backendId)) {
        backendsTried.push(request.backendId);
      }

      let authRefreshedFor401 = false;
      let currentReq = request;

      for (let a = 1; a <= l1Cfg.maxAttempts; a++) {
        // Reduce tools based on attempt count
        const budget = toolBudgetForAttempt(a);
        const reducedTools = typeof router.reduceTools === "function"
          ? router.reduceTools(currentReq, budget)
          : (currentReq.body?.tools ?? []);

        currentReq = typeof router.withReducedTools === "function"
          ? router.withReducedTools(currentReq, reducedTools)
          : currentReq;

        _log(`[retry] L1 attempt=${a} backend=${currentReq.backendId} model=${currentReq.model} tools=${reducedTools.length}`);

        const res = await sendWithRateLimitRetry(currentReq, router, attempts, 1, counter);
        const errClass = res.status < 400 ? null : classifyError(res.status, res.body.toString("utf-8").slice(0, 500));

        if (res.status < 400) {
          // Success
          circuitSuccess(cb1);
          finalResponse = res;
          finalBackend = currentReq.backendId;
          finalModel = currentReq.model;
          break;
        }

        // 401 — attempt auth refresh once
        if (errClass === "auth_error" && !authRefreshedFor401) {
          authRefreshedFor401 = true;
          _log(`[retry] L1 401 — attempting auth refresh for backend=${currentReq.backendId}`);
          const refreshed = await tryRefreshAuth(currentReq.backendId, router);
          if (refreshed) {
            _log(`[retry] L1 auth refreshed — re-trying attempt ${a}`);
            a--; // redo this attempt with fresh token
            continue;
          }
          // Refresh failed — escalate
          circuitFailure(cb1);
          break;
        }

        // bad_payload — reduce tools further; will loop to next attempt
        if (errClass === "bad_payload" && a < l1Cfg.maxAttempts) {
          _log(`[retry] L1 bad_payload — reducing tools and retrying (attempt ${a + 1}/${l1Cfg.maxAttempts})`);
          // Delay before retry (short)
          const delay = jitteredBackoff(a - 1, l1Cfg.baseDelay, l1Cfg.maxDelay);
          if (delay > 0) await sleep(delay);
          continue;
        }

        // rate_limit after internal retries exhausted → let outer layers decide
        if (errClass === "rate_limit") {
          _log(`[retry] L1 rate_limit exhausted for backend=${currentReq.backendId} — escalating`);
          circuitFailure(cb1);
          break;
        }

        // backend_error, overloaded, timeout, network → failover
        if (["backend_error", "overloaded", "timeout", "network"].includes(errClass)) {
          _log(`[retry] L1 ${errClass} — escalating to L2/L3`);
          circuitFailure(cb1);
          break;
        }

        // unknown or non-retriable status
        _log(`[retry] L1 non-retriable status=${res.status} errClass=${errClass}`);
        finalResponse = res;
        finalBackend = currentReq.backendId;
        break;
      }
    } else {
      _log(`[retry] L1 circuit OPEN for backend=${request.backendId} — skipping to L2/L3`);
    }

    if (finalResponse) {
      return _buildResult(finalResponse, attempts, backendsTried, finalBackend, finalModel, usedFallback, overallStart, false);
    }

    // -----------------------------------------------------------------------
    // Layer 2: Same backend, alternate model
    // -----------------------------------------------------------------------
    const l2Cfg = config.layer2;
    const alternateModels = request.alternateModels ?? [];

    if (alternateModels.length > 0 && circuitAllows(cb1)) {
      for (const altModel of alternateModels.slice(0, l2Cfg.maxAttempts)) {
        const altReq = typeof router.withModel === "function"
          ? router.withModel(request, altModel)
          : { ...request, model: altModel };

        _log(`[retry] L2 backend=${altReq.backendId} model=${altModel}`);

        const delay = jitteredBackoff(0, l2Cfg.baseDelay, l2Cfg.maxDelay);
        if (delay > 0) await sleep(delay);

        const res = await sendWithRateLimitRetry(altReq, router, attempts, 2, counter);

        if (res.status < 400) {
          circuitSuccess(cb1);
          finalResponse = res;
          finalBackend = altReq.backendId;
          finalModel = altModel;
          break;
        }

        const errClass = classifyError(res.status, res.body.toString("utf-8").slice(0, 500));
        _log(`[retry] L2 failed status=${res.status} errClass=${errClass}`);

        if (["backend_error", "overloaded", "timeout", "network", "rate_limit"].includes(errClass)) {
          circuitFailure(cb1);
          break;
        }
      }
    }

    if (finalResponse) {
      return _buildResult(finalResponse, attempts, backendsTried, finalBackend, finalModel, usedFallback, overallStart, false);
    }

    // -----------------------------------------------------------------------
    // Layer 3: Failover to next backend
    // -----------------------------------------------------------------------
    const l3Cfg = config.layer3;

    for (const backend of allBackends) {
      if (backend.backendId === request.backendId) continue; // already tried

      const cbN = getCircuit(backend.backendId);
      if (!circuitAllows(cbN)) {
        _log(`[retry] L3 circuit OPEN for backend=${backend.backendId} — skipping`);
        continue;
      }

      if (!backendsTried.includes(backend.backendId)) {
        backendsTried.push(backend.backendId);
      }

      let l3Succeeded = false;

      for (let a = 1; a <= l3Cfg.maxAttempts; a++) {
        // Build a request for this new backend, preserving original body structure
        const failoverReq = {
          ...request,
          backendId: backend.backendId,
          url: backend.url,
          headers: backend.headers ?? request.headers,
          model: backend.model ?? request.model,
        };

        // Reduce tools for the new backend if supported
        const reducedTools = typeof router.reduceTools === "function"
          ? router.reduceTools(failoverReq, toolBudgetForAttempt(a))
          : (failoverReq.body?.tools ?? []);

        const failoverReqWithTools = typeof router.withReducedTools === "function"
          ? router.withReducedTools(failoverReq, reducedTools)
          : failoverReq;

        _log(`[retry] L3 attempt=${a} backend=${failoverReqWithTools.backendId} model=${failoverReqWithTools.model} tools=${reducedTools.length}`);

        const delay = jitteredBackoff(a - 1, l3Cfg.baseDelay, l3Cfg.maxDelay);
        if (delay > 0) await sleep(delay);

        const res = await sendWithRateLimitRetry(failoverReqWithTools, router, attempts, 3, counter);

        if (res.status < 400) {
          circuitSuccess(cbN);
          finalResponse = res;
          finalBackend = failoverReqWithTools.backendId;
          finalModel = failoverReqWithTools.model;
          l3Succeeded = true;
          break;
        }

        const errClass = classifyError(res.status, res.body.toString("utf-8").slice(0, 500));
        _log(`[retry] L3 backend=${backend.backendId} attempt=${a} failed status=${res.status} errClass=${errClass}`);
        circuitFailure(cbN);

        if (!["backend_error", "overloaded", "timeout", "network", "rate_limit"].includes(errClass)) {
          break; // non-retriable on this backend
        }
      }

      if (l3Succeeded) break;
    }

    if (finalResponse) {
      return _buildResult(finalResponse, attempts, backendsTried, finalBackend, finalModel, usedFallback, overallStart, false);
    }

    // -----------------------------------------------------------------------
    // Layer 4: Text-only fallback — strip ALL tools
    // -----------------------------------------------------------------------
    _log(`[retry] L4 text-only fallback — stripping tools on backend=${request.backendId}`);
    usedFallback = true;

    // Try text-only on each backend in priority order until one succeeds
    const l4Cfg = config.layer4;
    const l4Backends = [request, ...allBackends.filter(b => b.backendId !== request.backendId)];

    for (const backend of l4Backends) {
      const cbN = getCircuit(backend.backendId);
      // For L4 we attempt even open circuits — this is truly last resort
      // but we note that we're doing so

      const l4Req = typeof router.withoutTools === "function"
        ? router.withoutTools({ ...request, backendId: backend.backendId, url: backend.url })
        : { ...request, backendId: backend.backendId, url: backend.url, body: { ...request.body, tools: undefined, tool_choice: undefined } };

      _log(`[retry] L4 backend=${l4Req.backendId} model=${l4Req.model} text-only`);

      for (let a = 1; a <= Math.max(1, l4Cfg.maxAttempts); a++) {
        const delay = jitteredBackoff(a - 1, l4Cfg.baseDelay, l4Cfg.maxDelay);
        if (delay > 0) await sleep(delay);

        const res = await sendWithRateLimitRetry(l4Req, router, attempts, 4, counter);

        if (res.status < 400) {
          circuitSuccess(cbN);
          finalResponse = res;
          finalBackend = l4Req.backendId;
          finalModel = l4Req.model;
          break;
        }

        const errClass = classifyError(res.status, res.body.toString("utf-8").slice(0, 500));
        _log(`[retry] L4 backend=${backend.backendId} attempt=${a} failed status=${res.status} errClass=${errClass}`);
        circuitFailure(cbN);
      }

      if (finalResponse) break;
    }

    // If we still have nothing, return the last error response from attempts
    if (!finalResponse) {
      const lastAttempt = attempts[attempts.length - 1];
      _log(`[retry] all layers exhausted — returning synthetic 503`);
      finalResponse = {
        status: 503,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({
          error: {
            message: "All backends exhausted — no successful response after multi-layer retry",
            type: "gateway_error",
            code: "all_backends_failed",
            attempts: attempts.length,
            lastStatus: lastAttempt?.status ?? 0,
          },
        })),
      };
    }

    return _buildResult(finalResponse, attempts, backendsTried, finalBackend, finalModel, usedFallback, overallStart, usedFallback);
  }

  // -------------------------------------------------------------------------
  // Build final result object
  // -------------------------------------------------------------------------

  /**
   * @param {{ status:number, headers:Record<string,string>, body:Buffer }} response
   * @param {AttemptRecord[]} attempts
   * @param {string[]} backendsTried
   * @param {string} finalBackend
   * @param {string} finalModel
   * @param {boolean} usedFallback
   * @param {number} overallStart
   * @param {boolean} fallbackUsed
   * @returns {{ response: object, metadata: RetryMetadata }}
   */
  function _buildResult(response, attempts, backendsTried, finalBackend, finalModel, usedFallback, overallStart, fallbackUsed) {
    /** @type {RetryMetadata} */
    const metadata = {
      totalAttempts: attempts.length,
      totalLatencyMs: Date.now() - overallStart,
      backendsTried: [...backendsTried],
      attempts,
      usedFallback: fallbackUsed,
      succeeded: response.status < 400,
      finalBackend,
      finalModel,
      circuitStatus: getCircuitStatus(),
    };

    return { response, metadata };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    execute,

    /**
     * Expose current circuit breaker state for health endpoints.
     * @returns {Record<string, { state: CircuitState, failures: number, rateLimited: boolean }>}
     */
    getCircuitStatus,

    /**
     * Manually reset the circuit breaker for a backend (e.g. after operator
     * intervention to restore a backend).
     *
     * @param {string} backendId
     */
    resetCircuit(backendId) {
      const cb = circuits.get(backendId);
      if (cb) {
        cb.state = "closed";
        cb.failures = 0;
        _log(`[retry] circuit manually reset for backend=${backendId}`);
      }
    },

    /**
     * Manually clear a rate limit hold for a backend (e.g. for testing or
     * after an operator confirms the backend is no longer rate-limited).
     *
     * @param {string} backendId
     */
    clearRateLimit(backendId) {
      const rl = rateLimits.get(backendId);
      if (rl) {
        rl.retryAfterMs = 0;
        _log(`[retry] rate limit cleared for backend=${backendId}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Internal logging
// ---------------------------------------------------------------------------

/**
 * Lightweight structured logger. Replace with a proper SIEM sink in production.
 * Writing to stderr keeps stdout clean for JSON line output.
 *
 * @param {string} msg
 */
function _log(msg) {
  process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
}
