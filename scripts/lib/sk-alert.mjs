/**
 * sk-alert.mjs - the ONE real invocation path to the fleet's sk-alert binary.
 *
 * Card a7f65226. There is a standing fleet incident
 * (~/.claude/projects/-home-cbrd21-clawd/memory/sk-alert-never-fired-from-schedulers.md,
 * skos #24 / card 95a3b69e) where sk-cron-run's realtime-alert branch NEVER
 * fired for any scheduled job, because of two silent failures stacked on one
 * line: (1) `command -v sk-alert` evaluated false under a scheduler's PATH
 * (`~/.skenv/bin` is on an interactive shell's PATH, not cron's or a systemd
 * user unit's), and (2) the message was piped to sk-alert, which does not
 * read stdin - it takes the message as an ARGUMENT and rejects an empty one.
 *
 * This module copies the WORKING invocation already used elsewhere in the
 * fleet rather than inventing a new one:
 *   - Python: skcapstone/src/skcapstone/fleet/alerts.py, gfs_backup.py,
 *     scheduled_tasks.py all do
 *       shutil.which("sk-alert") or os.path.expanduser("~/.skenv/bin/sk-alert")
 *   - Bash: skos/scripts/sk-cron-run.sh and clawd/scripts/battery-cycle-watch.sh
 *     resolve the same absolute path and pass the message as argv, never stdin.
 *
 * Same discipline here: resolve an ABSOLUTE path (PATH-independent), pass the
 * message as an argv element (never stdin), never throw into the caller.
 *
 * @module scripts/lib/sk-alert
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Default absolute install location (symlink to ~/.hermes/scripts/lib/skalert.sh). */
export const DEFAULT_SK_ALERT_BIN = join(homedir(), ".skenv", "bin", "sk-alert");

/**
 * Resolve sk-alert to an absolute, PATH-independent path. Honors
 * SK_ALERT_BIN (test/override hook, same env name sk-cron-run.sh uses),
 * then the well-known ~/.skenv/bin/sk-alert install location. Deliberately
 * does NOT fall back to a bare `command -v` / PATH lookup as the only
 * resolution strategy - that is the exact guard that silently evaluated
 * false from every scheduler.
 *
 * @returns {string|null} absolute path if resolvable, else null.
 */
export function resolveSkAlertBin() {
  const override = process.env.SK_ALERT_BIN;
  if (override && existsSync(override)) return override;
  if (existsSync(DEFAULT_SK_ALERT_BIN)) return DEFAULT_SK_ALERT_BIN;
  return null;
}

/**
 * Fire one sk-alert (a real Telegram DM to Chef when a bin resolves).
 * Never throws: failures are reported in the return value only, exactly like
 * fleet/alerts.py's send_alert(), so a broken alert path can never itself
 * take down the verification job.
 *
 * @param {object} args
 * @param {string} args.message           the alert body (sent as an ARGUMENT)
 * @param {"info"|"warn"|"crit"} [args.level="warn"]
 * @param {string} [args.key]             sk-alert dedupe key (-k)
 * @param {number} [args.ttlSeconds]      dedupe re-arm window in seconds (-t); omitted = once-ever
 * @param {number} [args.timeoutMs=30000]
 * @param {(cmd:string, args:string[], opts:object) => Promise<{stdout:string,stderr:string}>} [args.execImpl]
 * @param {() => string|null} [args.resolveBinImpl]  override point for tests; defaults to resolveSkAlertBin()
 * @returns {Promise<{fired:boolean, bin:string|null, reason?:string}>}
 */
export async function fireSkAlert({
  message,
  level = "warn",
  key,
  ttlSeconds,
  timeoutMs = 30000,
  execImpl = execFileAsync,
  resolveBinImpl = resolveSkAlertBin,
} = {}) {
  if (!message || !String(message).trim()) {
    return { fired: false, bin: null, reason: "empty message" };
  }
  const bin = resolveBinImpl();
  if (!bin) {
    return { fired: false, bin: null, reason: "sk-alert not found at an absolute path" };
  }
  const argv = ["-l", level];
  if (key) argv.push("-k", key);
  if (ttlSeconds) argv.push("-t", String(ttlSeconds));
  argv.push(message); // argument, never stdin
  try {
    await execImpl(bin, argv, { timeout: timeoutMs });
    return { fired: true, bin };
  } catch (e) {
    return { fired: false, bin, reason: e.message };
  }
}
