---
section: Fixed
---

- **Runner exit codes now gate clean vs. errored (refs #1736)** — Knip, jscpd,
  and vulture no longer read an empty result on a nonzero exit as "clean."
  A broken shim, a crash, or a config-load error now reports as errored and
  records a bounded degradation entry naming the runner and its exit status,
  instead of silently showing zero issues.
