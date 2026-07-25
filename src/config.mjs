/**
 * config.mjs — YAML config loader for SKGateway
 *
 * Responsibilities
 * ────────────────
 * 1. Load `config/skgateway.yaml` (or the path set by SKGATEWAY_CONFIG).
 * 2. Deep-merge with hard-coded defaults so missing keys are always present.
 * 3. Apply environment-variable overrides (SKGATEWAY_PORT, SKGATEWAY_TARGET, …).
 * 4. Validate the merged config; throw a descriptive error on bad values.
 * 5. Listen for SIGHUP and hot-reload the file, emitting 'config-changed'.
 *
 * Usage
 * ─────
 *   import { loadConfig, getConfig } from './config.mjs';
 *
 *   const cfg = await loadConfig();           // first call — reads file
 *   cfg.on('config-changed', (newCfg) => {…}); // optional live updates
 *   const port = getConfig().server.port;      // sync access after load
 *
 * @module config
 */

import { EventEmitter } from 'node:events';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { load as yamlLoad } from 'js-yaml';

// ─── paths ────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

/**
 * Resolve `~` in a path string to the real home directory.
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (typeof p !== 'string') return p;
  return p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : p;
}

// ─── defaults ─────────────────────────────────────────────────────────────────

/** @type {import('./config-types.d.ts').GatewayConfig} */
const DEFAULTS = {
  server: {
    port: 18780,
    dashboard_port: 18781,
    bind: '0.0.0.0',
  },

  backends: {
    nvidia: {
      url: 'https://integrate.api.nvidia.com/v1',
      auth_type: 'api_key',
      api_key_env: 'NVIDIA_API_KEY',
      models: ['moonshotai/kimi-k2.6', 'minimaxai/minimax-m2.7'],
      priority: 1,
    },
    anthropic: {
      url: 'https://api.anthropic.com/v1',
      auth_type: 'oauth',
      credentials_path: '~/.claude/.credentials.json',
      models: ['claude-opus-4-6', 'claude-sonnet-4-6'],
      priority: 2,
    },
    ollama: {
      url: 'http://192.168.0.100:11434/v1',
      auth_type: 'none',
      models: ['dolphin-*'],
      priority: 3,
    },
    openrouter: {
      url: 'https://openrouter.ai/api/v1',
      auth_type: 'api_key',
      api_key_env: 'OPENROUTER_API_KEY',
      discovery: 'free', // free | all
      max_concurrent: 10,
    },
  },

  tools: {
    guaranteed: ['exec', 'read', 'write', 'edit', 'message'],
    max_budget: 16,
    fallback_budget: 8,
    call_limit: 10,
  },

  sanitizer: {
    max_system_bytes: 40_000,
    max_body_bytes: 120_000,
    keep_start: 2,
    keep_end: 12,
    strip_thinking: true,
  },

  // Streaming → non-streaming auto-flip for upstream stability on large /
  // tool-heavy turns.  Independent of the tool-request path (which always
  // buffers upstream).  Used by shouldForceNonStream() in the classifier.
  streaming: {
    default: true,
    force_header: 'x-skgateway-nonstream',   // value 'force' or '1' triggers
    auto_nonstream: {
      enabled: true,
      trigger_if_body_bytes_ge: 40_000,      // ~10k tokens
      trigger_if_messages_ge: 6,
      trigger_if_tool_call_history_ge: 3,    // tool_call messages in history
      aggressive_models: [                   // match via includes() on model name
        'moonshotai/kimi-k2.6',
        'deepseek-ai/deepseek-v4',
        'qwen/qwen3-next',
      ],
    },
  },

  metrics: {
    enabled: true,
    db_path: './data/metrics.db',
    retention_days: 90,
    token_tracking: true,
    cost_tracking: true,
    pricing: {
      'claude-opus-4-7': { input: 15.00, output: 75.00, cache_read: 1.50, cache_write: 3.75 },
      'claude-sonnet-4-6': { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 0.375 },
      'claude-haiku-4-5': { input: 0.80, output: 4.00, cache_read: 0.08, cache_write: 0.10 },
      'moonshotai/kimi-k2.6': { input: 0, output: 0 },
      'minimaxai/minimax-m2.7': { input: 0, output: 0 },
      'default_local': { input: 0, output: 0 },
    },
  },

  siem: {
    enabled: true,
    outputs: [
      { type: 'file', path: './logs/audit.jsonl', rotate_mb: 100 },
    ],
  },

  // Prompt classification engine (SKGateway P3.5). PASSIVE observability: labels
  // each request's intent/risk/jailbreak/injection and emits a `prompt.classified`
  // SIEM event. Deterministic keyword/regex — no network, sub-10ms — so it is safe
  // on the hot path. It never changes routing (that is the sk-auto DIFFICULTY
  // router's job); `gate` is a reserved forward-compat flag and defaults OFF so
  // classification can never block or reroute a request.
  //   enabled    — run the engine + emit SIEM labels (default true; pure observability)
  //   classifier — registered classifier name to use (default "heuristic")
  //   gate       — RESERVED: allow labels to influence routing/policy (default false)
  classification: {
    enabled: true,
    classifier: 'heuristic',
    gate: false,
  },

  dashboard: {
    enabled: true,
    refresh_ms: 5_000,
  },

  // Dead-alias auto-quarantine (SKGateway card 2d1f3a2c). Complements the
  // router's error-rate health machine + SPOF failover with a faster
  // CONSECUTIVE-failure trip: a backend alias that fails `threshold` requests in
  // a row is pulled OUT of rotation for `cooldown_ms`, after which one probe is
  // admitted; a success re-admits it. Quarantine + re-admit emit SIEM events.
  // Applied as the fleet-wide default; per-backend `quarantine_threshold` /
  // `quarantine_cooldown_ms` override it. threshold 0 disables the layer.
  quarantine: {
    threshold: 5,
    cooldown_ms: 30_000,
  },

  // Per-agent model routing rules (SKGateway P4.3, card 45509bf5). Maps a
  // resolved agent identity to a pinned routing target that overrides the model
  // the caller asked for. The target is either a concrete model id or an
  // alias/role the skmodels registry resolves (e.g. "sk-default", "ornith-tiny").
  // Explicit x-sk-context / x-sk-service / x-sk-role headers still win; only the
  // model field is pinned. Empty map = no rules, routing behaviour unchanged.
  //   per_agent: { <agent-id>: <model-or-alias> } (agent ids are case-insensitive)
  //
  // strict_targets: PROVIDER-ROUTE ASSERTION (card 7ec1d18a). When true
  // (default), the boot + reload config validation fails fast if any per_agent
  // routing target is a dangling reference: neither an sk-* registry alias nor a
  // model served by a declared backend. Set false to allow targets that only a
  // live skmodels registry role-key resolves (validated at first request instead).
  routing: {
    per_agent: {},
    strict_targets: true,
  },

  // CapAuth agent-identity (SKGateway P2.1). Every /v1/* request is resolved to
  // a verified agent identity used for routing / metrics / SIEM audit.
  //   allow_anonymous     — resolve unidentified callers to "anonymous" (default true)
  //   require_agent_id     — AUTH GATE: reject anonymous requests with 403. OFF by
  //                          default so the hot path is never blocked unless opted in.
  //   default_agent        — registry entry used for anonymous callers (or null)
  //   agents_dir           — override for ~/.skcapstone/agents discovery
  identity: {
    enabled: true,
    allow_anonymous: true,
    require_agent_id: false,
  },

  // Dynamic provider model discovery (SKGateway dynamic-provider-model-discovery).
  // Periodically queries each declared backend's model-list endpoint and folds
  // newly seen models into the effective model set, instead of relying solely
  // on the static `models` arrays above.
  //   enabled: run the discovery poller (default true)
  //   refresh_seconds: how often to re-poll each provider (default 3600 = 1h)
  //   providers.<name>.enabled: include this provider in discovery
  //   providers.<name>.free_only: keep only models with zero listed cost
  //   providers.<name>.chat_only: drop non-chat-completions model types
  discovery: {
    enabled: true,
    refresh_seconds: 3600,
    providers: {
      nvidia: { enabled: true, free_only: true, chat_only: true },
      openrouter: { enabled: true, free_only: true, chat_only: true },
    },
  },
};

