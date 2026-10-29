---
section: Fixed
audience: user
---

- **The MCP server no longer takes a pi session's staged findings:** when pi and an MCP client (the Stop hook or `lens_turn_end`) work in the same project, the MCP side now reads only the turn-end message an MCP server staged, so a pi session's blocker is no longer shown to the MCP client as a historical finding and marked delivered before the pi session sees it; a restarted MCP server still delivers what the previous one staged, except a message a commit-gate rewrite has replaced since (refs #4943).
