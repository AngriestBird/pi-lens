---
section: Fixed
---

- **Tree-sitter cache now spans a full-project scan** — the parse-tree cache
  grows to fit a scan's file count (capped at 500 entries, or
  `PI_LENS_TREE_SITTER_CACHE_SCAN_CAP`) instead of staying fixed at 50, so a
  repeat `lens_diagnostics mode=full` scan reuses trees from the first pass
  instead of re-parsing every file (#1715).
