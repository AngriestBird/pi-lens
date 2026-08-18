---
section: Fixed
---

- **Gitleaks/trivy/opengrep log a compensating `available` row when auto-install recovers a failed probe (refs #1606)** — `ensureViaInstaller` probes the tool on PATH first and, on a miss, falls back to the pi-lens installer. When the PATH probe failed but the installer then resolved the managed binary, the probe's `unavailable` record stood alone in `latency.log`: nothing said the tool came back. An auditor reading the log concluded the lane was off when it was on. A second `availability_decision` row now fires on that recovery path, with `verdict: "available"`, `cause: "ok"`, `classifiedBy: "caller"`, and the resolved binary path in `evidence`.
