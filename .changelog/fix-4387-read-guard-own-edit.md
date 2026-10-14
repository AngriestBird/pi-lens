---
section: Fixed
audience: user
---

- **The read guard no longer refuses edits of a file the agent wrote itself (#4387)** — when the agent's own `edit` (oldText/newText) touched a file it had written whole, the read guard ended that file's authorship. It logged `authorship_retired` with `writer: "bridge"`, and after a bash write the next edit was refused with "File modified since your write" although no other process had touched the file. The authorship now advances to the edit's bytes. Separately, after a bash write and one own positional edit, an edit of another line was refused with "File modified since read". The guard again records the whole file as read when it allows that first edit. A change by another writer still ends the authorship. A range-scoped authorship that meets an edit of unknown range is still retired, and that record now reads `writer: "unknown-range"`.
