---
section: Changed
audience: internal
---

- The `## Detection` PR-body check is owed by any PR that closes, or whose `Refs` line or title names, an issue labelled `bug` or `nightly-drift`, not only by one that closes a `bug` issue; CI refuses a label it cannot read and, unless the body already closes a bug, a `owner/repo#N` or URL reference, and the local preflight warns and skips an unreadable label (refs #4968).
