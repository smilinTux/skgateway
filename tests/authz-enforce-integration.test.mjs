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
function bootGateway({ port, dashPort, env, extraConfig = [], backends = ["backends: {}"] }) {
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
      ...backends,
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
        resolveBoot({ child, dir, get out() { return out; } });
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

test('native dynamic selectors reach the strict PDP through the actual server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skgw-native-'));
  const credential = join(dir, 'service-token');
  writeFileSync(credential, 'synthetic-service', { mode: 0o600 });
  const calls = [];
  const pdp = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ authorization: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ allow: false, reason: 'capability_denied', obligations: [] }));
  });
  let handle;
  try {
    await new Promise(resolveListen => pdp.listen(18951, '127.0.0.1', resolveListen));
    handle = await bootGateway({ port: 18952, dashPort: 18953,
      env: { SKGATEWAY_AUTHZ_ENFORCE: '1' },
      extraConfig: ['authz:', '  enforce: true', '  trust_internal: true',
        '  sklegal_qualification:', '    enabled: true',
        '    url: http://127.0.0.1:18951/v1/authz/decide',
        `    service_credential_file: ${credential}`, '    routes:',
        '      - method: POST', '        path: /v1/chat/completions',
        '        request_capability: true', '        subject: synthetic-agent',
        '        model_route: local_qwen',
        '        resource: {tenant_id: tenant, matter_id: matter, route_id: governed-corpus-qwen}',
        '        context: {purpose: legal_research, classification: public, privilege: none, ethical_wall: clear}',
      ],
    });
    for (const id of ['first-material', 'second-material']) {
      const authorization = 'Bearer ' + JSON.stringify({ skcapstone_token: '1.0',
        signature: '-----BEGIN PGP SIGNATURE-----\nsynthetic', payload: { metadata: {
          sklegal_capability: { principal: { subject: 'synthetic-agent' }, grant: {
            audience: 'model', tenant_id: 'tenant', matter_id: 'matter',
            resource_id: id, resource_version: 1, model_route: 'local_qwen', purpose: 'legal_research',
          } },
        } },
      });
      const response = await httpResponse('POST', 18952, '/v1/chat/completions',
        { model: 'x', messages: [] }, { authorization });
      assert.equal(response.status, 403);
      assert.equal(calls.at(-1).body.resource.material_id, id);
      assert.equal(calls.at(-1).body.resource.route_id, 'governed-corpus-qwen');
      assert.equal(calls.at(-1).authorization, authorization);
    }
    assert.equal(calls.length, 2);
    const missing = await httpResponse('POST', 18952, '/v1/chat/completions', { model: 'x', messages: [] });
    assert.equal(missing.status, 403);
    assert.equal(calls.length, 2);
  } finally {
    stop(handle);
    if (pdp.listening) await new Promise(resolveClose => pdp.close(resolveClose));
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SKLegal governed qualification wire contract on the live server", () => {
  let handle;
  let pdp;
  let backend;
  let dispatches = 0;
  let credentialDir;
  let serviceCredential;
  let mode = "allow";
  const calls = [];

  before(async () => {
    backend = createServer((req, res) => {
      if (req.method === "POST") dispatches++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "synthetic" } }] }));
    });
    await new Promise(resolveListen => backend.listen(0, "127.0.0.1", resolveListen));
    credentialDir = mkdtempSync(join(tmpdir(), "skgw-authz-credential-"));
    serviceCredential = join(credentialDir, "skgateway-authz-service-token");
    writeFileSync(serviceCredential, "synthetic-service-secret", { mode: 0o600 });
    chmodSync(serviceCredential, 0o600);
    pdp = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      calls.push({ headers: req.headers, body: JSON.parse(raw) });
      if (mode === "timeout") return;
      if (mode === "body-timeout") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"allow":');
        return;
      }
      if (["503", "500", "401", "403"].includes(mode)) {
        res.writeHead(Number(mode), { "content-type": "application/json" });
        res.end(JSON.stringify({ secret: "private-upstream-body" }));
        return;
      }
      if (mode === "invalid-json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("private-invalid-json");
        return;
      }
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
      backends: ["backends:", "  synthetic:", `    url: http://127.0.0.1:${backend.address().port}/v1`,
        "    auth_type: none", "    models: [x]", "    priority: 1"],
      extraConfig: [
        "authz:",
        "  enforce: true",
        "  trust_internal: true",
        "  sklegal_qualification:",
        "    enabled: true",
        "    timeout_ms: 250",
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
    if (backend?.listening) await new Promise(resolveClose => backend.close(resolveClose));
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

  test("every high-bit credential byte denies before PDP or provider dispatch", async () => {
    mode = "allow";
    const before = calls.length;
    for (let byte = 0x80; byte <= 0xff; byte++) {
      writeFileSync(serviceCredential, Buffer.from([0x41, byte, 0x42]), { mode: 0o600 });
      chmodSync(serviceCredential, 0o600);
      const denied = await httpResponse(
        "POST",
        SKLEGAL_PORT,
        "/v1/chat/completions",
        { model: "x", messages: [] },
        { authorization: "Bearer synthetic-request-capauth" },
      );
      assert.equal(denied.status, 503, `byte 0x${byte.toString(16)} must fail closed`);
      assert.equal(calls.length, before, "unsafe credential must not reach the PDP");
    }
    writeFileSync(serviceCredential, "synthetic-service-secret", { mode: 0o600 });
    chmodSync(serviceCredential, 0o600);
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
    assert.equal(denied.status, 503);
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
      assert.equal(response.status, 503);
      const text = await response.text();
      assert.doesNotMatch(text, /protected-synthetic-content|synthetic-service-secret|synthetic-request-capauth/);
    }
  });

  test("outages return 503, bounded denials return 403, and neither dispatches", async () => {
    const before = dispatches;
    assert.ok(before > 0, "allow scenarios must prove the synthetic backend is reachable");
    for (const [responseMode, status] of [
      ["503", 503], ["500", 503], ["timeout", 503], ["body-timeout", 503],
      ["invalid-json", 503], ["malformed", 503], ["leak", 503],
      ["deny", 403], ["401", 403], ["403", 403],
    ]) {
      mode = responseMode;
      const response = await httpResponse("POST", SKLEGAL_PORT, "/v1/chat/completions",
        { model: "x", messages: [{ role: "user", content: "private-request-prompt" }] },
        { authorization: "Bearer synthetic-request-capauth" });
      const body = await response.json();
      assert.equal(response.status, status, responseMode);
      assert.equal(body.error.code, status, responseMode);
      assert.equal(dispatches, before, responseMode);
      assert.doesNotMatch(JSON.stringify(body) + handle.out,
        /private-upstream-body|private-invalid-json|protected-synthetic-content|synthetic-service-(secret|restored)|synthetic-request-capauth|private-request-prompt/);
      assert.equal(calls.at(-1).headers.authorization, "Bearer synthetic-request-capauth");
      assert.doesNotMatch(JSON.stringify(calls.at(-1).body), /private-request-prompt/);
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
    assert.equal(response.status, 503);
  });
});

