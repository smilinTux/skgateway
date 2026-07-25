#!/usr/bin/env node
/**
 * SKGateway — Enterprise AI Inference Proxy
 *
 * "BlueCoat for AI" — sits between any client and any LLM backend.
 * Routes, monitors, audits, and secures all AI inference traffic.
 *
 * Usage:
 *   node src/index.mjs [--port 18780] [--config ./config/skgateway.yaml]
 */

import http from "node:http";
import { loadConfig } from "./config.mjs";
import { createProxyServer, handleRequest, buildConfig } from "./proxy/core.mjs";
import { createRouter, routeAndSend } from "./proxy/router.mjs";
import { buildModelCatalog, reconcileModeFromConfig } from "./proxy/advertise.mjs";
import { getPool, resetPool } from "./proxy/connection-pool.mjs";
import { loadAgentRegistry, extractIdentity, ANONYMOUS_AGENT_ID } from "./identity/capauth.mjs";
import { classifyRequest, toSiemEvent } from "./classifiers/engine.mjs";

// ─── Parse CLI args ───
const args = process.argv.slice(2);
let configPath = "./config/skgateway.yaml";
let portOverride = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--config" && args[i + 1]) configPath = args[++i];
  if (args[i] === "--port" && args[i + 1]) portOverride = parseInt(args[++i], 10);
}

// ─── Load config ───
const _cfgEmitter = await loadConfig({ configPath });
const config = _cfgEmitter.current();
const port = portOverride || config.server?.port || 18780;
const bind = config.server?.bind || "127.0.0.1";

// ─── Initialize subsystems ───
// Map YAML credentials_path → credentials_file (Backend reads credentials_file)
const _routerBackends = {};
for (const [id, b] of Object.entries(config.backends || {})) {
  _routerBackends[id] = { ...b };
  if (b.credentials_path && !b.credentials_file) {
    _routerBackends[id].credentials_file = b.credentials_path;
  }
}
const router = createRouter({ backends: _routerBackends, quarantine: config.quarantine, routing: config.routing });

// Advertised-vs-working reconciliation mode (card 5c680ee9). The /v1/models
// catalog is reconciled against live backend health so callers are not offered
// models whose only backend(s) are down or quarantined. Default "flag" is
// non-breaking (annotate status, hide nothing). See src/proxy/advertise.mjs.
const advertiseReconcileMode = reconcileModeFromConfig(config);
console.log(`[skgateway] advertised-catalog reconcile mode: ${advertiseReconcileMode}`);

// Initialize connection pool with per-backend limits from config
const poolConfig = {
  defaultMaxConcurrent: config.pooling?.default_max_concurrent || 20,
  defaultMaxQueue: config.pooling?.default_max_queue || 1000,
  queueTimeoutMs: config.pooling?.queue_timeout_ms || 300000,
  perBackend: config.pooling?.per_backend || {},
};
const pool = getPool(poolConfig);

// Metrics collector (lazy — may not be installed yet)
let metrics = null;
try {
  const { createMetricsCollector } = await import("./metrics/collector.mjs");
  metrics = createMetricsCollector(config.metrics || {});
  console.log("[skgateway] metrics collector initialized");
} catch (e) {
  console.log("[skgateway] metrics collector not available (optional):", e.message);
}

// ─── CapAuth agent-identity registry (P2.1) ───
// Resolves every /v1/* request to a verified agent identity so routing,
// metrics, and SIEM audit all key on the same caller. Building the registry
// never blocks startup — on failure we degrade to identity disabled.
let identityRegistry = null;
const identityCfg = config.identity || {};
const identityEnabled = identityCfg.enabled !== false;
const requireAgentId = identityCfg.require_agent_id === true;
if (identityEnabled) {
  try {
    identityRegistry = loadAgentRegistry(config);
    console.log(
      `[skgateway] identity registry loaded (${identityRegistry.byName.size} agents, ` +
      `anonymous ${identityCfg.allow_anonymous === false ? "denied" : "allowed"}, ` +
      `auth-gate ${requireAgentId ? "ON" : "OFF"})`,
    );
  } catch (e) {
    console.log("[skgateway] identity registry not available (optional):", e.message);
  }
}

