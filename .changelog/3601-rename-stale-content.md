---
section: Fixed
---

- **`lsp_navigation`'s `rename` no longer rewrites a file that changed after the language server computed the rename (closes #3601)** — the tool applied the server's workspace edit with no expected-content check, so a concurrent `edit` or `write` to any file the rename touched was overwritten at the server's stale offsets. The rename's own file is now held to the bytes the tool sent the server, and every other file the edit writes text to is held to the bytes the language client last sent for it: the edit is refused, before any write, when a file's content differs from what the server computed against, naming the file in the tool result and counting one `lsp-edit-stale-content` degradation. A file the language client does not track (never opened in the server) is refused too, because nothing shows what the server read for it, so a rename that reaches a file the server holds no open copy of is refused; a file the edit creates is not checked.
