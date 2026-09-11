import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const originalFsync = fs.fsyncSync;
fs.fsyncSync = function crashAfterSourceFsync(fd) {
  const result = originalFsync.call(this, fd);
  const path = fs.readlinkSync(`/proc/self/fd/${fd}`), phase = process.env.SKGW_TEST_CRASH_PHASE;
  if ((phase === "preappend" && path.endsWith(".journal")) || (phase === "postfsync" && path === process.env.SKGW_TEST_CRASH_SOURCE) || (phase === "precommit" && path.endsWith(".json"))) process.kill(process.pid, "SIGKILL");
  return result;
};
const originalWrite = fs.writeFileSync;
fs.writeFileSync = function crashAfterSourceAppend(target, ...args) {
  const result = originalWrite.call(this, target, ...args);
  if (process.env.SKGW_TEST_CRASH_PHASE === "postappend" && typeof target === "number" && fs.readlinkSync(`/proc/self/fd/${target}`) === process.env.SKGW_TEST_CRASH_SOURCE) process.kill(process.pid, "SIGKILL");
  return result;
};
syncBuiltinESMExports();
