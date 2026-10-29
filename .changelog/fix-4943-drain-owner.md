---
section: Fixed
audience: user
---

- **A subagent's deferred format runs in its own settle:** with an in-process subagent, a file it wrote through a tool pi-lens observes, `ast_grep_replace`, `lens_diagnostic_mark` or a background change found at settle is now queued under the subagent, and the subagent's own `agent_settled` formats it and its native edits. Before, the parent session formatted such a write as its own, and the subagent's native edits waited for the parent's 10-minute orphan claim. A subagent still never takes the parent's records or runs the actionable-warning quick fixes (refs #4943).