// Dashboard server
let dashboard = null;
try {
  const { createDashboardServer } = await import("./dashboard/server.mjs");
  const dashPort = config.dashboard?.port || config.server?.dashboard_port || 18781;
  dashboard = createDashboardServer({
    port:    dashPort,
    bind:    config.server?.bind || "0.0.0.0",
    metrics,
    router,
    config,
  });
  console.log(`[skgateway] dashboard server started on port ${dashPort}`);
} catch (e) {
  console.log("[skgateway] dashboard server not available (optional):", e.message);
}

// ─── SIEM hook — append gateway decisions to logs/audit.jsonl ───
import fs from "node:fs";
import path from "node:path";
const siemPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  config.siem?.outputs?.[0]?.path || "./logs/audit.jsonl",
);
try { fs.mkdirSync(path.dirname(siemPath), { recursive: true }); } catch {}
// Optional skcapstone bridge — shares warn+ SIEM events on the mesh-wide
// sk-alert bus when ~/.skcapstone is present; no-op otherwise.
import * as skcapstone from "./integration.mjs";

// ─── Syslog output (RFC 5424) — disabled by default ───
// Build one adapter per `type: syslog` output in config.siem.outputs. Each is a
// no-op unless `enabled: true` (or SKGATEWAY_SYSLOG_* env is set). Shipping to
// syslog never blocks or breaks the existing file/append + skcapstone path.
let syslogOutputs = [];
try {
  const { createSyslogOutput } = await import("./siem/syslog.mjs");
  syslogOutputs = (config.siem?.outputs || [])
    .filter((o) => o && o.type === "syslog")
    .map((o) => createSyslogOutput(o))
    .filter((a) => a.enabled);
  if (syslogOutputs.length) {
    console.log(`[skgateway] syslog output(s) enabled: ${syslogOutputs.length}`);
  }
} catch (e) {
  console.log("[skgateway] syslog output not available (optional):", e.message);
}

// ─── Elasticsearch / OpenSearch output (_bulk) - disabled by default ───
// Build one adapter per `type: elasticsearch` (or `opensearch`) output. Both
// engines speak the identical _bulk protocol, so one adapter serves both. Each
// is a no-op unless `enabled: true` with an endpoint (or SKGATEWAY_ES_* env is
// set). Shipping to ES never blocks or breaks the file/append + syslog path.
let esOutputs = [];
try {
  const { createElasticsearchOutput } = await import("./siem/elasticsearch.mjs");
  esOutputs = (config.siem?.outputs || [])
    .filter((o) => o && (o.type === "elasticsearch" || o.type === "opensearch"))
    .map((o) => createElasticsearchOutput(o))
    .filter((a) => a.enabled);
  if (esOutputs.length) {
    console.log(`[skgateway] elasticsearch/opensearch output(s) enabled: ${esOutputs.length}`);
  }
} catch (e) {
  console.log("[skgateway] elasticsearch output not available (optional):", e.message);
}

function siemHook(evt) {
  try {
    fs.appendFile(siemPath, JSON.stringify(evt) + "\n", () => {});
  } catch (e) {
    console.warn("[skgateway] siem append failed:", e.message);
  }
  try { skcapstone.forwardSiemEvent(evt); } catch {}
  for (const out of syslogOutputs) {
    try { out.write(evt); } catch { /* never let syslog break the hot path */ }
  }
  for (const out of esOutputs) {
    try { out.write(evt); } catch { /* never let ES break the hot path */ }
  }
}

// ─── Build per-model limit map from YAML model_limits section ───
// YAML uses snake_case; core.mjs uses camelCase.
// model_limits:
//   moonshotai/kimi-k2.6: { max_body_bytes: 800000, max_system_bytes: 320000 }
function buildModelLimits(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [model, limits] of Object.entries(raw)) {
    out[model] = {
      ...(limits.max_body_bytes   != null ? { maxBodyBytes:   limits.max_body_bytes   } : {}),
      ...(limits.max_system_bytes != null ? { maxSystemBytes: limits.max_system_bytes } : {}),
    };
  }
  return out;
}

