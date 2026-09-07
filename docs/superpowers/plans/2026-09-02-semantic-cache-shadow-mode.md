# Semantic Cache Shadow Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure the real semantic-cache hit rate on live skgateway traffic without serving a single cached response.

**Architecture:** `src/proxy/semantic-cache.mjs` already exists, is unit-tested, and is imported by nothing. This wires it into the `/v1/chat/completions` path in `src/index.mjs` behind a config flag, in SHADOW mode only: on every eligible request it embeds the prompt, searches the store, records whether a hit *would* have occurred, then discards the answer and dispatches to the backend exactly as today. After the response returns it stores the prompt/response pair so later requests can match it. Nothing about routing, response bytes, or latency-critical ordering changes.

**Why shadow first:** The hit rate cannot be measured from what the gateway logs today. `logs/audit.jsonl` carries only `{event, model, reason, body_bytes, messages, ts}` with no prompt text and no prompt hash, which is a deliberate privacy default. Serving cached responses before knowing the hit rate would be guessing. One week of shadow data turns the go/no-go into arithmetic.

**Tech Stack:** Node 22 ESM, `node:test`, existing `createSemanticCache` / `createMemoryStore` / `createMxbaiEmbedder`, mxbai-embed-large at `http://192.168.0.100:11438/v1/embeddings` (measured 72-75 ms warm, 320 ms cold), SIEM file sink for the shadow ledger.

**Spec:** This plan's design was agreed with Chef on 2026-08-30 and is recorded in the Autocache Verdict artifact, section "What performance would it actually buy". Key measured inputs reproduced under Global Constraints so the plan stands alone.

## Global Constraints

- **Node 22 only.** The repo declares `"node": ">=22.0.0"` and CI tests 22 only.
- **No new dependencies.** Prod deps are exactly `better-sqlite3`, `js-yaml`, `openpgp`. Do not add a fourth.
- **CHANGELOG entry is mandatory** for any change under `src/`. Tier-2 docs-check fails the PR without one. Add it in the same commit as the code.
- **Never write the production lifecycle store from a test.** Set `SKGATEWAY_MODEL_CATALOG_STORE_PATH` to a temp path before importing any module, or tests throw.
- **Run tests as:** `node --test --import ./tests/_setup.mjs tests/<file>` and the full suite as `npm test`.
- **Shadow mode means shadow.** No code path in this plan may return a cached response to a client. The only observable effects are SIEM events and an added embed call.
- **Fail-open always.** Any error in cache code must be swallowed and the request dispatched normally. The cache is an observer, never a gate.
- **Eligible categories are exactly:** `administrative`, `system`, `data_query`. These are 26.9% of measured wall clock. `tool_use` (49.0%) has side effects, `conversation` (4.9%) is memory-grounded, `code_generation` (17.1%) produces novel output. Do not widen this set in this plan.
- **Config lives in two places.** `config/skgateway.yaml` in-repo is what CI loads. `~/.skcapstone/gateway/skgateway.yaml` is what the running service loads (a systemd drop-in clears `--config` and sets `SKGATEWAY_CONFIG`). Changing only one is the bug that made `anthropic-spof` fail in CI while passing on the host.

---

### Task 1: Config schema and a default-off flag

**Files:**
- Modify: `src/config.mjs`
- Modify: `config/skgateway.yaml`
- Test: `tests/semantic-cache-config.test.mjs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `config.semantic_cache` with shape
  `{ enabled: boolean, mode: "shadow"|"serve", threshold: number, ttl_seconds: number, max_entries: number, embed_url: string, embed_model: string, embed_timeout_ms: number, categories: string[] }`.
  Task 2 and Task 3 read this object.

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadConfig } from "../src/config.mjs";

describe("semantic_cache config", () => {
  test("absent section defaults to disabled shadow mode", async () => {
    const cfg = (await loadConfig({ silent: true })).current();
    const sc = cfg.semantic_cache;
    assert.ok(sc, "semantic_cache must always be present after normalisation");
    assert.equal(sc.enabled, false, "must be OFF unless explicitly enabled");
    assert.equal(sc.mode, "shadow", "shadow is the only safe default");
    assert.deepEqual(sc.categories, ["administrative", "system", "data_query"]);
  });

  test("serve mode is refused until shadow data justifies it", async () => {
    const cfg = (await loadConfig({ silent: true })).current();
    assert.notEqual(cfg.semantic_cache.mode, "serve",
      "no committed config may ship mode: serve");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import ./tests/_setup.mjs tests/semantic-cache-config.test.mjs`
