/**
 * authz-enforce-integration.test.mjs — boots the REAL gateway (src/index.mjs) as
 * a subprocess and proves the two load-bearing behaviors on the live HTTP surface:
 *
 *   FLAG OFF (default): a gated route is NOT 403ed by authz. The gateway behaves
 *     exactly as before (with no backend configured the inference route 404s /
 *     502s from the proxy, never a 403). This is the byte-identical guarantee.
 *
 *   FLAG ON, no PDP token configured: gated routes (/v1/* inference, /admin/*)
 *     fail closed with 403, while public routes (/health, /v1/models) still 200.
 *
 * The subprocess is launched with a minimal in-repo temp config (discovery off,
 * identity off, no backends) on a fixed loopback port.
 *
 * Run with:  node --test tests/authz-enforce-integration.test.mjs
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(__dirname, "..", "src", "index.mjs");

/** Boot the gateway with the given env; resolve once it logs "listening". */
function bootGateway({ port, dashPort, env, extraConfig = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "skgw-authz-"));
  const cfgPath = join(dir, "gw.yaml");
  writeFileSync(
    cfgPath,
    [
      "server:",
      "  bind: 127.0.0.1",
      `  port: ${port}`,
      `  dashboard_port: ${dashPort}`,
      "discovery:",
      "  enabled: false",
      "dashboard:",
      `  port: ${dashPort}`,
      "identity:",
      "  enabled: false",
      "backends: {}",
      ...extraConfig,
      "",
    ].join("\n"),
  );

  const childEnv = { ...process.env, ...env };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[key];
  }
  const child = spawn(process.execPath, [INDEX, "--config", cfgPath, "--port", String(port)], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolveBoot, rejectBoot) => {
    let out = "";
    const onData = (buf) => {
      out += buf.toString();
      if (/\[skgateway\] listening/.test(out)) {
        resolveBoot({ child, dir, out });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => rejectBoot(new Error(`gateway exited early (${code}):\n${out}`)));
    setTimeout(() => rejectBoot(new Error(`gateway did not start in time:\n${out}`)), 15000);
  });
}

async function http(method, port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.status;
}

