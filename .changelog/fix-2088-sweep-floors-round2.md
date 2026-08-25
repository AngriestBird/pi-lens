---
section: Fixed
---

- **Closed the managed-tool seam sweep's vacuous exemption (refs #2088)** — The meta-sweep exempted `managed-tool-seam-coverage.test.ts` with a false reason; the file walks `clients/` from a cwd-relative root and asserted zero violations with no floor, so blinding its walk to an empty array still passed. It now walks from a repo-root-derived path and carries its own scanned-files and detector-signal floors. Reworded two other exemption reasons that wrongly said "not a population sweep" when both carry their own hand-rolled floors. Added the `readdir` named-import spelling to the meta-sweep's enumeration regex, closing an async-walk evasion. Recalibrated the meta-sweep's `minFlagged` to the measured population (55) after the exemption-list growth made the prior figure stale.
