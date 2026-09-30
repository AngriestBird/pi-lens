---
section: Fixed
---

- **`lens_diagnostics mode=full` no longer re-stamps folded project rows at scan time (closes #3600)** — heavyweight-analyzer findings (knip, jscpd, madge, gitleaks, govulncheck, opengrep, trivy, dead-code, test-runner) and `projectDelta` rows were stamped by the #1888 correlated commit with the cheap project scan's `scannedAt`, or with the fold's own time when no scan ran. A file edited while the analyzer was still reading therefore looked older than its row, and no widget freshness gate demoted it. Each heavyweight row now carries the analyzer's own observation time (its result's `scannedAt`, or the moment the lane started when the result has no stamp) and each `projectDelta` row carries the report's `generatedAt`, through to the widget.
