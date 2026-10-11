#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const DEFAULT_FILE_TIMEOUT_MS = 120_000;

export function runTestFile(file, { timeoutMs = DEFAULT_FILE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const { NODE_TEST_CONTEXT: _parentTestContext, ...env } = process.env;
    const child = spawn(process.execPath, ["--test", "--import", "./tests/_setup.mjs", file], {
      detached: process.platform !== "win32",
      env,
      stdio: "inherit",
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ file, classification: "runner_error", exitCode: null, error: error.message });
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        file,
        classification: timedOut ? "timeout" : exitCode === 0 ? "pass" : "test_failure",
        exitCode,
        signal,
      });
    });
  });
}

export async function main({ timeoutMs = Number(process.env.SKGATEWAY_TEST_FILE_TIMEOUT_MS) || DEFAULT_FILE_TIMEOUT_MS } = {}) {
  const files = (await readdir("tests"))
    .filter((file) => file.endsWith(".test.mjs"))
    .sort()
    .map((file) => `tests/${file}`);

  for (const file of files) {
    const result = await runTestFile(file, { timeoutMs });
    process.stderr.write(`${JSON.stringify(result)}\n`);
    if (result.classification !== "pass") return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
