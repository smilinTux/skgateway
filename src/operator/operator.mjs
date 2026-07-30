/**
 * skgateway operator facet: the explain / observe / act contract (R2.12).
 *
 * This is the Node-side operator-facet contract that mirrors Atlas's skgateway
 * adapter (skcapstone/src/skcapstone/operator_seat/skgateway_adapter.py). The
 * adapter contract (kinds / conditions / actions) is the shared source of truth
 * defined by sk-standards; this module reproduces it exactly so Atlas can manage
 * skgateway the same way it manages the five Python app adapters.
 *
 * Everything is pure and injectable: the health probe (observe) and the command
 * runner / quarantine actuator (act) are all parameters, so tests never touch a
 * live skgateway, real systemd, or the network. The default probe reads the
 * gateway /health endpoint and fails SAFE (reports healthy) rather than raising
 * a false alarm when it cannot be reached, mirroring the Python `_default_probe`.
 *
 * @module operator
 */

/** The object kinds this facet manages. */
export const KINDS = ["upstream", "pool"];

/** The conditions this facet reports (order-significant, matches the adapter). */
export const CONDITIONS = ["UpstreamServing", "PoolHealthy"];

/** The systemd unit `restart_service` restarts (user scope). */
export const SKGATEWAY_UNIT = "skgateway.service";

/**
 * Action metadata, byte-compatible in shape with the Python adapter's `_ACTIONS`.
 *
 * restart_service + quarantine_dead_alias are the standard, reversible, low-blast
 * actions the operator may actuate. raise_pool_limit is NOT standard: it is a
 * major change (raises the NIM connection-pool ceiling) and escalates instead of
 * actuating here.
 */
export const ACTIONS = [
  {
    name: "restart_service",
    standard: true,
    reversible: true,
    blast_radius: "low",
    runbook: "restart the skgateway service",
    kedb_refs: [],
  },
  {
    name: "quarantine_dead_alias",
    standard: true,
    reversible: true,
    blast_radius: "low",
    runbook: "drop a degraded upstream from the pool, auto-restore on recovery",
    kedb_refs: [],
  },
  {
    name: "raise_pool_limit",
    standard: false,
    reversible: true,
    blast_radius: "medium",
    runbook: "raise the NIM connection-pool ceiling (major: escalates)",
    kedb_refs: [],
  },
];

/** Coerce a boolean to the adapter's "True" / "False" string status. */
function _b(value) {
  return value ? "True" : "False";
}

/**
 * Best-effort skgateway health. Fails SAFE (reports healthy) when the gateway
 * cannot be reached, so an inability to probe never becomes a false alarm.
 *
 * Reads the gateway /health endpoint (derived from SKOPERATOR_GATEWAY, default
 * http://localhost:18780/v1) exactly like the Python adapter: all backends up ->
 * UpstreamServing; no backend quarantined -> PoolHealthy.
 *
 * @returns {Promise<{upstream_serving: boolean, pool_healthy: boolean}>}
 */
export async function defaultProbe() {
  try {
    const base = process.env.SKOPERATOR_GATEWAY || "http://localhost:18780/v1";
    const url = base.replace(/\/+$/, "").replace(/\/v1$/, "") + "/health";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let health;
    try {
      const resp = await fetch(url, { signal: controller.signal });
      health = await resp.json();
    } finally {
      clearTimeout(timer);
    }
    const backends = health?.backends || {};
    const values = Object.values(backends);
    const up = values.length ? values.every((b) => b?.status === "up") : true;
    const saturated = values.some((b) => b?.quarantined);
    return { upstream_serving: Boolean(up), pool_healthy: !saturated };
  } catch {
    return { upstream_serving: true, pool_healthy: true };
  }
}

/**
 * skgateway's self-description in the operator-contract shape.
 *
 * @returns {{kinds: string[], conditions: string[], actions: object[]}}
 */
export function explain() {
  return {
    kinds: [...KINDS],
    conditions: [...CONDITIONS],
    actions: ACTIONS.map((a) => ({ ...a })),
  };
}

/**
 * Read-only skgateway health snapshot in the operator-contract shape.
 *
 * @param {() => (object|Promise<object>)} [probe] injectable health probe; the
 *   default reads the gateway /health endpoint and fails safe. It may be sync or
 *   async and must yield `{upstream_serving, pool_healthy}`.
 * @returns {Promise<{conditions: Array<{type: string, status: string, object: string}>}>}
 */
