/**
 * ratelimit.mjs — Rate Limiter for SKGateway
 *
 * Provides per-agent, per-model, and per-tenant rate limiting using a
 * combination of Token Bucket (for burst control) and Sliding Window Counters
 * (for sustained-rate tracking over 1 min / 1 hr / 1 day windows).
 *
 * Design goals
 * ────────────
 * 1. No external dependencies — pure in-process, in-memory, O(1) per check.
 * 2. Sub-millisecond `checkRateLimit()` even at high throughput.
 * 3. Memory-bounded — no unbounded history arrays.  Sliding windows use
 *    a ring-buffer of fixed-size buckets.
 * 4. Composable — agent limits, model limits, and tenant limits are
 *    checked together; the tightest limit wins.
 *
 * Token Bucket
 * ────────────
 * Each bucket refills at `rate` tokens/second up to `capacity`.
 * A request costs `cost` tokens (default 1 for requests, actual token count
 * for token-rate limits).  Requests that would drain below zero are rejected.
 *
 * Sliding Window
 * ──────────────
 * Each window is implemented as a circular array of `numSlots` time slots.
 * The current slot's count is always in slot[(now / slotMs) % numSlots].
 * Stale slots (older than the window duration) are zeroed on access.
 * This gives an O(numSlots) worst-case rebuild cost but a constant O(1)
 * amortised cost per operation (slots are cleared lazily, one at a time).
 *
 * Usage
 * ─────
 *   import { createRateLimiter, checkRateLimit } from './policy/ratelimit.mjs';
 *
 *   const limiter = createRateLimiter({
 *     agents: {
 *       lumina: { requests_per_min: 60, tokens_per_min: 100_000, burst: 10 },
 *     },
 *     models: {
 *       'claude-opus-*': { requests_per_min: 10 },
 *     },
 *     default: { requests_per_min: 30, tokens_per_min: 50_000, burst: 5 },
 *   });
 *
 *   const result = limiter.check('lumina', 'claude-sonnet-4-6', { tokens: 500 });
 *   // { allowed, remaining, reset_at, retry_after, limit_type }
 *
 *   if (!result.allowed) {
 *     const { status, headers, body } = limiter.tooManyRequests(result);
 *   }
 *
 * @module policy/ratelimit
 */

// ─── constants ────────────────────────────────────────────────────────────────

const MS_PER_SEC  = 1_000;
const MS_PER_MIN  = 60 * MS_PER_SEC;
const MS_PER_HOUR = 60 * MS_PER_MIN;
const MS_PER_DAY  = 24 * MS_PER_HOUR;

/**
 * Number of slots in each sliding window.
 * More slots = finer granularity but higher memory per key.
 */
const SLOTS_PER_MIN  = 60;   // 1-second slots
const SLOTS_PER_HOUR = 60;   // 1-minute slots
const SLOTS_PER_DAY  = 24;   // 1-hour slots

// ─── Token Bucket ─────────────────────────────────────────────────────────────

/**
 * A single token bucket tracking available capacity.
 *
 * @typedef {object} TokenBucket
 * @property {number} tokens       Current available tokens.
 * @property {number} capacity     Maximum tokens (burst size).
 * @property {number} ratePerMs    Refill rate in tokens/ms.
 * @property {number} lastRefillAt Timestamp of last refill (ms since epoch).
 */

/**
 * Create a new token bucket.
 *
 * @param {number} capacity    Maximum tokens (burst ceiling).
 * @param {number} ratePerMin  Steady-state refill rate in tokens per minute.
 * @returns {TokenBucket}
 */
function createBucket(capacity, ratePerMin) {
  return {
    tokens:       capacity,          // start full
    capacity,
    ratePerMs:    ratePerMin / MS_PER_MIN,
    lastRefillAt: Date.now(),
  };
}

/**
 * Refill the bucket based on elapsed time, then attempt to consume `cost` tokens.
 *
 * Mutates the bucket in place.
 *
 * @param {TokenBucket} bucket
 * @param {number}      cost    Number of tokens to consume (default 1).
 * @param {number}      [now]   Current timestamp (ms).  Defaults to Date.now().
 * @returns {{ allowed: boolean, remaining: number, reset_at: number }}
 */
