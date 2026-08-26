---
section: Fixed
---

- **Test-flakiness and hygiene residuals (refs #2090, closes #2139, refs #2182)** — `project-snapshot.test.ts` now restores its stubbed idle-evict env var so it cannot leak into later tests, and `project-report.test.ts`'s graph-cold assertion checks the cache stayed cold instead of a 22x-loose wall-clock bound. `session-lifecycle.test.ts`'s guard=0 reset test gets a 15s timeout, sized off a measured 5.4-7.2s honest cost under load instead of vitest's tight 5s default. `managed-tool-refresh-strategies.test.ts`'s cross-session re-arm test gets the same budget correction after reproducing its combined-run flake against the degradation-ledger suites.
