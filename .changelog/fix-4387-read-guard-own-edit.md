---
section: Fixed
audience: user
---

- **An own oldText edit no longer ends the authorship of the agent's own write (#4387)** — the read guard ended authorship when the agent's own `edit` (oldText/newText) touched a file it had written whole. It logged `authorship_retired` with `writer: "bridge"`, and after a bash write the next edit was refused with "File modified since your write" although no other process had touched the file. The authorship now advances to the edit's bytes. A change by another writer still ends it. A range-scoped authorship that meets an edit of unknown range is still retired, and that record now reads `writer: "unknown-range"`.
