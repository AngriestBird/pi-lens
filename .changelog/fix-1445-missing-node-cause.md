---
section: Fixed
---

- **Cascade no longer blames the review graph for test-file edits (closes #1445)** — A `missing_node` cascade result had two causes that read the same but meant opposite things: a real gap in the graph, and a test file excluded from the graph by design (#260). Test-file edits now get a distinct `excluded_by_role` reason that stays in telemetry but never reaches the agent as a "review graph was unavailable" advisory. A genuinely missing source file still reports `missing_node` and still triggers the advisory.
