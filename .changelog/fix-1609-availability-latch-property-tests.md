---
section: Added
---

- **State-machine property tests for the availability latch (refs #1609)** — `tests/clients/dispatch/runners/availability-latch-properties.test.ts` runs a seeded, deterministic PRNG over random sequences of probe outcomes, time advances, session-start re-arms and caller retries against `createAvailabilityLatch`/`classifyProbeFailure`, asserting five invariants after every step: never durably latched on transient-only evidence, re-arm reachable at session_start, cooldown ladder monotone and capped, recovery reachable from every state, and degradation recorded exactly once per episode.