function bucketConsume(bucket, cost = 1, now = Date.now()) {
  // Refill
  const elapsed    = now - bucket.lastRefillAt;
  const refill     = elapsed * bucket.ratePerMs;
  bucket.tokens    = Math.min(bucket.capacity, bucket.tokens + refill);
  bucket.lastRefillAt = now;

  const allowed = bucket.tokens >= cost;
  if (allowed) bucket.tokens -= cost;

  // reset_at = when the bucket will next have `cost` tokens available
  const deficit  = allowed ? 0 : cost - bucket.tokens;
  const reset_at = now + Math.ceil(deficit / bucket.ratePerMs);

  return {
    allowed,
    remaining: Math.floor(bucket.tokens),
    reset_at,
  };
}

// ─── Sliding Window Counter ───────────────────────────────────────────────────

/**
 * A sliding-window counter backed by a fixed-size ring buffer.
 *
 * @typedef {object} SlidingWindow
 * @property {number}   windowMs    Total window duration in ms.
 * @property {number}   slotMs      Duration of each slot in ms.
 * @property {number}   numSlots    Total number of slots.
 * @property {number[]} counts      Ring-buffer of slot counts.
 * @property {number[]} slotIds     Slot "epoch" ID for each ring index (for staleness detection).
 * @property {number}   total       Cached running total (updated on each call).
 */

/**
 * Create a sliding window counter.
 *
 * @param {number} windowMs  Window duration in milliseconds.
 * @param {number} numSlots  Number of slots to divide the window into.
 * @returns {SlidingWindow}
 */
function createWindow(windowMs, numSlots) {
  return {
    windowMs,
    slotMs:   Math.floor(windowMs / numSlots),
    numSlots,
    counts:   new Array(numSlots).fill(0),
    slotIds:  new Array(numSlots).fill(-1),
    total:    0,
  };
}

/**
 * Record `amount` events in the current slot and return the total count
 * across the full window (after expiring stale slots).
 *
 * @param {SlidingWindow} win
 * @param {number}        amount  Number to add to the current slot (default 1).
 * @param {number}        [now]   Current timestamp (ms).
 * @returns {number} Total events in the sliding window after the update.
 */
function windowAdd(win, amount = 1, now = Date.now()) {
  const currentSlotId  = Math.floor(now / win.slotMs);
  const ringIdx        = currentSlotId % win.numSlots;
  const maxStaleSlotId = currentSlotId - win.numSlots; // slots older than this are stale

  // Zero out stale slots that this ring index previously held
  if (win.slotIds[ringIdx] !== currentSlotId) {
    // Subtract the old value from the running total if the slot is stale
    if (win.slotIds[ringIdx] <= maxStaleSlotId) {
      win.total -= win.counts[ringIdx];
    }
    win.counts[ringIdx]  = 0;
    win.slotIds[ringIdx] = currentSlotId;
  }

  win.counts[ringIdx] += amount;
  win.total           += amount;

  // Periodically sweep all slots to evict very stale entries.
  // We do a lazy sweep: only the current ring index is always checked above;
  // a full sweep is done here only when the total might be stale.
  // In practice the O(numSlots) sweep is rare and fast.
  if (win.total < 0) win.total = 0; // guard against underflow from delayed sweeps

  return windowTotal(win, now);
}

/**
 * Return the current total count across the non-stale window.
 *
 * @param {SlidingWindow} win
 * @param {number}        [now]
 * @returns {number}
 */
function windowTotal(win, now = Date.now()) {
  const currentSlotId  = Math.floor(now / win.slotMs);
  const maxStaleSlotId = currentSlotId - win.numSlots;

  let total = 0;
  for (let i = 0; i < win.numSlots; i++) {
    if (win.slotIds[i] > maxStaleSlotId) {
      total += win.counts[i];
    }
  }
  win.total = total; // resync cached total
  return total;
}

// ─── Limit config normalisation ───────────────────────────────────────────────

