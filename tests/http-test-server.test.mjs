import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { closeTestServer } from "./support/http-test-server.mjs";

test("closeTestServer bounds a retained HTTP connection", async () => {
  const server = http.createServer((_req, res) => res.write("open"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const socket = net.connect(server.address().port, "127.0.0.1");
  socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n");
  await new Promise((resolve) => socket.once("data", resolve));

  const started = Date.now();
  const result = await closeTestServer(server, { timeoutMs: 50 });
  assert.equal(result.forced, true);
  assert.ok(Date.now() - started < 500);
  socket.destroy();
});

test("closeTestServer completes normally without retained connections", async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  assert.deepEqual(await closeTestServer(server, { timeoutMs: 50 }), { forced: false });
});
