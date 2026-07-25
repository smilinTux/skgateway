# SKGateway Dynamic Provider Model Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SKGateway's `/v1/models` catalog dynamic: local backends plus NVIDIA NIM free cards plus OpenRouter free-only models, chat-filtered, cached, health-reconciled, with an advertise allowlist the future console can toggle.

**Architecture:** A new pure `discovery.mjs` fetches + filters provider model lists (fixture-tested, no live HTTP in tests). A cache layer merges them with the config's local backends and persists to disk for resilience. An advertise allowlist (`advertise.json`, empty = advertise-all) filters what `/v1/models` returns. Routing is augmented so any discovered id routes to its provider backend. This is the source catalog the skchat unified reply-model picker consumes.

**Tech Stack:** Node.js ESM (`type: module`), Node built-in test runner (`node --test tests/*.test.mjs`), stdlib `fetch`. No new dependencies.

## Global Constraints

- **No em/en dashes** anywhere (code, comments, docs, commits). Commas, colons, parentheses, new sentences. Regular hyphens fine.
- **ESM only** (`import`/`export`), Node 20+ global `fetch`. No new npm deps (devDeps is empty; keep it empty).
- **Tests:** `node --test tests/*.test.mjs`, run from the repo root. New tests are `tests/<name>.test.mjs`. Pure functions take injected fixtures; NEVER hit live NVIDIA/OpenRouter in a test.
- **Fail-soft:** a provider fetch that throws must never break `/v1/models`; serve the last cache and mark entries `stale`.
- **Free-only for OpenRouter** is the "for now" default (`discovery.providers.openrouter.free_only: true`); a flag widens later. NVIDIA `integrate.api.nvidia.com` is all free-tier.
- **Secrets** live in `~/.config/skgateway/secrets.env` (`NVIDIA_API_KEY` present; add `OPENROUTER_API_KEY`). Never inline a key.
- **Do not regress** the existing advertise-reconcile behavior (card `5c680ee9`): advertise all, annotate `available`/`unavailable` by health.

## Reference: verified provider shapes (2026-07-25)

- NVIDIA: `GET https://integrate.api.nvidia.com/v1/models` (Bearer `NVIDIA_API_KEY`) -> `{data:[{id,...}]}`, 118 cards (incl. embed like `baai/bge-m3`, vision like `adept/fuyu-8b`).
- OpenRouter: `GET https://openrouter.ai/api/v1/models` (keyless to list) -> `{data:[{id, pricing:{prompt,completion}, ...}]}`, 345 total, 18 free (`:free` suffix or pricing `"0"`).

## File Structure

- `src/discovery.mjs` (CREATE): pure fetch + filter + merge + cache. One responsibility: turn provider APIs + config into a merged catalog.
- `src/advertise.mjs` (CREATE): the advertise allowlist read/write (`advertise.json`).
- `src/index.mjs` (MODIFY): call discovery on startup + interval; feed `/v1/models`; add `/admin/models` GET + `/admin/models/advertise` PUT; augment routing map.
- `src/config.mjs` (MODIFY): add the `discovery:` block defaults + the `openrouter` backend.
- `config/skgateway.yaml` (MODIFY): add the `openrouter` backend + `discovery:` block.
- `tests/discovery.test.mjs`, `tests/advertise.test.mjs` (CREATE).
- `~/.config/skgateway/secrets.env` (MODIFY, ops): add `OPENROUTER_API_KEY`.

---

## Task 1: Discovery fetch + filter (pure, fixture-tested)

**Files:**
- Create: `src/discovery.mjs`
- Test: `tests/discovery.test.mjs`

**Interfaces:**
- Produces: `isChatModel(id) -> boolean` (drops embeddings/vision/safety); `parseNvidia(json) -> [{id, provider:"nvidia", free:true}]`; `parseOpenRouterFree(json) -> [{id, provider:"openrouter", free:true}]`. Pure; the network wrapper is Task 2.

- [ ] **Step 1: Write the failing test**