async function governedAdmissionFixture(policy = { model_only: true, max_requests: 8, window_ms: 60000 }, enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), "skgw-admission-"));
  const credential = join(directory, "service-token");
  writeFileSync(credential, "synthetic-admission-secret", { mode: 0o600 });
  const fixture = { mode: "allow", dispatches: 0, pdpCalls: [], logs: "" };
  const backend = createServer((req, res) => {
    if (req.method === "POST") fixture.dispatches++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "synthetic" } }] }));
  });
  const pdp = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    fixture.pdpCalls.push({ headers: req.headers, body: JSON.parse(raw) });
    res.writeHead(fixture.mode === "outage" ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(fixture.mode === "outage" ? { secret: "private-admission-upstream" }
      : { allow: fixture.mode === "allow", reason: fixture.mode === "allow" ? "allow" : "policy_denied", obligations: [] }));
  });
  for (const server of [backend, pdp]) await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const scopes = [
    { tenant_id: "tenant-a", matter_id: "matter-a", purpose: "research" },
    { tenant_id: "tenant-a", matter_id: "matter-a", purpose: "draft" },
    { tenant_id: "tenant-a", matter_id: "matter-b", purpose: "research" },
    { tenant_id: "tenant-b", matter_id: "matter-b", purpose: "research" },
  ];
  const config = {
    enforce: true, trust_internal: true,
    sklegal_qualification: { enabled: true, url: `http://127.0.0.1:${pdp.address().port}/v1/authz/decide`,
      service_credential_file: credential,
      routes: scopes.map(({ purpose, ...scope }) => ({ method: "POST", path: "/v1/chat/completions",
        subject: "synthetic-agent", request_capability: true, model_route: "local_qwen",
        resource: { ...scope, route_id: "governed-corpus-qwen" },
        context: { purpose, classification: "public", privilege: "none", ethical_wall: "clear" }, request_policy: policy })) },
  };
  let handle;
  async function shutdown() {
    if (!handle) return;
    fixture.logs += handle.out;
    const exited = new Promise(resolveExit => handle.child.once("exit", resolveExit));
    stop(handle);
    await exited;
    handle = null;
  }
  fixture.restart = async () => {
    await shutdown();
    handle = await bootGateway({ port: 18954, dashPort: 18955,
      env: { SKGATEWAY_AUTHZ_ENFORCE: enabled ? "1" : "0", SKLEGAL_AUTHZ_SERVICE_TOKEN: undefined },
      backends: ["backends:", "  synthetic:", `    url: http://127.0.0.1:${backend.address().port}/v1`,
        "    auth_type: none", "    models: [x]", "    priority: 1"],
      extraConfig: ["authz: " + JSON.stringify(config)],
    });
  };
  let material = 0;
  fixture.request = async (scopeIndex = 0, overrides = {}) => {
    const materialId = "material-" + material++;
    const authorization = "Bearer " + JSON.stringify({ payload: { metadata: { sklegal_capability: {
      principal: { subject: "synthetic-agent" }, grant: { audience: "model", ...scopes[scopeIndex],
        resource_id: materialId, resource_version: 1, model_route: "local_qwen" },
    } } } });
    const response = await httpResponse("POST", 18954, "/v1/chat/completions",
      { model: "x", messages: [{ role: "user", content: "private-admission-prompt" }], ...overrides },
      { authorization, "x-sklegal-tenant-id": "forged-tenant", "x-agent-id": "forged-agent" });
    const body = await response.json();
    assert.doesNotMatch(JSON.stringify(body) + handle.out, /synthetic-admission-secret|private-admission-upstream|private-admission-prompt|private-tool-argument|sklegal_capability/);
    if (enabled) assert.equal(fixture.pdpCalls.find(call => call.body.resource.material_id === materialId)?.headers.authorization, authorization);
    return { response, body };
  };
  fixture.close = async () => {
    await shutdown();
    for (const server of [backend, pdp]) await new Promise(resolveClose => server.close(resolveClose));
    rmSync(directory, { recursive: true, force: true });
  };
  await fixture.restart();
  return fixture;
}

