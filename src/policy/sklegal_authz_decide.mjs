/**
 * Strict two-credential client for the SKLegal authorization adapter.
 *
 * This client is separate from the generic SKGateway PDP client. It accepts
 * only exact configured scope, forwards no request content, validates a narrow
 * response, and never caches a decision.
 */

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_CREDENTIAL_MAX_AGE_MS = 5 * 60 * 1000;
const MAX_CREDENTIAL_BYTES = 8 * 1024;
const MAX_TEXT = 256;
const MAX_OBLIGATIONS = 16;
const SYSTEMD_CREDENTIALS_ROOT = "/run/credentials";
const SKLEGAL_QUALIFICATION_UNIT = "skgateway-sklegal-qualification.service";
const SKLEGAL_CREDENTIAL_NAME = "skgateway-authz-service-token";

export const SKLEGAL_SERVICE_AUTHORIZATION_HEADER = "X-SKLegal-Service-Authorization";

const RESPONSE_FIELDS = new Set([
  "allow",
  "reason",
  "decision_id",
  "policy_revision",
  "correlation_id",
  "obligations",
]);
const REQUIRED_RESPONSE_FIELDS = new Set(["allow", "reason", "obligations"]);
const DECISION_REASONS = new Set([
  "allow",
  "policy_denied",
  "capability_denied",
  "audit_unavailable",
]);
const RESOURCE_FIELDS = [
  "tenant_id",
  "matter_id",
  "material_id",
  "material_version",
  "route_id",
];
const CONTEXT_FIELDS = [
  "purpose",
  "classification",
  "privilege",
  "ethical_wall",
];

function deny(reason) {
  return {
    allow: false,
    reason: `authz_decide fail-closed: ${reason}`,
    decision_id: null,
    policy_revision: null,
    correlation_id: null,
    obligations: [],
  };
}

function isBoundedText(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_TEXT
    && value.trim() === value;
}

function hasExactBoundedFields(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && fields.every((key) => isBoundedText(value[key]));
}

/**
 * Validate and rebuild the narrow response emitted by the SKLegal adapter.
 */
export function validateSkLegalDecisionResponse(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const keys = Object.keys(data);
  if (keys.some((key) => !RESPONSE_FIELDS.has(key))) return null;
  if ([...REQUIRED_RESPONSE_FIELDS].some((key) => !Object.hasOwn(data, key))) return null;
  if (typeof data.allow !== "boolean" || !DECISION_REASONS.has(data.reason)) return null;
  if (data.allow !== (data.reason === "allow")) return null;
  if (!Array.isArray(data.obligations) || data.obligations.length > MAX_OBLIGATIONS) return null;
  if (data.obligations.some((item) => !isBoundedText(item))) return null;

  for (const key of ["decision_id", "policy_revision", "correlation_id"]) {
    if (Object.hasOwn(data, key) && data[key] !== null && !isBoundedText(data[key])) return null;
  }
  return {
    allow: data.allow,
    reason: data.reason,
    decision_id: data.decision_id ?? null,
    policy_revision: data.policy_revision ?? null,
    correlation_id: data.correlation_id ?? null,
    obligations: [...data.obligations],
  };
}

export function resolveSkLegalAuthzUrl(explicit, env = process.env) {
  const raw = (explicit || env.SKLEGAL_CAPAUTH_AUTHZ_ENDPOINT || "").trim();
  if (!raw) return null;
  if (/\/v1\/authz\/decide\/?$/.test(raw)) return raw.replace(/\/$/, "");
  return raw.replace(/\/$/, "") + "/v1/authz/decide";
}

function credentialFileUnavailable() {
  return new Error("SKLegal service credential file is unavailable");
}

function unescapeMountPath(value) {
  return value.replace(/\\(040|011|012|134)/g, (match, octal) =>
    String.fromCharCode(Number.parseInt(octal, 8)));
}

