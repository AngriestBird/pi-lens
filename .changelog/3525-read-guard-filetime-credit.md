---
section: Fixed
---

- **The read guard no longer credits bytes the agent never saw (refs #3525, refs #3524)** — On a file too large for line hashes (over 3,000 lines), FileTime is the guard's only staleness check, and four paths moved it over another writer's bytes: the 120-second own-edit grace, an own edit that had passed a stale FileTime on other evidence (for example a resolved `oldText`), the deferred `agent_end` format, autofix and LSP quick fix, and the settled sweep's replay of unexplained drift. None of them re-stamps FileTime now, so the next positional edit of a changed line asks for a re-read. The deferred writers still count as authorship. A `write` that overwrites a file records the lines it wrote from its `content` rather than from the disk. `PI_LENS_READ_GUARD_OWN_EDIT_GRACE_MS` has no effect any more.
