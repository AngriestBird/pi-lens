---
section: Fixed
---

- **Normalize the remaining NDJSON logger `filePath` fields (refs #2219, the #2141 class)** — `cascade.log`, `latency.log`, `read-guard.log`, `tree-sitter.log`, and `actionable-warnings.log` now normalize `filePath` once at each logger's single emit seam, so the same file no longer appears in two path forms across a log. Non-path sentinels (`"<quiet-window>"`, `"<tree-sitter>"`, shell commands, coarse labels) mixed into the same field are left untouched instead of being resolved against the process cwd.