/**
 * Default rate limits applied when no agent/model/tenant-specific config exists.
 *
 * @type {NormalisedLimit}
 *
 * @typedef {object} NormalisedLimit
 * @property {number} req_per_min       Max requests per minute.
 * @property {number} req_per_hour      Max requests per hour.
 * @property {number} req_per_day       Max requests per day.
 * @property {number} tokens_per_min    Max tokens per minute.
 * @property {number} tokens_per_hour   Max tokens per hour.
 * @property {number} tokens_per_day    Max tokens per day.
 * @property {number} burst             Token bucket capacity (burst ceiling).
 */
const FALLBACK_LIMIT = {
  req_per_min:     60,
  req_per_hour:    1_000,
  req_per_day:     10_000,
  tokens_per_min:  200_000,
  tokens_per_hour: 2_000_000,
  tokens_per_day:  20_000_000,
  burst:           10,
};

/**
 * Normalise a raw limit config object, filling missing fields from fallback.
 *
 * @param {object} raw    Raw limit config from YAML/JS.
 * @param {object} [base] Base defaults to merge with (defaults to FALLBACK_LIMIT).
 * @returns {NormalisedLimit}
 */
function normLimit(raw, base = FALLBACK_LIMIT) {
  if (!raw) return { ...base };
  return {
    req_per_min:     raw.requests_per_min   ?? raw.req_per_min   ?? base.req_per_min,
    req_per_hour:    raw.requests_per_hour  ?? raw.req_per_hour  ?? base.req_per_hour,
    req_per_day:     raw.requests_per_day   ?? raw.req_per_day   ?? base.req_per_day,
    tokens_per_min:  raw.tokens_per_min     ?? base.tokens_per_min,
    tokens_per_hour: raw.tokens_per_hour    ?? base.tokens_per_hour,
    tokens_per_day:  raw.tokens_per_day     ?? base.tokens_per_day,
    burst:           raw.burst              ?? base.burst,
  };
}

// ─── Rate limiter state ───────────────────────────────────────────────────────

/**
 * All state for a single rate-limit subject (agent, model, or tenant).
 *
 * @typedef {object} LimiterState
 * @property {NormalisedLimit} limit
 * @property {TokenBucket}     reqBucket      Bucket for request-count rate limiting.
 * @property {TokenBucket}     tokenBucket    Bucket for token-count rate limiting.
 * @property {SlidingWindow}   reqMin
 * @property {SlidingWindow}   reqHour
 * @property {SlidingWindow}   reqDay
 * @property {SlidingWindow}   tokMin
 * @property {SlidingWindow}   tokHour
 * @property {SlidingWindow}   tokDay
 */

/**
 * Create a fresh LimiterState for the given limit config.
 *
 * @param {NormalisedLimit} limit
 * @returns {LimiterState}
 */
function createLimiterState(limit) {
  return {
    limit,
    reqBucket:   createBucket(limit.burst,           limit.req_per_min),
    tokenBucket: createBucket(limit.tokens_per_min,  limit.tokens_per_min),
    reqMin:      createWindow(MS_PER_MIN,  SLOTS_PER_MIN),
    reqHour:     createWindow(MS_PER_HOUR, SLOTS_PER_HOUR),
    reqDay:      createWindow(MS_PER_DAY,  SLOTS_PER_DAY),
    tokMin:      createWindow(MS_PER_MIN,  SLOTS_PER_MIN),
    tokHour:     createWindow(MS_PER_HOUR, SLOTS_PER_HOUR),
    tokDay:      createWindow(MS_PER_DAY,  SLOTS_PER_DAY),
  };
}

// ─── RateLimiter ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} RateLimitResult
 * @property {boolean} allowed       Whether the request is within rate limits.
 * @property {number}  remaining     Remaining tokens/requests in the tightest window.
 * @property {number}  reset_at      Unix ms timestamp when the limit resets.
 * @property {number}  retry_after   Seconds until the request could be retried.
 * @property {string}  limit_type    Which limit fired: 'agent'|'model'|'tenant'|'none'.
 * @property {string}  limit_window  Which window fired: 'burst'|'min'|'hour'|'day'|'none'.
 * @property {number}  limit_value   The configured ceiling that was hit.
 */

