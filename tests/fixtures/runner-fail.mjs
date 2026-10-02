import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { closeTestServer } from "../support/http-test-server.mjs";

test("assertion failure still cleans up its server", async (t) => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeTestServer(server, { timeoutMs: 50 }));
  assert.fail("synthetic failure");
});
