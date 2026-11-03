### Fixed

- Incident 2026-11-03: sk-glm-l stayed not routable after z.ai recovered because glm-5 and glm-5.3 model cooldowns retained roughly 229-minute retry deadlines. Reuse PR #202 capacity recovery machinery to open a bounded model probe slot after a configurable 3-minute floor, with per-provider single-flight ownership and one exact model per scheduler transaction.
- Preserve the original cooldown evidence, back off failed model probes, and persist explicit upstream Retry-After as a hard not-before deadline. Successful probes clear only the recovered model and its stale in-memory throttle cooldown.

Requires Lumina's review and deployment decision. No live gateway restart, deployment, or capacity-store edit is part of this change.
