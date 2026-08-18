---
section: Fixed
---

- **Security scanners log a compensating `available` row when auto-install recovers a failed probe (refs #1606)** — gitleaks, trivy, and opengrep probe on PATH first and fall back to the pi-lens installer; govulncheck falls back to `go install`. When the probe failed but the install then resolved the binary, the probe's `unavailable` record stood alone in `latency.log`: nothing said the tool came back. An auditor reading the log concluded the lane was off when it was on. A second `availability_decision` row now fires on every recovery path, with `verdict: "available"`, `cause: "ok"`, `classifiedBy: "caller"`, and the binary's basename plus its install source in `evidence`.
