---
section: Fixed
---

- **A tool path with `/../` in it no longer orphans its own diagnostics record (refs #3184)** — `normalizeMapKey`, the canonical map-key normalizer, passed dot segments through unchanged on macOS and Linux whenever the path's casing was already right, so an absolute path containing `/../` (or `/./`, or a doubled separator) keyed under a spelling no other writer or reader ever derives. A `lens_diagnostic_mark`, `pilens_analyze` or `lens_diagnostics {source:"lsp"}` call typed that way produced an orphan widget row, a missed line reanchor and a split disposition anchor. The POSIX arm now folds dot segments before it looks at casing, so every consumer inherits one key per file; the fold is pure string algebra, so a relative path is still never resolved against the process working directory. The `lsp_diagnostics` single-`path` mode, which derives its key without that normalizer, was folded onto the same expression its `paths` batch already uses.
