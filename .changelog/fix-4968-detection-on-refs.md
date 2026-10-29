---
section: Changed
audience: internal
---

- The `## Detection` PR-body check is owed by any PR whose `Refs`, `Closes`, `Fixes` or `Resolves` line names an issue labelled `bug` or `nightly-drift`, not only by one that closes a `bug` issue; a label it cannot read, or a `owner/repo#N` or URL reference, is refused rather than skipped (refs #4968).
