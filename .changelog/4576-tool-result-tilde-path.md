---
section: Fixed
audience: user
---

- **`~/` paths on a tool result resolve to the home directory (closes #4576)** — the tool_result seam now shares the tool_call resolver, so writes through `~/…` no longer dispatch runners and emit ghost findings for a `<projectRoot>/~/…` path that never existed.
