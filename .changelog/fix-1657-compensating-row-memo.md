---
section: Fixed
---

- **A compensating `available` row that corrected nothing no longer silences the real one** — the once-per-correction memo now burns only when a latched `unavailable` row actually stood before it. Runners that reach the install seam with no probe of their own (biome-check, oxlint) emitted a row that pre-empted the next genuine latch-then-recover for the same tool and directory, leaving the durable log saying the tool was off while it ran (#1657).
- **A broken managed shim no longer shadows a working PATH binary** — managed-tool resolution runs the installer's own `verifyToolBinary` check instead of a bare `existsSync`, memoized per shim per session so the fast path still answers without a spawn. A verification that never got to run keeps the optimistic answer rather than reporting the tool missing (#1657).
