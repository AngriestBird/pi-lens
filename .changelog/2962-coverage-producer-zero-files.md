---
section: Fixed
---

- `lens_diagnostics mode=full` no longer retires retained opengrep findings
  across the whole project when an opengrep scan completed but scanned zero
  files (an empty `paths.scanned`, e.g. no rule language matched the root).
  A coverage producer that declares zero scanned files now has file-level
  authority over nothing instead of falling back to whole-root authority, so
  a finding is only retired when a scan actually covered its file. The
  one-per-session `runner-coverage-empty` ledger row says when that happened
  (refs #2962).
