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
      models: ['kimi-k2-instruct', 'kimi-k2.5', 'minimax-m2.1'],
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

  metrics: {
    enabled: true,
    db_path: './data/metrics.db',
    retention_days: 90,
    token_tracking: true,
    cost_tracking: true,
    pricing: {
      'claude-opus-4-6': { input: 15.00, output: 75.00, cache_read: 1.50, cache_write: 3.75 },
      'claude-sonnet-4-6': { input: 3.00, output: 15.00, cache_read: 0.30, cache_write: 0.375 },
      'kimi-k2-instruct': { input: 0, output: 0 },
      'kimi-k2.5': { input: 0, output: 0 },
      'minimax-m2.1': { input: 0, output: 0 },
      'default_local': { input: 0, output: 0 },
    },
  },

  siem: {
    enabled: true,
    outputs: [
      { type: 'file', path: './logs/audit.jsonl', rotate_mb: 100 },
    ],
  },

  dashboard: {
    enabled: true,
    refresh_ms: 5_000,
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

  return cfg;
}

// ─── validation ───────────────────────────────────────────────────────────────

const VALID_AUTH_TYPES = new Set(['api_key', 'oauth', 'bearer', 'none']);

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
      if (!Array.isArray(backend.models) || backend.models.length === 0)
        errs.push(`backends.${name}.models must be a non-empty array`);
      if (!Number.isInteger(backend.priority) || backend.priority < 1)
        errs.push(`backends.${name}.priority must be a positive integer`);
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
 * Falls back to `default_local` (all zeros) if no exact or prefix match found.
 *
 * @param {string} model
 * @returns {{ input: number, output: number, cache_read?: number, cache_write?: number }}
 */
export function getPricing(model) {
  const pricing = getConfig().metrics.pricing ?? {};

  // Exact match first
  if (pricing[model]) return pricing[model];

  // Prefix match (e.g. "claude-opus" matches "claude-opus-4-6")
  for (const [key, val] of Object.entries(pricing)) {
    if (model.startsWith(key)) return val;
  }

  return pricing['default_local'] ?? { input: 0, output: 0 };
}
