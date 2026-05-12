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
import { createRouter } from "./proxy/router.mjs";

// ─── Parse CLI args ───
const args = process.argv.slice(2);
let configPath = "./config/skgateway.yaml";
let portOverride = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--config" && args[i + 1]) configPath = args[++i];
  if (args[i] === "--port" && args[i + 1]) portOverride = parseInt(args[++i], 10);
}

// ─── Load config ───
const config = loadConfig(configPath);
const port = portOverride || config.server?.port || 18780;
const bind = config.server?.bind || "127.0.0.1";

// ─── Initialize subsystems ───
const router = createRouter(config.backends || {});

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
function siemHook(evt) {
  try {
    fs.appendFile(siemPath, JSON.stringify(evt) + "\n", () => {});
  } catch (e) {
    console.warn("[skgateway] siem append failed:", e.message);
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

  // Health check endpoint
  if (req.url === "/health" || req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime: process.uptime(),
      backends: router.getHealth(),
    }));
    return;
  }

  // Status endpoint
  if (req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      version: "0.1.0",
      uptime: process.uptime(),
      backends: router.getHealth(),
      metrics: metrics?.getStats() || null,
    }));
    return;
  }

  // Dashboard redirect (future)
  if (req.url === "/" || req.url === "/dashboard") {
    const dashboardPort = config.dashboard?.port || config.server?.dashboard_port || 18781;
    res.writeHead(302, { location: `http://${req.headers.host?.split(":")[0] || "localhost"}:${dashboardPort}/` });
    res.end();
    return;
  }

  // Proxy all /v1/* requests
  try {
    await handleRequest(req, res, proxyConfig);

    // Record metrics
    if (metrics) {
      const duration = Date.now() - startTime;
      metrics.recordRequest({
        path: req.url,
        method: req.method,
        duration,
        status: res.statusCode,
        agent_id: req.headers["x-agent-id"] || "unknown",
        model: req.headers["x-model"] || "unknown",
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
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ─── Hot reload config on SIGHUP ───
process.on("SIGHUP", () => {
  console.log("[skgateway] SIGHUP — reloading config");
  try {
    const newConfig = loadConfig(configPath);
    Object.assign(config, newConfig);
    console.log("[skgateway] config reloaded");
  } catch (e) {
    console.error("[skgateway] config reload failed:", e.message);
  }
});

// ─── Start ───
server.listen(port, bind, () => {
  console.log(`[skgateway] listening on http://${bind}:${port}`);
  console.log(`[skgateway] backends: ${Object.keys(config.backends || {}).join(", ") || "default"}`);
  console.log(`[skgateway] metrics: ${metrics ? "enabled" : "disabled"}`);
  console.log(`[skgateway] dashboard: port ${config.server?.dashboard_port || 18781} (coming soon)`);
});
