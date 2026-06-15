/**
 * skgateway ⇄ skcapstone — optional integration bridge (polyglot, file-based).
 *
 * skgateway is a Node service and cannot import the Python `skcapstone.sdk`,
 * so this bridge integrates the *same way the Python SDK actually works* —
 * by writing to the shared, Syncthing-synced file tree under
 * `~/.skcapstone` (zero-broker, daemon-independent).  When that tree is
 * present (and `SK_STANDALONE` is unset) gateway SIEM events are shared on the
 * mesh-wide sk-alert bus and skgateway advertises itself to service discovery.
 * When it is absent, everything degrades to skgateway's native logging.
 *
 * Message + registry formats mirror skcapstone's `pubsub.PubSub.publish` and
 * `sdk.register_service`, so a Python consumer (`skcapstone alerts`,
 * `service_health`) reads them transparently.  See
 * skcapstone/docs/ADR-optional-integration-backbone.md (§3.5 polyglot bridge).
 *
 * Topic convention: `skgateway.<severity>` (severity ∈ info|warn|error|
 * critical); the SIEM event type travels in the payload `event` field.
 *
 * @module integration
 */

import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const SERVICE = "skgateway";

/** sk-alert levels worth forwarding to the shared bus (info is dropped). */
const NOTIFY_LEVELS = new Set(["warn", "error", "critical"]);

/** skgateway SIEM severity → canonical sk-alert level. */
const SEVERITY_TO_LEVEL = {
  info: "info",
  warning: "warn",
  error: "error",
  critical: "critical",
};

/** Resolve the shared skcapstone root, honouring SKCAPSTONE_HOME. */
function sharedHome() {
  return process.env.SKCAPSTONE_HOME || join(homedir(), ".skcapstone");
}

/** Mirror skcapstone.pubsub._sanitize_topic for filesystem-safe topic dirs. */
function sanitizeTopic(topic) {
  return topic.split("/").join("--").split(" ").join("_");
}

/**
 * Whether skcapstone integration should be used from this process.
 * True iff SK_STANDALONE is unset and the shared home tree exists.
 * @returns {boolean}
 */
export function isPresent() {
  if (process.env.SK_STANDALONE) return false;
  try {
    return existsSync(sharedHome());
  } catch {
    return false;
  }
}

/** Map a skgateway SIEM severity to an sk-alert level. */
export function levelForSeverity(severity) {
  return SEVERITY_TO_LEVEL[String(severity || "").toLowerCase()] || "warn";
}

/** Atomic JSON write (temp + rename), mirroring the Python side. */
function atomicWriteJson(dir, filename, obj) {
  mkdirSync(dir, { recursive: true });
  const finalPath = join(dir, filename);
  const tmpPath = join(dir, `.${filename}.${randomUUID().slice(0, 8)}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
  renameSync(tmpPath, finalPath);
  return finalPath;
}

/**
 * Publish an alert to the shared sk-alert bus when present, else log locally.
 *
 * @param {string} event     SIEM event type / name (stored in payload.event).
 * @param {object} [payload] JSON-serialisable detail body.
 * @param {string} [level]   info | warn | error | critical.
 * @returns {boolean} true if published to the shared bus, false on fallback.
 */
export function alert(event, payload = {}, level = "info") {
  const body = { event, ...payload };
  if (isPresent()) {
    try {
      const topic = `${SERVICE}.${level}`;
      const id = randomUUID().slice(0, 12);
      const msg = {
        message_id: id,
        topic,
        sender: SERVICE,
        payload: body,
        published_at: new Date().toISOString(),
        ttl_seconds: 86400,
        tags: [level],
      };
      const dir = join(sharedHome(), "pubsub", "topics", sanitizeTopic(topic));
      atomicWriteJson(dir, `msg-${id}.json`, msg);
      return true;
    } catch (e) {
      process.stderr.write(`[skgateway:integration] sk-alert publish failed: ${e.message}\n`);
    }
  }
  // native fallback — structured log at the matching level
  const line = `[${SERVICE}.${level}] ${JSON.stringify(body)}`;
  if (level === "error" || level === "critical") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
  return false;
}

/**
 * Forward a skgateway SIEM event to the shared bus, gated by severity.
 * Routine `info` events are dropped to avoid flooding the mesh; warn and
 * above (rate limits, upstream/backend errors, policy blocks) are shared.
 *
 * @param {{event_type?:string, severity?:string, details?:object}} evt
 * @returns {boolean} true if forwarded to the shared bus.
 */
export function forwardSiemEvent(evt) {
  if (!evt || typeof evt !== "object") return false;
  const level = levelForSeverity(evt.severity);
  if (!NOTIFY_LEVELS.has(level)) return false;
  const { event_type, severity, details, ...rest } = evt;
  return alert(event_type || "siem_event", { severity, ...details, ...rest }, level);
}

/**
 * Advertise skgateway to skcapstone's discovery registry when present.
 *
 * @param {{healthUrl?:string, pidFile?:string}} [opts]
 * @returns {boolean} true if registered.
 */
export function registerService({ healthUrl = null, pidFile = null } = {}) {
  if (!isPresent()) return false;
  try {
    const entry = {
      name: SERVICE,
      health_url: healthUrl,
      pid_file: pidFile,
      registered_by: SERVICE,
      registered_at: new Date().toISOString(),
    };
    atomicWriteJson(join(sharedHome(), "registry"), `${SERVICE}.json`, entry);
    return true;
  } catch (e) {
    process.stderr.write(`[skgateway:integration] register failed: ${e.message}\n`);
    return false;
  }
}
