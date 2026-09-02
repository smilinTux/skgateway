# Token Ratio Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded 4-bytes-per-token guess in the context guard with a ratio measured per model from live traffic.

**Architecture:** The gateway already receives exact `usage.prompt_tokens` from every backend that reports usage. It does not record the request's byte size anywhere, so the two cannot be joined today. This emits one SIEM event per request carrying both, then a report computes bytes-per-token per model. Applying the measured ratio is a separate, later decision, exactly like `mode: serve` in the semantic-cache plan.

**Why not port a tokenizer:** The autocache tokenizer is 1.77 MB of vendored BPE data plus a ~350-line Go port, and it is Claude-specific. Measured traffic is 99% ornith, qwen38 and NVIDIA, which tokenize differently, so it would be precise for the lane we barely use and wrong for the ones we do. The repo also has exactly three prod dependencies and a documented history of hand-maintained data rotting. A measured ratio costs no dependency, no vendored asset, and is correct per model by construction.

**Tech Stack:** Node 22 ESM, `node:test`, existing `siemHook` file sink.

**Spec:** Agreed with Chef 2026-09-02, replacing plan item B ("port the autocache tokenizer") after the 1.77 MB asset cost was measured.

## Global Constraints

- **Node 22 only.**
- **No new dependencies.** Prod deps stay exactly `better-sqlite3`, `js-yaml`, `openpgp`.
- **No schema migration.** Reuse the SIEM sink rather than adding a metrics column, so this is reversible by turning a flag off.
- **CHANGELOG entry mandatory** for `src/` changes (tier-2 docs-check).
- **Set `SKGATEWAY_MODEL_CATALOG_STORE_PATH`** to a temp path in tests.
- **Fail-open.** Sampling must never fail a request.
- **Do not change truncation behaviour in this plan.** Phase 1 measures only. The current `max_body_bytes` limits stay exactly as they are.

---

### Task 1: Sample body bytes against reported tokens

**Files:**
- Create: `src/metrics/token-ratio.mjs`
- Test: `tests/token-ratio.test.mjs` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `sampleTokenRatio({ model, bodyBytes, usage }) => {model, body_bytes, prompt_tokens, bytes_per_token}|null` — Task 2 wires it, Task 3 reads its events.

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sampleTokenRatio } from "../src/metrics/token-ratio.mjs";

