---
section: Fixed
---

- **BLIND WRITE no longer fires on self-authored files (closes #1364)** — A `write`/`edit` of the same normalized path earlier in the blind-write window now counts as file knowledge, so the common author-then-iterate loop (create a file with `write`, refine it with successive `edit` calls) stays quiet. A genuinely stale edit of a file not touched in the window still warns, and the two-write threshold, 5-call window, and thrashing detection are unchanged. Thanks to @snrogers for the field report and the fix.