Create `tests/discovery.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isChatModel, parseNvidia, parseOpenRouterFree } from '../src/discovery.mjs';

test('isChatModel drops embeddings, vision, safety', () => {
  assert.equal(isChatModel('meta/llama-3.3-70b-instruct'), true);
  assert.equal(isChatModel('baai/bge-m3'), false);
  assert.equal(isChatModel('nvidia/embed-qa-4'), false);
  assert.equal(isChatModel('adept/fuyu-8b'), false);
  assert.equal(isChatModel('nvidia/nemotron-3.5-content-safety'), false);
});

test('parseNvidia keeps chat ids, tags provider+free', () => {
  const out = parseNvidia({ data: [{ id: 'qwen/qwen3.5-122b-a10b' }, { id: 'baai/bge-m3' }] });
  assert.deepEqual(out, [{ id: 'qwen/qwen3.5-122b-a10b', provider: 'nvidia', free: true }]);
});

test('parseOpenRouterFree keeps only free chat models', () => {
  const json = { data: [
    { id: 'google/gemma-4-31b-it:free', pricing: { prompt: '0', completion: '0' } },
    { id: 'anthropic/claude-x', pricing: { prompt: '0.003', completion: '0.015' } },
    { id: 'nvidia/nemotron-3.5-content-safety:free', pricing: { prompt: '0', completion: '0' } },
  ] };
  const out = parseOpenRouterFree(json).map(m => m.id);
  assert.deepEqual(out, ['google/gemma-4-31b-it:free']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/discovery.test.mjs`
Expected: FAIL (`Cannot find module '../src/discovery.mjs'`).

- [ ] **Step 3: Write minimal implementation**

Create `src/discovery.mjs`:
```javascript
// Pure provider parsing/filtering. Network + cache live in this file too (Task 2)
// but these three functions never touch the network.

const NON_CHAT = [
  /embed/i, /\bbge\b/i, /rerank/i, /content-safety/i, /guard/i,
  /\bfuyu\b/i, /\bocr\b/i, /vision-embed/i, /moderation/i,
];

export function isChatModel(id) {
  if (!id || typeof id !== 'string') return false;
  return !NON_CHAT.some((re) => re.test(id));
}

export function parseNvidia(json) {
  const data = (json && json.data) || [];
  return data
    .map((m) => m.id)
    .filter(isChatModel)
    .map((id) => ({ id, provider: 'nvidia', free: true }));
}

function isFree(m) {
  if (String(m.id || '').endsWith(':free')) return true;
  const p = m.pricing || {};
  return String(p.prompt) === '0' && String(p.completion) === '0';
}

export function parseOpenRouterFree(json) {
  const data = (json && json.data) || [];
  return data
    .filter(isFree)
    .map((m) => m.id)
    .filter(isChatModel)
    .map((id) => ({ id, provider: 'openrouter', free: true }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/discovery.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/discovery.mjs tests/discovery.test.mjs
git commit -m "feat(discovery): pure NVIDIA + OpenRouter-free chat-model parsers"
```

---

## Task 2: Fetch wrappers + merge + on-disk cache (fail-soft)

**Files:**
- Modify: `src/discovery.mjs`
- Test: `tests/discovery.test.mjs`

**Interfaces:**
- Consumes: `parseNvidia`, `parseOpenRouterFree` (Task 1).
- Produces: `mergeCatalog(local, nvidia, openrouter) -> [{id, provider, free}]` (dedup by id, precedence local > nvidia > openrouter); `discoverCatalog(opts) -> {models, stale}` where `opts = {localModels, nvidiaFetch, openrouterFetch, cache}` so tests inject fetchers + an in-memory cache (no live HTTP, no disk).

- [ ] **Step 1: Write the failing test**

