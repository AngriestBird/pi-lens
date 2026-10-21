---
section: Changed
audience: internal
---

- **Drive the LSP service double through the real singleton lifecycle seam in 16 test files.** `tests/support/lsp-service-seam.ts` installs a `makeLspServiceDouble` surface through `configureLspServiceLifecycle`, replacing the in-process `vi.mock` of `clients/lsp/capabilities` (AGENTS.md shape 66, #4709), and the three hand-rolled installs fold onto it.