// ─── Build proxy config ───
// Explicitly map YAML snake_case keys → core.mjs camelCase to avoid silent misses.
const s = config.sanitizer || {};
const t = config.tools     || {};
const proxyConfig = buildConfig({
  port,
  targetUrl:          Object.values(config.backends || {})[0]?.url || "https://integrate.api.nvidia.com/v1",
  maxBodyBytes:       s.max_body_bytes,
  maxSystemBytes:     s.max_system_bytes,
  proactiveToolLimit: t.max_budget,
  toolRoundLimit:     t.call_limit,
  modelLimits:        buildModelLimits(config.model_limits),
  ...(config.streaming ? { streaming: config.streaming } : {}),
  siem: siemHook,
});

// ─── Create HTTP server ───
const server = http.createServer(async (req, res) => {
  const startTime = Date.now();

  // ── Health check endpoint ──
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime: process.uptime(),
      backends: router.getHealth(),
    }));
    return;
  }

  // ── Status endpoint (includes pool stats) ──
  if (req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      version: "0.1.0",
      uptime: process.uptime(),
      backends: router.getHealth(),
      pool: pool.getTotalStats(),
      metrics: metrics?.getStats() || null,
    }));
    return;
  }

  // ── Queue / connection pool depth endpoint ──
  if (req.url === "/queue") {
    const allStats = pool.getAllStats();
    const total = pool.getTotalStats();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      pool: {
        totalActive: total.totalActive,
        totalQueued: total.totalQueued,
        totalCapacity: total.totalCapacity,
        utilization: total.totalCapacity > 0 ? (total.totalActive / total.totalCapacity) : 0,
      },
      backends: allStats,
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // ── Dashboard redirect (future) ──
  if (req.url === "/" || req.url === "/dashboard") {
    const dashboardPort = config.dashboard?.port || config.server?.dashboard_port || 18781;
    const host = req.headers.host?.split(":")[0] || "localhost";
    res.writeHead(302, { location: `http://${host}:${dashboardPort}/` });
    res.end();
    return;
  }

  // ── Aggregated model catalog from configured backends ──
  // Reconciled against live backend health/quarantine (card 5c680ee9): a model
  // whose only serving backend(s) are down or quarantined is flagged
  // (status: "unavailable") or hidden per config.advertise.reconcile, so callers
  // are not offered dead models. Recovery re-admits automatically.
  if (req.url === "/v1/models" && req.method === "GET") {
    const data = buildModelCatalog(config.backends || {}, router, advertiseReconcileMode);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data }));
    return;
  }

  // Proxy all /v1/* requests — model-aware routing via the router.
  try {
    // ── CapAuth agent-identity resolution (P2.1) ──
    // Resolve the caller BEFORE routing so the verified agent identity drives
    // routing, metrics, and every SIEM event. Fail-safe: any error degrades to
    // anonymous, never crashes the request. Only the opt-in auth gate blocks.
    let identity = {
      agent_id: req.headers["x-agent-id"] || ANONYMOUS_AGENT_ID,
      verified: false,
      method: req.headers["x-agent-id"] ? "header" : "anonymous",
      session_id: req.headers["x-session-id"] || null,
      fingerprint: null,
    };
    if (identityRegistry) {
      try {
        identity = await extractIdentity(req, identityRegistry);
      } catch (e) {
        // degrade to anonymous — never let identity resolution break the request
        identity = { agent_id: ANONYMOUS_AGENT_ID, verified: false, method: "anonymous", session_id: null, fingerprint: null };
      }
    }
    req.identity = identity;
    req.agent_id = identity.agent_id;

    // Emit an audit event carrying the resolved (and verification-flagged) agent.
    siemHook({
      ts: new Date().toISOString(),
      event: "identity.resolved",
      agent_id: identity.agent_id,
      method: identity.method,
      verified: identity.verified,
      session_id: identity.session_id,
      fingerprint: identity.fingerprint,
      path: req.url,
      remote: req.socket?.remoteAddress ?? null,
    });

    // Opt-in auth gate: reject anonymous callers with 403 (OFF by default).
    if (requireAgentId && identity.method === "anonymous") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({
        error: {
          message: "Agent identity required. Provide X-Agent-Id, X-CapAuth-Signature, or Authorization: Bearer.",
          code: "identity_required",
          status: 403,
        },
      }));
      return;
    }

    // Buffer the request body so we can read the model for routing.
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    let parsedModel = req.headers["x-model"] || undefined;
    let parsedMessages = undefined;
    if (req.headers["content-type"]?.includes("application/json") && body.length) {
      try {
        const parsed = JSON.parse(body.toString("utf-8"));
        parsedModel = parsed.model || parsedModel;
        // Carry messages for sk-auto difficulty classification (registry.mjs).
        if (Array.isArray(parsed.messages)) parsedMessages = parsed.messages;
      } catch {}
    }

    // ── Prompt classification (P3.5) — PASSIVE observability into SIEM ──
    // Label the request's intent/risk/jailbreak/injection and emit it. Pure
    // heuristic (no network, sub-10ms), fail-open, and it NEVER changes routing.
    if (config.classification?.enabled && Array.isArray(parsedMessages)) {
      try {
        const classification = classifyRequest(parsedMessages, {
          classifier: config.classification.classifier,
        });
        siemHook(toSiemEvent(classification, {
          agent_id: identity.agent_id,
          session_id: identity.session_id,
          model: parsedModel,
          path: req.url,
        }));
      } catch { /* never let classification break a request */ }
    }

    const routeRequest = {
      model:   parsedModel,
      messages: parsedMessages,
      // Verified CapAuth identity (falls back to X-Agent-Id / anonymous).
      agentId: identity.agent_id !== ANONYMOUS_AGENT_ID ? identity.agent_id : (req.headers["x-agent-id"] || undefined),
      // skmodels registry role/context routing (single source of truth).
      // Present => routeAndSend resolves via ~/.skcapstone/models/registry.yaml
      // (precedence context > service > role > default) before backend select.
      context: req.headers["x-sk-context"] || undefined,
      service: req.headers["x-sk-service"] || undefined,
      role:    req.headers["x-sk-role"]    || undefined,
    };

    const result = await routeAndSend(
      router, routeRequest, req.url, req.method, req.headers, body, true, siemHook,
    );

    if (!result) {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "No backend produced a response", code: 502 } }));
      }
    } else {
      const headers = { ...result.headers };
      delete headers["content-length"];
      delete headers["transfer-encoding"];
      delete headers["content-encoding"];
      res.writeHead(result.status, headers);
      res.end(result.body);
    }

    // Record metrics
    if (metrics) {
      const duration = Date.now() - startTime;
      metrics.recordRequest({
        path: req.url,
        method: req.method,
        duration,
        status: result?.status ?? res.statusCode,
        agent_id: req.agent_id || req.headers["x-agent-id"] || "unknown",
        model: parsedModel || "unknown",
        backend: result?.backendId,
      });
    }
  } catch (err) {
    console.error("[skgateway] unhandled error:", err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Gateway error", code: 502 } }));
    }
  }
});

