---
section: Added
audience: internal
---

- **Live cross-file rename and deletion twins for the classic TypeScript server (#1712)** — `tests/clients/lsp/crossfile-classic-ts-live.test.ts` drives the real
  `typescript-language-server` wrapper and a classic compiler through
  `LSPService.renameFile` and `LSPService.notifyExternalFileChange`, and lands
  in the `lsp-spawn-heavy` lane beside the cascade twin. Two cases prove a file
  rename applies the server's own `workspace/willRenameFiles` edits to the
  importer, and that no `workspace/didRenameFiles` reaches a server that never
  registered it. The deletion case is written and admitted but skips on a
  condition derived from the client capability, because a classic wrapper asks
  for no client-side file watching while pi-lens advertises no relative-pattern
  support and drops every `workspace/didChangeWatchedFiles` event it is sent.
  Opt-in like the sibling live suites: `PI_LENS_INTEGRATION=1` plus
  `PI_LENS_CLASSIC_TSC`, so CI skips it with a printed reason. No product
  behaviour changes.
