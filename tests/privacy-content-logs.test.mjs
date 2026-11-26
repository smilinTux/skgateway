/**
 * privacy-content-logs.test.mjs: the privacy.content_logs switch in isolation.
 * Config validation, the log helpers, the metering-client rule and the
 * core.mjs log sites that the live gateway test cannot reach (they belong to
 * the standalone proxy in core.mjs/handleRequest).
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.mjs";
import { setContentLogs, contentLogsOn, logText, logError } from "../src/privacy.mjs";
import { meteringClient } from "../src/policy/client-guard.mjs";
import { normalizeSuccessfulResponse } from "../src/proxy/core.mjs";

const CANARY = "PRIVCANARY"; // ten chars: a JSON SyntaxError quotes the first ten of its input
afterEach(() => setContentLogs(true));

async function configWith(yaml) {
  const dir = mkdtempSync(join(tmpdir(), "skgw-privacy-cfg-"));
  const path = join(dir, "gw.yaml");
  writeFileSync(path, [
    "backends:", "  stub:", "    url: http://127.0.0.1:9/v1", "    auth_type: none", "    models: [m]", "    priority: 1",
    ...yaml,
  ].join("\n") + "\n");
  return (await loadConfig({ configPath: path, silent: true })).current();
}

test("privacy.content_logs defaults to true and accepts false", async () => {
  assert.equal((await configWith([])).privacy.content_logs, true);
  assert.equal((await configWith(["privacy:", "  content_logs: false"])).privacy.content_logs, false);
});

test("privacy.content_logs must be a boolean", async () => {
  await assert.rejects(configWith(["privacy:", "  content_logs: \"no\""]), /privacy\.content_logs must be a boolean/);
});

test("logText and logError keep text when on and only its size and class when off", () => {
  assert.equal(contentLogsOn(), true);
  assert.equal(logText(`a ${CANARY} b`, 5), `a ${CANARY}`.slice(0, 5));
  let err;
  try { JSON.parse(`${CANARY} not json`); } catch (e) { err = e; }
  assert.match(logError(err), new RegExp(CANARY), "V8 quotes the input in a JSON SyntaxError");
  setContentLogs(false);
  assert.equal(contentLogsOn(), false);
  assert.equal(logText(`a ${CANARY} b`, 5), "[14 chars withheld]");
  assert.equal(logText(undefined), "[0 chars withheld]");
  assert.equal(logError(err), "SyntaxError");
  assert.equal(logError(Object.assign(new Error(CANARY), { code: "ECONNRESET" })), "Error code=ECONNRESET");
});

test("meteringClient: the verified client id under client_auth, x-app otherwise", () => {
  const headers = { "x-app": "someone-else" };
  assert.equal(meteringClient(headers, { method: "client_auth", client_id: "sk-aaaaaaaaaaaa" }), "sk-aaaaaaaaaaaa");
  assert.equal(meteringClient(headers, { method: "header", client_id: "sk-aaaaaaaaaaaa" }), "someone-else");
  assert.equal(meteringClient(headers, undefined), "someone-else");
  assert.equal(meteringClient({}, null), "untagged");
});

test("core: suppressed reasoning is quoted when on and only counted when off", () => {
  const run = () => {
    const lines = [];
    const cfg = { logger: { log: (m) => lines.push(m) }, sanitizer: (s) => s, reasoningPromoteThreshold: 1000, emptyResponseFallback: "x" };
    normalizeSuccessfulResponse({ choices: [{ message: { content: "", reasoning: `short ${CANARY}` }, finish_reason: "stop" }] }, cfg);
    return lines.join("\n");
  };
  assert.match(run(), new RegExp(CANARY));
  setContentLogs(false);
  const off = run();
  assert.doesNotMatch(off, new RegExp(CANARY));
  assert.match(off, /suppressed short reasoning \(16 chars\)/);
});
