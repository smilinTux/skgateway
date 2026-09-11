import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

function absoluteBase(value, fallback, label) {
  const selected = value == null || value === "" ? fallback : value;
  if (!isAbsolute(selected)) throw new Error(`${label} must be absolute`);
  return resolve(selected);
}

export function resolveStatePaths({ env = process.env, home = homedir() } = {}) {
  if (!isAbsolute(home)) throw new Error("home must be absolute");
  const configBase = absoluteBase(env.XDG_CONFIG_HOME, join(home, ".config"), "XDG_CONFIG_HOME");
  const stateBase = absoluteBase(env.XDG_STATE_HOME, join(home, ".local", "state"), "XDG_STATE_HOME");
  const configRoot = join(configBase, "skgateway");
  const stateRoot = join(stateBase, "skgateway");
  return Object.freeze({
    configRoot,
    stateRoot,
    metricsDb: join(stateRoot, "metrics.db"),
    capacityState: join(stateRoot, "capacity-state.json"),
    providerHealth: join(stateRoot, "provider-health.json"),
    semanticCache: join(stateRoot, "semantic-cache"),
    auditLog: join(stateRoot, "audit.jsonl"),
  });
}

function within(path, root) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function validateStateRoot(path, { uid = process.getuid?.(), parent } = {}) {
  if (!isAbsolute(path)) throw new Error("state root must be absolute");
  if (parent && !within(path, parent)) throw new Error("state root escapes configured XDG root");
  const parts = resolve(path).split(sep).filter(Boolean);
  let cursor = sep;
  for (const part of parts) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`state path contains a symlink: ${cursor}`);
    }
  }
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`state root is a symlink: ${path}`);
  if (!stat.isDirectory()) throw new Error(`state root is not a directory: ${path}`);
  if (uid != null && stat.uid !== uid) throw new Error(`state root has wrong owner: ${path}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`state root has unsafe permissions: ${path}`);
}

function ensurePrivateDirectory(path, uid) {
  if (existsSync(path)) validateStateRoot(path, { uid });
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  validateStateRoot(path, { uid });
}

export function ensurePrivateFile(path, { uid = process.getuid?.() } = {}) {
  const parent = resolve(path, "..");
  ensurePrivateDirectory(parent, uid);
  const fd = openSync(path, "a", 0o600);
  closeSync(fd);
  chmodSync(path, 0o600);
}

export function ensureStatePaths(paths, { uid = process.getuid?.() } = {}) {
  ensurePrivateDirectory(paths.configRoot, uid);
  ensurePrivateDirectory(paths.stateRoot, uid);
  ensurePrivateDirectory(paths.semanticCache, uid);
  return paths;
}

export const DEFAULT_STATE_PATHS = resolveStatePaths();
