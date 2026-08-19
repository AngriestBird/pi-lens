---
section: Fixed
---

- **A compensating `available` row that corrected nothing no longer silences the real one** — the once-per-correction memo now burns only when a latched `unavailable` row actually stood before it. Runners that reach the install seam with no probe of their own (biome-check, oxlint) emitted a row that pre-empted the next genuine latch-then-recover for the same tool and directory, leaving the durable log saying the tool was off while it ran. Managed-tool resolution also runs the installer's own `verifyToolBinary` check instead of a bare `existsSync`, so a broken shim no longer shadows a working PATH binary; a settled verdict is memoized per shim per session, a verification that never got to run keeps the optimistic answer under a bounded cooldown, and concurrent first touches share one probe (#1657).
