---
section: Fixed
---

- **The widget `suppressed: N` chip keeps counting a marked finding (refs #3158)** — A finding marked `false-positive` or `suppress` stopped contributing to the pi-lens footer's `suppressed: N` chip as soon as any fresh `lens_diagnostics source=lsp` probe ran, because the probe hands the widget store the post-disposition filtered set and the store replaces a file's entries wholesale. Suppressed rows the latest scan no longer reports are now retained, and a suppressed row is no longer treated as a blocker anywhere — it cannot draw a red footer row, displace a live finding, or enter the turn-end blocker sweep. Known window: the retained row is retired by the file's next edit, even one that leaves the marked line unchanged and the mark still applying, and nothing re-creates it; the chip therefore counts a mark until that file is next edited rather than for as long as the mark stands.
