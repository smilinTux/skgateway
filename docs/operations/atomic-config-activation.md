# Atomic gateway config activation

Gateway replacement is a drain-gated transaction. Operators must use the source implementation in `src/restart/atomic-activation.mjs`. Direct restart commands are not a valid config activation procedure.

## Required sequence

1. Snapshot the intended config bytes once. Fully parse, merge, resolve, and validate that snapshot before touching the listener. Compute its SHA-256 revision from the same bytes.
2. Record baseline health, queue depth, active request count, old listener PID, and old config revision.
3. Start the replacement without a listening socket. It must load the prepared snapshot, not reread the mutable config path.
4. Tell the old listener to stop accepting new requests. Existing accepted requests may continue.
5. Wait for active requests and queue depth to reach zero, up to the declared drain timeout.
6. Bind the replacement only after the drain succeeds. Publish activation evidence containing the new PID and the exact prepared revision.
7. Every request must fail closed unless the listener's loaded revision equals its published activation revision.
8. Supply an observation callback that records health, accepting state, queue depth, active and completed request counters, and loaded revision. The activation event includes baseline, drained, and active observations. Rollback evidence includes the restored observation.

No overlap is permitted between an accepting old listener and a bound replacement. A supervisor or socket activator must not hand the listening socket to the candidate early.

## Exact rollback

A drain timeout, candidate bind failure, revision mismatch, unhealthy candidate, or evidence write failure aborts activation. Stop the candidate, restore the old config revision, and resume the old listener. Record the attempted revision, prior revision, reason, health, queue depth, active request count, and continuity counters. Never fall forward to a listener whose revision is unproved.

## Qualification evidence

Before review, attach:

- synthetic stale-config race and drain-timeout test results
- old and candidate config SHA-256 revisions and PIDs
- before and after health, queue depth, and active request count
- accepted, completed, and failed request counters proving continuity
- exact rollback event and restored revision from the negative test
- independent reviewer identity and verdict

This contract is for source and synthetic test qualification only. It does not authorize a live restart, deployment, or configuration mutation.
