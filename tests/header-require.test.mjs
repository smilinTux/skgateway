/**
 * header-require.test.mjs (card P4.3): the `x-sk-require` header escape
 * hatch (design 7.1).
 *
 * A caller can declare ranker requirements for a single request without
 * editing the registry, using the EXACT SAME comma-separated mini-grammar as
 * `parseRequireSpec()` / the `/admin/models/rank?require=` inline spec (card
 * P3.3): `tool_use,min_ctx=64000,tier=local|free-remote`. This module does
 * not reimplement that grammar: `parseSkRequireHeader()` is a thin fail-soft
 * wrapper around the existing `parseRequireSpec()`.
 *
 * The whole escape hatch is gated behind `routing.match_enabled` (design
 * 7.2, card P4.2/P4.4), DEFAULT OFF: `resolveRequestRequirements()` is the
 * pure gate composition (header parse result only surfaces when the flag is
 * on) so the flag-off shape is asserted directly, WITHOUT needing a second
 * server boot with a different config (registry.mjs's REGISTRY_PATH, and
 * other nested modules' module-level state, is captured once at first
 * import in this process, so a second dynamic import of index.mjs under a
 * different SKMODELS_REGISTRY/SKGATEWAY_CONFIG would silently keep reading
 * the FIRST boot's registry; testing the gate as a pure function sidesteps
 * that entirely).
 *
 * Coverage:
 *   1. `parseSkRequireHeader`: well-formed parse (same grammar as the design
 *      doc's example), malformed/absent -> null (fail-soft, never throws).
 *   2. `resolveRequestRequirements` (the flag gate): off -> always undefined
 *      regardless of header validity; on -> the parsed header (or undefined
 *      for a malformed one).
 *   3. Live end-to-end (one boot, flag ON): a request carrying BOTH an
 *      explicit `x-sk-role` and an `x-sk-require` header still resolves via
 *      the role (composes, does not override/break role resolution); a
 *      malformed `x-sk-require` value does not break the request either;
 *      no header at all behaves exactly as before this card.
 *
 * Run with:  node --test tests/header-require.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(__dirname, "..", "src", "index.mjs");

const PORT = 18981, DASH = 18982;

describe("card P4.3: x-sk-require header escape hatch", () => {
  let mod;
  let tmpDir;
  let upstream;
  let lastUpstreamModel = null;
  let upstreamRequestCount = 0;

  before(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "skgw-p43-"));
    const cfgPath = join(tmpDir, "gw.yaml");
    const regPath = join(tmpDir, "registry.yaml");

    upstream = await new Promise((res) => {
      const server = http.createServer((req, r) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          upstreamRequestCount++;
          try { lastUpstreamModel = JSON.parse(Buffer.concat(chunks).toString("utf-8")).model ?? null; }
          catch { lastUpstreamModel = null; }
          r.writeHead(200, { "content-type": "application/json" });
          r.end(JSON.stringify({ id: "p43", choices: [{ message: { role: "assistant", content: "ok" } }] }));
        });
      });
      server.listen(0, "127.0.0.1", () => res(server));
    });
    const upstreamPort = upstream.address().port;

    // A registry role that resolves straight to the fake upstream (the
    // "external llama backend" registry path, per-agent-routing.test.mjs
    // style): the registry's OWN `backends:` block, not skgateway.yaml's.
    writeFileSync(
      regPath,
      [
        "backends:",
        "  p43-local:",
        `    url: http://127.0.0.1:${upstreamPort}/v1`,
        "    model: p43-concrete-model",
        "roles:",
        "  sk-p43-role: p43-local",
        "",
      ].join("\n"),
    );

    writeFileSync(
      cfgPath,
      [
        "server:",
        "  bind: 127.0.0.1",
        `  port: ${PORT}`,
        `  dashboard_port: ${DASH}`,
        "dashboard:",
        `  port: ${DASH}`,
        "discovery:",
        "  enabled: false",
        "identity:",
        "  enabled: false",
        // Boot with the master flag ON so the live-endpoint tests below
        // exercise the real header-parse-and-attach code path; the OFF case
        // is covered directly as a pure-function assertion (see module doc).
        "routing:",
        "  match_enabled: true",
        "backends:",
        "  noop:",
        "    url: http://127.0.0.1:1/v1",
        "    auth_type: none",
        "    priority: 1",
        "    models: [_p43-never]",
        "",
      ].join("\n"),
    );

    process.env.SKGATEWAY_CONFIG = cfgPath;
    process.env.SKMODELS_REGISTRY = regPath;
    mod = await import(pathToFileURL(INDEX).href);
  });

  after(() => {
    delete process.env.SKGATEWAY_CONFIG;
    delete process.env.SKMODELS_REGISTRY;
    try { mod.server.close(); } catch { /* best effort */ }
    try { mod.dashboard?.close?.(); } catch { /* best effort */ }
    try { upstream.close(); } catch { /* best effort */ }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // ── Pure helper: parseSkRequireHeader ──

  test("well-formed header: same grammar as the design-doc example", () => {
    const out = mod.parseSkRequireHeader("tool_use,min_ctx=64000,tier=local|free-remote");
    assert.deepEqual(out, {
      require: { tool_use: true, min_ctx: 64000 },
      tier: ["local", "free-remote"],
    });
  });

  test("well-formed header: a single bare requirement", () => {
    assert.deepEqual(mod.parseSkRequireHeader("tool_use"), { require: { tool_use: true } });
  });

  test("well-formed header: prefer= parses to a top-level list", () => {
    const out = mod.parseSkRequireHeader("prefer=sovereign|success_rate");
    assert.deepEqual(out.prefer, ["sovereign", "success_rate"]);
  });

  test("malformed: undefined header -> null", () => {
    assert.equal(mod.parseSkRequireHeader(undefined), null);
  });

  test("malformed: empty string header -> null", () => {
    assert.equal(mod.parseSkRequireHeader(""), null);
  });

  test("malformed: whitespace-only header -> null", () => {
    assert.equal(mod.parseSkRequireHeader("   "), null);
  });

  test("malformed: non-string header (array, e.g. a duplicated header) -> null", () => {
    assert.equal(mod.parseSkRequireHeader(["tool_use", "min_ctx=1000"]), null);
  });

  test("malformed: non-string header (number) -> null", () => {
    assert.equal(mod.parseSkRequireHeader(64000), null);
  });

  test("garbled-but-present header never throws (fail-soft degrade, not a crash)", () => {
    assert.doesNotThrow(() => mod.parseSkRequireHeader("!!!not,,,=valid==junk,,tier="));
    const out = mod.parseSkRequireHeader("!!!not,,,=valid==junk,,tier=");
    assert.equal(typeof out, "object");
    assert.ok(out.require && typeof out.require === "object");
  });

  // ── Pure helper: resolveRequestRequirements (the routing.match_enabled gate) ──

  test("gate OFF: always undefined, even for a well-formed header", () => {
    assert.equal(mod.resolveRequestRequirements("tool_use,min_ctx=64000", false), undefined);
  });

  test("gate OFF: undefined even when the header is absent", () => {
    assert.equal(mod.resolveRequestRequirements(undefined, false), undefined);
  });

  test("gate ON: a well-formed header comes through parsed", () => {
    const out = mod.resolveRequestRequirements("tool_use,tier=local", true);
    assert.deepEqual(out, { require: { tool_use: true }, tier: ["local"] });
  });

  test("gate ON: a malformed/absent header still yields undefined (not null)", () => {
    assert.equal(mod.resolveRequestRequirements(undefined, true), undefined);
    assert.equal(mod.resolveRequestRequirements("", true), undefined);
  });

  // ── matchRoutingEnabled: reflects this boot's routing.match_enabled: true ──

  test("matchRoutingEnabled is true for this boot's config (routing.match_enabled: true)", () => {
    assert.equal(mod.matchRoutingEnabled, true);
  });

  // ── Live end-to-end: composes with an explicit role, never breaks routing ──

  test("x-sk-require composes with an explicit x-sk-role: role resolution still wins the route", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sk-role": "sk-p43-role",
        "x-sk-require": "tool_use,min_ctx=8000,tier=local|free-remote",
      },
      body: JSON.stringify({ model: "irrelevant-caller-model", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(
      lastUpstreamModel,
      "p43-concrete-model",
      "the registry role resolution rewrote the model, unaffected by the presence of x-sk-require",
    );
  });

  test("a malformed x-sk-require does not break a role-routed request (fail-soft)", async () => {
    const before = upstreamRequestCount;
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sk-role": "sk-p43-role",
        "x-sk-require": "   ",
      },
      body: JSON.stringify({ model: "irrelevant-caller-model", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(upstreamRequestCount, before + 1, "request still reached the upstream normally");
    assert.equal(lastUpstreamModel, "p43-concrete-model");
  });

  test("no x-sk-require at all: role routing behaves exactly as before this card", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sk-role": "sk-p43-role" },
      body: JSON.stringify({ model: "irrelevant-caller-model", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(lastUpstreamModel, "p43-concrete-model");
  });
});
