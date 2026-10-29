---
section: Changed
audience: user
---

- **A gitleaks or trivy scan that failed is no longer read as a clean scan.** A CLI that failed to spawn, whose run threw, or that exited non-zero without writing its report now leaves a `security-scan-report-failed` health row and a failed (not cached-clean) result, as opengrep and jscpd already did. Both scanners now share one report-scan body (`SecurityScanClient.runReportScan`), so their outcomes cannot drift apart (refs #4907).
