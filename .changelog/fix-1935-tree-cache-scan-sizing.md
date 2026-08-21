---
section: Fixed
---

- **Diagnostics scans stop logging a phantom ast-grep cache-stats record (refs #1935)** — `#1715` already grows the tree-sitter parse cache to span a project scan's file count, so the diagnostics-scan path does not run at the 50-entry interactive default; that part of `#1935` was resolved before this fix landed. What was still broken: every scan logged a second `cache_stats` record under scope `project_diagnostics_ast_grep_scan`, always all-zero, because ast-grep-napi parses through its own native engine and never touches the WASM tree cache that record claimed to measure. That vacuous record is now removed instead of wired to a cache it structurally cannot use. Added a memory-safety test pinning `treeCacheTotalBytes` to the existing 500-entry scan ceiling (`TREE_CACHE_SCAN_CAPACITY_CEILING`) even when a project offers far more files than that, and a regression test proving the scanner never emits the dead ast-grep scope.