Expected: FAIL, `semantic_cache must always be present after normalisation`

- [ ] **Step 3: Add the normaliser to `src/config.mjs`**

Find the function that normalises other optional sections (search for `classification` handling) and add alongside it:

```javascript
/**
 * Normalise the semantic-cache section. Always present, always OFF by default.
 * `shadow` records what WOULD have been served and serves nothing; `serve`
 * returns cached responses to clients. Shadow is the only default because the
 * hit rate on this fleet has never been measured.
 */
function normalizeSemanticCache(raw = {}) {
  const sc = raw && typeof raw === "object" ? raw : {};
  const mode = sc.mode === "serve" ? "serve" : "shadow";
  return {
    enabled: sc.enabled === true,
    mode,
    threshold: Number.isFinite(sc.threshold) ? sc.threshold : 0.92,
    ttl_seconds: Number.isFinite(sc.ttl_seconds) ? sc.ttl_seconds : 3600,
    max_entries: Number.isFinite(sc.max_entries) ? sc.max_entries : 2000,
    embed_url: typeof sc.embed_url === "string" && sc.embed_url
      ? sc.embed_url : "http://192.168.0.100:11438/v1/embeddings",
    embed_model: typeof sc.embed_model === "string" && sc.embed_model
      ? sc.embed_model : "mxbai-embed-large",
    embed_timeout_ms: Number.isFinite(sc.embed_timeout_ms) ? sc.embed_timeout_ms : 5000,
    categories: Array.isArray(sc.categories) && sc.categories.length
      ? sc.categories.filter((c) => typeof c === "string")
      : ["administrative", "system", "data_query"],
  };
}
```

Then call it where the config object is assembled, so `cfg.semantic_cache` is always set:

```javascript
  semantic_cache: normalizeSemanticCache(raw.semantic_cache),
```

- [ ] **Step 4: Add the documented default to `config/skgateway.yaml`**

Append at top level:

```yaml
## Semantic cache (card: semantic-cache stage 2).
## SHADOW MODE: embeds each eligible prompt, records whether a cached answer
## WOULD have matched, then throws that away and dispatches normally. It never
## serves a cached response to a client while mode is `shadow`.
##
## Off by default. The hit rate on this fleet has never been measured: the
## gateway logs no prompt text and no prompt hash, so there is no way to
## compute it retroactively. Run shadow for a week, read
## `semantic_cache.shadow` events out of the SIEM sink, then decide.
##
## Eligible categories are deliberately narrow. Measured over 10,755 classified
## prompts: tool_use is 49.0% of wall clock but has side effects, conversation
## is memory-grounded, code_generation produces novel output. What is left is
## 26.9% of wall clock, about 2.4 hours per week.
semantic_cache:
  enabled: false
  mode: shadow
  threshold: 0.92
  ttl_seconds: 3600
  max_entries: 2000
  embed_url: http://192.168.0.100:11438/v1/embeddings
  embed_model: mxbai-embed-large
  embed_timeout_ms: 5000
  categories: [administrative, system, data_query]
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --import ./tests/_setup.mjs tests/semantic-cache-config.test.mjs`
Expected: PASS, 2 tests

- [ ] **Step 6: Commit**

```bash
git add src/config.mjs config/skgateway.yaml tests/semantic-cache-config.test.mjs CHANGELOG.md
git commit -m "feat(cache): add semantic_cache config, default off in shadow mode"
```

CHANGELOG entry to add under `## [Unreleased]` / `### Added`:

```markdown
- A `semantic_cache` config section, disabled by default and defaulting to
  `mode: shadow`. Shadow records whether a cached response would have matched
  and serves nothing, because the hit rate on this fleet has never been
  measured: the gateway logs no prompt text and no prompt hash, so it cannot be
  computed from existing data.
```

