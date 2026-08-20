---
section: Fixed
---

- **The widget count now includes project self-scan findings** —
  `lens_diagnostics mode=full` projects its correlated cross-lane result into
  widget state, so `ast-grep-napi` findings remain counted when the ast-grep LSP
  lane is broken or unconfirmed (#1888).
