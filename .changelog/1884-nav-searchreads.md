---
section: Fixed
audience: user
---

- **`lsp_navigation` results count as reads again (refs #1884)** — A navigation result whose path was relative and had no recorded resolution basis lost the `details.searchReads` lines it showed the agent, so the next edit to those lines was blocked by the read guard. Those lines are registered as reads before the refusal, which still keeps turn state and dispatch closed for the unresolved path.
