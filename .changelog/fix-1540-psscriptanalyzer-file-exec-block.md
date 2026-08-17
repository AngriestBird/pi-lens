---
section: Fixed
---

- **An execution-policy-blocked PSScriptAnalyzer run no longer reports the file as clean (refs #1540)** — Both availability probes call PowerShell with `-Command`, which the execution policy does not gate, but the real analysis runs with `-File`, which it does. Under `Restricted`/`AllSigned` — the default on many corporate Windows hosts — the analysis exits nonzero with a `SecurityError` on stderr and nothing on stdout, and the runner read that empty stdout as zero diagnostics: a blocked analyzer reported as a clean file. A `-File` run is now verified directly: a nonzero exit or a crashed/signal-killed process (`status === null`) records a legible `availability_decision` (policy and interpreter included) and a `grammar-blocked` degradation-ledger entry instead of a silent pass or a silent skip, and only an actual exit-0 run is read as evidence about the file's diagnostics.
