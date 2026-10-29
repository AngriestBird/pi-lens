---
section: Fixed
audience: user
---

- **A language server sees a declaration, config or install change before the next `lsp_diagnostics` answer (refs #4532)** — the look that reports a disk change outside pi-lens walked at most once every `PI_LENS_DECLARATION_LOOK_MS` (2 s) at a tool call, so a `.d.ts`/`.pyi`, a server config file or an install made inside that window reached no server before the answer: the importer kept its stale finding on call 1 and cleared only after a later bash result. The diagnostics answer now runs that look itself, with a forced walk, before it reads the servers' view (16 ms on a 688-directory repository, 0.12 ms on a small one).
