---
section: Fixed
---

- **The widget `suppressed: N` chip keeps counting a marked finding (refs #3158)** — A finding marked `false-positive` or `suppress` stopped contributing to the pi-lens footer's `suppressed: N` chip as soon as any fresh `lens_diagnostics source=lsp` probe ran, because the probe hands the widget store the post-disposition filtered set and the store replaces a file's entries wholesale. Suppressed rows the latest scan no longer reports are now retained, and are retired when the file changes on disk, when a scan reports the finding again, when the mark stops suppressing it, or at a per-file cap whose truncation is recorded once per file.