---

### Task 2: The shadow recorder

**Files:**
- Create: `src/proxy/semantic-cache-shadow.mjs`
- Test: `tests/semantic-cache-shadow.test.mjs` (create)

**Interfaces:**
- Consumes: `config.semantic_cache` from Task 1. `createSemanticCache({embed, store, threshold, ttlMs})` and `createMemoryStore({maxEntries})` from `src/proxy/semantic-cache.mjs`. `createMxbaiEmbedder({url, model, timeoutMs})` from `src/proxy/embedders/mxbai.mjs`.
- Produces: `createShadowRecorder(cfg, { emit }) => { eligible(category), observe({text, agent, category}), record({text, response, agent, category}), stats() }` — Task 3 calls exactly these.

Why a separate file rather than inline in `index.mjs`: `index.mjs` is 2,519 lines. This is self-contained, independently testable, and keeps the wiring in Task 3 down to a handful of lines.

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createShadowRecorder } from "../src/proxy/semantic-cache-shadow.mjs";

const CFG = {
  enabled: true, mode: "shadow", threshold: 0.9, ttl_seconds: 60,
  max_entries: 10, categories: ["administrative", "system", "data_query"],
};
// Deterministic stand-in for mxbai: identical text embeds identically.
const fakeEmbed = async (t) => [t.length, t.charCodeAt(0) || 0, 1];