Add to `tests/discovery.test.mjs`:
```javascript
import { mergeCatalog, discoverCatalog } from '../src/discovery.mjs';

test('mergeCatalog dedups by id, local wins', () => {
  const out = mergeCatalog(
    [{ id: 'ornith-tiny', provider: 'local', free: true }],
    [{ id: 'ornith-tiny', provider: 'nvidia', free: true }, { id: 'qwen/x', provider: 'nvidia', free: true }],
    [{ id: 'g/y:free', provider: 'openrouter', free: true }],
  );
  const byId = Object.fromEntries(out.map((m) => [m.id, m.provider]));
  assert.equal(byId['ornith-tiny'], 'local');
  assert.equal(byId['qwen/x'], 'nvidia');
  assert.equal(byId['g/y:free'], 'openrouter');
});

test('discoverCatalog serves cache + marks stale when a provider throws', async () => {
  const cache = { models: [{ id: 'cached', provider: 'nvidia', free: true }] };
  const res = await discoverCatalog({
    localModels: [{ id: 'ornith-tiny', provider: 'local', free: true }],
    nvidiaFetch: async () => { throw new Error('down'); },
    openrouterFetch: async () => ({ data: [] }),
    cache,
  });
  assert.equal(res.stale, true);
  const ids = res.models.map((m) => m.id);
  assert.ok(ids.includes('ornith-tiny'));   // local always present
  assert.ok(ids.includes('cached'));        // nvidia fell back to cache
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/discovery.test.mjs`
Expected: FAIL (`mergeCatalog`/`discoverCatalog` not exported).

- [ ] **Step 3: Write minimal implementation**

Append to `src/discovery.mjs`:
```javascript
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const CACHE_PATH = join(homedir(), '.config', 'skgateway', 'model_catalog_cache.json');

export function mergeCatalog(local, nvidia, openrouter) {
  const seen = new Map();
  for (const group of [local || [], nvidia || [], openrouter || []]) {
    for (const m of group) {
      if (!seen.has(m.id)) seen.set(m.id, m); // first wins => local > nvidia > openrouter
    }
  }
  return [...seen.values()];
}

export async function fetchNvidia(apiKey) {
  const r = await fetch('https://integrate.api.nvidia.com/v1/models', {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) throw new Error(`nvidia ${r.status}`);
  return r.json();
}

export async function fetchOpenRouter() {
  const r = await fetch('https://openrouter.ai/api/v1/models');
  if (!r.ok) throw new Error(`openrouter ${r.status}`);
  return r.json();
}

// opts: { localModels, nvidiaFetch, openrouterFetch, cache } (cache is an object
// we read prior results from and write fresh ones into; disk persistence is the
// caller's concern via loadCache/saveCache below).
export async function discoverCatalog(opts) {
  const { localModels = [], nvidiaFetch, openrouterFetch, cache = {} } = opts;
  let stale = false;
  let nvidia = [];
  let openrouter = [];
  try {
    nvidia = parseNvidia(await nvidiaFetch());
  } catch {
    stale = true;
    nvidia = (cache.models || []).filter((m) => m.provider === 'nvidia');
  }
  try {
    openrouter = parseOpenRouterFree(await openrouterFetch());
  } catch {
    stale = true;
    openrouter = (cache.models || []).filter((m) => m.provider === 'openrouter');
  }
  const models = mergeCatalog(localModels, nvidia, openrouter).map((m) => ({ ...m, stale }));
  cache.models = models;
  return { models, stale };
}

export function loadCache(path = CACHE_PATH) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

export function saveCache(cache, path = CACHE_PATH) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2));
  } catch {
    // cache persistence is best-effort; never throw into a request path
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/discovery.test.mjs`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/discovery.mjs tests/discovery.test.mjs
git commit -m "feat(discovery): merge + fail-soft cache; live nvidia/openrouter fetchers"
```

---

## Task 3: Config: openrouter backend + discovery block

**Files:**
- Modify: `src/config.mjs` (add `openrouter` backend default + `discovery` defaults)
- Modify: `config/skgateway.yaml` (declare them)
- Ops: `~/.config/skgateway/secrets.env` add `OPENROUTER_API_KEY`

**Interfaces:**
- Produces: `config.backends.openrouter = {url, auth_type, api_key_env, discovery, max_concurrent}`; `config.discovery = {enabled, refresh_seconds, providers:{nvidia, openrouter}}`.

- [ ] **Step 1: Add config defaults (verify existing shape first)**

Inspect the current backend/config shape:
```bash
grep -n "nvidia:" -A4 src/config.mjs
```
In `src/config.mjs`, beside the existing `nvidia` backend default, add:
```javascript
    openrouter: {
      url: 'https://openrouter.ai/api/v1',
      auth_type: 'api_key',
      api_key_env: 'OPENROUTER_API_KEY',
      discovery: 'free', // free | all
      max_concurrent: 10,
    },
