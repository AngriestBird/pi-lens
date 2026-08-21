---
section: Fixed
---

- **The oxlint runner now surfaces warning-severity findings instead of discarding them (closes #1947)** — oxlint exits 0 whenever nothing at error severity was found, and warning is oxlint's own default severity. The runner treated any exit 0 as "no findings" and returned early, so a real capture of oxlint on an unused variable — a full JSON report, exit 0 — was thrown away. The runner now parses stdout unconditionally and decides on the parsed diagnostic count instead of the exit code: zero diagnostics is still a clean `succeeded`/`none`, one or more is `failed` with `semantic: "warning"` (or `"blocking"` when a diagnostic is error severity), matching the mapping the runner already used for the nonzero-exit case. A captured real-bytes fixture (`tests/fixtures/runner-output/oxlint/warning-exit-zero.captured.json`, oxlint 1.79.0, exit 0) pins the behavior.
