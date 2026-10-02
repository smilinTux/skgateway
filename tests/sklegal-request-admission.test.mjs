import { test } from "node:test";
import assert from "node:assert/strict";
import { createSkLegalRequestAdmission } from "../src/policy/sklegal_request_admission.mjs";

const body = Buffer.from(JSON.stringify({ model: "x", messages: [{ role: "user", content: "synthetic" }] }));
test("fixed windows start on first admission, deny exactly at eight and reset at elapsed window", () => {
  let time = 100000;
  const admit = createSkLegalRequestAdmission({ model_only: true, max_requests: 8, window_ms: 60000 }, () => time);
  for (let i = 0; i < 8; i++) assert.equal(admit(body), null);
  assert.deepEqual(admit(body), { status: 429, code: "request_rate_limited", message: "Request admission limit reached", retryAfter: 60 });
  time += 59001;
  assert.equal(admit(body).retryAfter, 1);
  time += 999;
  assert.equal(admit(body), null);
  for (let i = 0; i < 7; i++) assert.equal(admit(body), null);
  assert.equal(admit(body).status, 429);
});

test("invalid model-only requests never spend admission budget", () => {
  const admit = createSkLegalRequestAdmission({ model_only: true, max_requests: 1, window_ms: 60000 });
  for (const value of [null, [], "bad", { messages: null }, { messages: [null] },
    { messages: [], tools: [] }, { messages: [{ role: "tool", content: "synthetic" }] }]) {
    assert.equal(admit(Buffer.from(JSON.stringify(value))).status, 403);
  }
  assert.equal(admit(Buffer.from("invalid-json")).status, 403);
  assert.equal(admit(body), null);
  assert.equal(admit(body).status, 429);
});
