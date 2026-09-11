import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.mjs";
import { createRouter, routeAndSend, configuredModelAlias } from "../src/proxy/router.mjs";

const ALIAS = "qwen3.8-27b";
const EXACT = "qwen3.8-27b-huihui-abliterated-q4_k_m";

test("configured aliases are translated before backend selection and forwarding", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "skgateway-alias-"));
  const path = join(dir, "skgateway.yaml");
  writeFileSync(path, `model_aliases:\n  ${ALIAS}: ${EXACT}\n`);
  await loadConfig({ configPath: path, silent: true });

  let upstreamModel = null;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      upstreamModel = JSON.parse(raw).model;
      const status = upstreamModel === EXACT ? 200 : 404;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200
        ? { model: EXACT, choices: [{ message: { content: "ok" } }] }
        : { error: { message: "model does not exist" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const router = createRouter({ backends: { local: {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    auth_type: "none",
    models: [EXACT],
  } } });
  const result = await routeAndSend(
    router,
    { model: ALIAS, agentId: "alias-parity-test" },
    "/chat/completions",
    "POST",
    { "content-type": "application/json" },
    Buffer.from(JSON.stringify({ model: ALIAS, messages: [] })),
    false,
  );

  assert.equal(result.status, 200);
  assert.equal(upstreamModel, EXACT);
  assert.equal(result.requestedModel, ALIAS);
});

test("exact model ids and invalid alias declarations remain untouched", () => {
  assert.equal(configuredModelAlias(EXACT, { model_aliases: { [ALIAS]: EXACT } }), null);
  assert.equal(configuredModelAlias(ALIAS, { model_aliases: { [ALIAS]: ALIAS } }), null);
});
