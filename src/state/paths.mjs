import {
  chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync,
  mkdirSync, openSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
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
  validateStateRoot(path, { uid });
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  validateStateRoot(path, { uid });
}

function ensureFileParent(path) {
  const parent = resolve(path, "..");
  const parts = parent.split(sep).filter(Boolean);
  let cursor = sep;
  for (const part of parts) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error(`state path contains a symlink: ${cursor}`);
  }
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (!lstatSync(parent).isDirectory()) throw new Error(`state file parent is not a directory: ${parent}`);
  return parent;
}

function validateProductionRoot(path, uid) {
  for (const root of [DEFAULT_STATE_PATHS.configRoot, DEFAULT_STATE_PATHS.stateRoot]) {
    if (!within(path, root)) continue;
    validateStateRoot(root, { uid });
    if (!existsSync(root)) ensurePrivateDirectory(root, uid);
  }
}

export function ensurePrivateFile(path, { uid = process.getuid?.() } = {}) {
  validateProductionRoot(path, uid);
  ensureFileParent(path);
  if (existsSync(path)) {
    const before = lstatSync(path);
    if (before.isSymbolicLink()) throw new Error(`state file is a symlink: ${path}`);
    if (!before.isFile() || before.nlink !== 1) throw new Error(`state file must be a regular single-link file: ${path}`);
    if (uid != null && before.uid !== uid) throw new Error(`state file has wrong owner: ${path}`);
    if ((before.mode & 0o777) !== 0o600) throw new Error(`state file has unsafe permissions: ${path}`);
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) throw new Error(`state file must be a regular single-link file: ${path}`);
    if (uid != null && opened.uid !== uid) throw new Error(`state file has wrong owner: ${path}`);
    fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
}

export function writePrivateFileAtomic(path, bytes, { uid = process.getuid?.() } = {}) {
  validateProductionRoot(path, uid);
  const parent = ensureFileParent(path);
  if (existsSync(path)) {
    const current = lstatSync(path);
    if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1) {
      throw new Error(`state file must be a regular single-link file: ${path}`);
    }
    if (uid != null && current.uid !== uid) throw new Error(`state file has wrong owner: ${path}`);
    if ((current.mode & 0o777) !== 0o600) throw new Error(`state file has unsafe permissions: ${path}`);
  }
  const temp = join(parent, `.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
    fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
  try { renameSync(temp, path); } catch (error) { try { unlinkSync(temp); } catch {} throw error; }
}

export function ensureStatePaths(paths, { uid = process.getuid?.() } = {}) {
  ensurePrivateDirectory(paths.configRoot, uid);
  ensurePrivateDirectory(paths.stateRoot, uid);
  ensurePrivateDirectory(paths.semanticCache, uid);
  return paths;
}

export const DEFAULT_STATE_PATHS = resolveStatePaths();
