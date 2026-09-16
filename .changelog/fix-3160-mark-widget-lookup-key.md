---
section: Fixed
---

- **`lens_diagnostic_mark` widget cross-check missed mis-cased paths on case-insensitive filesystems (refs #3160)** — the #802 line-reanchor
  cross-check looked up the raw, possibly mis-cased, mark target against
  widget state, which is keyed case-preservingly on POSIX; on a
  case-insensitive filesystem (macOS APFS, `nocase` vfat/ntfs3/cifs) this
  silently missed the live diagnostic and fell back to the fuzzy line guess.
  The lookup now normalizes the path to on-disk casing before checking
  widget state. `pilens_analyze` also recorded diagnostics under the raw,
  un-normalized spelling of its agent-supplied `file` argument, so it now
  normalizes on write too — both sides key on-disk casing consistently. The
  `lsp_diagnostics`/`lens_diagnostics(source: "lsp", scope: "paths")`
  explicit-`paths` batch had the same raw-key write for a mis-cased entry
  (refs #3182); it now normalizes on write as well.
