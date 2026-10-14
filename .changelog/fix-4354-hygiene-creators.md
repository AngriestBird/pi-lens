---
section: Fixed
audience: internal
---

- The tmp-fixture hygiene owner no longer excuses a leak whose recorded creator ran in the same run, and the MCP test harness now removes a server socket whose bound path Node truncated under a long TMPDIR, so `tool-registry-governance` and `tool-roster-budget` leave no `pi-lens-mcp-*` socket (#4354, #4353).