// ─── Graceful shutdown ───
function shutdown(signal) {
  console.log(`[skgateway] ${signal} received, shutting down`);
  server.close(() => {
    if (metrics)   metrics.close?.();
    if (dashboard) dashboard.close?.();
    for (const out of syslogOutputs) { try { out.close?.(); } catch {} }
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Hot reload config on SIGHUP ───
// config.mjs registers its own SIGHUP handler that re-reads + validates the
// file and emits "config-changed"; we just refresh our local snapshot from it.
_cfgEmitter.on("config-changed", () => {
  try {
    Object.assign(config, _cfgEmitter.current());
    console.log("[skgateway] config reloaded");
  } catch (e) {
    console.error("[skgateway] config reload failed:", e.message);
  }
});

// ─── Start ───
server.listen(port, bind, () => {
    console.log("[skgateway] listening on http://" + bind + ":" + port);
    const backendNames = Object.keys(config.backends || {});
    console.log("[skgateway] backends: " + (backendNames.join(", ") || "default"));
    console.log("[skgateway] metrics: " + (metrics ? "enabled" : "disabled"));
    const dashPort = config.server?.dashboard_port || 18781;
    console.log("[skgateway] dashboard: port " + dashPort + " (coming soon)");
    // Advertise to skcapstone service discovery when present (no-op otherwise).
    try {
      if (skcapstone.registerService({ healthUrl: `http://localhost:${port}/health` })) {
        console.log("[skgateway] registered with skcapstone service discovery");
      }
    } catch {}
});
