---
section: Added
audience: user
---

- **Opt-in one-line widget summary (`ui.compactWidget`, `--lens-compact-widget`) (refs #3959)** — the pi-lens widget can now render as a single summary line (languages + error/warning totals) instead of also stacking file rows, the suppressed count and blocker details below it; those details stay reachable through `lens_diagnostics`. Default off: unset, the rendered lines are byte-identical to before.
