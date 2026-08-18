---
section: Fixed
---

- **~16 CLI runners now log recovery when auto-install fixes a failed tool probe (refs #1612)** — `resolveAvailableOrInstallUnshared`, the shared seam behind golangci-lint, ruff, shellcheck, pyright, knip, jscpd, and about a dozen other runners, wrote a latched `unavailable` `availability_decision` row when the PATH probe missed, then fell through to the pi-lens installer. If the installer resolved the binary, nothing recorded that recovery — the durable log kept saying the tool was off after it came back on. This is the same defect shape #1606/PR #1610 fixed in `security-scan-client.ts`'s `ensureViaInstaller`, on a seam with a much larger blast radius. A second row now fires on that recovery path, with `verdict: "available"`, `cause: "ok"`, `classifiedBy: "caller"`, and `evidence: { install: "succeeded", binary: "<basename>", source: "managed-dir" }` — matching #1610's settled, redacted evidence shape exactly.
