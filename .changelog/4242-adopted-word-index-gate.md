---
section: Fixed
audience: user
---

- **Keep an adopted project's files out of the session word index.** An edit in a project pi-lens serves read-only no longer adds a document to the session's symbol index, and the MCP analyze route refuses the same write for the warm index of the workspace it belongs to. Both refusals record one bounded `adopted_root_writer_skipped` decision naming `word-index`. (#4242)