```
And add a top-level `discovery` default:
```javascript
  discovery: {
    enabled: true,
    refresh_seconds: 3600,
    providers: {
      nvidia: { enabled: true, free_only: true, chat_only: true },
      openrouter: { enabled: true, free_only: true, chat_only: true },
    },
  },
```

- [ ] **Step 2: Declare in `config/skgateway.yaml`**

Add under `backends:`:
```yaml
  openrouter:
    url: https://openrouter.ai/api/v1
    auth_type: api_key
    api_key_env: OPENROUTER_API_KEY
    discovery: free
    max_concurrent: 10
```
And at top level:
```yaml
discovery:
  enabled: true
  refresh_seconds: 3600
  providers:
    nvidia:     { enabled: true, free_only: true, chat_only: true }
    openrouter: { enabled: true, free_only: true, chat_only: true }
```

- [ ] **Step 3: Add the secret (ops)**

```bash
grep -q '^OPENROUTER_API_KEY=' ~/.config/skgateway/secrets.env || \
  echo '# OPENROUTER_API_KEY needed to INVOKE free models (listing is keyless)' >> ~/.config/skgateway/secrets.env
# Then add the real key value (from OpenRouter dashboard) to that file, mode 600.
```
Record in the report that discovery LISTS free models without the key, but calls to them 401 (and the health reconciler flags them `unavailable`) until the key is set.

- [ ] **Step 4: Verify config loads**

Run: `node -e "import('./src/config.mjs').then(m => { const c = m.getConfig(); console.log('openrouter?', !!c.backends.openrouter, 'discovery?', !!c.discovery); })"`
Expected: `openrouter? true discovery? true`.

- [ ] **Step 5: Commit**

```bash
git add src/config.mjs config/skgateway.yaml
git commit -m "feat(config): openrouter backend + discovery block (free-only defaults)"
```

---

## Task 4: Advertise allowlist + admin API

**Files:**
- Create: `src/advertise.mjs`
- Test: `tests/advertise.test.mjs`
- Modify: `src/index.mjs` (wire the two admin routes)

**Interfaces:**
- Produces: `applyAllowlist(catalog, allowlist) -> catalog'` (empty allowlist = advertise-all; else `catalog.filter(m => allowlist.includes(m.id))`, each entry gets `advertised: boolean`); `loadAllowlist()/saveAllowlist(list)` over `~/.config/skgateway/advertise.json`.

- [ ] **Step 1: Write the failing test**

Create `tests/advertise.test.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAllowlist } from '../src/advertise.mjs';

const cat = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('empty allowlist advertises all', () => {
  const out = applyAllowlist(cat, []);
  assert.equal(out.length, 3);
  assert.ok(out.every((m) => m.advertised === true));
});

test('non-empty allowlist filters + flags', () => {
  const out = applyAllowlist(cat, ['a', 'c']);
  assert.deepEqual(out.map((m) => m.id), ['a', 'c']);
  assert.ok(out.every((m) => m.advertised === true));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/advertise.test.mjs`
Expected: FAIL (module missing).

- [ ] **Step 3: Write minimal implementation**

