---
section: Changed
---

- **Cut the two heaviest test files' peak memory by 8.4 GB and gate the budget (refs #3058)** — `bounded-container-guard` re-parsed and re-walked each source up to six times per container occurrence (9,207 → 812 MB peak RSS) and the `vi.mock` export detector re-parsed production modules once per call site (5,646 → 1,800 MB); the `[mem-file]` hook now fails any file that exceeds `WORKER_PEAK_RSS_BUDGET_MB` without a measured admission.
