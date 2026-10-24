---
section: Fixed
audience: user
---

- **The session-start orientation names every lazy tool that is enabled.** The situational bullet listed three of the five lazy tools; `ast_grep_outline` and `lens_diagnostic_mark` were missing. It now derives its list from the tool registry, skips a tool disabled by `tools.<name>.enabled`, and under MCP names only the tools MCP can call (#4682).
