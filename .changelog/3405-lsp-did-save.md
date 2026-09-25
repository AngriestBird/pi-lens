---
section: Fixed
---

- **Elixir diagnostics refresh again after an edit (refs [#3405](https://github.com/apmantza/pi-lens/issues/3405))** — pi-lens advertised `textDocument/didSave` but never sent one, so a language server whose diagnose pass runs on save (Expert, which recompiles the Mix project on save and on nothing else) never reported anything for a file edited through pi-lens. The post-write sync and the explicit `lsp_diagnostics` query now send the notification to every server that asked for it, carrying the document text when the server requested it and the file is inside the same 2 MiB / 5000-line bound the rest of the LSP sync already honours; servers that declare no `save` capability are unaffected, as are warm-up, cascade and workspace-sweep touches.
