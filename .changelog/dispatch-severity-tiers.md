---
section: Fixed
---

- **Preserve ast-grep rule severity tiers through dispatch** — The dispatch
  runner collapsed every `warning`, `hint`, and `info` rule severity to
  `warning`, so the quiet tier that 43 shipped rules declare did not exist
  downstream. All four tiers now reach `Diagnostic.severity`. The turn-end
  advisories say how many findings are hint or info, the code-quality report
  spends its cap on warnings before hints, and hint-tier rules that carry a fix
  still route to actionable warnings. The `lens_diagnostics` and TUI-footer
  tallies count hint and info alongside warning, so a hint-only file is never
  reported as clean. Only `error` blocks, exactly as before.
