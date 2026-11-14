import { test } from "node:test";
import assert from "node:assert/strict";
import { runTestFile } from "../scripts/test-per-file.mjs";

test("per-file runner reports pass", async () => {
  const result = await runTestFile("tests/fixtures/runner-pass.mjs", { timeoutMs: 500 });
  assert.equal(result.classification, "pass");
});

test("per-file runner reports failure and timeout with exact file", async () => {
  const failure = await runTestFile("tests/fixtures/runner-fail.mjs", { timeoutMs: 500 });
  assert.equal(failure.classification, "test_failure");
  assert.equal(failure.file, "tests/fixtures/runner-fail.mjs");

  const timeout = await runTestFile("tests/fixtures/runner-hang.mjs", { timeoutMs: 50 });
  assert.equal(timeout.classification, "timeout");
  assert.equal(timeout.file, "tests/fixtures/runner-hang.mjs");
});
