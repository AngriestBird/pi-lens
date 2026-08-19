---
section: Fixed
---

- **Give `reconcileProjectDiagnosticsSnapshot` the shared mtime-skew tolerance, not a bare +1ms (closes #1711)** — `reconcileProjectDiagnosticsSnapshot` (`clients/project-diagnostics/cache.ts`) compared a diagnostic's file mtime to the scan timestamp with only a +1ms slack. PR #1710 measured the real write-then-scan skew at up to ~11.4ms on Windows and gave `findingPathFreshness` and `isEntryFresh` the shared `MTIME_DRIFT_TOLERANCE_MS` (50ms) for it, but deferred this consumer. It is the worse sibling: its stale arm DROPS diagnostics outright rather than demoting them, so a same-tick write silently lost a finding from the persisted cache. It now reuses `MTIME_DRIFT_TOLERANCE_MS` from `blocker-freshness.ts`, and the stale-boundary doc comment at `clients/advisory-provenance.ts:264` (and two other spots that had drifted the same way) now cite the tolerance instead of a bare `mtime > scannedAt`.
