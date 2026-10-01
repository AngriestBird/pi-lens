---
section: Fixed
---

- **`lsp_navigation rename` no longer refuses a file the language client first opened after the rename was computed (closes #3827)** — A read or cascade touch that opened a not-yet-open file after the server answered made the staleness check report "it changed after the language server computed the rename" although no byte changed. The client now records when it first sent a file, and such a file is held to the unopened-file rule (mtime against the request) instead of the send stamp. A file that was open at the request, or written after it, is still refused.
