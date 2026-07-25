# SKGateway - Writing an Integration Adapter

SKGateway ships gateway events (auth, request, response, error, policy
violations, anomalies, failovers, tool use) to external systems through
**integration adapters**. The SIEM sinks (`file`, `syslog`,
`elasticsearch`/`opensearch`) are all adapters, and so is the
skcapstone sk-alert bridge. This guide is the reference for adding a new one so
every integration stays pluggable and consistent.

Start by copying the reference adapter:

- Reference adapter: [`src/integrations/reference-adapter.mjs`](../src/integrations/reference-adapter.mjs)
- Adapter registry (the registration point): [`src/integrations/registry.mjs`](../src/integrations/registry.mjs)
- Contract source of truth: the `OutputAdapter` typedef in [`src/siem/events.mjs`](../src/siem/events.mjs)

## The contract

An adapter is a factory `create<Name>Output(config, deps?)` that returns:

```js
{
  write(event)  // void: buffer/forward one event; MUST NOT throw
  flush()       // Promise<void>: force buffered work to complete
  close()       // Promise<void>: flush, then release resources
  enabled       // boolean: false when disabled or misconfigured (no-op)
}
```

The SIEM event bus (`createEventBus()` in `src/siem/events.mjs`) calls `write()`
for every event on each registered adapter, `flush()` on `drain()`, and
`close()` on shutdown. Any object with a `write(event)` method can be passed to
`bus.addOutput(...)`.

### Rules every adapter MUST follow

1. **Config-driven, disabled by default.** Return a fully-shaped no-op unless
   the caller opts in with `enabled: true` AND supplies what the adapter needs
   (endpoint, path, credentials, ...). The no-op still implements the full
   shape, so callers never branch on `enabled`. See the disabled branch at the
   top of every SIEM factory.
2. **`write()` is fire-and-forget and fail-safe.** It must never throw and never
   reject the hot proxy path. Catch errors, log to stderr, and drop the event.
3. **`flush()` / `close()` are idempotent** and safe to call on a no-op adapter.
4. **No live URLs, hosts, or secrets in code.** Read endpoints from `config`;
   read secrets from ENV-VAR *names* declared in config (e.g. `api_key_env`),
   never inline literals. See the elasticsearch adapter's `*_env` options.

## Step by step

1. **Copy the reference.** `cp src/integrations/reference-adapter.mjs
   src/integrations/my-thing.mjs`; rename `createReferenceOutput` to
   `createMyThingOutput` and set a `MY_THING_TYPE` key.
2. **Keep the disabled no-op branch first.** Enable only on `config.enabled ===
   true` plus your required config (an endpoint, a path, ...).
3. **Implement `write` / `flush` / `close`** around your transport. Buffer in
   `write`, drain in `flush`, release in `close`. Serialise async I/O on a
   single promise chain so writes never race (see `src/siem/file.mjs` and
   `src/siem/elasticsearch.mjs` for the pattern).
4. **Register it.** Add one line to `defaultRegistry()` in
   `src/integrations/registry.mjs`:

   ```js
   reg.register('my-thing', (cfg, deps) => createMyThingOutput(cfg, deps));
   ```

   or register at runtime: `registry.register('my-thing', factory)`.
5. **Wire it from config.** Add an entry under `siem.outputs` in config, keyed
   by your `type`:

   ```yaml
   siem:
     outputs:
       - { type: my-thing, enabled: false, endpoint: "" }   # disabled by default
   ```

   Build every enabled adapter with the registry:

   ```js
   import { defaultRegistry } from './integrations/registry.mjs';
   const adapters = defaultRegistry().buildAll(config.siem?.outputs ?? []);
   for (const a of adapters) bus.addOutput(a);
   ```
6. **Test it** like `tests/reference-adapter.test.mjs`: disabled → no-op;
   enabled → forwards; `write` never throws; registers on a real
   `createEventBus()`; builds by `type` through the registry.

## The reference adapter

`createReferenceOutput(config, deps)` is a no-op / echo adapter: when enabled it
records events into a bounded in-memory ring and optionally echoes a one-line
summary to `deps.sink` (defaults to stderr). It performs no network or disk I/O,
so it is always safe to enable, and it demonstrates the full contract for tests
and demos.

```js
import { createReferenceOutput } from './integrations/reference-adapter.mjs';

const out = createReferenceOutput({ enabled: true, echo: true });
bus.addOutput(out);
out.write(event);
await out.flush();
await out.close();
```

| Config key | Default | Meaning |
|------------|---------|---------|
| `enabled`  | `false` | Opt-in switch. Disabled → no-op. |
| `echo`     | `false` | Echo a one-line summary per event to `deps.sink`. |
| `max_keep` | `100`   | Max events retained in the in-memory ring. |
| `label`    | `reference` | Human label used in echo lines. |

## The skcapstone bridge

`src/integration.mjs` is a related but distinct integration: it forwards
`warn`+ SIEM events onto the mesh-wide sk-alert bus by writing Syncthing-synced
files under `~/.skcapstone` (a polyglot, broker-free bridge to the Python side).
It is not an `OutputAdapter` (it is called directly from the SIEM hook in
`src/index.mjs`), but it follows the same principles: present-or-degrade,
config/env driven, fail-safe. New network integrations should prefer the
`OutputAdapter` shape above so they can register on the event bus.
