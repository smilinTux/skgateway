#!/usr/bin/env node
/**
 * skgateway CLI.
 *
 * Currently exposes the operator facet (R2.12): the explain / observe / act
 * contract that mirrors Atlas's skgateway adapter. Structured as a subcommand
 * dispatcher so future top-level commands slot in alongside `operator`.
 *
 *   skgateway operator explain              -> print the contract JSON
 *   skgateway operator observe              -> print live conditions JSON (fails safe)
 *   skgateway operator act <action> [opts]  -> perform a standard action, or refuse
 *
 *     act actions:
 *       restart_service           [--unit <unit>]   systemctl --user restart <unit>
 *       quarantine_dead_alias     [--alias <name>]  drop a degraded upstream (stub actuator)
 *       raise_pool_limit                            NOT standard: escalates, never actuates
 */

import * as operator from "../src/operator/operator.mjs";

function usage() {
  return [
    "usage: skgateway operator <explain|observe|act> [args]",
    "",
    "  operator explain              print the operator contract (kinds/conditions/actions)",
    "  operator observe              print live conditions from the health probe (fails safe)",
    "  operator act <action> [opts]  perform a standard action, or refuse",
    "",
    "  act actions:",
    "    restart_service        [--unit <unit>]    restart the skgateway service",
    "    quarantine_dead_alias  [--alias <name>]   drop a degraded upstream from the pool",
    "    raise_pool_limit                          NOT standard: escalates, never actuates",
  ].join("\n");
}

/** Minimal --flag <value> parser over the remaining argv. */
function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      out[key] = i + 1 < args.length ? args[(i += 1)] : true;
    }
  }
  return out;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

export async function run(argv) {
  const [group, verb, ...rest] = argv;

  if (group === "-h" || group === "--help" || group === undefined) {
    process.stdout.write(usage() + "\n");
    return 0;
  }

  if (group !== "operator") {
    process.stderr.write(`skgateway: unknown command ${JSON.stringify(group)}\n\n${usage()}\n`);
    return 2;
  }

  if (verb === "explain") {
    emit(operator.explain());
    return 0;
  }

  if (verb === "observe") {
    emit(await operator.observe());
    return 0;
  }

  if (verb === "act") {
    const action = rest[0];
    if (!action) {
      process.stderr.write("skgateway operator act: missing <action>\n\n" + usage() + "\n");
      return 2;
    }
    const flags = parseFlags(rest.slice(1));
    try {
      const result = await operator.act(action, {
        unit: typeof flags.unit === "string" ? flags.unit : undefined,
        alias: typeof flags.alias === "string" ? flags.alias : undefined,
      });
      emit(result);
      return 0;
    } catch (err) {
      process.stderr.write(`skgateway operator act: ${err.message}\n`);
      return 1;
    }
  }

  process.stderr.write(`skgateway operator: unknown verb ${JSON.stringify(verb)}\n\n${usage()}\n`);
  return 2;
}

// Only run when invoked directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
