---
section: Fixed
---

- **Stamp classifiedBy on every availability_decision failure arm (refs #2131, #2209)** — 12 call sites across formatters, the JVM runtime probe, zizmor's gh-token latch, PowerShell script analysis, govulncheck, and the shared runner-helpers/ast-grep seams now record whether a probe or the call site itself classified the outcome, closing the failure-arm half of the gap #2205 fixed for successes.
