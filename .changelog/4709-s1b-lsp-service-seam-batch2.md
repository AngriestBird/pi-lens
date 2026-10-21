---
section: Changed
audience: internal
---

- Move 26 more LSP test files off `vi.mock` of `clients/lsp/capabilities` and onto `tests/support/lsp-service-seam.ts`, deleting their `in-process-mock` and `vi-mock-export` baseline rows (#4709).
