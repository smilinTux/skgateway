import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Read once, hash those exact bytes, then fully load and validate those bytes. */
export async function prepareConfigRevision(path, load) {
  const bytes = await readFile(path);
  const revision = sha256(bytes);
  const config = await load(bytes, path);
  return Object.freeze({ path, bytes, revision, config });
}

export class DrainTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`listener did not drain within ${timeoutMs}ms`);
    this.name = "DrainTimeoutError";
  }
}

function deadline(promise, timeoutMs, timers) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = timers.setTimeout(() => reject(new DrainTimeoutError(timeoutMs)), timeoutMs);
    }),
  ]).finally(() => timers.clearTimeout(timer));
}

/**
 * Perform a fail-closed listener handoff.
 *
 * The candidate must be prepared from an immutable config snapshot before this
 * function is called. The old listener first stops accepting, then drains.
 * Only after a successful bounded drain may the candidate bind. Any drain or
 * bind failure restores the prior config and listener before returning.
 */
export async function activateReplacement({
  prior,
  candidate,
  prepared,
  timeoutMs,
  evidence,
  observe,
  timers = globalThis,
}) {
  if (!prepared?.revision || !prepared?.config) throw new TypeError("prepared config revision required");
  if (typeof observe !== "function") throw new TypeError("listener observation function required");

  const baseline = await observe(prior);
  let priorStopped = false;
  try {
    await prior.stopAccepting();
    priorStopped = true;
    await deadline(Promise.resolve(prior.drain()), timeoutMs, timers);
    const drained = await observe(prior);
    if (drained.accepting || drained.active_requests || drained.queue_depth) {
      throw new Error("old listener reported work after drain");
    }

    const activation = await candidate.bind(prepared.config, prepared.revision);
    const active = await observe(candidate);
    if (activation.revision !== prepared.revision || active.loaded_revision !== prepared.revision) {
      throw new Error("candidate loaded revision differs from activation revision");
    }
    const record = Object.freeze({
      event: "config_activation",
      pid: activation.pid,
      revision: prepared.revision,
      config_path: prepared.path,
      baseline,
      drained,
      active,
    });
    await evidence(record);
    await prior.retire();
    return record;
  } catch (error) {
    await candidate.stop?.();
    if (priorStopped) await prior.restore();
    const restored = await observe(prior);
    await evidence({
      event: "config_activation_rollback",
      revision: prepared.revision,
      prior_revision: prior.revision,
      restored,
      reason: error.message,
    });
    throw error;
  }
}

/** Refuse requests if process state and published activation ever diverge. */
export function assertActiveRevision(loadedRevision, activationRevision) {
  if (!loadedRevision || loadedRevision !== activationRevision) {
    const error = new Error("listener config revision does not match activation revision");
    error.code = "SKGW_REVISION_MISMATCH";
    throw error;
  }
}
