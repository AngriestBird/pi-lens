---
section: Fixed
---

- **Per-edit autofix no longer mutates files mid-turn (closes #1414)** — `edit` queues pipeline autofix for the owning `agent_end`, where autofix runs before the stable formatting pass; `write` keeps immediate autofix and returns authoritative post-fix file content, while write-then-edit paths stay demoted for the rest of the turn. Deferred mutation records coalesce both phases, preserve session ownership, deduplicate project-wide Rust/Dart fixers, and merge independently requeued phases.
