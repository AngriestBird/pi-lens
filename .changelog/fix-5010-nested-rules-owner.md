---
section: Fixed
audience: user
---

- **A nested `.pi-lens.json` now governs its own files' `rules`:** `rules.<id>.disable`, `select` and `ignorePaths` are read per file from the nearest `.pi-lens.json` at or above it, on every surface that filters by them: the per-edit dispatch, `lens_diagnostics`, `lsp_diagnostics` and the turn-end advisories. Before, every surface read the workspace root's file alone, so a rule a package disabled for itself still reported. The workspace root's policy still reaches nested files. An `ignorePaths` glob in a nested file is relative to that file's directory; global and root entries match against the workspace root as before (refs #5010).