function exactSystemdCredentialMount(mountInfo, directory) {
  if (typeof mountInfo !== "string") return false;
  return mountInfo.trimEnd().split("\n").some((line) => {
    const sections = line.split(" - ");
    if (sections.length !== 2) return false;
    const before = sections[0].split(" ");
    const after = sections[1].split(" ");
    if (before.length < 6 || after.length < 3) return false;
    if (unescapeMountPath(before[4]) !== directory) return false;
    if (!new Set(["ramfs", "tmpfs"]).has(after[0])) return false;
    const mountOptions = new Set(before[5].split(","));
    const superOptions = new Set(after[2].split(","));
    return mountOptions.has("ro")
      && !mountOptions.has("rw")
      && mountOptions.has("nosuid")
      && mountOptions.has("nodev")
      && superOptions.has("ro")
      && !superOptions.has("rw");
  });
}

function exactSystemdServiceCgroup(cgroup, unit) {
  if (typeof cgroup !== "string") return false;
  return cgroup.trimEnd().split("\n").some((line) => {
    const fields = line.split(":");
    if (fields.length !== 3) return false;
    return fields[2].split("/").includes(unit);
  });
}

function isApprovedSystemd0440(file, opened, opts) {
  const root = opts.systemdCredentialsRoot ?? SYSTEMD_CREDENTIALS_ROOT;
  const expectedDirectory = join(root, SKLEGAL_QUALIFICATION_UNIT);
  const credentialDirectory = opts.systemdCredentialDirectory;
  if (
    opened.uid !== BigInt(opts.systemdRootUid ?? 0)
    || resolve(file) !== file
    || credentialDirectory !== expectedDirectory
    || dirname(file) !== expectedDirectory
    || file !== join(expectedDirectory, SKLEGAL_CREDENTIAL_NAME)
  ) return false;
  let directory;
  let cgroup;
  let mountInfo;
  try {
    directory = lstatSync(expectedDirectory, { bigint: true });
    if (!directory.isDirectory()
      || directory.isSymbolicLink()
      || directory.uid !== BigInt(opts.systemdRootUid ?? 0)
      || Number(directory.mode & 0o007n) !== 0) return false;
    cgroup = opts.systemdCgroup ?? readFileSync("/proc/self/cgroup", "utf8");
    mountInfo = opts.systemdMountInfo ?? readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return false;
  }
  return exactSystemdServiceCgroup(cgroup, SKLEGAL_QUALIFICATION_UNIT)
    && exactSystemdCredentialMount(mountInfo, expectedDirectory);
}

/**
 * Read one systemd-compatible service credential without following links or
 * retaining a cross-request value. The optional hooks are test seams only.
 */
