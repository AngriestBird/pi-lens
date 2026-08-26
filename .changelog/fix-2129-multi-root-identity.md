---
section: Fixed
---

- **Key session start and the host registry by project root (closes #2129, refs #2130)** — a subagent temp worktree no longer steals the process's primary session. Root identity is now an input to session-start classification, so a start in a different directory takes the reduced path instead of resetting the host's warm LSP fleet and re-running the whole startup battery over unchanged content. Two temp roots in one host previously cost about 50 seconds of opengrep and 53 seconds of word-index rebuild each, and drove host RSS from 290MB to 1.1GB in four minutes. The host registry entry in `instances.json` now holds a set of roots with the primary pinned, instead of one scalar every session start overwrote, so warm attach and the shared-checkout guard can see a peer working under any of its roots. The shared-checkout guard now confirms a peer against every root it serves, so a session working under a secondary root can no longer be missed and have its uncommitted work discarded. `memory_sample` carries the owning root and the distinct-root count of its live LSP clients, which makes a turn index attributable on a multi-root host.

> Refs #2129, #2130
