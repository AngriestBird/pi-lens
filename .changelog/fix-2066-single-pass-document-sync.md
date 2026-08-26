---
section: Fixed
---

- **Per-send LSP document sync makes one JavaScript pass over the previous document instead of two, on `didChange` (refs #2066)** — the newline count behind `lsp_document_send`'s `contentLineCount` and the last-line position behind an Incremental `didChange` range now come from a single scan whose result rides on the existing per-path content-binding entry, so a change no longer splits the previous document into one substring per line to read one of them. Line-count semantics are unchanged: `contentLineCount` still counts `\n` only, while the range still treats `\r\n`, lone `\r`, and `\n` as terminators. The remainder of #2066 is its "one pass total" target: the #1095 sha256 content binding is a second, native full-document pass and still runs on every send.