describe("token ratio sampling", () => {
  test("computes bytes per token from a reported usage", () => {
    const s = sampleTokenRatio({ model: "ornith-1.5-9b", bodyBytes: 4000, usage: { prompt_tokens: 1000 } });
    assert.equal(s.model, "ornith-1.5-9b");
    assert.equal(s.body_bytes, 4000);
    assert.equal(s.prompt_tokens, 1000);
    assert.equal(s.bytes_per_token, 4);
  });

  test("accepts the Anthropic usage spelling too", () => {
    const s = sampleTokenRatio({ model: "claude-opus-5", bodyBytes: 900, usage: { input_tokens: 300 } });
    assert.equal(s.bytes_per_token, 3);
  });

  test("returns null when there is nothing to measure", () => {
    assert.equal(sampleTokenRatio({ model: "m", bodyBytes: 100, usage: {} }), null);
    assert.equal(sampleTokenRatio({ model: "m", bodyBytes: 100, usage: { prompt_tokens: 0 } }), null,
      "zero tokens would divide by zero, not a measurement");
    assert.equal(sampleTokenRatio({ model: "m", bodyBytes: 0, usage: { prompt_tokens: 10 } }), null);
    assert.equal(sampleTokenRatio({ model: "", bodyBytes: 100, usage: { prompt_tokens: 10 } }), null);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import ./tests/_setup.mjs tests/token-ratio.test.mjs`
Expected: FAIL, `Cannot find module '../src/metrics/token-ratio.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
/**
 * token-ratio.mjs — measure bytes-per-token per model from live traffic.
 *
 * The context guard in sanitizer.mjs budgets by BYTES (max_body_bytes) as a
 * stand-in for tokens, using a hardcoded ~4 bytes/token. That ratio is a guess,
 * it is wrong by model (CJK, code and prose differ), and nothing has ever
 * checked it. Backends already report exact prompt token counts; the gateway
 * simply never recorded the matching byte size, so the two could not be joined.
 *
 * This pairs them. Phase 1 only measures. Applying the measured ratio to the
 * budget is a separate decision once there is data to justify it.
 *
 * @module token-ratio
 */

/**
 * @param {{model: string, bodyBytes: number, usage: object}} args
 * @returns {{model:string, body_bytes:number, prompt_tokens:number,
 *            bytes_per_token:number}|null} null when there is nothing to measure
 */
export function sampleTokenRatio({ model, bodyBytes, usage } = {}) {
  if (typeof model !== "string" || !model) return null;
  if (!Number.isFinite(bodyBytes) || bodyBytes <= 0) return null;
  // OpenAI shape is prompt_tokens; Anthropic Messages is input_tokens.
  const tokens = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  return {
    model,
    body_bytes: bodyBytes,
    prompt_tokens: tokens,
    bytes_per_token: bodyBytes / tokens,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import ./tests/_setup.mjs tests/token-ratio.test.mjs`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/metrics/token-ratio.mjs tests/token-ratio.test.mjs
git commit -m "feat(metrics): compute bytes-per-token from reported usage"
```

---

### Task 2: Emit one sample per request

**Files:**
- Modify: `src/index.mjs` (after the response is known good, same guard the response sanitiser uses)
- Test: `tests/token-ratio-emit.test.mjs` (create)

**Interfaces:**
- Consumes: `sampleTokenRatio` from Task 1, `siemHook` in `src/index.mjs`.
- Produces: `token_ratio.sample` SIEM events. Task 3 reads them.

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sampleTokenRatio } from "../src/metrics/token-ratio.mjs";

describe("token ratio emission contract", () => {
  test("a sample carries exactly the fields the report needs", () => {
    const s = sampleTokenRatio({ model: "qwen3.8-27b", bodyBytes: 8192, usage: { prompt_tokens: 2048 } });
    const evt = { ts: new Date().toISOString(), event: "token_ratio.sample", ...s };
    for (const k of ["model", "body_bytes", "prompt_tokens", "bytes_per_token"]) {
      assert.ok(k in evt, `report joins on ${k}`);
    }
    assert.equal(evt.bytes_per_token, 4);
  });

  test("an unmeasurable request produces no event", () => {
    assert.equal(sampleTokenRatio({ model: "m", bodyBytes: 10, usage: {} }), null,
      "a backend that reports no usage must not emit a fabricated ratio");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import ./tests/_setup.mjs tests/token-ratio-emit.test.mjs`
Expected: PASS if Task 1 is complete. This file is the field contract guard; confirm it passes before editing `index.mjs`.

- [ ] **Step 3: Wire it into `src/index.mjs`**

Add the import alongside the other metrics imports:

```javascript
import { sampleTokenRatio } from "./metrics/token-ratio.mjs";
```

Then, inside the same `result?.status === 200 && result?.body` guard the response sanitiser already uses, add:

```javascript
      // Measure bytes-per-token against what the backend actually reported, so
      // the context guard's byte budget can eventually stop guessing at ~4.
      // Sampling only: nothing here changes trimming. Never throws.
      try {
        const _usage = JSON.parse(result.body.toString("utf-8"))?.usage;
        const _sample = sampleTokenRatio({
          model: result.servedModel || parsedModel,
          bodyBytes: routeBody?.length ?? 0,
          usage: _usage,
        });
        if (_sample) siemHook({ ts: new Date().toISOString(), event: "token_ratio.sample", ..._sample });
      } catch { /* a backend that reports no usage simply is not measured */ }
```

- [ ] **Step 4: Run the full suite**

Run: `SKGATEWAY_MODEL_CATALOG_STORE_PATH=$(mktemp -d)/c.json npm test`
Expected: PASS, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/index.mjs tests/token-ratio-emit.test.mjs CHANGELOG.md
git commit -m "feat(metrics): sample bytes-per-token on every measurable response"
```

CHANGELOG entry under `### Added`:

```markdown
- Every response that reports usage now emits a `token_ratio.sample` SIEM event
  carrying the request's byte size and the backend's reported prompt tokens.
  The context guard budgets by bytes using a hardcoded ~4 bytes-per-token
  guess that nothing has ever checked; the request byte size was not recorded
  anywhere, so the guess could not be verified. This measures it per model.
  Sampling only, no trimming behaviour changes.
```

---

### Task 3: Report the measured ratio per model

**Files:**
- Create: `scripts/token-ratio-report.mjs`
- Test: `tests/token-ratio-report.test.mjs` (create)

**Interfaces:**
- Consumes: `token_ratio.sample` events from the SIEM sink.
- Produces: a CLI printing measured median bytes-per-token per model against the 4.0 assumption, and what each model's `max_body_bytes` would become.

- [ ] **Step 1: Write the failing test**

```javascript
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { summariseRatios } from "../scripts/token-ratio-report.mjs";

describe("token ratio report", () => {
  test("medians per model, and the drift from the 4.0 assumption", () => {
    const events = [
      { event: "token_ratio.sample", model: "a", bytes_per_token: 3 },
      { event: "token_ratio.sample", model: "a", bytes_per_token: 5 },
      { event: "token_ratio.sample", model: "a", bytes_per_token: 4 },
      { event: "token_ratio.sample", model: "b", bytes_per_token: 2 },
      { event: "semantic_cache.shadow", hit: true },
    ];
    const s = summariseRatios(events);
    assert.equal(s.a.samples, 3);
    assert.equal(s.a.median, 4);
    assert.equal(s.b.median, 2);
    assert.equal(s.b.driftFrom4, -0.5, "b packs twice the tokens per byte the guess assumes");
  });

  test("a model with too few samples is marked, not reported as fact", () => {
    const s = summariseRatios([{ event: "token_ratio.sample", model: "c", bytes_per_token: 9 }]);
    assert.equal(s.c.confident, false, "one sample is not a measurement");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import ./tests/_setup.mjs tests/token-ratio-report.test.mjs`
Expected: FAIL, `Cannot find module '../scripts/token-ratio-report.mjs'`

- [ ] **Step 3: Write the implementation**

```javascript
#!/usr/bin/env node
/**
 * token-ratio-report.mjs — what bytes-per-token actually is, per model.
 *
 * Usage: node scripts/token-ratio-report.mjs [path/to/audit.jsonl]
 *
 * The context guard assumes ~4 bytes per token. This prints the measured
 * median per model and how far the assumption drifts, so max_body_bytes can be
 * set from data instead of a guess.
 */
import { readFileSync } from "node:fs";

const ASSUMED_BYTES_PER_TOKEN = 4;
const MIN_CONFIDENT_SAMPLES = 30;

/** @param {Array<object>} events */
export function summariseRatios(events) {
  const byModel = {};
  for (const e of events) {
    if (e?.event !== "token_ratio.sample") continue;
    if (!Number.isFinite(e.bytes_per_token)) continue;
    (byModel[e.model] ||= []).push(e.bytes_per_token);
  }
  const out = {};
  for (const [model, values] of Object.entries(byModel)) {
    values.sort((a, b) => a - b);
    const median = values[Math.floor(values.length / 2)];
    out[model] = {
      samples: values.length,
      median,
      min: values[0],
      max: values[values.length - 1],
      driftFrom4: (median - ASSUMED_BYTES_PER_TOKEN) / ASSUMED_BYTES_PER_TOKEN,
      confident: values.length >= MIN_CONFIDENT_SAMPLES,
    };
  }
  return out;
}

function main() {
  const path = process.argv[2] || "logs/audit.jsonl";
  const events = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip malformed */ }
  }
  const s = summariseRatios(events);
  const models = Object.entries(s).sort((a, b) => b[1].samples - a[1].samples);
  if (!models.length) {
    console.log("No token_ratio.sample events yet.");
    return;
  }
  console.log("model                                samples  median  drift vs 4.0  confident");
  for (const [m, v] of models) {
    const drift = `${v.driftFrom4 >= 0 ? "+" : ""}${(v.driftFrom4 * 100).toFixed(0)}%`;
    console.log(
      `  ${m.slice(0, 34).padEnd(34)}${String(v.samples).padStart(7)}` +
      `${v.median.toFixed(2).padStart(8)}${drift.padStart(14)}${(v.confident ? "yes" : "NO").padStart(11)}`,
    );
  }
  console.log(`\n(confident = at least ${MIN_CONFIDENT_SAMPLES} samples)`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import ./tests/_setup.mjs tests/token-ratio-report.test.mjs`
Expected: PASS, 2 tests

- [ ] **Step 5: Run the full suite and commit**

```bash
SKGATEWAY_MODEL_CATALOG_STORE_PATH=$(mktemp -d)/c.json npm test
git add scripts/token-ratio-report.mjs tests/token-ratio-report.test.mjs CHANGELOG.md
git commit -m "feat(metrics): report measured bytes-per-token per model"
```

CHANGELOG entry under `### Added`:

```markdown
- `scripts/token-ratio-report.mjs` prints measured median bytes-per-token per
  model against the guard's 4.0 assumption, with a confidence marker so a model
  with a handful of samples is not read as a measurement.
```

---

## Deliberately NOT in this plan

- **Applying the measured ratio to `max_body_bytes`.** Phase 1 measures. Retuning the guard is a separate change once the report shows real drift on models with enough samples.
- **A metrics DB column.** The SIEM sink already persists these and needs no migration, so this is reversible by turning it off.
- **A tokenizer.** Rejected on cost: 1.77 MB vendored BPE plus a ~350-line port, Claude-specific, for a fleet that is 99% ornith / qwen38 / NVIDIA.
