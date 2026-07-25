// Advertise allowlist: which discovered models the gateway exposes on
// GET /admin/models (and, downstream, on /v1/models once Task 5 wires
// discovery in). An empty allowlist means "advertise everything" so a
// freshly installed gateway is never silently empty.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const PATH = join(homedir(), '.config', 'skgateway', 'advertise.json');

export function applyAllowlist(catalog, allowlist) {
  if (!allowlist || allowlist.length === 0) {
    return catalog.map((m) => ({ ...m, advertised: true }));
  }
  const set = new Set(allowlist);
  return catalog.filter((m) => set.has(m.id)).map((m) => ({ ...m, advertised: true }));
}

export function loadAllowlist(path = PATH) {
  try {
    return JSON.parse(readFileSync(path, 'utf8')).enabled || [];
  } catch {
    return [];
  }
}

export function saveAllowlist(list, path = PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ enabled: list }, null, 2));
}