Create `src/advertise.mjs`:
```javascript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/advertise.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire admin routes in `src/index.mjs`**

Near the existing `/v1/models` handler, add (gate to loopback/operator with the gateway's existing auth posture; reuse whatever the gateway already uses for privileged routes, otherwise bind admin to loopback only):
```javascript
  if (req.url === '/admin/models' && req.method === 'GET') {
    const full = await getDiscoveredCatalog();          // Task 5 provides this
    const allow = loadAllowlist();
    const set = new Set(allow);
    const data = full.map((m) => ({ ...m, advertised: allow.length === 0 || set.has(m.id) }));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data }));
    return;
  }
  if (req.url === '/admin/models/advertise' && req.method === 'PUT') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const enabled = (JSON.parse(body || '{}').enabled) || [];
    saveAllowlist(enabled);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, enabled }));
    return;
  }
```
Add `import { loadAllowlist, saveAllowlist, applyAllowlist } from './advertise.mjs';` at the top.

- [ ] **Step 6: Commit**

```bash
git add src/advertise.mjs tests/advertise.test.mjs src/index.mjs
git commit -m "feat(advertise): allowlist + /admin/models GET + /admin/models/advertise PUT"
```

---

## Task 5: Wire dynamic catalog into /v1/models + routing

**Files:**
- Modify: `src/index.mjs` (startup discovery + interval; feed `/v1/models`; augment routing)

**Interfaces:**
- Consumes: `discoverCatalog`, `loadCache`, `saveCache`, `fetchNvidia`, `fetchOpenRouter` (discovery.mjs); `applyAllowlist`, `loadAllowlist` (advertise.mjs).
- Produces: `getDiscoveredCatalog()` (returns the current merged catalog, used by both `/v1/models` and `/admin/models`); the router resolves any discovered id to its provider backend.

- [ ] **Step 1: Add the discovery loop + accessor**

In `src/index.mjs`, after config load, add:
```javascript
import { discoverCatalog, loadCache, saveCache, fetchNvidia, fetchOpenRouter } from './discovery.mjs';

let _catalog = [];
const _cache = loadCache();

function localModels(config) {
  // The static/local backend model lists already in config (ornith/beellama/ollama).
  const out = [];
  for (const [name, b] of Object.entries(config.backends || {})) {
    if (['nvidia', 'openrouter'].includes(name)) continue;
    for (const id of b.models || []) out.push({ id, provider: 'local', free: true });
  }
  return out;
}

async function refreshCatalog(config) {
  const d = config.discovery || {};
  const nv = d.providers?.nvidia?.enabled !== false;
  const or = d.providers?.openrouter?.enabled !== false;
  const nvidiaKey = process.env[config.backends?.nvidia?.api_key_env || 'NVIDIA_API_KEY'];
  const { models } = await discoverCatalog({
    localModels: localModels(config),
    nvidiaFetch: nv ? () => fetchNvidia(nvidiaKey) : async () => ({ data: [] }),
    openrouterFetch: or ? () => fetchOpenRouter() : async () => ({ data: [] }),
    cache: _cache,
  });
  _catalog = models;
  saveCache(_cache);
  return models;
}

export async function getDiscoveredCatalog() {
  if (_catalog.length === 0) await refreshCatalog(getConfig());
  return _catalog;
}

// kick off on startup + interval
refreshCatalog(getConfig()).catch(() => {});
setInterval(() => refreshCatalog(getConfig()).catch(() => {}),
  (getConfig().discovery?.refresh_seconds || 3600) * 1000).unref();
```

- [ ] **Step 2: Feed `/v1/models` from the discovered + allowlisted catalog**

Replace the body of the existing `/v1/models` handler so it merges the discovered catalog with the existing `buildModelCatalog` health reconciliation, then applies the allowlist:
```javascript
  if (req.url === '/v1/models' && req.method === 'GET') {
    const discovered = await getDiscoveredCatalog();
    const reconciled = buildModelCatalog(config.backends || {}, router, advertiseReconcileMode);
    // health/availability from reconciled; provider/free from discovered
    const meta = new Map(discovered.map((m) => [m.id, m]));
    const merged = [...new Map([...reconciled, ...discovered.map((m) => ({ id: m.id, ...m }))]
      .map((m) => [m.id, { ...(meta.get(m.id) || {}), ...m }])).values()];
    const data = applyAllowlist(merged, loadAllowlist());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data }));
    return;
  }
