/**
 * siem-syslog.test.mjs — RFC 5424 syslog output adapter tests.
 *
 * Coverage:
 *   1. RFC 5424 message-format correctness (PRI, VERSION, HEADER fields, SD, MSG).
 *   2. Facility + severity → PRI mapping.
 *   3. Disabled-by-default no-op behaviour (and default config carries no sink).
 *   4. Config: SKGATEWAY_SYSLOG_* env overrides produce an enabled sink.
 *   5. End-to-end delivery over UDP and TCP (octet-counting framing).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import net from "node:net";

import {
  formatRFC5424,
  createSyslogOutput,
  computePri,
  severityToLevel,
} from "../src/siem/syslog.mjs";
import { createEvent } from "../src/siem/events.mjs";
import { loadConfig } from "../src/config.mjs";

// ─── helpers ──────────────────────────────────────────────────────────────────

function sampleEvent(overrides = {}) {
  return createEvent(
    "request",
    { prompt_class: "chat", token_estimate: 2400 },
    { agent_id: "lumina", model: "kimi-k2", backend: "nvidia", ...overrides },
  );
}

/**
 * Parse the RFC 5424 HEADER of a syslog line.
 * Returns { pri, version, timestamp, hostname, appName, procId, msgId, rest }.
 */
function parseHeader(line) {
  const m = line.match(
    /^<(\d+)>(\d+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/s,
  );
  assert.ok(m, `line is not RFC 5424: ${JSON.stringify(line)}`);
  return {
    pri: Number(m[1]),
    version: Number(m[2]),
    timestamp: m[3],
    hostname: m[4],
    appName: m[5],
    procId: m[6],
    msgId: m[7],
    rest: m[8], // STRUCTURED-DATA SP MSG
  };
}

// ─── 1. format correctness ──────────────────────────────────────────────────

test("formatRFC5424 emits a well-formed RFC 5424 header", () => {
  const ev = sampleEvent();
  const line = formatRFC5424(ev, { facility: 16 });
  const h = parseHeader(line);

  // info severity (6) + local0 facility (16) → PRI 16*8+6 = 134
  assert.equal(h.pri, 134);
  assert.equal(h.version, 1);
  assert.equal(h.timestamp, ev.timestamp);
  assert.equal(h.appName, "skgateway");
  assert.equal(h.procId, String(process.pid));
  assert.equal(h.msgId, "request");
  assert.ok(h.hostname.length > 0 && h.hostname !== " ");
});

test("formatRFC5424 includes a structured-data element with event_id", () => {
  const ev = sampleEvent();
  const line = formatRFC5424(ev);
  const h = parseHeader(line);
  // rest = SD SP MSG; SD is the bracketed element
  assert.match(h.rest, /^\[skgateway@32473 /);
  assert.ok(h.rest.includes(`event_id="${ev.event_id}"`));
  assert.ok(h.rest.includes(`agent_id="lumina"`));
});

test("formatRFC5424 default MSG body is CEF, with a UTF-8 BOM", () => {
  const ev = sampleEvent();
  const line = formatRFC5424(ev);
  // MSG follows the SD element; BOM then CEF header
  const bomIdx = line.indexOf("﻿");
  assert.ok(bomIdx > 0, "expected a UTF-8 BOM before MSG");
  assert.ok(line.slice(bomIdx).startsWith("﻿CEF:0|SKWorld|SKGateway|"));
});

test("formatRFC5424 format=json emits a JSON MSG body", () => {
  const ev = sampleEvent();
  const line = formatRFC5424(ev, { format: "json", bom: false });
  const h = parseHeader(line);
  // After the SD element there is a space then the JSON body.
  const sdEnd = h.rest.indexOf("] ");
  const msg = h.rest.slice(sdEnd + 2);
  const parsed = JSON.parse(msg);
  assert.equal(parsed.event_id, ev.event_id);
  assert.equal(parsed.event_type, "request");
});

test("formatRFC5424 can suppress structured data (NILVALUE)", () => {
  const ev = sampleEvent();
  const line = formatRFC5424(ev, { structuredData: false, bom: false });
  const h = parseHeader(line);
  assert.ok(h.rest.startsWith("- "), "SD should be NILVALUE '-'");
});

test("formatRFC5424 tolerates a bad timestamp by synthesising one", () => {
  const ev = sampleEvent();
  ev.timestamp = "not-a-date";
  const line = formatRFC5424(ev);
  const h = parseHeader(line);
  assert.match(h.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

// ─── 2. facility + severity mapping ─────────────────────────────────────────

test("severityToLevel maps SKGateway severities to RFC 5424 levels", () => {
  assert.equal(severityToLevel("info"), 6);
  assert.equal(severityToLevel("warning"), 4);
  assert.equal(severityToLevel("error"), 3);
  assert.equal(severityToLevel("critical"), 2);
  assert.equal(severityToLevel("bogus"), 6); // fallback = informational
});

test("computePri = facility*8 + severity, with clamping", () => {
  assert.equal(computePri(16, 6), 134); // local0 / info
  assert.equal(computePri(0, 3), 3); // kern / error
  assert.equal(computePri(23, 0), 184); // local7 / emergency
  // out-of-range facility falls back to local0 (16)
  assert.equal(computePri(99, 3), 16 * 8 + 3);
});

test("PRI reflects event severity for an error event", () => {
  const ev = createEvent("error", { type: "upstream_timeout" });
  const line = formatRFC5424(ev, { facility: 16 });
  const h = parseHeader(line);
  // error severity (3) + local0 (16) → 131
  assert.equal(h.pri, 131);
});

// ─── 3. disabled by default ─────────────────────────────────────────────────

test("createSyslogOutput() with no config is a no-op adapter", () => {
  const out = createSyslogOutput();
  assert.equal(out.enabled, false);
  // Must not throw and must not open a socket.
  assert.doesNotThrow(() => out.write(sampleEvent()));
});

test("createSyslogOutput ignores enabled:true without a target host", () => {
  const out = createSyslogOutput({ enabled: true, protocol: "udp" });
  assert.equal(out.enabled, false);
});

test("createSyslogOutput with enabled:false is a no-op even with a host", () => {
  const out = createSyslogOutput({ enabled: false, host: "127.0.0.1", port: 514 });
  assert.equal(out.enabled, false);
  assert.doesNotThrow(() => out.write(sampleEvent()));
});

test("default config carries no syslog output (sink disabled by default)", async () => {
  const emitter = await loadConfig({
    configPath: "/nonexistent/skgateway.yaml",
    silent: true,
  });
  const cfg = emitter.current();
  const syslogSinks = (cfg.siem?.outputs ?? []).filter((o) => o.type === "syslog");
  assert.equal(syslogSinks.length, 0);
});

// ─── 4. config env overrides ────────────────────────────────────────────────

test("SKGATEWAY_SYSLOG_* env vars produce an enabled syslog sink", async () => {
  const saved = { ...process.env };
  process.env.SKGATEWAY_SYSLOG_ENABLED = "true";
  process.env.SKGATEWAY_SYSLOG_HOST = "syslog.internal";
  process.env.SKGATEWAY_SYSLOG_PORT = "10514";
  process.env.SKGATEWAY_SYSLOG_PROTOCOL = "tcp";
  process.env.SKGATEWAY_SYSLOG_FACILITY = "20";
  process.env.SKGATEWAY_SYSLOG_FORMAT = "json";
  try {
    const emitter = await loadConfig({
      configPath: "/nonexistent/skgateway.yaml",
      silent: true,
    });
    const cfg = emitter.current();
    const sink = (cfg.siem?.outputs ?? []).find((o) => o.type === "syslog");
    assert.ok(sink, "expected an env-injected syslog sink");
    assert.equal(sink.enabled, true);
    assert.equal(sink.host, "syslog.internal");
    assert.equal(sink.port, 10514);
    assert.equal(sink.protocol, "tcp");
    assert.equal(sink.facility, 20);
    assert.equal(sink.format, "json");
  } finally {
    for (const k of [
      "SKGATEWAY_SYSLOG_ENABLED",
      "SKGATEWAY_SYSLOG_HOST",
      "SKGATEWAY_SYSLOG_PORT",
      "SKGATEWAY_SYSLOG_PROTOCOL",
      "SKGATEWAY_SYSLOG_FACILITY",
      "SKGATEWAY_SYSLOG_FORMAT",
    ]) {
      delete process.env[k];
      if (saved[k] !== undefined) process.env[k] = saved[k];
    }
    // Restore a clean default config for any later suites.
    await loadConfig({ configPath: "/nonexistent/skgateway.yaml", silent: true });
  }
});

// ─── 5. end-to-end delivery ─────────────────────────────────────────────────

test("UDP transport delivers a parseable RFC 5424 datagram", async () => {
  const server = dgram.createSocket("udp4");
  const received = new Promise((resolve) => {
    server.on("message", (buf) => resolve(buf.toString("utf8")));
  });
  await new Promise((res) => server.bind(0, "127.0.0.1", res));
  const { port } = server.address();

  const out = createSyslogOutput({
    enabled: true,
    protocol: "udp",
    host: "127.0.0.1",
    port,
    facility: 16,
  });
  assert.equal(out.enabled, true);

  out.write(sampleEvent());
  const line = await received;
  const h = parseHeader(line);
  assert.equal(h.pri, 134);
  assert.equal(h.appName, "skgateway");
  assert.equal(h.msgId, "request");

  await out.close();
  await new Promise((res) => server.close(res));
});

test("TCP transport delivers an octet-counted RFC 5424 frame", async () => {
  const chunks = [];
  const received = new Promise((resolve) => {
    const server = net.createServer((sock) => {
      sock.on("data", (d) => {
        chunks.push(d);
        resolve({ data: Buffer.concat(chunks).toString("utf8"), server });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const out = createSyslogOutput({
        enabled: true,
        protocol: "tcp",
        host: "127.0.0.1",
        port,
        facility: 16,
        framing: "octet",
      });
      out.write(sampleEvent());
      // keep the adapter alive on the closure for teardown
      received._out = out;
    });
  });

  const { data, server } = await received;
  // Octet-counting frame: "<len> <SYSLOG-MSG>"
  const m = data.match(/^(\d+) (.*)$/s);
  assert.ok(m, `expected octet-counting frame, got: ${JSON.stringify(data)}`);
  const declaredLen = Number(m[1]);
  assert.equal(Buffer.byteLength(m[2], "utf8"), declaredLen);
  const h = parseHeader(m[2]);
  assert.equal(h.pri, 134);
  assert.equal(h.msgId, "request");

  await received._out.close();
  await new Promise((res) => server.close(res));
});
