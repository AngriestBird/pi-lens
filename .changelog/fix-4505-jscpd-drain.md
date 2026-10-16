---
section: Fixed
audience: internal
---

- **Test drain waits for the jscpd scan (#4505)** — `drainBackgroundWritesForTests` now waits for a resident jscpd scan, and `JscpdClient.shutdown()` also waits for a pending availability probe and the scan behind it, so a test file that ends right after `session_start` no longer strands a `pi-lens-jscpd-*` report directory in the pre-push batch. Pinned by `tests/clients/test-utils-drain-jscpd-4505.test.ts` and the probe cases in `tests/clients/jscpd-client.test.ts`.