// ─── deep merge ───────────────────────────────────────────────────────────────

/**
 * Recursively merge `src` into `target`.  Arrays in `src` replace (not concat)
 * arrays in `target` so list overrides work intuitively.
 *
 * @param {object} target
 * @param {object} src
 * @returns {object} mutated `target`
 */
function deepMerge(target, src) {
  if (!src || typeof src !== 'object') return target;
  for (const [key, val] of Object.entries(src)) {
    if (
      val !== null &&
      typeof val === 'object' &&
      !Array.isArray(val) &&
      typeof target[key] === 'object' &&
      target[key] !== null &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

/**
 * Produce a deep clone of a plain object/array tree (no functions, Buffers, etc.).
 * @template T
 * @param {T} obj
 * @returns {T}
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ─── env overrides ────────────────────────────────────────────────────────────

/**
 * Apply well-known SKGATEWAY_* environment variables onto a merged config.
 *
 * | Env var                  | Config path               |
 * |--------------------------|---------------------------|
 * | SKGATEWAY_PORT           | server.port               |
 * | SKGATEWAY_DASHBOARD_PORT | server.dashboard_port     |
 * | SKGATEWAY_BIND           | server.bind               |
 * | SKGATEWAY_TARGET         | backends.nvidia.url       |
 * | SKGATEWAY_NVIDIA_KEY_ENV | backends.nvidia.api_key_env |
 * | SKGATEWAY_METRICS_DB     | metrics.db_path           |
 * | SKGATEWAY_RETENTION_DAYS | metrics.retention_days    |
 * | SKGATEWAY_SYSLOG_ENABLED | siem syslog output (on/off) |
 * | SKGATEWAY_SYSLOG_HOST    | syslog output host        |
 * | SKGATEWAY_SYSLOG_PORT    | syslog output port        |
 * | SKGATEWAY_SYSLOG_PROTOCOL| syslog transport (udp/tcp/tls/unix) |
 * | SKGATEWAY_SYSLOG_FACILITY| syslog facility (0-23)    |
 * | SKGATEWAY_SYSLOG_FORMAT  | syslog MSG format (cef/json) |
 * | SKGATEWAY_ES_ENABLED     | siem elasticsearch output (on/off) |
 * | SKGATEWAY_ES_ENDPOINT    | ES/OpenSearch base URL    |
 * | SKGATEWAY_ES_INDEX       | ES index name (may use %DATE%) |
 * | SKGATEWAY_ES_BATCH_SIZE  | ES bulk batch size        |
 * | SKGATEWAY_ES_FLUSH_MS    | ES flush interval (ms)    |
 * | SKGATEWAY_ES_API_KEY_ENV | NAME of env var holding an ES API key |
 * | SKGATEWAY_ES_BEARER_TOKEN_ENV | NAME of env var holding a bearer token |
 * | SKGATEWAY_ES_AUTH_HEADER_ENV  | NAME of env var holding a raw Authorization value |
 *
 * @param {object} cfg  Mutable merged config object.
 * @returns {object} Same object, mutated in place.
 */
function applyEnvOverrides(cfg) {
  const e = process.env;

  if (e.SKGATEWAY_PORT)           cfg.server.port            = Number(e.SKGATEWAY_PORT);
  if (e.SKGATEWAY_DASHBOARD_PORT) cfg.server.dashboard_port  = Number(e.SKGATEWAY_DASHBOARD_PORT);
  if (e.SKGATEWAY_BIND)           cfg.server.bind            = e.SKGATEWAY_BIND;
  if (e.SKGATEWAY_TARGET)         cfg.backends.nvidia.url    = e.SKGATEWAY_TARGET;
  if (e.SKGATEWAY_NVIDIA_KEY_ENV) cfg.backends.nvidia.api_key_env = e.SKGATEWAY_NVIDIA_KEY_ENV;
  if (e.SKGATEWAY_METRICS_DB)     cfg.metrics.db_path        = e.SKGATEWAY_METRICS_DB;
  if (e.SKGATEWAY_RETENTION_DAYS) cfg.metrics.retention_days = Number(e.SKGATEWAY_RETENTION_DAYS);

  applySyslogEnv(cfg, e);
  applyElasticsearchEnv(cfg, e);

  return cfg;
}

/**
 * Merge SKGATEWAY_SYSLOG_* environment variables into the SIEM syslog output.
 *
 * The syslog sink is DISABLED by default: it only becomes active when either a
 * `type: syslog` output is present in the YAML with `enabled: true`, or
 * `SKGATEWAY_SYSLOG_ENABLED` is set to a truthy value. Env values update the
 * first existing syslog output (creating one if none exists) so operators can
 * turn it on without editing the YAML.
 *
 * @param {object} cfg
 * @param {Record<string,string|undefined>} e  process.env
 */
function applySyslogEnv(cfg, e) {
  const touched =
    e.SKGATEWAY_SYSLOG_ENABLED  !== undefined ||
    e.SKGATEWAY_SYSLOG_HOST     !== undefined ||
    e.SKGATEWAY_SYSLOG_PORT     !== undefined ||
    e.SKGATEWAY_SYSLOG_PROTOCOL !== undefined ||
    e.SKGATEWAY_SYSLOG_FACILITY !== undefined ||
    e.SKGATEWAY_SYSLOG_FORMAT   !== undefined;

  if (!touched) return;

  cfg.siem = cfg.siem ?? {};
  cfg.siem.outputs = Array.isArray(cfg.siem.outputs) ? cfg.siem.outputs : [];

  let sink = cfg.siem.outputs.find((o) => o && o.type === 'syslog');
  if (!sink) {
    sink = { type: 'syslog' };
    cfg.siem.outputs.push(sink);
  }

  if (e.SKGATEWAY_SYSLOG_ENABLED !== undefined) {
    sink.enabled = /^(1|true|yes|on)$/i.test(e.SKGATEWAY_SYSLOG_ENABLED);
  }
  if (e.SKGATEWAY_SYSLOG_HOST     !== undefined) sink.host     = e.SKGATEWAY_SYSLOG_HOST;
  if (e.SKGATEWAY_SYSLOG_PORT     !== undefined) sink.port     = Number(e.SKGATEWAY_SYSLOG_PORT);
  if (e.SKGATEWAY_SYSLOG_PROTOCOL !== undefined) sink.protocol = e.SKGATEWAY_SYSLOG_PROTOCOL;
  if (e.SKGATEWAY_SYSLOG_FACILITY !== undefined) sink.facility = Number(e.SKGATEWAY_SYSLOG_FACILITY);
  if (e.SKGATEWAY_SYSLOG_FORMAT   !== undefined) sink.format   = e.SKGATEWAY_SYSLOG_FORMAT;
}

/**
 * Merge SKGATEWAY_ES_* environment variables into the SIEM Elasticsearch /
 * OpenSearch output.
 *
 * The ES sink is DISABLED by default: it only becomes active when either a
 * `type: elasticsearch` (or `opensearch`) output is present in the YAML with
 * `enabled: true` and an endpoint, or `SKGATEWAY_ES_ENABLED` is set truthy with
 * an endpoint. Env values update the first existing ES/OpenSearch output
 * (creating one if none exists) so operators can turn it on without editing the
 * YAML.
 *
 * NOTE: `SKGATEWAY_ES_API_KEY_ENV` / `SKGATEWAY_ES_BEARER_TOKEN_ENV` /
 * `SKGATEWAY_ES_AUTH_HEADER_ENV` carry the NAME of another env var that holds the
 * secret, never the secret itself. This keeps credentials out of config.
 *
 * @param {object} cfg
 * @param {Record<string,string|undefined>} e  process.env
 */
function applyElasticsearchEnv(cfg, e) {
  const touched =
    e.SKGATEWAY_ES_ENABLED         !== undefined ||
    e.SKGATEWAY_ES_ENDPOINT        !== undefined ||
    e.SKGATEWAY_ES_INDEX           !== undefined ||
    e.SKGATEWAY_ES_BATCH_SIZE      !== undefined ||
    e.SKGATEWAY_ES_FLUSH_MS        !== undefined ||
    e.SKGATEWAY_ES_API_KEY_ENV     !== undefined ||
    e.SKGATEWAY_ES_BEARER_TOKEN_ENV !== undefined ||
    e.SKGATEWAY_ES_AUTH_HEADER_ENV !== undefined;

  if (!touched) return;

  cfg.siem = cfg.siem ?? {};
  cfg.siem.outputs = Array.isArray(cfg.siem.outputs) ? cfg.siem.outputs : [];

  let sink = cfg.siem.outputs.find(
    (o) => o && (o.type === 'elasticsearch' || o.type === 'opensearch'),
  );
  if (!sink) {
    sink = { type: 'elasticsearch' };
    cfg.siem.outputs.push(sink);
  }

  if (e.SKGATEWAY_ES_ENABLED !== undefined) {
    sink.enabled = /^(1|true|yes|on)$/i.test(e.SKGATEWAY_ES_ENABLED);
  }
  if (e.SKGATEWAY_ES_ENDPOINT         !== undefined) sink.endpoint         = e.SKGATEWAY_ES_ENDPOINT;
  if (e.SKGATEWAY_ES_INDEX            !== undefined) sink.index            = e.SKGATEWAY_ES_INDEX;
  if (e.SKGATEWAY_ES_BATCH_SIZE       !== undefined) sink.batch_size       = Number(e.SKGATEWAY_ES_BATCH_SIZE);
  if (e.SKGATEWAY_ES_FLUSH_MS         !== undefined) sink.flush_ms         = Number(e.SKGATEWAY_ES_FLUSH_MS);
  if (e.SKGATEWAY_ES_API_KEY_ENV      !== undefined) sink.api_key_env      = e.SKGATEWAY_ES_API_KEY_ENV;
  if (e.SKGATEWAY_ES_BEARER_TOKEN_ENV !== undefined) sink.bearer_token_env = e.SKGATEWAY_ES_BEARER_TOKEN_ENV;
  if (e.SKGATEWAY_ES_AUTH_HEADER_ENV  !== undefined) sink.auth_header_env  = e.SKGATEWAY_ES_AUTH_HEADER_ENV;
}

// ─── validation ───────────────────────────────────────────────────────────────

const VALID_AUTH_TYPES = new Set(['api_key', 'oauth', 'bearer', 'none']);

/**
 * Test whether a model id matches a backend `models` pattern. Patterns may use
 * `*` as a wildcard (e.g. "dolphin-*"); an exact match is also accepted. Mirrors
 * the router's modelMatches() so the boot assertion agrees with live routing.
 *
 * @param {string} pattern
 * @param {string} model
 * @returns {boolean}
 */
function modelMatchesPattern(pattern, model) {
  if (!pattern || !model) return false;
  if (pattern === model) return true;
  const reStr = '^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
  return new RegExp(reStr, 'i').test(model);
}

/**
 * Provider-route consistency assertion (card 7ec1d18a).
 *
 * Runs at boot AND on every SIGHUP reload (both flow through validate()). Catches
 * a mis-wired provider route immediately (fail fast) instead of at first request:
 *
 *   1. auth completeness: a backend whose route can never authenticate is dead.
 *        oauth            requires credentials_path / credentials_file
 *        api_key | bearer requires api_key or api_key_env
 *   2. pooling.per_backend: every per-backend concurrency limit must name a
 *      declared backend (a limit on a nonexistent provider is dead config).
 *   3. routing.per_agent: every pinned target must resolve to a known route,
 *      an sk-* registry alias, or a model served by at least one declared
 *      backend. A dangling target (typo'd model / removed backend) is rejected.
 *      Gated by routing.strict_targets (default true) so registry-only role-keys
 *      can opt out with strict_targets: false.
 *
 * Problems are appended to `errs`; the caller (validate) throws a single
 * ConfigError naming every bad route. Non-breaking for a valid config.
 *
 * Exposed for testing so the assertion can be exercised directly; it is also
 * invoked by validate() on every boot + reload.
 *
 * @param {object}   cfg
 * @param {string[]} [errs]  Mutable error accumulator (created if omitted).
 * @returns {string[]} The accumulated problems (empty when the routes are valid).
 */
export function assertProviderRoutes(cfg, errs = []) {
  const backends = (cfg.backends && typeof cfg.backends === 'object') ? cfg.backends : {};
  const backendIds = new Set(Object.keys(backends));

  // 1. Auth completeness per backend: a route that can never authenticate is a
  //    misconfiguration best caught at boot, not at the first 401/empty-header.
  for (const [name, backend] of Object.entries(backends)) {
    if (!backend || typeof backend !== 'object') continue;
    const auth = backend.auth_type;
    if (auth === 'oauth' && !backend.credentials_path && !backend.credentials_file) {
      errs.push(`backends.${name}.auth_type is "oauth" but no credentials_path/credentials_file is set`);
    }
    if ((auth === 'api_key' || auth === 'bearer') && !backend.api_key && !backend.api_key_env) {
      errs.push(`backends.${name}.auth_type is "${auth}" but neither api_key nor api_key_env is set`);
    }
  }

  // 2. pooling.per_backend keys must reference a declared backend.
  const perBackend = cfg.pooling && typeof cfg.pooling === 'object' ? cfg.pooling.per_backend : null;
  if (perBackend && typeof perBackend === 'object') {
    for (const id of Object.keys(perBackend)) {
      if (!backendIds.has(id)) {
        errs.push(
          `pooling.per_backend.${id} references an unknown backend ` +
          `(declared backends: ${[...backendIds].join(', ') || 'none'})`,
        );
      }
    }
  }

  // 3. routing.per_agent targets must resolve to a known route.
  const routing = cfg.routing && typeof cfg.routing === 'object' ? cfg.routing : {};
  const strict = routing.strict_targets !== false; // default strict
  const perAgent = routing.per_agent || routing.perAgent;
  if (strict && perAgent && typeof perAgent === 'object') {
    // A target resolves if it is an sk-* alias or is served by a declared backend.
    const servedByBackend = (target) => {
      for (const backend of Object.values(backends)) {
        const models = Array.isArray(backend?.models) ? backend.models : [];
        if (models.some((pat) => modelMatchesPattern(pat, target))) return true;
      }
      return false;
    };
    for (const [agent, target] of Object.entries(perAgent)) {
      if (typeof target !== 'string' || !target.trim()) continue; // router drops these
      const t = target.trim();
      if (t.startsWith('sk-')) continue;           // registry alias, resolved live
      if (servedByBackend(t)) continue;             // concrete model on a backend
      errs.push(
        `routing.per_agent.${agent} -> "${t}" is a dangling route: no declared ` +
        `backend serves it and it is not an sk-* alias ` +
        `(set routing.strict_targets: false to allow a registry-only role-key)`,
      );
    }
  }

  return errs;
}

/**
 * Throw a descriptive ConfigError if the merged config has obviously bad values.
 * This is intentionally lenient — it catches mis-types and clearly wrong values
 * rather than attempting a full JSON-Schema style validation.
 *
 * @param {object} cfg
 * @throws {ConfigError}
 */
function validate(cfg) {
  const errs = [];

  // server
  if (!Number.isInteger(cfg.server.port) || cfg.server.port < 1 || cfg.server.port > 65535)
    errs.push(`server.port must be 1–65535 (got ${cfg.server.port})`);
  if (!Number.isInteger(cfg.server.dashboard_port) || cfg.server.dashboard_port < 1 || cfg.server.dashboard_port > 65535)
    errs.push(`server.dashboard_port must be 1–65535 (got ${cfg.server.dashboard_port})`);
  if (cfg.server.port === cfg.server.dashboard_port)
    errs.push('server.port and server.dashboard_port must be different');
  if (typeof cfg.server.bind !== 'string')
    errs.push('server.bind must be a string');

  // backends
  if (!cfg.backends || typeof cfg.backends !== 'object')
    errs.push('backends must be an object');
  else {
    for (const [name, backend] of Object.entries(cfg.backends)) {
      if (!backend.url || typeof backend.url !== 'string')
        errs.push(`backends.${name}.url must be a non-empty string`);
      if (!VALID_AUTH_TYPES.has(backend.auth_type))
        errs.push(`backends.${name}.auth_type must be one of: ${[...VALID_AUTH_TYPES].join(', ')}`);
      // Discovery-driven backends (e.g. openrouter) intentionally have no
      // static `models` list, their catalog is populated at runtime by
      // discovery.mjs. Backend.matches() already treats an empty models list
      // as "accept everything", and Backend defaults a missing priority to
      // 99, so skip both checks for them rather than forcing a fake list.
      if (!backend.discovery) {
        if (!Array.isArray(backend.models) || backend.models.length === 0)
          errs.push(`backends.${name}.models must be a non-empty array`);
        if (!Number.isInteger(backend.priority) || backend.priority < 1)
          errs.push(`backends.${name}.priority must be a positive integer`);
      }
    }
  }

  // tools
  if (!Array.isArray(cfg.tools.guaranteed))
    errs.push('tools.guaranteed must be an array');
  if (!Number.isInteger(cfg.tools.max_budget) || cfg.tools.max_budget < 1)
    errs.push('tools.max_budget must be a positive integer');
  if (!Number.isInteger(cfg.tools.fallback_budget) || cfg.tools.fallback_budget < 1)
    errs.push('tools.fallback_budget must be a positive integer');
  if (cfg.tools.fallback_budget > cfg.tools.max_budget)
    errs.push('tools.fallback_budget must be <= tools.max_budget');
  if (!Number.isInteger(cfg.tools.call_limit) || cfg.tools.call_limit < 1)
    errs.push('tools.call_limit must be a positive integer');

  // sanitizer
  if (typeof cfg.sanitizer.max_system_bytes !== 'number' || cfg.sanitizer.max_system_bytes < 1)
    errs.push('sanitizer.max_system_bytes must be a positive number');
  if (typeof cfg.sanitizer.max_body_bytes !== 'number' || cfg.sanitizer.max_body_bytes < 1)
    errs.push('sanitizer.max_body_bytes must be a positive number');

  // metrics
  if (typeof cfg.metrics.enabled !== 'boolean')
    errs.push('metrics.enabled must be a boolean');
  if (typeof cfg.metrics.db_path !== 'string' || !cfg.metrics.db_path)
    errs.push('metrics.db_path must be a non-empty string');
  if (!Number.isInteger(cfg.metrics.retention_days) || cfg.metrics.retention_days < 1)
    errs.push('metrics.retention_days must be a positive integer');

  // dashboard
  if (typeof cfg.dashboard.refresh_ms !== 'number' || cfg.dashboard.refresh_ms < 100)
    errs.push('dashboard.refresh_ms must be >= 100');

  // Provider-route consistency (card 7ec1d18a): assert routes map to known
  // backends / resolvable aliases at boot AND reload, so a mis-wired route fails
  // fast here rather than silently mis-routing at first request.
  assertProviderRoutes(cfg, errs);

  if (errs.length) throw new ConfigError(errs);
}

/** @extends {Error} */
class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Config validation failed:\n  • ${problems.join('\n  • ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

// ─── post-process ─────────────────────────────────────────────────────────────

/**
 * Resolve relative paths inside the config to absolute paths anchored at the
 * repo root (or expand `~` for home-relative paths).
 *
 * @param {object} cfg  Mutable config.
 * @returns {object}
 */
function resolvePaths(cfg) {
  // metrics.db_path
  if (cfg.metrics.db_path) {
    cfg.metrics.db_path = cfg.metrics.db_path.startsWith('~')
      ? expandHome(cfg.metrics.db_path)
      : resolve(REPO_ROOT, cfg.metrics.db_path);
  }

  // siem output paths
  for (const out of (cfg.siem?.outputs ?? [])) {
    if (out.path) {
      out.path = out.path.startsWith('~')
        ? expandHome(out.path)
        : resolve(REPO_ROOT, out.path);
    }
  }

  // backend credentials paths
  for (const backend of Object.values(cfg.backends ?? {})) {
    if (backend.credentials_path) {
      backend.credentials_path = expandHome(backend.credentials_path);
    }
  }

  return cfg;
}

// ─── singleton state ──────────────────────────────────────────────────────────

/** Singleton EventEmitter that broadcasts config-changed events. */
const emitter = new EventEmitter();

/** Currently active (validated, resolved) config. */
let _current = null;

/** Absolute path of the config file being watched. */
let _configFilePath = null;

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Load, merge, validate and activate the gateway config.
 *
 * Safe to call multiple times — subsequent calls re-read the file and validate
 * without resetting the SIGHUP handler.  Returns the same EventEmitter every
 * time so callers can chain `.on('config-changed', …)` to the return value.
 *
 * @param {object}  [options]
 * @param {string}  [options.configPath]  Override the YAML file path.
 * @param {boolean} [options.silent]      If true, do not log to stderr.
 * @returns {Promise<EventEmitter & { current: () => object }>}
 */
export async function loadConfig({ configPath, silent = false } = {}) {
  _configFilePath = configPath
    ?? process.env.SKGATEWAY_CONFIG
    ?? resolve(REPO_ROOT, 'config', 'skgateway.yaml');

  _current = _readAndBuild(_configFilePath, silent);

  // Register SIGHUP handler only once.
  if (!_sighupRegistered) {
    process.on('SIGHUP', () => _handleSighup(silent));
    _sighupRegistered = true;
  }

  // Attach a convenience accessor to the emitter so callers can do:
  //   const cfg = await loadConfig();
  //   cfg.current().server.port
  emitter.current = getConfig;

  return emitter;
}

let _sighupRegistered = false;

/**
 * Synchronously return the current active config.
 * Throws if `loadConfig()` has not been called yet.
 *
 * @returns {object}
 */
export function getConfig() {
  if (!_current) throw new Error('Config not loaded — call loadConfig() first');
  return _current;
}

// ─── internal helpers ─────────────────────────────────────────────────────────

/**
 * Read the YAML file (if it exists), merge with defaults, apply env overrides,
 * validate, and return the finalised config object.
 *
 * @param {string}  filePath
 * @param {boolean} silent
 * @returns {object}
 */
function _readAndBuild(filePath, silent) {
  const base = deepClone(DEFAULTS);

  if (existsSync(filePath)) {
    try {
      const raw = readFileSync(filePath, 'utf8');
      const fromFile = yamlLoad(raw) ?? {};
      deepMerge(base, fromFile);
      if (!silent) process.stderr.write(`[skgateway:config] Loaded ${filePath}\n`);
    } catch (err) {
      // Parse error — fall back to defaults and warn
      process.stderr.write(`[skgateway:config] WARN: could not parse ${filePath}: ${err.message}\n`);
      process.stderr.write('[skgateway:config] Falling back to built-in defaults.\n');
    }
  } else {
    if (!silent) process.stderr.write(`[skgateway:config] ${filePath} not found — using defaults.\n`);
  }

  applyEnvOverrides(base);
  resolvePaths(base);
  validate(base);   // throws ConfigError on bad values

  return base;
}

/**
 * Handle SIGHUP: reload config and emit 'config-changed' if successful.
 * On validation failure, log the error but keep the old config active.
 *
 * @param {boolean} silent
 */
function _handleSighup(silent) {
  if (!silent) process.stderr.write('[skgateway:config] SIGHUP received — reloading config…\n');
  try {
    const next = _readAndBuild(_configFilePath, silent);
    const prev = _current;
    _current = next;
    emitter.emit('config-changed', next, prev);
    if (!silent) process.stderr.write('[skgateway:config] Config reloaded successfully.\n');
  } catch (err) {
    process.stderr.write(`[skgateway:config] Reload failed — keeping old config: ${err.message}\n`);
  }
}

/**
 * Exposed for testing: force a synchronous config reload without requiring SIGHUP.
 * Same semantics as the SIGHUP handler.
 *
 * @param {boolean} [silent=false]
 * @returns {{ ok: boolean, error?: Error }}
 */
export function reloadConfig(silent = false) {
  try {
    _handleSighup(silent);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err };
  }
}

/**
 * Lookup the per-1M-token pricing for a given model name.
 *
 * A model that is present in the price table (even at $0, e.g. a local backend)
 * is considered *priced* (`unpriced: false`). Only a model with no exact and no
 * prefix match falls back to `default_local` and is flagged `unpriced: true` so
 * callers/dashboards can surface "cost unknown for this model".
 *
 * @param {string} model
 * @returns {{ input: number, output: number, cache_read?: number,
 *   cache_write?: number, unpriced: boolean }}
 */
export function getPricing(model) {
  const pricing = getConfig().metrics.pricing ?? {};

  // Exact match first
  if (pricing[model]) return { ...pricing[model], unpriced: false };

  // Prefix match (e.g. "claude-opus" matches "claude-opus-4-6"). Never treat
  // the "default_local" sentinel as a prefix — it is the unpriced fallback.
  for (const [key, val] of Object.entries(pricing)) {
    if (key !== 'default_local' && model && model.startsWith(key)) {
      return { ...val, unpriced: false };
    }
  }

  const fallback = pricing['default_local'] ?? { input: 0, output: 0 };
  return { ...fallback, unpriced: true };
}
