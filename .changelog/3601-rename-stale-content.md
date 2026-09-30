---
section: Fixed
---

- **`lsp_navigation`'s `rename` no longer rewrites a file that changed after the language server computed the rename (closes #3601)** — the tool read its target file to open it in the server, then threw the read away and applied the server's workspace edit with no expected-content check. A concurrent `edit` or `write` to the target, or to another file the rename touched, was overwritten at the server's stale offsets. The rename now keeps the read it already made for its target and reads every other file the edit touches before applying, and `applyWorkspaceEdit` refuses the whole edit when any of them changed in between, naming the file in the tool result and counting one `lsp-edit-stale-content` degradation. A file the edit creates is not content-checked, matching the existing expected-content callers.