test("native governed model-only controls reject every tool form without dispatch or budget consumption", async () => {
  const fixture = await governedAdmissionFixture();
  try {
    const toolForms = [
      ...["tools", "tool_choice", "parallel_tool_calls", "functions", "function_call"].flatMap(key => [{ [key]: [] }, { [key]: null }]),
      ...["tool", "toolResult", "function"].map(role => ({ messages: [{ role, content: "private-tool-argument" }] })),
      ...["tool_calls", "tool_call_id", "function_call"].map(key => ({ messages: [{ role: "assistant", [key]: "private-tool-argument" }] })),
      ...["tool_use", "tool_result", "function_call", "function_call_output"].map(type => ({ messages: [{ role: "user", content: [{ type, text: "private-tool-argument" }] }] })),
    ];
    for (const body of toolForms) {
      const denied = await fixture.request(0, body);
      assert.equal(denied.response.status, 403);
      assert.equal(denied.body.error.code, "model_only_required");
    }
    assert.equal(fixture.dispatches, 0);
    for (let i = 0; i < 8; i++) assert.equal((await fixture.request()).response.status, 200);
    const limited = await fixture.request();
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body.error.code, "request_rate_limited");
    assert.ok(Number(limited.response.headers.get("retry-after")) >= 1);
    assert.ok(Number(limited.response.headers.get("retry-after")) <= 60);
    assert.equal(fixture.dispatches, 8);
    // A different purpose, Matter or Tenant has its own trusted budget.
    const concurrent = await Promise.all(Array.from({ length: 10 }, () => fixture.request(1)));
    assert.equal(concurrent.filter(row => row.response.status === 200).length, 8);
    assert.equal(concurrent.filter(row => row.response.status === 429).length, 2);
    for (const scope of [2, 3]) assert.equal((await fixture.request(scope)).response.status, 200);
    assert.equal(fixture.dispatches, 18);
    for (const [mode, status] of [["deny", 403], ["outage", 503]]) {
      fixture.mode = mode;
      assert.equal((await fixture.request()).response.status, status);
    }
    assert.equal(fixture.dispatches, 18);
    fixture.mode = "allow";
    await fixture.restart();
    assert.equal((await fixture.request()).response.status, 200, "process restart explicitly resets local admission");
    assert.equal(fixture.dispatches, 19);
    assert.doesNotMatch(JSON.stringify(fixture.pdpCalls.map(call => call.body)), /private-admission-prompt|private-tool-argument/);
  } finally { await fixture.close(); }
});

test("native governed rate window recovers after elapsed monotonic time", async () => {
  const fixture = await governedAdmissionFixture({ model_only: true, max_requests: 1, window_ms: 250 });
  try {
    assert.equal((await fixture.request()).response.status, 200);
    assert.equal((await fixture.request()).response.status, 429);
    await new Promise(resolveWait => setTimeout(resolveWait, 300));
    assert.equal((await fixture.request()).response.status, 200);
    assert.equal(fixture.dispatches, 2);
  } finally { await fixture.close(); }
});

test("flag-off leaves native tool requests and request admission unchanged", async () => {
  const fixture = await governedAdmissionFixture({ model_only: true, max_requests: 1, window_ms: 60000 }, false);
  try {
    for (let i = 0; i < 2; i++) assert.equal((await fixture.request(0, { tools: [] })).response.status, 200);
    assert.equal(fixture.pdpCalls.length, 0);
    assert.equal(fixture.dispatches, 2);
  } finally { await fixture.close(); }
});