```
(Keep the exact reconcile semantics the current handler uses; the only additions are the discovered provider/free tags + the allowlist filter. If `buildModelCatalog` already returns objects with `id`, adapt the merge to its shape; do not drop its `status`/`available` fields.)

- [ ] **Step 3: Augment routing so discovered ids route to their provider**

Find where the router maps model id to backend (grep `routeAndSend`/registry). Register discovered ids: nvidia ids -> the `nvidia` backend, openrouter ids -> the `openrouter` backend, local ids unchanged. If the router reads a static map, build it from `getDiscoveredCatalog()` on refresh:
```javascript
function providerBackend(provider) {
  return provider === 'nvidia' ? 'nvidia' : provider === 'openrouter' ? 'openrouter' : null;
}
// after refreshCatalog sets _catalog, register routes for discovered ids:
for (const m of _catalog) {
  const be = providerBackend(m.provider);
  if (be && typeof router.registerModel === 'function') router.registerModel(m.id, be);
}
```
(Confirm the router's real registration API by reading `src/router*.mjs`; use the existing mechanism. Unknown-model body-size limits fall back to the safe default already in config.)

- [ ] **Step 4: Live smoke test**

```bash
node src/index.mjs &   # or restart the service
sleep 3
curl -s http://localhost:18780/v1/models | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s).data;const p={};d.forEach(m=>p[m.provider]=(p[m.provider]||0)+1);console.log('by provider:',p,'total:',d.length)})"
curl -s http://localhost:18780/admin/models | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s).data;console.log('admin total:',d.length,'sample advertised:',d.slice(0,3).map(m=>[m.id,m.advertised]))})"
```
Expected: `/v1/models` shows local + nvidia + openrouter counts (openrouter ~18, nvidia ~90 after chat filter); `/admin/models` lists all with `advertised` flags. A chat completion to a discovered NVIDIA free id routes and returns.

- [ ] **Step 5: Run full test suite + commit**

Run: `node --test tests/*.test.mjs`
Expected: PASS (existing suite + discovery + advertise, no regression).
```bash
git add src/index.mjs
git commit -m "feat(gateway): dynamic /v1/models from discovery + allowlist + provider routing"
```

---

## Self-Review

**1. Spec coverage:**
- Local + NVIDIA-free + OpenRouter-free dynamic catalog -> Tasks 1, 2, 5. ✅
- Chat-only filter (drop embed/vision/safety) -> Task 1. ✅
- Cache + fail-soft stale -> Task 2. ✅
- OpenRouter backend + free-only knob + key -> Task 3. ✅
- Advertise allowlist + `/admin/models` GET + PUT -> Task 4. ✅
- Dynamic `/v1/models` + routing augmentation -> Task 5. ✅
- Health reconciliation preserved -> Task 5 Step 2 (merge keeps reconciled fields). ✅

**2. Placeholder scan:** each code step has complete code. Task 5 Steps 2-3 include a "confirm the router's real registration API / buildModelCatalog shape" instruction because those adapt to existing internals; the added logic (discovered tags + allowlist + provider routing) is fully specified. The implementer must read `src/router*.mjs` + the current `/v1/models` handler before Task 5, which is called out.

**3. Type consistency:** catalog entry shape `{id, provider, free, stale?, advertised?}` is consistent across discovery (Tasks 1-2), advertise (Task 4), and the endpoints (Task 5). `getDiscoveredCatalog()` is defined in Task 5 and referenced by Task 4's `/admin/models` (Task 4 wires the route; Task 5 provides the accessor, so Task 5 must land before the admin route is exercised, noted in the interfaces).

**Risk flags for the implementer:** (a) `buildModelCatalog`'s exact return shape must be read before Task 5 Step 2 so the merge preserves `status`/`available`. (b) the router registration API (Task 5 Step 3) is internal; use the real one. (c) OpenRouter calls need the key; without it those ids advertise but 401 on use (correct, health-flagged).