export async function observe(probe) {
  const st = (await (probe || defaultProbe)()) || {};
  const upstreamServing = st.upstream_serving === undefined ? true : Boolean(st.upstream_serving);
  const poolHealthy = st.pool_healthy === undefined ? true : Boolean(st.pool_healthy);
  return {
    conditions: [
      { type: "UpstreamServing", status: _b(upstreamServing), object: "upstreams" },
      { type: "PoolHealthy", status: _b(poolHealthy), object: "connection-pool" },
    ],
  };
}

/** Look up an action's metadata by name. */
function _actionMeta(action) {
  return ACTIONS.find((a) => a.name === action) || null;
}

/**
 * Default command runner for restart_service. Runs the systemd command and
 * captures its result. Never invoked under test (act's runner is injected there).
 */
function _defaultRunner(cmd) {
  // Lazy import so this module stays pure/dependency-free until an action runs.
  return import("node:child_process").then(({ spawnSync }) => {
    const proc = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8" });
    return {
      ok: proc.status === 0,
      returncode: proc.status,
      stdout: proc.stdout || "",
      stderr: proc.stderr || "",
    };
  });
}

/**
 * Default quarantine actuator (clearly stubbed).
 *
 * skgateway's dead-alias quarantine is driven IN-PROCESS by the running gateway's
 * router (error-rate + consecutive-failure tracking, auto-restore on recovery);
 * there is no external admin endpoint to force it from a separate CLI process, so
 * the real pool mechanism is not trivially reachable from here. This default is a
 * clearly-marked stub: it does not mutate any live pool and reports that the
 * actuation belongs to the running gateway. Under test the actuator is injected.
 */
function _defaultQuarantineActuator(alias) {
  return {
    ok: false,
    stub: true,
    alias: alias || null,
    note:
      "stub: skgateway auto-quarantines dead aliases in-process (router error-rate " +
      "tracking, auto-restore on recovery); no external admin endpoint exists to force " +
      "it from the CLI. Inject an actuator, or wire to a live admin endpoint when one lands.",
  };
}

/**
 * Perform a reversible standard skgateway action, or refuse.
 *
 * - restart_service: `systemctl --user restart <unit>` through the injected
 *   `runner` (defaults to a real subprocess).
 * - quarantine_dead_alias: drop a degraded upstream from the pool through the
 *   injected `actuator` (defaults to a clearly-marked stub, see above).
 * - raise_pool_limit: NOT standard. It is a major change and is NEVER actuated
 *   here; it returns an escalate message. Any unknown action is refused (throws).
 *
 * @param {string} action one of the ACTIONS names.
 * @param {object} [opts]
 * @param {(cmd: string[]) => (object|Promise<object>)} [opts.runner] restart runner.
 * @param {(alias: string|null) => (object|Promise<object>)} [opts.actuator] quarantine actuator.
 * @param {string} [opts.unit] override the systemd unit for restart_service.
 * @param {string} [opts.alias] the upstream alias to quarantine.
 * @returns {Promise<object>}
 */
export async function act(action, opts = {}) {
  const { runner, actuator, unit, alias } = opts;
  const meta = _actionMeta(action);
  if (meta === null) {
    throw new Error(`unknown skgateway operator action ${JSON.stringify(action)}`);
  }
  if (!meta.standard) {
    // raise_pool_limit (and any future non-standard action): refuse at the act
    // verb. It escalates as a MAJOR change and never actuates here.
    return {
      action,
      performed: false,
      escalate: "MAJOR",
      reason:
        "major: raises the NIM connection-pool ceiling; escalates via change control " +
        "(policy.classify_change) and never actuates here",
    };
  }
  if (action === "restart_service") {
    const targetUnit = unit || SKGATEWAY_UNIT;
    const cmd = ["systemctl", "--user", "restart", targetUnit];
    const result = await (runner || _defaultRunner)(cmd);
    return { action, performed: true, reversible: true, unit: targetUnit, command: cmd, result };
  }
  // quarantine_dead_alias
  const target = alias || null;
  const result = await (actuator || _defaultQuarantineActuator)(target);
  return { action, performed: true, reversible: true, alias: target, result };
}

export default { KINDS, CONDITIONS, ACTIONS, SKGATEWAY_UNIT, defaultProbe, explain, observe, act };
