---
section: Changed
---

- **docs: document the per-edit autofix routing (refs #1414)** — `docs/agent-guide.md` and `docs/features.md`/`docs/usage.md` now describe the write-immediate vs. edit-deferred autofix split, the authoritative post-fix content attached to `write` tool results (with its size cap and shared multi-file bash budget), and the coalesced `{autofix, format}` deferred-mutation queue that drains at `agent_end`.
