---
section: Fixed
audience: user
---

- **Save-triggered language servers now hear a save from MCP hosts and from cold queries (refs #3405)** — an MCP host's edit (the PostToolUse hooks and `pilens_analyze`) re-synced the file without `textDocument/didSave`, and a first `lsp_diagnostics` query on a cold server lost its save to the touch debounce after its own warm-up pushed the same bytes. A server that compiles on save, such as Expert for Elixir, answered neither. Both now send the save to servers that declared `textDocumentSync.save`; servers that declared none see no change.