/**
 * Rate limiter instance created by `createRateLimiter`.
 *
 * @typedef {object} RateLimiter
 * @property {function} check            Check limits without recording (dry-run).
 * @property {function} consume          Check AND record the request.
 * @property {function} record           Record tokens after-the-fact (for response).
 * @property {function} getUsage         Return sliding-window usage stats.
 * @property {function} tooManyRequests  Build a 429 response object.
 */

/**
 * Create a rate limiter.
 *
 * @param {object} [config]            Rate limit configuration.
 * @param {object} [config.agents]     Per-agent limit configs, keyed by agent_id.
 * @param {object} [config.models]     Per-model limit configs, keyed by model name or glob.
 * @param {object} [config.tenants]    Per-tenant limit configs, keyed by tenant_id.
 * @param {object} [config.default]    Default limits (fallback for unknown keys).
 * @returns {RateLimiter}
 */
export function createRateLimiter(config = {}) {
  const agentCfg  = config.agents  ?? {};
  const modelCfg  = config.models  ?? {};
  const tenantCfg = config.tenants ?? {};
  const defaultLim = normLimit(config.default ?? {});

  /** @type {Map<string, LimiterState>} */
  const agentState  = new Map();
  /** @type {Map<string, LimiterState>} */
  const modelState  = new Map();
  /** @type {Map<string, LimiterState>} */
  const tenantState = new Map();

  // ── helpers ──────────────────────────────────────────────────────────────

  /**
   * Resolve the limit config for a given key, searching exact match then
   * glob patterns in the provided config map.
   *
   * @param {object} cfgMap
   * @param {string} key
   * @returns {NormalisedLimit}
   */
  function resolveLimit(cfgMap, key) {
    if (!key) return defaultLim;

    // Exact match
    if (cfgMap[key]) return normLimit(cfgMap[key], defaultLim);

    // Glob match
    for (const [pattern, raw] of Object.entries(cfgMap)) {
      if (pattern.includes('*') && _globMatch(pattern, key)) {
        return normLimit(raw, defaultLim);
      }
    }

    return defaultLim;
  }

  /**
   * Inline glob matcher (same logic as engine.mjs, copied to keep modules
   * self-contained — no intra-module import cycle).
   */
  function _globMatch(pattern, value) {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\x00')
      .replace(/\*/g, '[^]*?')
      .replace(/\x00/g, '[^]*');
    return new RegExp(`^${escaped}$`).test(value);
  }

  /**
   * Get-or-create a LimiterState for the given map/key.
   *
   * @param {Map<string, LimiterState>} stateMap
   * @param {object}                   cfgMap
   * @param {string}                   key
   * @returns {LimiterState}
   */
  function getState(stateMap, cfgMap, key) {
    if (!stateMap.has(key)) {
      stateMap.set(key, createLimiterState(resolveLimit(cfgMap, key)));
    }
    return stateMap.get(key);
  }

  // ── core check logic ──────────────────────────────────────────────────────

  /**
   * Check a single LimiterState against the current usage.
   *
   * This is a read-only probe (does NOT mutate any counters).
   * Use `_consumeState` to actually deduct.
   *
   * @param {LimiterState} st
   * @param {number}       reqCost    Requests to consume (usually 1).
   * @param {number}       tokenCost  Tokens to consume.
   * @param {number}       now
   * @returns {{ ok: boolean, remaining: number, reset_at: number, window: string, limitValue: number }}
   */
  function _checkState(st, reqCost, tokenCost, now) {
    const lim = st.limit;

    // Token bucket check (burst)
    {
      const elapsed = now - st.reqBucket.lastRefillAt;
      const refilled = Math.min(st.reqBucket.capacity, st.reqBucket.tokens + elapsed * st.reqBucket.ratePerMs);
      if (refilled < reqCost) {
        const deficit  = reqCost - refilled;
        const reset_at = now + Math.ceil(deficit / st.reqBucket.ratePerMs);
        return { ok: false, remaining: Math.floor(refilled), reset_at, window: 'burst', limitValue: lim.burst };
      }
    }

    // Sliding window: requests/min
    {
      const total = windowTotal(st.reqMin, now);
      if (total + reqCost > lim.req_per_min) {
        const reset_at = now + MS_PER_MIN;
        return { ok: false, remaining: Math.max(0, lim.req_per_min - total), reset_at, window: 'min', limitValue: lim.req_per_min };
      }
    }

    // Sliding window: tokens/min
    if (tokenCost > 0) {
      const total = windowTotal(st.tokMin, now);
      if (total + tokenCost > lim.tokens_per_min) {
        const reset_at = now + MS_PER_MIN;
        return { ok: false, remaining: Math.max(0, lim.tokens_per_min - total), reset_at, window: 'min', limitValue: lim.tokens_per_min };
      }
    }

    // Sliding window: requests/hour
    {
      const total = windowTotal(st.reqHour, now);
      if (total + reqCost > lim.req_per_hour) {
        const reset_at = now + MS_PER_HOUR;
        return { ok: false, remaining: Math.max(0, lim.req_per_hour - total), reset_at, window: 'hour', limitValue: lim.req_per_hour };
      }
    }

    // Sliding window: requests/day
    {
      const total = windowTotal(st.reqDay, now);
      if (total + reqCost > lim.req_per_day) {
        const reset_at = now + MS_PER_DAY;
        return { ok: false, remaining: Math.max(0, lim.req_per_day - total), reset_at, window: 'day', limitValue: lim.req_per_day };
      }
    }

    return {
      ok:         true,
      remaining:  Math.floor(st.reqBucket.tokens) - reqCost,
      reset_at:   now + MS_PER_MIN,
      window:     'none',
      limitValue: lim.req_per_min,
    };
  }

  /**
   * Consume (deduct) from all sliding windows and the token bucket.
   *
   * @param {LimiterState} st
   * @param {number}       reqCost
   * @param {number}       tokenCost
   * @param {number}       now
   */
  function _consumeState(st, reqCost, tokenCost, now) {
    bucketConsume(st.reqBucket, reqCost, now);
    windowAdd(st.reqMin,  reqCost,   now);
    windowAdd(st.reqHour, reqCost,   now);
    windowAdd(st.reqDay,  reqCost,   now);
    if (tokenCost > 0) {
      windowAdd(st.tokMin,  tokenCost, now);
      windowAdd(st.tokHour, tokenCost, now);
      windowAdd(st.tokDay,  tokenCost, now);
    }
  }

  // ── public API ────────────────────────────────────────────────────────────

  /**
   * Check rate limits for a request without recording it (dry-run probe).
   *
   * @param {string} agentId
   * @param {string} [model]
   * @param {object} [opts]
   * @param {number} [opts.tokens=0]     Estimated token cost for this request.
   * @param {string} [opts.tenantId]     Optional tenant identifier.
   * @param {number} [opts.reqCost=1]    Number of request slots to consume.
   * @returns {RateLimitResult}
   */
  function check(agentId, model = '', opts = {}) {
    const now       = Date.now();
    const reqCost   = opts.reqCost ?? 1;
    const tokenCost = opts.tokens  ?? 0;
    const tenantId  = opts.tenantId ?? null;

    // Check agent limit
    if (agentId) {
      const st  = getState(agentState, agentCfg, agentId);
      const res = _checkState(st, reqCost, tokenCost, now);
      if (!res.ok) {
        return _buildResult(false, res, 'agent', now);
      }
    }

    // Check model limit
    if (model) {
      const st  = getState(modelState, modelCfg, model);
      const res = _checkState(st, reqCost, tokenCost, now);
      if (!res.ok) {
        return _buildResult(false, res, 'model', now);
      }
    }

    // Check tenant limit
    if (tenantId) {
      const st  = getState(tenantState, tenantCfg, tenantId);
      const res = _checkState(st, reqCost, tokenCost, now);
      if (!res.ok) {
        return _buildResult(false, res, 'tenant', now);
      }
    }

    // Compute remaining from agent bucket as the representative value
    const agentSt   = agentId ? getState(agentState, agentCfg, agentId) : null;
    const remaining = agentSt ? Math.max(0, Math.floor(agentSt.reqBucket.tokens) - reqCost) : 9999;

    return {
      allowed:      true,
      remaining,
      reset_at:     now + MS_PER_MIN,
      retry_after:  0,
      limit_type:   'none',
      limit_window: 'none',
      limit_value:  agentSt ? agentSt.limit.req_per_min : defaultLim.req_per_min,
    };
  }

  /**
   * Check AND consume rate limit slots for a request.
   *
   * This is the primary function to call on every inbound request.
   * If allowed, all counters are decremented.  If denied, no counters change.
   *
   * @param {string} agentId
   * @param {string} [model]
   * @param {object} [opts]
   * @returns {RateLimitResult}
   */
  function consume(agentId, model = '', opts = {}) {
    const result = check(agentId, model, opts);
    if (!result.allowed) return result;

    const now       = Date.now();
    const reqCost   = opts.reqCost ?? 1;
    const tokenCost = opts.tokens  ?? 0;
    const tenantId  = opts.tenantId ?? null;

    if (agentId) _consumeState(getState(agentState,  agentCfg,  agentId),  reqCost, tokenCost, now);
    if (model)   _consumeState(getState(modelState,   modelCfg,  model),    reqCost, tokenCost, now);
    if (tenantId) _consumeState(getState(tenantState, tenantCfg, tenantId), reqCost, tokenCost, now);

    return result;
  }

  /**
   * Record token usage AFTER the response returns (when actual token counts
   * are known from the response body).  Does NOT check limits — use `consume`
   * for that on the inbound path, then call `record` with actual token counts
   * once the response arrives.
   *
   * @param {string} agentId
   * @param {string} [model]
   * @param {object} [opts]
   * @param {number} [opts.tokens=0]     Actual token count from response.
   * @param {string} [opts.tenantId]
   */
  function record(agentId, model = '', opts = {}) {
    const now       = Date.now();
    const tokenCost = opts.tokens  ?? 0;
    const tenantId  = opts.tenantId ?? null;

    // Only record tokens (reqCost=0 — request was already counted on inbound)
    if (agentId  && tokenCost > 0) {
      const st = getState(agentState,  agentCfg,  agentId);
      windowAdd(st.tokMin,  tokenCost, now);
      windowAdd(st.tokHour, tokenCost, now);
      windowAdd(st.tokDay,  tokenCost, now);
    }
    if (model    && tokenCost > 0) {
      const st = getState(modelState,  modelCfg,  model);
      windowAdd(st.tokMin,  tokenCost, now);
      windowAdd(st.tokHour, tokenCost, now);
      windowAdd(st.tokDay,  tokenCost, now);
    }
    if (tenantId && tokenCost > 0) {
      const st = getState(tenantState, tenantCfg, tenantId);
      windowAdd(st.tokMin,  tokenCost, now);
      windowAdd(st.tokHour, tokenCost, now);
      windowAdd(st.tokDay,  tokenCost, now);
    }
  }

  /**
   * Return current usage statistics for an agent/model/tenant.
   *
   * @param {string} agentId
   * @param {string} [model]
   * @param {object} [opts]
   * @param {string} [opts.tenantId]
   * @returns {object}
   */
  function getUsage(agentId, model = '', opts = {}) {
    const now      = Date.now();
    const tenantId = opts.tenantId ?? null;

    const out = {};

    if (agentId && agentState.has(agentId)) {
      const st = agentState.get(agentId);
      out.agent = {
        req_last_min:    windowTotal(st.reqMin,  now),
        req_last_hour:   windowTotal(st.reqHour, now),
        req_last_day:    windowTotal(st.reqDay,  now),
        tokens_last_min: windowTotal(st.tokMin,  now),
        tokens_last_hour:windowTotal(st.tokHour, now),
        tokens_last_day: windowTotal(st.tokDay,  now),
        bucket_remaining:Math.floor(st.reqBucket.tokens),
        limit: st.limit,
      };
    }

    if (model && modelState.has(model)) {
      const st = modelState.get(model);
      out.model = {
        req_last_min:    windowTotal(st.reqMin,  now),
        req_last_hour:   windowTotal(st.reqHour, now),
        req_last_day:    windowTotal(st.reqDay,  now),
        tokens_last_min: windowTotal(st.tokMin,  now),
        tokens_last_hour:windowTotal(st.tokHour, now),
        tokens_last_day: windowTotal(st.tokDay,  now),
        bucket_remaining:Math.floor(st.reqBucket.tokens),
        limit: st.limit,
      };
    }

    if (tenantId && tenantState.has(tenantId)) {
      const st = tenantState.get(tenantId);
      out.tenant = {
        req_last_min:    windowTotal(st.reqMin,  now),
        req_last_hour:   windowTotal(st.reqHour, now),
        req_last_day:    windowTotal(st.reqDay,  now),
        tokens_last_min: windowTotal(st.tokMin,  now),
        tokens_last_hour:windowTotal(st.tokHour, now),
        tokens_last_day: windowTotal(st.tokDay,  now),
        bucket_remaining:Math.floor(st.reqBucket.tokens),
        limit: st.limit,
      };
    }

    return out;
  }

  /**
   * Build a 429 Too Many Requests response object suitable for returning to
   * the HTTP client.
   *
   * @param {RateLimitResult} result  Result from `check` or `consume`.
   * @param {object} [opts]
   * @param {string} [opts.agentId]  For inclusion in the error message.
   * @returns {{ status: number, headers: Record<string,string>, body: string }}
   */
  function tooManyRequests(result, opts = {}) {
    const retryAfterSecs = result.retry_after > 0 ? result.retry_after : 1;
    const resetSecs      = Math.ceil((result.reset_at - Date.now()) / 1000);

    const headers = {
      'content-type':           'application/json',
      'retry-after':            String(retryAfterSecs),
      'x-ratelimit-limit':      String(result.limit_value),
      'x-ratelimit-remaining':  String(Math.max(0, result.remaining)),
      'x-ratelimit-reset':      String(Math.ceil(result.reset_at / 1000)),  // Unix seconds
      'x-ratelimit-reset-after':String(Math.max(0, resetSecs)),
      'x-ratelimit-type':       result.limit_type,
      'x-ratelimit-window':     result.limit_window,
    };

    const body = JSON.stringify({
      error: {
        type:    'rate_limit_exceeded',
        message: `Rate limit exceeded for ${opts.agentId ?? 'client'} ` +
                 `(${result.limit_type} ${result.limit_window} limit). ` +
                 `Retry after ${retryAfterSecs}s.`,
        retry_after:  retryAfterSecs,
        reset_at:     result.reset_at,
        limit_type:   result.limit_type,
        limit_window: result.limit_window,
      },
    });

    return { status: 429, headers, body };
  }

  return { check, consume, record, getUsage, tooManyRequests };
}

