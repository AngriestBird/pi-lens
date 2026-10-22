---
section: Changed
audience: internal
---

- Add a PATH-probe stub (`tests/support/path-probe-stub.ts`) that puts executable stand-in package managers first on a hermetic PATH, and a router that lets a `safeSpawnAsync` double pass only the package-manager lookup's own probes to the real spawn. Two test files (`review-rebuild`, the `resolveExec` argv matrix) move off `vi.mock` of `clients/package-manager` and onto the real lookup, deleting 2 `in-process-mock` rows; two hand-rolled stand-in writers fold onto the stub's `writeStandIn` (#4709).