describe("shadow recorder", () => {
  test("only the eligible categories are observed", () => {
    const r = createShadowRecorder(CFG, { emit: () => {}, embed: fakeEmbed });
    assert.equal(r.eligible("administrative"), true);
    assert.equal(r.eligible("data_query"), true);
    assert.equal(r.eligible("tool_use"), false, "tool_use has side effects");
    assert.equal(r.eligible("conversation"), false, "memory-grounded");
    assert.equal(r.eligible(undefined), false);
  });

  test("a repeated prompt is recorded as a WOULD-HIT and still returns no response", async () => {
    const events = [];
    const r = createShadowRecorder(CFG, { emit: (e) => events.push(e), embed: fakeEmbed });
    const args = { text: "what is the gtd status", agent: "lumina", category: "administrative" };

    const first = await r.observe(args);
    assert.equal(first.hit, false, "nothing stored yet");

    await r.record({ ...args, response: { choices: [{ message: { content: "answer" } }] } });

    const second = await r.observe(args);
    assert.equal(second.hit, true, "the same prompt must match");
    assert.equal(second.response, undefined,
      "SHADOW MODE: a would-hit must never carry a response back to the caller");

    const hits = events.filter((e) => e.event === "semantic_cache.shadow" && e.hit);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].category, "administrative");
    assert.ok(hits[0].similarity >= 0.9);
  });

  test("an embed failure is swallowed and reported as a miss", async () => {
    const events = [];
    const r = createShadowRecorder(CFG, {
      emit: (e) => events.push(e),
      embed: async () => { throw new Error("mxbai down"); },
    });
    const out = await r.observe({ text: "x", agent: "a", category: "system" });
    assert.equal(out.hit, false, "must fail open, never throw into the request path");
    assert.ok(events.some((e) => e.event === "semantic_cache.error"));
  });

  test("agent and category namespaces do not bleed into each other", async () => {
    const r = createShadowRecorder(CFG, { emit: () => {}, embed: fakeEmbed });
    const text = "same words entirely";
    await r.record({ text, response: { a: 1 }, agent: "lumina", category: "administrative" });
    const other = await r.observe({ text, agent: "jarvis", category: "administrative" });
    assert.equal(other.hit, false, "agent A's cache must never serve agent B");
    const otherCat = await r.observe({ text, agent: "lumina", category: "system" });
    assert.equal(otherCat.hit, false, "a system answer must not serve an administrative query");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import ./tests/_setup.mjs tests/semantic-cache-shadow.test.mjs`
Expected: FAIL, `Cannot find module '../src/proxy/semantic-cache-shadow.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
/**
 * semantic-cache-shadow.mjs — SC stage 2, SHADOW half.
 *
 * Wraps the stage-1 engine so the live path can ask "would a cached answer have
 * matched?" and get a yes/no WITHOUT ever receiving the cached answer itself.
 * The engine's lookup() returns the response on a hit; this deliberately drops
 * it. That is the whole safety property of shadow mode, so it is enforced here,
 * in one place, rather than trusted to every call site.
 *
 * Everything is fail-open. The cache is an observer on the request path and a
 * thrown error here would turn a working request into a failed one, which is a
 * strictly worse outcome than not measuring.
 *
 * @module semantic-cache-shadow
 */
import { createSemanticCache, createMemoryStore } from "./semantic-cache.mjs";
import { createMxbaiEmbedder } from "./embedders/mxbai.mjs";

/**
 * @param {object} cfg  config.semantic_cache (see config.mjs normalizeSemanticCache)
 * @param {{emit: (evt:object)=>void, embed?: (t:string)=>Promise<number[]>,
 *          store?: object}} deps  embed/store are injected by tests
 */
export function createShadowRecorder(cfg, { emit, embed, store } = {}) {
  const eligibleSet = new Set(cfg.categories || []);
  const embedFn = embed || createMxbaiEmbedder({
    url: cfg.embed_url,
    model: cfg.embed_model,
    timeoutMs: cfg.embed_timeout_ms,
  });
  const backing = store || createMemoryStore({ maxEntries: cfg.max_entries });
  const engine = createSemanticCache({
    embed: embedFn,
    store: backing,
    threshold: cfg.threshold,
    ttlMs: (cfg.ttl_seconds ?? 3600) * 1000,
  });
  const counters = { observed: 0, wouldHit: 0, errors: 0 };

  const safeEmit = (evt) => { try { emit?.(evt); } catch { /* never break the path */ } };

  return {
    /** Is this prompt category one we are allowed to measure? */
    eligible(category) {
      return typeof category === "string" && eligibleSet.has(category);
    },

    /**
     * Record whether a cached answer WOULD have matched. Never returns the
     * cached response: shadow mode's guarantee lives on this line.
     * @returns {Promise<{hit: boolean, similarity: number, ms: number}>}
     */
    async observe({ text, agent, category }) {
      const started = Date.now();
      try {
        counters.observed++;
        const res = await engine.lookup(text, { agent, category });
        const ms = Date.now() - started;
        if (res.hit) counters.wouldHit++;
        safeEmit({
          ts: new Date().toISOString(),
          event: "semantic_cache.shadow",
          hit: Boolean(res.hit),
          similarity: Number(res.similarity ?? 0),
          agent_id: agent,
          category,
          embed_ms: ms,
          observed: counters.observed,
          would_hit: counters.wouldHit,
        });
        // Deliberately drops res.response.
        return { hit: Boolean(res.hit), similarity: Number(res.similarity ?? 0), ms };
      } catch (err) {
        counters.errors++;
        safeEmit({
          ts: new Date().toISOString(),
          event: "semantic_cache.error",
          phase: "observe",
          message: String(err?.message || err).slice(0, 200),
        });
        return { hit: false, similarity: 0, ms: Date.now() - started };
      }
    },

    /** Store a completed prompt/response so later prompts can match it. */
    async record({ text, response, agent, category }) {
      try {
        await engine.put(text, response, { agent, category });
      } catch (err) {
        counters.errors++;
        safeEmit({
          ts: new Date().toISOString(),
          event: "semantic_cache.error",
          phase: "record",
          message: String(err?.message || err).slice(0, 200),
        });
      }
    },

    stats() {
      return { ...counters, size: backing.size ?? 0 };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import ./tests/_setup.mjs tests/semantic-cache-shadow.test.mjs`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/proxy/semantic-cache-shadow.mjs tests/semantic-cache-shadow.test.mjs
git commit -m "feat(cache): shadow recorder that measures would-hits and serves nothing"
```

---

### Task 3: Wire it into the live path

**Files:**
- Modify: `src/index.mjs` (classification block around line 2002; `routeAndSend` call around line 2244)
- Test: `tests/semantic-cache-live-wiring.test.mjs` (create)

**Interfaces:**
- Consumes: `createShadowRecorder` from Task 2, `config.semantic_cache` from Task 1.
- Produces: no new exports. The observable output is `semantic_cache.shadow` SIEM events.

**Blocker to fix first:** `classification` is declared with `const` inside the `try` block at `src/index.mjs:2002`, so it is NOT in scope at the `routeAndSend` call on line 2244. Hoist it.

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createShadowRecorder } from "../src/proxy/semantic-cache-shadow.mjs";

const CFG = {
  enabled: true, mode: "shadow", threshold: 0.9, ttl_seconds: 60, max_entries: 10,
  categories: ["administrative", "system", "data_query"],
};
const fakeEmbed = async (t) => [t.length, t.charCodeAt(0) || 0, 1];

describe("live wiring contract", () => {
  test("an ineligible category is never embedded at all", async () => {
    let embedCalls = 0;
    const r = createShadowRecorder(CFG, {
      emit: () => {},
      embed: async (t) => { embedCalls++; return fakeEmbed(t); },
    });
    // The live path must consult eligible() BEFORE spending an embed call.
    if (r.eligible("tool_use")) await r.observe({ text: "x", agent: "a", category: "tool_use" });
    assert.equal(embedCalls, 0, "no embed call may be spent on ineligible traffic");
  });

  test("stats expose the numbers the go/no-go decision needs", async () => {
    const r = createShadowRecorder(CFG, { emit: () => {}, embed: fakeEmbed });
    await r.observe({ text: "a", agent: "l", category: "administrative" });
    await r.record({ text: "a", response: { ok: 1 }, agent: "l", category: "administrative" });
    await r.observe({ text: "a", agent: "l", category: "administrative" });
    const s = r.stats();
    assert.equal(s.observed, 2);
    assert.equal(s.wouldHit, 1);
    assert.equal(s.errors, 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import ./tests/_setup.mjs tests/semantic-cache-live-wiring.test.mjs`
Expected: PASS on test 2 but this file is the contract guard; if `stats()` is missing it FAILs with `r.stats is not a function`. If Task 2 is complete both pass. Confirm both pass before editing `index.mjs`.

- [ ] **Step 3: Hoist `classification` in `src/index.mjs`**

Replace the block starting at line 2002:

```javascript
    let classification = null;
    if (config.classification?.enabled && Array.isArray(parsedMessages)) {
      try {
        classification = classifyRequest(parsedMessages, {
          classifier: config.classification.classifier,
        });
        siemHook(toSiemEvent(classification, {
          agent_id: identity.agent_id,
          session_id: identity.session_id,
          model: parsedModel,
          path: req.url,
        }));
      } catch { /* never let classification break a request */ }
    }
```

The only change is `const classification =` becoming an assignment to a `let` declared above the `if`, so the category is readable further down.

- [ ] **Step 4: Create the recorder once at module scope**

Near the other module-level singletons in `src/index.mjs`, add:

```javascript
import { createShadowRecorder } from "./proxy/semantic-cache-shadow.mjs";

/**
 * One recorder for the process. Built lazily on first eligible request so a
 * disabled cache costs nothing at boot and an unreachable embedder cannot stop
 * the gateway starting.
 */
let _shadowCache = null;
function shadowCache(config) {
  const cfg = config.semantic_cache;
  if (!cfg?.enabled) return null;
  if (!_shadowCache) _shadowCache = createShadowRecorder(cfg, { emit: siemHook });
  return _shadowCache;
}
```

- [ ] **Step 5: Observe before dispatch**

Immediately BEFORE the `result = await routeAndSend(` call (around line 2244), add:

```javascript
    // Semantic cache, SHADOW ONLY. Records whether a cached answer would have
    // matched and throws that answer away. It cannot change what is served.
    // Guarded on eligible() first so ineligible traffic never spends an embed.
    const _sc = shadowCache(config);
    const _scText = _sc && Array.isArray(parsedMessages)
      ? parsedMessages.filter((m) => m?.role === "user")
          .map((m) => (typeof m.content === "string" ? m.content : "")).join("\n").trim()
      : "";
    const _scCategory = classification?.category;
    const _scEligible = Boolean(_sc && _scText && _sc.eligible(_scCategory));
    if (_scEligible) {
      await _sc.observe({ text: _scText, agent: metricsAgentId, category: _scCategory });
    }
```

- [ ] **Step 6: Record after a successful response**

Immediately AFTER the response is known good (inside the same `status === 200` guard the response sanitiser uses), add:

```javascript
      if (_scEligible && result?.status === 200 && result?.body) {
        try {
          _sc.record({
            text: _scText,
            response: JSON.parse(result.body.toString("utf-8")),
            agent: metricsAgentId,
            category: _scCategory,
          });
        } catch { /* not JSON, nothing to cache; never break the response */ }
      }
```

Note this is intentionally NOT awaited beyond the parse: storing must not add latency to the client's response.

- [ ] **Step 7: Run the full suite**

Run: `SKGATEWAY_MODEL_CATALOG_STORE_PATH=$(mktemp -d)/c.json npm test`
Expected: PASS, 0 fail. The cache is disabled by default so no existing test changes behaviour.

- [ ] **Step 8: Commit**

```bash
git add src/index.mjs tests/semantic-cache-live-wiring.test.mjs CHANGELOG.md
git commit -m "feat(cache): observe would-hits on the live path in shadow mode"
```

CHANGELOG entry under `### Added`:

```markdown
- The semantic cache is wired into the live `/v1/chat/completions` path in
  shadow mode. On an eligible request it embeds the user text, records whether a
  cached answer would have matched, discards that answer, and dispatches
  normally. It cannot change what a client receives while `mode: shadow`.
  Disabled by default.
```

---

### Task 4: Read the shadow data back

**Files:**
- Create: `scripts/semantic-cache-report.mjs`
- Test: `tests/semantic-cache-report.test.mjs` (create)

**Interfaces:**
- Consumes: `semantic_cache.shadow` events written to the SIEM file sink (`logs/audit.jsonl` by default).
- Produces: a CLI printing observed / would-hit / hit-rate overall and per category. This is the artefact the go/no-go decision is read from.

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { summarise } from "../scripts/semantic-cache-report.mjs";

describe("shadow report", () => {
  test("computes hit rate overall and per category", () => {
    const events = [
      { event: "semantic_cache.shadow", hit: true,  category: "administrative", embed_ms: 70 },
      { event: "semantic_cache.shadow", hit: false, category: "administrative", embed_ms: 80 },
      { event: "semantic_cache.shadow", hit: false, category: "data_query",     embed_ms: 75 },
      { event: "prompt.classified",     category: "tool_use" },
    ];
    const s = summarise(events);
    assert.equal(s.observed, 3, "only semantic_cache.shadow events count");
    assert.equal(s.wouldHit, 1);
    assert.equal(s.hitRate, 1 / 3);
    assert.equal(s.byCategory.administrative.observed, 2);
    assert.equal(s.byCategory.administrative.wouldHit, 1);
    assert.equal(s.medianEmbedMs, 75);
  });

  test("no events is reported honestly, not as a zero hit rate", () => {
    const s = summarise([]);
    assert.equal(s.observed, 0);
    assert.equal(s.hitRate, null, "no data must not be presented as 0% hit rate");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import ./tests/_setup.mjs tests/semantic-cache-report.test.mjs`
Expected: FAIL, `Cannot find module '../scripts/semantic-cache-report.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
#!/usr/bin/env node
/**
 * semantic-cache-report.mjs — read the shadow ledger and print the hit rate.
 *
 * Usage: node scripts/semantic-cache-report.mjs [path/to/audit.jsonl]
 *
 * This is the whole point of shadow mode: turn "we do not know the hit rate"
 * into a number, so enabling `mode: serve` is arithmetic rather than a guess.
 */
import { readFileSync } from "node:fs";

/** @param {Array<object>} events */
export function summarise(events) {
  const shadow = events.filter((e) => e?.event === "semantic_cache.shadow");
  const byCategory = {};
  const embedTimes = [];
  let wouldHit = 0;
  for (const e of shadow) {
    const c = e.category || "unknown";
    byCategory[c] ||= { observed: 0, wouldHit: 0 };
    byCategory[c].observed++;
    if (e.hit) { byCategory[c].wouldHit++; wouldHit++; }
    if (Number.isFinite(e.embed_ms)) embedTimes.push(e.embed_ms);
  }
  embedTimes.sort((a, b) => a - b);
  return {
    observed: shadow.length,
    wouldHit,
    // null, not 0: "no data" and "never hits" are different answers.
    hitRate: shadow.length ? wouldHit / shadow.length : null,
    medianEmbedMs: embedTimes.length ? embedTimes[Math.floor(embedTimes.length / 2)] : null,
    byCategory,
  };
}

function main() {
  const path = process.argv[2] || "logs/audit.jsonl";
  const events = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  const s = summarise(events);
  if (s.observed === 0) {
    console.log("No semantic_cache.shadow events. Is semantic_cache.enabled true?");
    return;
  }
  console.log(`observed        ${s.observed}`);
  console.log(`would-hit       ${s.wouldHit}`);
  console.log(`hit rate        ${(s.hitRate * 100).toFixed(1)}%`);
  console.log(`median embed    ${s.medianEmbedMs} ms`);
  console.log("");
  console.log("category            observed  would-hit  rate");
  for (const [c, v] of Object.entries(s.byCategory).sort((a, b) => b[1].observed - a[1].observed)) {
    const rate = ((v.wouldHit / v.observed) * 100).toFixed(1);
    console.log(`  ${c.padEnd(18)}${String(v.observed).padStart(8)}${String(v.wouldHit).padStart(11)}${(rate + "%").padStart(7)}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import ./tests/_setup.mjs tests/semantic-cache-report.test.mjs`
Expected: PASS, 2 tests

- [ ] **Step 5: Run the full suite and commit**

```bash
SKGATEWAY_MODEL_CATALOG_STORE_PATH=$(mktemp -d)/c.json npm test
git add scripts/semantic-cache-report.mjs tests/semantic-cache-report.test.mjs CHANGELOG.md
git commit -m "feat(cache): report the shadow-mode hit rate per category"
```

CHANGELOG entry under `### Added`:

```markdown
- `scripts/semantic-cache-report.mjs` reads `semantic_cache.shadow` events out
  of the SIEM sink and prints observed count, would-hit count, hit rate and
  median embed latency, overall and per category. Reports "no data" rather than
  a 0% hit rate when the cache has not run.
```

---

### Task 5: Enable shadow on the gateway host

**Files:**
- Modify: `~/.skcapstone/gateway/skgateway.yaml` (NOT in this repo)

**Interfaces:**
- Consumes: everything above.
- Produces: live shadow data.

- [ ] **Step 1: Confirm the embedder is reachable**

```bash
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" -m 10 \
  -X POST http://192.168.0.100:11438/v1/embeddings \
  -H 'content-type: application/json' \
  -d '{"model":"mxbai-embed-large","input":"probe"}'
```
Expected: `200` and under 0.5s. If this fails, stop: shadow mode would log only errors.

- [ ] **Step 2: Add the block to the LIVE config**

Append the same `semantic_cache:` block from Task 1 Step 4 to `~/.skcapstone/gateway/skgateway.yaml`, with `enabled: true` and `mode: shadow`.

- [ ] **Step 3: Reload and verify**

```bash
systemctl --user restart skgateway
sleep 6
curl -s -m 6 http://127.0.0.1:18780/health | head -c 120
```

- [ ] **Step 4: Confirm events are being written**

After some real traffic:

```bash
grep -c '"event":"semantic_cache.shadow"' logs/audit.jsonl
node scripts/semantic-cache-report.mjs
```

- [ ] **Step 5: Leave it for one week, then decide**

Do not enable `mode: serve` in this plan. The decision belongs to whoever reads the report.

---

## Deliberately NOT in this plan

- **pgvector backing store.** `createMemoryStore` is in-process and capped at `max_entries`, which is enough to measure a hit rate. A persistent store only matters once we know the rate justifies serving. Add it when the report says yes.
- **`mode: serve`.** No code path here returns a cached response to a client.
- **Widening the eligible categories.** `tool_use` is the biggest slice of wall clock and the most dangerous to cache.
- **Streaming responses.** Shadow only records buffered JSON responses. Streaming would need its own capture and adds nothing to a hit-rate measurement.
