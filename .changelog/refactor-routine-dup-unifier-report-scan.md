---
section: Changed
audience: user
---

- **Gitleaks and trivy scan failures now leave a `security-scan-report-failed` health row.** A scan whose CLI failed to spawn or whose run threw was visible only as the result's summary; opengrep already recorded the same event. Both scanners now share one report-scan body (`SecurityScanClient.runReportScan`), so their outcomes cannot drift apart (refs #4907).
