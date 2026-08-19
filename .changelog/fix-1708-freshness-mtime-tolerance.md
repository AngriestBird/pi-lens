---
section: Fixed
---

- **Give `findingPathFreshness` the same mtime-skew tolerance its sibling freshness gates carry (closes #1708)** — `findingPathFreshness` (`clients/advisory-provenance.ts`) compared a finding's cited-file mtime to the scan timestamp with zero tolerance. On Windows, a file's mtime can lead the immediately following `Date.now()` read by up to ~11.4ms, the same host skew `blocker-freshness.ts`'s `MTIME_DRIFT_TOLERANCE_MS` already covers. Without it, a file written and scanned within that window demoted a real secrets STOP blocker to an ACTION NEEDED tier, flaking `runtime-turn-secrets-disposition.test.ts`. `findingPathFreshness` now reuses the same `MTIME_DRIFT_TOLERANCE_MS` constant instead of a second hand-tuned number.
