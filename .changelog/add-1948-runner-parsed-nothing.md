---
section: Added
---

- **A runner that reads nothing out of a failing tool's output now leaves a record (closes #1948)** — when a dispatch runner's tool exits nonzero, prints output, and the runner's parser extracts zero diagnostics, the degradation ledger gets a bounded `runner-parsed-nothing` row naming the tool, the exit status, the output length, and the first output line. Until now that case was byte-for-byte identical to a clean file in the worklog, which is how five parser bugs (vale, taplo, stylelint, phpstan, sqlfluff) reported clean files for months. A genuinely clean run records nothing, so the ledger does not fill up with one row per save. The gate lives in one shared helper, `parseToolRun`, that fourteen runners now share, and a sweep test keeps a new runner from silently opting out through any of the older spawn-outcome primitives.
