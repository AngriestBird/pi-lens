---
section: Fixed
---

- **`tmp-fixture-hygiene`'s governance owner attributed another test file's async-recreated directory to itself (refs #3186)** — PR #3168's CI run redded `tests/config/tmp-fixture-hygiene.test.ts` over `pi-lens-tool-policy-conventions-*` directories owned by `tests/clients/tool-policy-conventions.test.ts`. That file's `afterEach` removes its `setupTestEnvironment` directory synchronously, but `saveProjectSnapshot` (called from within the test) dispatches its body persist to a worker thread / main-thread fallback the caller never awaits, and that persist's write path recreates the just-removed directory via a recursive `mkdir` — measured directly landing ~10-50ms later, unforced, on a bare invocation of the real function. The prefix is now admitted in the shrink-only baseline, the same class already covering other async-persist owners (`pi-lens-session-nested-snapshot-`, `pi-lens-warmup-prewarm-`, …); the throw is unchanged for any genuinely unadmitted leftover.
