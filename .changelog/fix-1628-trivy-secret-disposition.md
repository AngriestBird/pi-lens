---
section: Fixed
---

- **Trivy secret findings now honor dispositions (closes #1628)** — Trivy's own secret scan (`TrivyResult.secrets`) had no `ProjectDiagnostic` identity for an agent to anchor a `lens_diagnostic_mark` call against, so a false-positive mark could never suppress it — the same bug #1617/#1625 fixed for gitleaks, govulncheck, and Trivy's CVE lane, left open for Trivy's secret lane. A new `trivySecretFindingToProjectDiagnostic` adapter (rule id `trivy-secret:<ruleId>`, namespaced apart from the CVE lane's `trivy:<vulnerabilityId>`) now surfaces these findings in `lens_diagnostics mode=full` and routes them through `applyDispositionsMultiFile`/`turn_end`'s disposition filter, matching the existing gitleaks/govulncheck/Trivy-CVE wiring.