export function readSkLegalServiceCredential(file, opts = {}) {
  const now = opts.now ?? Date.now;
  const currentUid = opts.currentUid
    ?? (typeof process.geteuid === "function" ? process.geteuid() : 0);
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_CREDENTIAL_MAX_AGE_MS;
  let descriptor;
  let credential;
  try {
    if (typeof file !== "string" || !isAbsolute(file)) throw credentialFileUnavailable();
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > DEFAULT_CREDENTIAL_MAX_AGE_MS) {
      throw credentialFileUnavailable();
    }
    const before = lstatSync(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw credentialFileUnavailable();
    opts.afterLstat?.();
    descriptor = openSync(
      file,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_CLOEXEC,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    const mode = Number(opened.mode & 0o777n);
    const owner = Number(opened.uid);
    const age = now() - Number(opened.mtimeMs);
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.nlink !== 1n
      || (mode === 0o440
        ? !isApprovedSystemd0440(file, opened, opts)
        : !new Set([0o400, 0o600]).has(mode) || !new Set([0, currentUid]).has(owner))
      || opened.size < 1n
      || opened.size > BigInt(MAX_CREDENTIAL_BYTES)
      || !Number.isFinite(age)
      || age < 0
      || age > maxAgeMs
    ) {
      throw credentialFileUnavailable();
    }
    credential = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs
      || credential.length !== Number(opened.size)
      || credential.some((byte) => byte < 0x21 || byte > 0x7e)
    ) {
      credential.fill(0);
      throw credentialFileUnavailable();
    }
    return credential;
  } catch {
    credential?.fill(0);
    throw credentialFileUnavailable();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function createSkLegalAuthzClient(opts = {}) {
  const env = opts.env || process.env;
  const url = resolveSkLegalAuthzUrl(opts.url, env);
  const qualificationEnabled = opts.qualificationEnabled === true;
  const inlineCredentialConfigured = Object.hasOwn(opts, "serviceToken")
    || Object.hasOwn(env, "SKLEGAL_AUTHZ_SERVICE_TOKEN");
  if (qualificationEnabled && inlineCredentialConfigured) {
    throw new Error("SKLegal qualification forbids environment or inline service credentials");
  }
  const serviceCredentialFile = opts.serviceCredentialFile;
  const serviceCredentialMaxAgeMs = opts.serviceCredentialMaxAgeMs
    ?? DEFAULT_CREDENTIAL_MAX_AGE_MS;
  const legacyServiceToken = qualificationEnabled
    ? ""
    : (opts.serviceToken ?? env.SKLEGAL_AUTHZ_SERVICE_TOKEN ?? "").trim();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const fileConfigured = typeof serviceCredentialFile === "string"
    && isAbsolute(serviceCredentialFile)
    && Number.isSafeInteger(serviceCredentialMaxAgeMs)
    && serviceCredentialMaxAgeMs >= 1
    && serviceCredentialMaxAgeMs <= DEFAULT_CREDENTIAL_MAX_AGE_MS;
  const configured = Boolean(url && (
    qualificationEnabled ? fileConfigured : legacyServiceToken && legacyServiceToken.length <= MAX_CREDENTIAL_BYTES
  ));
  let calls = 0;

  async function decideSkLegal({ subject, capability, resource, context, requestCapAuth } = {}) {
    if (!isBoundedText(subject) || capability !== "skgateway.infer") {
      return deny("invalid subject or capability");
    }
    if (!hasExactBoundedFields(resource, RESOURCE_FIELDS)
      || !hasExactBoundedFields(context, CONTEXT_FIELDS)) {
      return deny("exact SKLegal scope is required");
    }
    if (typeof requestCapAuth !== "string"
      || requestCapAuth.length > 8192
      || !/^Bearer\s+\S+$/i.test(requestCapAuth)) {
      return deny("request-local CapAuth credential is required");
    }
    if (!configured || typeof fetchImpl !== "function") {
      return deny("authorization backend unavailable");
    }

    let credential;
    let serviceAuthorization;
    try {
      if (qualificationEnabled) {
        credential = readSkLegalServiceCredential(serviceCredentialFile, {
          maxAgeMs: serviceCredentialMaxAgeMs,
          systemdCredentialDirectory: env.CREDENTIALS_DIRECTORY,
        });
        serviceAuthorization = `Bearer ${credential.toString("ascii")}`;
      } else {
        serviceAuthorization = `Bearer ${legacyServiceToken}`;
      }
    } catch {
      return deny("authorization backend unavailable");
    }

    calls++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SKLEGAL_SERVICE_AUTHORIZATION_HEADER]: serviceAuthorization,
          authorization: requestCapAuth,
        },
        body: JSON.stringify({ subject, capability, resource, context }),
        signal: ac.signal,
      });
    } catch {
      return deny("authorization backend unavailable");
    } finally {
      clearTimeout(timer);
      if (credential) credential.fill(0);
      serviceAuthorization = null;
    }

    if (!response || response.status !== 200) {
      return deny("authorization backend unavailable");
    }
    let data;
    try {
      data = await response.json();
    } catch {
      return deny("malformed authorization response");
    }
    return validateSkLegalDecisionResponse(data)
      || deny("malformed authorization response");
  }

  return {
    decideSkLegal,
    configured,
    stats: () => ({ calls, configured, cacheEnabled: false }),
  };
}
