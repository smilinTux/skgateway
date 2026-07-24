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
import { getPool, resetPool } from "./proxy/connection-pool.mjs";

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
const router = createRouter({ backends: _routerBackends });

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
  if (req.url === "/v1/models" && req.method === "GET") {
    const seen = new Set();
    const data = [];
    for (const [id, b] of Object.entries(config.backends || {})) {
      for (const m of (b.models || [])) {
        if (m.includes("*") || seen.has(m)) continue;
        seen.add(m);
        data.push({ id: m, object: "model", created: 0, owned_by: id });
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data }));
    return;
  }

  // Proxy all /v1/* requests — model-aware routing via the router.
  try {
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

    const routeRequest = {
      model:   parsedModel,
      messages: parsedMessages,
      agentId: req.headers["x-agent-id"] || undefined,
      // skmodels registry role/context routing (single source of truth).
      // Present => routeAndSend resolves via ~/.skcapstone/models/registry.yaml
      // (precedence context > service > role > default) before backend select.
      context: req.headers["x-sk-context"] || undefined,
      service: req.headers["x-sk-service"] || undefined,
      role:    req.headers["x-sk-role"]    || undefined,
    };

    const result = await routeAndSend(
      router, routeRequest, req.url, req.method, req.headers, body, true,
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
        agent_id: req.headers["x-agent-id"] || "unknown",
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