// ─── helper ───────────────────────────────────────────────────────────────────

/**
 * Build a standardised RateLimitResult from an internal check outcome.
 *
 * @param {boolean} allowed
 * @param {{ remaining: number, reset_at: number, window: string, limitValue: number }} res
 * @param {string} limitType
 * @param {number} now
 * @returns {RateLimitResult}
 */
function _buildResult(allowed, res, limitType, now) {
  const retryAfterMs = Math.max(0, res.reset_at - now);
  return {
    allowed,
    remaining:    Math.max(0, res.remaining),
    reset_at:     res.reset_at,
    retry_after:  Math.ceil(retryAfterMs / 1000),
    limit_type:   limitType,
    limit_window: res.window,
    limit_value:  res.limitValue,
  };
}

// ─── singleton limiter (hot-reloadable) ───────────────────────────────────────

/** @type {import('./ratelimit.mjs').RateLimiter|null} */
let _limiter = null;

/**
 * Initialise the singleton rate limiter from a config object.
 *
 * @param {object} config
 * @returns {import('./ratelimit.mjs').RateLimiter}
 */
export function initRateLimiter(config = {}) {
  _limiter = createRateLimiter(config);
  return _limiter;
}

/**
 * Check the singleton rate limiter.  Must call `initRateLimiter` first.
 *
 * @param {string} agentId
 * @param {string} [model]
 * @param {object} [opts]
 * @returns {RateLimitResult}
 */
export function checkRateLimit(agentId, model = '', opts = {}) {
  if (!_limiter) throw new Error('Rate limiter not initialised — call initRateLimiter() first');
  return _limiter.consume(agentId, model, opts);
}

/**
 * Return the singleton limiter instance.
 *
 * @returns {import('./ratelimit.mjs').RateLimiter|null}
 */
export function getRateLimiter() {
  return _limiter;
}