async function httpResponse(method, port, path, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function stop(handle) {
  if (!handle) return;
  try { handle.child.kill("SIGKILL"); } catch { /* already gone */ }
  try { rmSync(handle.dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Fixed loopback ports in a high, uncommon range to avoid collisions.
const OFF_PORT = 18942, OFF_DASH = 18943;
const ON_PORT = 18944, ON_DASH = 18945;

describe("authz enforce — flag OFF is byte-identical (live server)", () => {
  let handle;
  before(async () => { handle = await bootGateway({ port: OFF_PORT, dashPort: OFF_DASH, env: {} }); });
  after(() => stop(handle));

  test("boot log confirms enforce OFF passthrough", () => {
    assert.match(handle.out, /authz enforce OFF/);
  });
  test("gated inference route is NOT 403ed by authz (no backend → 404/502, never 403)", async () => {
    const status = await http("POST", OFF_PORT, "/v1/chat/completions", { model: "x", messages: [] });
    assert.notEqual(status, 403, "flag-off must never 403 a gated route via authz");
  });
  test("public /health still 200", async () => {
    assert.equal(await http("GET", OFF_PORT, "/health"), 200);
  });
});

describe("authz enforce — flag ON fails closed without a PDP token (live server)", () => {
  let handle;
  before(async () => {
    handle = await bootGateway({
      port: ON_PORT,
      dashPort: ON_DASH,
      // enforce ON, but no CAPAUTH_AUTHZ_URL/TOKEN → client is unconfigured → deny.
      // Strict mode (TRUST_INTERNAL=0) so the loopback test client is gated and
      // the fail-closed PDP path is exercised (default trust_internal would allow
      // loopback as internal; that default is covered by its own block below).
      env: {
        SKGATEWAY_AUTHZ_ENFORCE: "1",
        SKGATEWAY_AUTHZ_TRUST_INTERNAL: "0",
        CAPAUTH_AUTHZ_URL: "",
        CAPAUTH_AUTHZ_TOKEN: "",
      },
    });
  });
  after(() => stop(handle));

  test("boot log confirms enforce ON", () => {
    assert.match(handle.out, /authz ENFORCE ON/);
  });
  test("gated inference route → 403 (fail closed)", async () => {
    assert.equal(await http("POST", ON_PORT, "/v1/chat/completions", { model: "x", messages: [] }), 403);
  });
  test("gated admin route → 403 (fail closed)", async () => {
    assert.equal(await http("GET", ON_PORT, "/admin/models"), 403);
  });
  test("public /health → 200 (no authz on public routes)", async () => {
    assert.equal(await http("GET", ON_PORT, "/health"), 200);
  });
  test("public /v1/models → 200 (read-only listing is public)", async () => {
    assert.equal(await http("GET", ON_PORT, "/v1/models"), 200);
  });
});

// Fixed loopback ports for the internal-allow (default posture) block.
const INT_PORT = 18946, INT_DASH = 18947;

describe("authz enforce ON — allow-internal default authorizes a loopback caller", () => {
  let handle;
  before(async () => {
    handle = await bootGateway({
      port: INT_PORT,
      dashPort: INT_DASH,
      // enforce ON, PDP UNCONFIGURED (would deny), but trust_internal DEFAULT (on).
      // The test client connects from 127.0.0.1 = internal, so it is allowed with
      // NO PDP call — proving the "allow internal, gate external" posture: enforce
      // can be flipped without denying trusted-network inference traffic.
      env: { SKGATEWAY_AUTHZ_ENFORCE: "1", CAPAUTH_AUTHZ_URL: "", CAPAUTH_AUTHZ_TOKEN: "" },
    });
  });
  after(() => stop(handle));

  test("gated inference route from loopback is NOT 403ed (internal-allowed)", async () => {
    const status = await http("POST", INT_PORT, "/v1/chat/completions", { model: "x", messages: [] });
    assert.notEqual(status, 403, "internal peer must be allowed even with enforce ON + no PDP token");
  });
  test("gated admin route from loopback is NOT 403ed (internal-allowed)", async () => {
    assert.notEqual(await http("GET", INT_PORT, "/admin/models"), 403);
  });
});

const SKLEGAL_PDP_PORT = 18948, SKLEGAL_PORT = 18949, SKLEGAL_DASH = 18950;

describe("SKLegal governed qualification wire contract on the live server", () => {
  let handle;
  let pdp;
  let credentialDir;
  let serviceCredential;
  let mode = "allow";
  const calls = [];

  before(async () => {
    credentialDir = mkdtempSync(join(tmpdir(), "skgw-authz-credential-"));
    serviceCredential = join(credentialDir, "skgateway-authz-service-token");
    writeFileSync(serviceCredential, "synthetic-service-secret", { mode: 0o600 });
    chmodSync(serviceCredential, 0o600);
    pdp = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      calls.push({ headers: req.headers, body: JSON.parse(raw) });
      const base = {
        allow: mode === "allow" || mode === "leak",
        reason: mode === "allow" || mode === "leak" ? "allow" : "policy_denied",
        decision_id: "synthetic-decision",
        policy_revision: "synthetic-policy",
        correlation_id: "synthetic-correlation",
        obligations: [],
      };
      const body = mode === "malformed"
        ? { ...base, allow: "true" }
        : mode === "leak"
          ? { ...base, prompt: "protected-synthetic-content" }
          : base;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise((resolveListen) => pdp.listen(SKLEGAL_PDP_PORT, "127.0.0.1", resolveListen));
    handle = await bootGateway({
      port: SKLEGAL_PORT,
      dashPort: SKLEGAL_DASH,
      env: {
        SKGATEWAY_AUTHZ_ENFORCE: "1",
        SKLEGAL_CAPAUTH_AUTHZ_ENDPOINT: `http://127.0.0.1:${SKLEGAL_PDP_PORT}/v1/authz/decide`,
        SKLEGAL_AUTHZ_SERVICE_TOKEN: undefined,
      },
      extraConfig: [
        "authz:",
        "  enforce: true",
        "  trust_internal: true",
        "  sklegal_qualification:",
        "    enabled: true",
        `    service_credential_file: ${serviceCredential}`,
        "    service_credential_max_age_ms: 300000",
        "    routes:",
        "      - method: POST",
        "        path: /v1/chat/completions",
        "        subject: synthetic-agent",
        "        resource:",
        "          tenant_id: synthetic-tenant",
        "          matter_id: synthetic-matter",
        "          material_id: synthetic-material",
        "          material_version: '7'",
        "          route_id: synthetic-route",
        "        context:",
        "          purpose: research",
        "          classification: public",
        "          privilege: none",
        "          ethical_wall: clear",
      ],
    });
  });

  after(async () => {
    stop(handle);
    if (pdp?.listening) await new Promise((resolveClose) => pdp.close(resolveClose));
    if (credentialDir) rmSync(credentialDir, { recursive: true, force: true });
  });

  test("missing request-local CapAuth denies without contacting the PDP", async () => {
    const before = calls.length;
    const response = await httpResponse("POST", SKLEGAL_PORT, "/v1/chat/completions", { model: "x", messages: [] });
    assert.equal(response.status, 403);
    assert.equal(calls.length, before);
  });

  test("loopback cannot bypass and the PDP receives exact headers and body", async () => {
    mode = "allow";
    const response = await httpResponse(
      "POST",
      SKLEGAL_PORT,
      "/v1/chat/completions",
      { model: "x", messages: [] },
      { authorization: "Bearer synthetic-request-capauth", "x-sklegal-tenant-id": "attacker-tenant" },
    );
    assert.notEqual(response.status, 403);
    const call = calls.at(-1);
    assert.equal(call.headers.authorization, "Bearer synthetic-request-capauth");
    assert.equal(call.headers["x-sklegal-service-authorization"], "Bearer synthetic-service-secret");
    assert.deepEqual(call.body, {
      subject: "synthetic-agent",
      capability: "skgateway.infer",
      resource: {
        tenant_id: "synthetic-tenant",
        matter_id: "synthetic-matter",
        material_id: "synthetic-material",
        material_version: "7",
        route_id: "synthetic-route",
      },
      context: {
        purpose: "research",
        classification: "public",
        privilege: "none",
        ethical_wall: "clear",
      },
    });
  });

  test("allows are not cached and a policy deny becomes 403", async () => {
    mode = "allow";
    const before = calls.length;
    for (let index = 0; index < 2; index++) {
      await httpResponse(
        "POST",
        SKLEGAL_PORT,
        "/v1/chat/completions",
        { model: "x", messages: [] },
        { authorization: "Bearer synthetic-request-capauth" },
      );
    }
    assert.equal(calls.length, before + 2);
    mode = "deny";
    const denied = await httpResponse(
      "POST",
      SKLEGAL_PORT,
      "/v1/chat/completions",
      { model: "x", messages: [] },
      { authorization: "Bearer synthetic-request-capauth" },
    );
    assert.equal(denied.status, 403);
  });

  test("credential rotation is read through and removal denies before PDP transport", async () => {
    mode = "allow";
    writeFileSync(serviceCredential, "synthetic-service-rotated", { mode: 0o600 });
    chmodSync(serviceCredential, 0o600);
    const rotated = await httpResponse(
      "POST",
      SKLEGAL_PORT,
      "/v1/chat/completions",
      { model: "x", messages: [] },
      { authorization: "Bearer synthetic-request-capauth" },
    );
    assert.notEqual(rotated.status, 403);
    assert.equal(
      calls.at(-1).headers["x-sklegal-service-authorization"],
      "Bearer synthetic-service-rotated",
    );

    rmSync(serviceCredential, { force: true });
    const before = calls.length;
    const denied = await httpResponse(
      "POST",
      SKLEGAL_PORT,
      "/v1/chat/completions",
      { model: "x", messages: [] },
      { authorization: "Bearer synthetic-request-capauth" },
    );
    assert.equal(denied.status, 403);
    assert.equal(calls.length, before);

    writeFileSync(serviceCredential, "synthetic-service-restored", { mode: 0o600 });
    chmodSync(serviceCredential, 0o600);
    assert.doesNotMatch(handle.out, /synthetic-service-(secret|rotated|restored)/);
    assert.doesNotMatch(handle.child.spawnargs.join(" "), /synthetic-service-(secret|rotated|restored)/);
  });

  test("malformed or expanded responses deny without leakage", async () => {
    for (const responseMode of ["malformed", "leak"]) {
      mode = responseMode;
      const response = await httpResponse(
        "POST",
        SKLEGAL_PORT,
        "/v1/chat/completions",
        { model: "x", messages: [] },
        { authorization: "Bearer synthetic-request-capauth" },
      );
      assert.equal(response.status, 403);
      const text = await response.text();
      assert.doesNotMatch(text, /protected-synthetic-content|synthetic-service-secret|synthetic-request-capauth/);
    }
  });

  test("an unavailable PDP fails closed", async () => {
    await new Promise((resolveClose) => pdp.close(resolveClose));
    const response = await httpResponse(
      "POST",
      SKLEGAL_PORT,
      "/v1/chat/completions",
      { model: "x", messages: [] },
      { authorization: "Bearer synthetic-request-capauth" },
    );
    assert.equal(response.status, 403);
  });
});
